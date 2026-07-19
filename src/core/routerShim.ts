import * as http from "node:http";
import * as net from "node:net";
import { HARNESS_PROTOCOLS } from "../shared/harnessProtocols";
import { routerTargetForModel, type RouterTarget } from "../shared/modelCatalog";
import { assertSubscriptionModelAvailable, subscriptionProxyConfig } from "./subscriptionProxy";

const CLAUDE_PROTOCOL = HARNESS_PROTOCOLS["claude-code"];
const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const MAX_ACCOUNTING_CAPTURE_BYTES = 256 * 1024;

export interface EmbeddedHarnessRouterOptions {
  preferredPort: number;
  openRouterApiKey?: string;
  /** Override exists for protocol-contract QA; production uses OpenRouter. */
  openRouterBaseUrl?: string;
  subscriptionProxyBaseUrl?: string;
  subscriptionProxyApiKey?: string;
  authToken: string;
}

export interface RouterTurnUsage {
  costUsd?: number;
  generationId?: string;
  costUnavailableReason?: string;
  requestCount: number;
}

interface CostBucket {
  costUsd: number;
  requestCount: number;
  generationIds: string[];
  unavailableReasons: string[];
  hasCost: boolean;
}

interface UpstreamRoute {
  response: Response;
  openRouter: boolean;
}

/**
 * Claude Code's embedded protocol gateway.
 *
 * The gateway selects credentials and a concrete provider model, but it never
 * translates the harness contract. Requests enter and leave as Anthropic
 * Messages, including tool blocks, interruption markers, images, thinking and
 * SSE events. Provider bridges may translate internally after that boundary.
 */
export class EmbeddedHarnessRouter {
  private server: http.Server | undefined;
  private port = 0;
  private options: EmbeddedHarnessRouterOptions;
  private readonly costBuckets = new Map<string, CostBucket>();
  private requestCount = 0;
  private lastRoute: { protocol: string; targetKind: RouterTarget["kind"]; targetModel: string; upstreamEndpoint: string } | undefined;

  constructor(options: EmbeddedHarnessRouterOptions) {
    this.options = options;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port || this.options.preferredPort}`;
  }

  updateOptions(options: Partial<EmbeddedHarnessRouterOptions>): void {
    this.options = { ...this.options, ...options };
  }

  resetTurnUsage(accountingKey: string): void {
    this.costBuckets.set(accountingKey, {
      costUsd: 0,
      requestCount: 0,
      generationIds: [],
      unavailableReasons: [],
      hasCost: false,
    });
  }

  consumeTurnUsage(accountingKey: string): RouterTurnUsage | undefined {
    const bucket = this.costBuckets.get(accountingKey);
    this.costBuckets.delete(accountingKey);
    if (!bucket || bucket.requestCount === 0) {
      return undefined;
    }
    return {
      costUsd: bucket.hasCost ? bucket.costUsd : undefined,
      generationId: bucket.generationIds.join(",") || undefined,
      costUnavailableReason: bucket.unavailableReasons.join("; ") || undefined,
      requestCount: bucket.requestCount,
    };
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }
    this.server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    this.server.on("clientError", (_error, socket) => {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    });
    this.port = await listen(this.server, this.options.preferredPort);
  }

  dispose(): void {
    this.server?.close();
    this.server = undefined;
    this.port = 0;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const abortController = new AbortController();
    const abortUpstream = () => abortController.abort();
    req.once("aborted", abortUpstream);
    res.once("close", abortUpstream);
    try {
      const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
      if (req.method === "GET" && pathname === "/health") {
        sendJson(res, 200, {
          ok: true,
          router: "agentparty-harness-protocol",
          harness: "claude-code",
          protocol: CLAUDE_PROTOCOL.id,
          openRouterConfigured: Boolean(this.openRouterApiKey()),
          subscriptionProxyConfigured: Boolean(this.subscriptionProxy().apiKey),
          subscriptionProxyBaseUrl: this.subscriptionProxy().baseUrl,
          requestCount: this.requestCount,
          lastRoute: this.lastRoute,
        });
        return;
      }
      if (req.method !== "POST" || pathname !== `/v1/${CLAUDE_PROTOCOL.endpoint}`) {
        sendJson(res, 404, {
          error: {
            type: "not_found",
            message: `AgentParty's Claude Code gateway only implements POST /v1/${CLAUDE_PROTOCOL.endpoint}.`,
          },
        });
        return;
      }
      const expected = this.options.authToken || "dummy";
      const actual = clientAuthToken(req);
      if (expected && actual && actual !== expected && !actual.startsWith("agentparty-native-session:")) {
        sendJson(res, 401, { error: { type: "authentication_error", message: "Invalid AgentParty harness gateway token." } });
        return;
      }
      const accountingKey = actual || expected;
      const body = await readJson(req);
      const route = await this.forward(body, req.headers, abortController.signal);
      await this.relay(route, res, accountingKey, abortController.signal);
    } catch (error) {
      if (isAbortError(error) && (req.destroyed || res.destroyed || abortController.signal.aborted)) {
        return;
      }
      if (!res.headersSent && !res.destroyed) {
        sendJson(res, 500, { error: { type: "api_error", message: error instanceof Error ? error.message : String(error) } });
      } else if (!res.destroyed) {
        res.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      req.off("aborted", abortUpstream);
      res.off("close", abortUpstream);
    }
  }

  private async forward(body: any, incomingHeaders: http.IncomingHttpHeaders, signal: AbortSignal): Promise<UpstreamRoute> {
    const requestedModel = String(body.model || process.env.ANTHROPIC_CUSTOM_MODEL_OPTION || "");
    const target = routerTargetForModel(requestedModel);
    if (!target) {
      throw new Error(`No explicit AgentParty provider target for '${requestedModel}'. Refusing to guess or fall back.`);
    }
    this.requestCount += 1;
    this.lastRoute = {
      protocol: CLAUDE_PROTOCOL.id,
      targetKind: target.kind,
      targetModel: target.model,
      upstreamEndpoint: CLAUDE_PROTOCOL.endpoint,
    };
    return target.kind === "codex-subscription"
      ? this.forwardToCodexSubscription(body, incomingHeaders, target, signal)
      : this.forwardToOpenRouter(body, incomingHeaders, target, signal);
  }

  private async forwardToCodexSubscription(
    body: any,
    incomingHeaders: http.IncomingHttpHeaders,
    target: RouterTarget & { kind: "codex-subscription" },
    signal: AbortSignal,
  ): Promise<UpstreamRoute> {
    const config = this.subscriptionProxy();
    await assertSubscriptionModelAvailable(target.model, "codex", config);
    const response = await fetch(apiEndpoint(config.baseUrl, CLAUDE_PROTOCOL.endpoint), {
      method: "POST",
      headers: anthropicUpstreamHeaders(incomingHeaders, config.apiKey),
      body: JSON.stringify(rewriteAnthropicRequestModel(body, target.model)),
      signal,
    });
    return { response, openRouter: false };
  }

  private async forwardToOpenRouter(
    body: any,
    incomingHeaders: http.IncomingHttpHeaders,
    target: RouterTarget & { kind: "openrouter" },
    signal: AbortSignal,
  ): Promise<UpstreamRoute> {
    const apiKey = this.openRouterApiKey();
    if (!apiKey) {
      throw new Error("OPENROUTER_API_KEY is not configured. Open AgentParty Authentication and connect OpenRouter. No fallback was attempted.");
    }
    const response = await fetch(apiEndpoint(this.options.openRouterBaseUrl || DEFAULT_OPENROUTER_BASE_URL, CLAUDE_PROTOCOL.endpoint), {
      method: "POST",
      headers: anthropicUpstreamHeaders(incomingHeaders, apiKey, {
        "HTTP-Referer": "https://agentparty-native.local",
        "X-OpenRouter-Title": "AgentParty Native",
        "X-OpenRouter-Metadata": "enabled",
      }),
      body: JSON.stringify(rewriteAnthropicRequestModel(body, target.model)),
      signal,
    });
    return { response, openRouter: true };
  }

  private async relay(route: UpstreamRoute, res: http.ServerResponse, accountingKey: string, signal: AbortSignal): Promise<void> {
    const { response } = route;
    res.writeHead(response.status, relayHeaders(response.headers));
    if (!response.body) {
      res.end();
      return;
    }

    const reader = response.body.getReader();
    const captured: Buffer[] = [];
    let capturedBytes = 0;
    while (true) {
      if (signal.aborted) {
        await reader.cancel();
        throw abortError();
      }
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const chunk = Buffer.from(value);
      if (capturedBytes < MAX_ACCOUNTING_CAPTURE_BYTES) {
        const remaining = MAX_ACCOUNTING_CAPTURE_BYTES - capturedBytes;
        captured.push(chunk.subarray(0, remaining));
        capturedBytes += Math.min(chunk.length, remaining);
      }
      if (!res.write(chunk)) {
        await waitForDrain(res, signal);
      }
    }

    if (route.openRouter) {
      await this.recordOpenRouterCost(accountingKey, Buffer.concat(captured).toString("utf8"));
    }
    res.end();
  }

  private openRouterApiKey(): string {
    return this.options.openRouterApiKey || process.env.OPENROUTER_API_KEY || "";
  }

  private subscriptionProxy() {
    return subscriptionProxyConfig({
      baseUrl: this.options.subscriptionProxyBaseUrl,
      apiKey: this.options.subscriptionProxyApiKey,
    });
  }

  private async recordOpenRouterCost(accountingKey: string, responseText: string): Promise<void> {
    const bucket = this.costBuckets.get(accountingKey);
    if (!bucket) {
      return;
    }
    bucket.requestCount += 1;
    const payload = parseResponsePayload(responseText);
    const generationId = responseGenerationId(payload, responseText);
    if (generationId) {
      bucket.generationIds.push(generationId);
    }
    const directCost = numberValue(payload?.usage?.cost)
      ?? numberValue(payload?.openrouter_metadata?.cost)
      ?? numberValue(payload?.openrouter_metadata?.total_cost);
    if (typeof directCost === "number") {
      bucket.costUsd += directCost;
      bucket.hasCost = true;
      return;
    }
    const stats = await fetchOpenRouterGenerationStats(this.openRouterApiKey(), generationId);
    if (typeof stats.cost === "number") {
      bucket.costUsd += stats.cost;
      bucket.hasCost = true;
    } else if (stats.costUnavailableReason) {
      bucket.unavailableReasons.push(stats.costUnavailableReason);
    }
  }
}

/**
 * The only legal body change at the Claude Code gateway: choose the concrete
 * provider model. All Anthropic content/tool/control fields remain untouched.
 * Explicit multi-model fallback fields are removed because AgentParty promises
 * never to select an unrequested model.
 */
export function rewriteAnthropicRequestModel(body: any, targetModel: string): any {
  const rewritten = { ...body, model: targetModel };
  delete rewritten.models;
  delete rewritten.fallbacks;
  return rewritten;
}

function anthropicUpstreamHeaders(
  incoming: http.IncomingHttpHeaders,
  apiKey: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "x-api-key": apiKey,
    "Content-Type": "application/json",
    ...extra,
  };
  for (const name of ["anthropic-version", "anthropic-beta"]) {
    const value = incoming[name];
    if (typeof value === "string" && value) {
      headers[name] = value;
    }
  }
  return headers;
}

function relayHeaders(headers: Headers): Record<string, string> {
  const relayed: Record<string, string> = {};
  for (const name of [
    "content-type",
    "cache-control",
    "x-request-id",
    "request-id",
    "anthropic-ratelimit-requests-limit",
    "anthropic-ratelimit-requests-remaining",
    "anthropic-ratelimit-requests-reset",
    "anthropic-ratelimit-tokens-limit",
    "anthropic-ratelimit-tokens-remaining",
    "anthropic-ratelimit-tokens-reset",
  ]) {
    const value = headers.get(name);
    if (value) {
      relayed[name] = value;
    }
  }
  return relayed;
}

function clientAuthToken(req: http.IncomingMessage): string {
  const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const apiKey = typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"] : "";
  return bearer || apiKey;
}

function apiEndpoint(baseUrl: string, endpoint: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${endpoint.replace(/^\/+/, "")}`;
}

function parseResponsePayload(text: string): any {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    const events = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter((line) => line && line !== "[DONE]");
    for (let index = events.length - 1; index >= 0; index -= 1) {
      try {
        const event = JSON.parse(events[index]);
        if (event?.openrouter_metadata || event?.message?.openrouter_metadata) {
          return event?.message || event;
        }
      } catch {
        // Keep scanning earlier native SSE events.
      }
    }
    return {};
  }
}

function responseGenerationId(payload: any, text: string): string | undefined {
  const direct = payload?.openrouter_metadata?.generation_id
    || payload?.generation_id
    || payload?.id
    || payload?.message?.openrouter_metadata?.generation_id
    || payload?.message?.id;
  if (direct) {
    return String(direct);
  }
  const metadata = /"generation_id"\s*:\s*"([^"]+)"/.exec(text);
  if (metadata?.[1]) {
    return metadata[1];
  }
  const message = /"id"\s*:\s*"((?:gen|msg)[-_][^"]+)"/.exec(text);
  return message?.[1];
}

async function fetchOpenRouterGenerationStats(
  apiKey: string,
  generationId: string | undefined,
): Promise<{ cost?: number; costUnavailableReason?: string }> {
  if (!generationId) {
    return { costUnavailableReason: "OpenRouter response did not include a generation id." };
  }
  let lastReason = "";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (attempt > 0) {
      await delay(400 * attempt);
    }
    try {
      const response = await fetch(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(generationId)}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!response.ok) {
        lastReason = `OpenRouter generation stats returned ${response.status}.`;
        continue;
      }
      const payload = await response.json();
      const data = payload?.data || payload;
      const cost = numberValue(data?.total_cost) ?? numberValue(data?.cost) ?? numberValue(data?.usage?.cost);
      if (typeof cost === "number") {
        return { cost };
      }
      lastReason = "OpenRouter generation stats did not include total_cost/cost.";
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error);
    }
  }
  return { costUnavailableReason: lastReason || "OpenRouter generation stats cost unavailable." };
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function readJson(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function listen(server: http.Server, preferredPort: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off("error", onError);
      if (error.code === "EADDRINUSE" && preferredPort !== 0) {
        server.listen(0, "127.0.0.1");
        return;
      }
      reject(error);
    };
    server.once("error", onError);
    server.on("listening", () => {
      server.off("error", onError);
      const address = server.address() as net.AddressInfo;
      resolve(address.port);
    });
    server.listen(preferredPort, "127.0.0.1");
  });
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function abortError(): Error {
  const error = new Error("Harness request interrupted by client.");
  error.name = "AbortError";
  return error;
}

function waitForDrain(res: http.ServerResponse, signal: AbortSignal): Promise<void> {
  if (signal.aborted || res.destroyed) {
    return Promise.reject(abortError());
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      res.off("drain", onDrain);
      res.off("close", onClose);
      res.off("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(abortError());
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    res.once("drain", onDrain);
    res.once("close", onClose);
    res.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
