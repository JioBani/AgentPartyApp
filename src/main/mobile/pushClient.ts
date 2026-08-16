import * as http from "node:http";
import * as https from "node:https";
import { URL } from "node:url";
import {
  buildPushRequest,
  sealPushPayload,
  toB64,
  type Identity,
  type Platform,
  type PushPayload,
} from "@agentparty/protocol";
import type { MobileGatewayDeps } from "./index";
import { PushError } from "./mobileGateway";

/**
 * Sends a sealed notification to the push relay (01 §7).
 *
 * The relay is semi-trusted: it forwards to APNs/FCM and rate-limits, but never
 * sees the text. The payload is sealed to the phone's static kx key and the
 * whole request is signed with the desktop's identity key, so the relay can
 * reject spam without being able to read anything (02 §T8).
 *
 * Everything here fails loudly. A push that silently does not arrive is the
 * worst outcome in this system: the user is waiting for an approval that will
 * never appear on their phone, with nothing to explain the silence.
 */

export interface PushClientDeps {
  identity: Identity;
  /** Base URL of the relay, e.g. `https://push.agentparty.app`. */
  pushUrl: () => string;
  log: MobileGatewayDeps["log"];
  /** Injected in tests. */
  post?: (url: string, body: string) => Promise<{ status: number; text: string }>;
  timeoutMs?: number;
}

export interface PushTarget {
  deviceId: string;
  platform: Platform;
  handle: string;
  /** Phone's static X25519 public key, base64url as stored in the trust record. */
  kxPk: Uint8Array;
}

export class PushClient {
  constructor(private readonly deps: PushClientDeps) {}

  /**
   * Seals, signs and posts one notification.
   *
   * @throws when the relay is not configured, refuses the request, or cannot be
   *   reached. The message names the relay's own reason where it gave one.
   */
  async notify(target: PushTarget, payload: PushPayload): Promise<void> {
    const base = this.deps.pushUrl().trim();
    if (!base) {
      throw new PushError(
        "not_configured",
        "푸시 서버 주소가 설정되지 않아 알림을 보낼 수 없습니다. 모바일 설정에서 pushUrl을 지정하세요.",
      );
    }
    const endpoint = pushEndpoint(base);

    const box = sealPushPayload(payload, target.kxPk);
    const request = buildPushRequest(
      { platform: target.platform, handle: target.handle, box },
      this.deps.identity.sigPk,
      this.deps.identity.sigSk,
    );

    const post = this.deps.post ?? ((url, body) => postJson(url, body, this.deps.timeoutMs ?? 10_000));
    let response: { status: number; text: string };
    try {
      response = await post(endpoint, JSON.stringify(request));
    } catch (error) {
      // The relay was unreachable — distinct from a relay that answered and
      // said no, because only one of those is worth retrying soon.
      throw new PushError("transport_failed", error instanceof Error ? error.message : String(error));
    }

    if (response.status === 429) {
      // 01 §7 — the relay rate-limits per device. Retrying immediately would
      // only deepen the limit, so the caller is told to back off instead.
      throw new PushError("rate_limited", "푸시 서버가 요청 빈도 제한을 적용했습니다. 잠시 후 다시 시도하세요.");
    }
    if (response.status < 200 || response.status >= 300) {
      throw new PushError(
        "relay_refused",
        `푸시 서버가 요청을 거부했습니다 (HTTP ${response.status}): ${describe(response.text)}`,
      );
    }

    this.deps.log("info", "mobile push delivered to the relay", {
      deviceId: target.deviceId,
      platform: target.platform,
      // The handle is a device credential; only its shape is useful in a log.
      handleLength: target.handle.length,
      boxBytes: box.byteLength,
      sigPk: toB64(this.deps.identity.sigPk).slice(0, 8),
    });
  }
}

/**
 * `https://host` → `https://host/v1/push`, leaving an explicit path alone so a
 * relay behind a prefix still works.
 */
export function pushEndpoint(base: string): string {
  const url = new URL(base);
  if (url.pathname && url.pathname !== "/") {
    return url.toString();
  }
  return new URL("/v1/push", url).toString();
}

function postJson(url: string, body: string, timeoutMs: number): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === "https:" ? https : http;
    const request = transport.request(
      {
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": String(Buffer.byteLength(body)),
        },
        timeout: timeoutMs,
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, text }));
      },
    );
    request.on("timeout", () => request.destroy(new Error(`푸시 서버가 ${timeoutMs}ms 안에 응답하지 않았습니다.`)));
    request.on("error", reject);
    request.write(body);
    request.end();
  });
}

/** Prefers the relay's own error text over a raw body dump. */
function describe(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
    const detail = parsed.error ?? parsed.message;
    if (typeof detail === "string" && detail) {
      return detail;
    }
  } catch {
    // Not JSON; fall through to the trimmed body.
  }
  return text.trim().slice(0, 200) || "(본문 없음)";
}
