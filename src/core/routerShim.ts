import * as crypto from "node:crypto";
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEEPSEEK_ANTHROPIC_BASE_URL, DEEPSEEK_API_KEY_ENV } from "../shared/deepseekDefaults";
import { HARNESS_PROTOCOLS } from "../shared/harnessProtocols";
import { routerTargetForModel, type RouterTarget } from "../shared/modelCatalog";
import { CursorHarnessBridge } from "./cursorHarnessBridge";
import { GrokSubscriptionAuthError, grokSubscriptionToken } from "./grokSubscriptionAuth";
import { createXaiSseFilter, normalizeAnthropicRequestForXai, stripThinkingFromAnthropicResponse } from "./xaiRequestCompat";
import { assertSubscriptionModelAvailable, subscriptionProxyConfig } from "./subscriptionProxy";

const CLAUDE_PROTOCOL = HARNESS_PROTOCOLS["claude-code"];
const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
/** xAI's Anthropic-compatible surface; the caller appends /v1/messages. */
const DEFAULT_XAI_BASE_URL = "https://api.x.ai/v1";
const MAX_ACCOUNTING_CAPTURE_BYTES = 256 * 1024;

export interface EmbeddedHarnessRouterOptions {
  preferredPort: number;
  openRouterApiKey?: string;
  /** Override exists for protocol-contract QA; production uses OpenRouter. */
  openRouterBaseUrl?: string;
  deepseekApiKey?: string;
  /** Override exists for protocol-contract QA; production uses DeepSeek. */
  deepseekAnthropicBaseUrl?: string;
  /** Override exists for protocol-contract QA; production uses api.x.ai. */
  xaiBaseUrl?: string;
  subscriptionProxyBaseUrl?: string;
  subscriptionProxyApiKey?: string;
  authToken: string;
  /** Enables the Cursor-subscription ACP bridge (cursor-provider catalog models). */
  cursorBridge?: {
    /** Absolute path to scripts/agentparty-acp-mcp-relay.mjs (or its packaged copy). */
    relayScriptPath: string;
    /** Directory for the bridge's isolated per-conversation ACP workspaces. */
    workspacesDir: string;
    cursorExecutablePath?: () => string | undefined;
  };
}

export interface RouterTurnUsage {
  costUsd?: number;
  generationId?: string;
  costUnavailableReason?: string;
  requestCount: number;
  /**
   * Tokens summed from the upstream responses this turn actually made.
   *
   * Claude Code reports its own `result.usage`, but for a router-backed model
   * it reports ZEROS — a Grok turn landed in the ledger as 0 in / 0 out while
   * really costing ~100k input tokens per request, so the usage dashboard and
   * the context meter told the user nothing and a subscription drained
   * invisibly. The gateway is the one place that sees the true numbers, so it
   * measures them here and the adapter prefers them when the harness reports
   * nothing.
   */
  tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

interface CostBucket {
  costUsd: number;
  requestCount: number;
  generationIds: string[];
  unavailableReasons: string[];
  hasCost: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  hasTokens: boolean;
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
  private cursorBridge: CursorHarnessBridge | undefined;
  private readonly cursorBridgeToken = crypto.randomBytes(24).toString("hex");
  private oneshotSeq = 0;
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
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      hasTokens: false,
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
      tokens: bucket.hasTokens
        ? {
            input: bucket.inputTokens,
            output: bucket.outputTokens,
            cacheRead: bucket.cacheReadTokens,
            cacheWrite: bucket.cacheWriteTokens,
          }
        : undefined,
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
    this.cursorBridge?.dispose();
    this.cursorBridge = undefined;
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
      if (req.method === "POST" && pathname.startsWith("/acp-bridge/")) {
        // Loopback callback surface for the bridge's relay MCP stubs. Guarded
        // by the per-process bridge token, never the harness gateway token.
        const bridge = this.cursorBridge;
        if (!bridge) {
          sendJson(res, 404, { error: { type: "not_found", message: "The Cursor ACP bridge is not active in this router." } });
          return;
        }
        const outcome = await bridge.handleRelay(pathname, clientAuthToken(req), await readJson(req));
        sendJson(res, outcome.status, outcome.body);
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
      const route = await this.forward(body, req.headers, abortController.signal, accountingKey);
      await this.relay(route, res, accountingKey, abortController.signal);
    } catch (error) {
      if (isAbortError(error) && (req.destroyed || res.destroyed || abortController.signal.aborted)) {
        return;
      }
      if (!res.headersSent && !res.destroyed) {
        // A missing or expired provider credential must reach the user with the
        // one instruction that fixes it (`grok login`). Measured on a WSL engine
        // whose distro has no ~/.grok:
        //   500 → the Anthropic SDK retries with backoff and the member sits at
        //         "requesting" forever, showing nothing;
        //   401 → Claude Code swallows the body and reports
        //         "API Error: 400 status code (no body)";
        //   400 → the body is surfaced verbatim in the transcript.
        // So the actionable failure goes out as 400 even though the cause is
        // authentication. Status semantics lose to the user actually seeing it.
        const authFailure = error instanceof GrokSubscriptionAuthError;
        sendJson(res, authFailure ? 400 : 500, {
          error: {
            type: authFailure ? "invalid_request_error" : "api_error",
            message: error instanceof Error ? error.message : String(error),
          },
        });
      } else if (!res.destroyed) {
        res.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      req.off("aborted", abortUpstream);
      res.off("close", abortUpstream);
    }
  }

  private async forward(body: any, incomingHeaders: http.IncomingHttpHeaders, signal: AbortSignal, accountingKey: string): Promise<UpstreamRoute> {
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
    if (target.kind === "cursor-subscription") {
      return this.forwardToCursorBridge(body, target, accountingKey);
    }
    if (target.kind === "deepseek") {
      return this.forwardToDeepSeek(body, incomingHeaders, target, signal);
    }
    if (target.kind === "xai-subscription") {
      return this.forwardToXai(body, incomingHeaders, target, signal);
    }
    return target.kind === "codex-subscription"
      ? this.forwardToCodexSubscription(body, incomingHeaders, target, signal)
      : this.forwardToOpenRouter(body, incomingHeaders, target, signal);
  }

  private async forwardToCursorBridge(
    body: any,
    target: RouterTarget & { kind: "cursor-subscription" },
    accountingKey: string,
  ): Promise<UpstreamRoute> {
    const config = this.options.cursorBridge;
    if (!config) {
      throw new Error(
        "This model needs the Cursor ACP bridge, which is not configured in this router. No fallback was attempted.",
      );
    }
    if (!this.cursorBridge) {
      this.cursorBridge = new CursorHarnessBridge({
        relayScriptPath: config.relayScriptPath,
        bridgeToken: this.cursorBridgeToken,
        routerBaseUrl: () => this.baseUrl,
        cursorExecutablePath: config.cursorExecutablePath,
        workspacesDir: config.workspacesDir,
      });
    }
    // Harness sessions carry a stable per-session token — the bridge keys its
    // warm ACP session (and tool round-trip state) on it. Anything else (gate
    // reviewer, ad-hoc callers) is a stateless one-shot conversation.
    const conversationKey = accountingKey.startsWith("agentparty-native-session:")
      ? accountingKey
      : `oneshot-${(this.oneshotSeq += 1)}`;
    const response = await this.cursorBridge.handleMessages(conversationKey, target.model, body);
    return { response, openRouter: false };
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

  /**
   * DeepSeek's own Anthropic-format endpoint. It speaks the same Messages
   * contract this gateway already carries, so the body passes through with only
   * the model rewritten — no translation, same as the OpenRouter leg.
   *
   * The documented base is `.../anthropic` and the caller appends `/v1/messages`,
   * so the version segment is added here rather than baked into the constant.
   * Auth is `x-api-key`, which anthropicUpstreamHeaders already sends.
   */
  private async forwardToDeepSeek(
    body: any,
    incomingHeaders: http.IncomingHttpHeaders,
    target: RouterTarget & { kind: "deepseek" },
    signal: AbortSignal,
  ): Promise<UpstreamRoute> {
    const apiKey = this.deepseekApiKey();
    if (!apiKey) {
      throw new Error(
        `${DEEPSEEK_API_KEY_ENV} is not configured. Open AgentParty Authentication and connect DeepSeek. No fallback was attempted.`,
      );
    }
    const base = `${(this.options.deepseekAnthropicBaseUrl || DEEPSEEK_ANTHROPIC_BASE_URL).replace(/\/+$/, "")}/v1`;
    const response = await fetch(apiEndpoint(base, CLAUDE_PROTOCOL.endpoint), {
      method: "POST",
      headers: anthropicUpstreamHeaders(incomingHeaders, apiKey),
      body: JSON.stringify(rewriteAnthropicRequestModel(body, target.model)),
      signal,
    });
    return { response, openRouter: false };
  }

  /**
   * xAI's own Anthropic-format endpoint, billed to the user's Grok
   * subscription via the token `grok login` stored. Same pass-through shape as
   * the DeepSeek leg — api.x.ai speaks Messages natively, so only the model is
   * rewritten.
   *
   * Effort and service-tier are NOT forwarded: measured 2026-08-10, this
   * surface accepts and discards both (it 200s on `service_tier: "fast"`, an
   * enum value its own OpenAI surface rejects). Catalog entries pin them for
   * the same reason, so there is nothing here to strip.
   */
  private async forwardToXai(
    body: any,
    incomingHeaders: http.IncomingHttpHeaders,
    target: RouterTarget & { kind: "xai-subscription" },
    signal: AbortSignal,
  ): Promise<UpstreamRoute> {
    const credential = grokSubscriptionToken();
    const payload = JSON.stringify(normalizeAnthropicRequestForXai(rewriteAnthropicRequestModel(body, target.model)));
    const response = await fetch(apiEndpoint(this.options.xaiBaseUrl || DEFAULT_XAI_BASE_URL, CLAUDE_PROTOCOL.endpoint), {
      method: "POST",
      headers: anthropicUpstreamHeaders(incomingHeaders, credential.accessToken),
      body: payload,
      signal,
    });
    if (response.status >= 400 && process.env.AGENTPARTY_ROUTER_DUMP) {
      // An upstream 4xx here means xAI rejected the harness's request SHAPE, and
      // the error text alone ("Invalid message role") does not say which field.
      // Opt-in so a normal run never writes conversation content to disk.
      const dump = path.join(os.tmpdir(), `agentparty-xai-reject-${Date.now()}.json`);
      const cloned = response.clone();
      fs.writeFileSync(dump, JSON.stringify({ status: response.status, upstream: await cloned.text(), request: JSON.parse(payload) }, null, 1));
      console.error(`[router:xai] upstream ${response.status}; request dumped to ${dump}`);
    }
    return { response: response.ok ? filterXaiThinking(response) : response, openRouter: false };
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

    const capturedText = Buffer.concat(captured).toString("utf8");
    this.recordUpstreamTokens(accountingKey, capturedText);
    if (route.openRouter) {
      await this.recordOpenRouterCost(accountingKey, capturedText);
    }
    res.end();
  }

  private openRouterApiKey(): string {
    return this.options.openRouterApiKey || process.env.OPENROUTER_API_KEY || "";
  }

  private deepseekApiKey(): string {
    return this.options.deepseekApiKey || process.env[DEEPSEEK_API_KEY_ENV] || "";
  }

  private subscriptionProxy() {
    return subscriptionProxyConfig({
      baseUrl: this.options.subscriptionProxyBaseUrl,
      apiKey: this.options.subscriptionProxyApiKey,
    });
  }

  /**
   * Sums the Anthropic `usage` numbers out of one upstream response, streamed
   * or not. Input/cache counts arrive on `message_start` and the output count
   * on `message_delta`, so both are scanned; a non-streaming body carries them
   * together on `usage`.
   */
  private recordUpstreamTokens(accountingKey: string, responseText: string): void {
    const bucket = this.costBuckets.get(accountingKey);
    if (!bucket || !responseText) {
      return;
    }
    bucket.requestCount += 1;
    const add = (usage: Record<string, unknown> | undefined) => {
      if (!usage) {
        return;
      }
      const input = numberValue(usage.input_tokens) ?? 0;
      const output = numberValue(usage.output_tokens) ?? 0;
      const cacheRead = numberValue(usage.cache_read_input_tokens) ?? 0;
      const cacheWrite = numberValue(usage.cache_creation_input_tokens) ?? 0;
      if (input || output || cacheRead || cacheWrite) {
        bucket.inputTokens += input;
        bucket.outputTokens += output;
        bucket.cacheReadTokens += cacheRead;
        bucket.cacheWriteTokens += cacheWrite;
        bucket.hasTokens = true;
      }
    };
    if (responseText.includes("data:")) {
      for (const line of responseText.split("\n")) {
        if (!line.startsWith("data:")) {
          continue;
        }
        let event: any;
        try {
          event = JSON.parse(line.slice(5).trim());
        } catch {
          continue;
        }
        add(asRecord(event?.message?.usage) || asRecord(event?.usage));
      }
      return;
    }
    add(asRecord(parseResponsePayload(responseText)?.usage));
  }

  private async recordOpenRouterCost(accountingKey: string, responseText: string): Promise<void> {
    const bucket = this.costBuckets.get(accountingKey);
    if (!bucket) {
      return;
    }
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
      relayed[name] = name === "content-type" && /^application\/json(?:\s*;|$)/i.test(value) && !/charset=/i.test(value)
        ? `${value}; charset=utf-8`
        : value;
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
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function readJson(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
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

/**
 * Removes xAI's unsigned `thinking` blocks from a response, in both shapes the
 * gateway can carry. See xaiRequestCompat for why they cannot be forwarded.
 */
function filterXaiThinking(response: Response): Response {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/event-stream")) {
    const rewritten = response
      .clone()
      .json()
      .then((body) => JSON.stringify(stripThinkingFromAnthropicResponse(body as Record<string, unknown>)))
      .catch(() => response.clone().text());
    return new Response(
      new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode(await rewritten));
          controller.close();
        },
      }),
      { status: response.status, statusText: response.statusText, headers: response.headers },
    );
  }

  const filter = createXaiSseFilter();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = response.body?.getReader();
      if (!reader) {
        controller.close();
        return;
      }
      const flush = (chunk: string) => {
        // One SSE frame: optional "event:" line plus a "data:" line. Frames the
        // filter rejects are dropped whole so no half-event reaches the client.
        const dataLine = chunk.split("\n").find((line) => line.startsWith("data:"));
        if (!dataLine) {
          controller.enqueue(encoder.encode(chunk + "\n\n"));
          return;
        }
        let parsed: Record<string, unknown> | undefined;
        try {
          parsed = JSON.parse(dataLine.slice(5).trim());
        } catch {
          controller.enqueue(encoder.encode(chunk + "\n\n"));
          return;
        }
        const kept = filter(parsed as Record<string, unknown>);
        if (!kept) {
          return;
        }
        controller.enqueue(encoder.encode(`event: ${String(kept.type)}\ndata: ${JSON.stringify(kept)}\n\n`));
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          flush(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");
        }
      }
      if (buffer.trim()) {
        flush(buffer.trim());
      }
      controller.close();
    },
  });
  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
