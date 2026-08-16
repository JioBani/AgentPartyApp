import * as dgram from "node:dgram";
import { randomBytes } from "node:crypto";

/**
 * Minimal STUN binding client (RFC 5389) — just enough to learn this machine's
 * reflexive address and whether the NAT reuses the same mapping for different
 * destinations.
 *
 * Written rather than taken from a package because that is all diagnostics
 * needs: a binding request is a 20-byte header, and the answer is one
 * attribute. A dependency would add install weight and another native-ish
 * surface to keep working on three platforms for no gain (06).
 */

const STUN_BINDING_REQUEST = 0x0001;
const STUN_BINDING_SUCCESS = 0x0101;
const MAGIC_COOKIE = 0x2112a442;
const ATTR_XOR_MAPPED_ADDRESS = 0x0020;
/** Pre-RFC5389 servers may answer with this instead. */
const ATTR_MAPPED_ADDRESS = 0x0001;

export interface StunResult {
  address: string;
  port: number;
  family: 4 | 6;
  elapsedMs: number;
}

export interface StunProbeOptions {
  /** `host:port`, e.g. `stun.l.google.com:19302`. */
  server: string;
  timeoutMs?: number;
  /**
   * Reuses one socket across probes. Mapping behaviour can only be judged when
   * both requests leave the SAME local port — a fresh socket per probe would
   * make every NAT look symmetric.
   */
  socket?: dgram.Socket;
}

/**
 * Sends one binding request and resolves the reflexive address.
 *
 * @throws on timeout or a malformed answer. Callers record the failure as a
 *   probe result rather than letting it abort the whole diagnosis.
 */
export function stunProbe(options: StunProbeOptions): Promise<StunResult> {
  const { host, port } = splitHostPort(options.server);
  const timeoutMs = options.timeoutMs ?? 3_000;
  const owned = !options.socket;
  const socket = options.socket ?? dgram.createSocket({ type: "udp4", reuseAddr: true });
  const transactionId = randomBytes(12);
  const startedAt = Date.now();

  return new Promise<StunResult>((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | undefined, result?: StunResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("error", onError);
      if (owned) {
        socket.close();
      }
      if (error) {
        reject(error);
      } else if (result) {
        resolve(result);
      }
    };

    const timer = setTimeout(() => {
      finish(new Error(`STUN ${options.server}: no answer within ${timeoutMs}ms`));
    }, timeoutMs);

    const onMessage = (message: Buffer) => {
      // One socket may carry several probes; ignore answers to other requests.
      if (message.length < 20 || !message.subarray(8, 20).equals(transactionId)) {
        return;
      }
      try {
        finish(undefined, { ...parseBindingResponse(message), elapsedMs: Date.now() - startedAt });
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };

    const onError = (error: Error) => finish(error);

    socket.on("message", onMessage);
    socket.on("error", onError);

    const request = Buffer.alloc(20);
    request.writeUInt16BE(STUN_BINDING_REQUEST, 0);
    request.writeUInt16BE(0, 2);
    request.writeUInt32BE(MAGIC_COOKIE, 4);
    transactionId.copy(request, 8);
    socket.send(request, port, host, (error) => {
      if (error) {
        finish(error);
      }
    });
  });
}

function parseBindingResponse(message: Buffer): Omit<StunResult, "elapsedMs"> {
  const type = message.readUInt16BE(0);
  if (type !== STUN_BINDING_SUCCESS) {
    throw new Error(`STUN: unexpected message type 0x${type.toString(16)}`);
  }
  const length = message.readUInt16BE(2);
  let offset = 20;
  const end = Math.min(20 + length, message.length);

  while (offset + 4 <= end) {
    const attrType = message.readUInt16BE(offset);
    const attrLength = message.readUInt16BE(offset + 2);
    const valueStart = offset + 4;
    const valueEnd = valueStart + attrLength;
    if (valueEnd > message.length) {
      break;
    }
    if (attrType === ATTR_XOR_MAPPED_ADDRESS || attrType === ATTR_MAPPED_ADDRESS) {
      return readAddress(message.subarray(valueStart, valueEnd), attrType === ATTR_XOR_MAPPED_ADDRESS);
    }
    // Attributes are padded to a 4-byte boundary.
    offset = valueEnd + ((4 - (attrLength % 4)) % 4);
  }
  throw new Error("STUN: the answer carried no mapped address");
}

function readAddress(value: Buffer, xored: boolean): Omit<StunResult, "elapsedMs"> {
  const family = value.readUInt8(1);
  const rawPort = value.readUInt16BE(2);
  const port = xored ? rawPort ^ (MAGIC_COOKIE >>> 16) : rawPort;

  if (family === 0x01) {
    const bytes = Buffer.from(value.subarray(4, 8));
    if (xored) {
      const cookie = Buffer.alloc(4);
      cookie.writeUInt32BE(MAGIC_COOKIE, 0);
      for (let index = 0; index < 4; index += 1) {
        bytes[index] ^= cookie[index];
      }
    }
    return { address: [...bytes].join("."), port, family: 4 };
  }
  if (family === 0x02) {
    const bytes = Buffer.from(value.subarray(4, 20));
    if (xored) {
      const mask = Buffer.alloc(16);
      mask.writeUInt32BE(MAGIC_COOKIE, 0);
      // The remaining 12 bytes are masked with the transaction id, which the
      // caller does not need here: only the address family and reachability
      // matter for diagnostics, so an un-masked v6 address is not reported.
      for (let index = 0; index < 4; index += 1) {
        bytes[index] ^= mask[index];
      }
    }
    return { address: formatIpv6(bytes), port, family: 6 };
  }
  throw new Error(`STUN: unknown address family 0x${family.toString(16)}`);
}

function formatIpv6(bytes: Buffer): string {
  const groups: string[] = [];
  for (let index = 0; index < 16; index += 2) {
    groups.push(bytes.readUInt16BE(index).toString(16));
  }
  return groups.join(":");
}

/** Accepts `host:port`, defaulting to the STUN port when none is given. */
export function splitHostPort(server: string): { host: string; port: number } {
  const withoutScheme = server.replace(/^stun:/, "");
  const index = withoutScheme.lastIndexOf(":");
  if (index < 0) {
    return { host: withoutScheme, port: 3478 };
  }
  const port = Number(withoutScheme.slice(index + 1));
  return {
    host: withoutScheme.slice(0, index),
    port: Number.isInteger(port) && port > 0 ? port : 3478,
  };
}

export function createProbeSocket(): dgram.Socket {
  return dgram.createSocket({ type: "udp4", reuseAddr: true });
}
