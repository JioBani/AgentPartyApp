import * as http from "node:http";
import * as net from "node:net";
import { routerTargetForModel, type RouterTarget } from "../shared/modelCatalog";
import { assertSubscriptionModelAvailable, subscriptionProxyConfig } from "./subscriptionProxy";

export interface EmbeddedRouterOptions {
  preferredPort: number;
  openRouterApiKey?: string;
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

class RouterUpstreamError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RouterUpstreamError";
  }
}

export class EmbeddedRouter {
  private server: http.Server | undefined;
  private port = 0;
  private options: EmbeddedRouterOptions;
  private readonly costBuckets = new Map<string, CostBucket>();

  constructor(options: EmbeddedRouterOptions) {
    this.options = options;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port || this.options.preferredPort}`;
  }

  updateOptions(options: Partial<EmbeddedRouterOptions>): void {
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
    try {
      if (req.method === "GET" && req.url === "/health") {
        sendJson(res, 200, {
          ok: true,
          router: "agentparty-native",
          openRouterConfigured: Boolean(this.openRouterApiKey()),
          subscriptionProxyConfigured: Boolean(this.subscriptionProxy().apiKey),
          subscriptionProxyBaseUrl: this.subscriptionProxy().baseUrl,
        });
        return;
      }
      if (req.method !== "POST" || !req.url?.startsWith("/v1/messages")) {
        sendJson(res, 404, { error: { type: "not_found", message: "AgentParty Native router only implements POST /v1/messages." } });
        return;
      }
      const expected = this.options.authToken || "dummy";
      const actual = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      if (expected && actual && actual !== expected && !actual.startsWith("agentparty-native-session:")) {
        sendJson(res, 401, { error: { type: "authentication_error", message: "Invalid AgentParty Native router token." } });
        return;
      }
      const accountingKey = actual || expected;
      const body = await readJson(req);
      const response = await this.forward(body, accountingKey);
      if (body.stream) {
        sendAnthropicSse(res, response);
      } else {
        sendJson(res, 200, response);
      }
    } catch (error) {
      const status = error instanceof RouterUpstreamError ? error.status : 500;
      sendJson(res, status, { error: { type: "api_error", message: error instanceof Error ? error.message : String(error) } });
    }
  }

  private async forward(body: any, accountingKey: string): Promise<any> {
    const requestedModel = String(body.model || process.env.ANTHROPIC_CUSTOM_MODEL_OPTION || "");
    const target = routerTargetForModel(requestedModel);
    if (!target) {
      throw new Error(`No explicit AgentParty router target for '${requestedModel}'. Refusing to guess or fall back.`);
    }
    return target.kind === "codex-subscription"
      ? this.forwardToCodexSubscription(body, requestedModel, target)
      : this.forwardToOpenRouter(body, accountingKey, requestedModel, target);
  }

  private async forwardToCodexSubscription(body: any, requestedModel: string, target: RouterTarget & { kind: "codex-subscription" }): Promise<any> {
    const config = this.subscriptionProxy();
    await assertSubscriptionModelAvailable(target.model, "codex", config);
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: target.model,
        messages: toOpenAiMessages(body),
        tools: Array.isArray(body.tools) ? body.tools.map(toOpenAiTool) : undefined,
        tool_choice: toOpenAiToolChoice(body.tool_choice),
        temperature: body.temperature,
        max_tokens: body.max_tokens,
        reasoning_effort: toCodexReasoningEffort(body),
        stream: false,
      }),
    });
    const payload = await readUpstreamPayload(response);
    if (!response.ok) {
      throw new RouterUpstreamError(
        response.status,
        `Codex subscription request failed (${response.status}): ${payload?.error?.message || JSON.stringify(payload)}`,
      );
    }
    return toAnthropicMessage(payload, requestedModel);
  }

  private async forwardToOpenRouter(
    body: any,
    accountingKey: string,
    requestedModel: string,
    target: RouterTarget & { kind: "openrouter" },
  ): Promise<any> {
    const apiKey = this.openRouterApiKey();
    if (!apiKey) {
      throw new Error("OPENROUTER_API_KEY is not configured. Set agentpartyNative.router.openRouterApiKey or the OPENROUTER_API_KEY environment variable.");
    }

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://agentparty-native.local",
        "X-Title": "AgentParty Native",
      },
      body: JSON.stringify({
        model: target.model,
        messages: toOpenAiMessages(body),
        tools: Array.isArray(body.tools) ? body.tools.map(toOpenAiTool) : undefined,
        tool_choice: toOpenAiToolChoice(body.tool_choice),
        temperature: body.temperature,
        max_tokens: body.max_tokens,
        reasoning: toOpenRouterReasoning(body),
        stream: false,
      }),
    });
    const payload = await readUpstreamPayload(response);
    if (!response.ok) {
      throw new RouterUpstreamError(
        response.status,
        `OpenRouter request failed (${response.status}): ${payload?.error?.message || JSON.stringify(payload)}`,
      );
    }
    payload.__openrouter = await fetchOpenRouterGenerationStats(apiKey, payload.id);
    this.recordOpenRouterCost(accountingKey, payload);
    return toAnthropicMessage(payload, requestedModel);
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

  private recordOpenRouterCost(accountingKey: string, payload: any): void {
    const bucket = this.costBuckets.get(accountingKey);
    if (!bucket) {
      return;
    }
    bucket.requestCount += 1;
    if (payload.id) {
      bucket.generationIds.push(String(payload.id));
    }
    const cost = numberValue(payload.usage?.cost) ?? numberValue(payload.__openrouter?.cost);
    if (typeof cost === "number") {
      bucket.costUsd += cost;
      bucket.hasCost = true;
      return;
    }
    if (payload.__openrouter?.costUnavailableReason) {
      bucket.unavailableReasons.push(String(payload.__openrouter.costUnavailableReason));
    }
  }
}

/**
 * Translates the reasoning intent the Claude Code harness forwards
 * (`output_config.effort` + `thinking`) into OpenRouter's unified `reasoning`
 * parameter, which OpenRouter normalizes to each provider's native control
 * (reasoning_effort, thinking, thinking_level, etc.). Without this the harness's
 * effort/thinking selection is silently dropped for router-backed models.
 */
function toOpenRouterReasoning(body: any): Record<string, unknown> | undefined {
  const thinkingType = body?.thinking?.type;
  const budget = numberValue(body?.thinking?.budget_tokens) ?? numberValue(body?.thinking?.budgetTokens);
  const effort = typeof body?.output_config?.effort === "string" ? body.output_config.effort : undefined;

  if (thinkingType === "disabled") {
    return { enabled: false, exclude: true };
  }
  const reasoning: Record<string, unknown> = {};
  if (budget != null) {
    reasoning.max_tokens = budget;
  } else if (effort) {
    const mapped = mapEffortToOpenRouter(effort);
    if (mapped) {
      reasoning.effort = mapped;
    }
  }
  if (Object.keys(reasoning).length === 0) {
    return thinkingType === "enabled" ? { enabled: true } : undefined;
  }
  return reasoning;
}

/** Claude Code effort -> OpenAI/Codex chat-completions reasoning effort. */
function toCodexReasoningEffort(body: any): string | undefined {
  const effort = typeof body?.output_config?.effort === "string" ? body.output_config.effort : undefined;
  if (!effort || effort === "none") {
    return undefined;
  }
  return effort === "max" ? "high" : effort;
}

/** OpenRouter accepts minimal|low|medium|high; clamp the harness's wider scale. */
function mapEffortToOpenRouter(effort: string): string | undefined {
  switch (effort) {
    case "none":
      return undefined;
    case "minimal":
      return "minimal";
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
    case "xhigh":
    case "max":
      return "high";
    default:
      return undefined;
  }
}

/** Exported for QA: Anthropic request body -> OpenAI chat messages (incl. images). */
export function toOpenAiMessages(body: any): any[] {
  const messages: any[] = [];
  if (body.system) {
    messages.push({ role: "system", content: contentToText(body.system) });
  }
  for (const message of body.messages || []) {
    const converted = toOpenAiMessage(message);
    if (Array.isArray(converted)) {
      messages.push(...converted);
    } else {
      messages.push(converted);
    }
  }
  return messages;
}

function toOpenAiMessage(message: any): any | any[] {
  const role = message.role === "assistant" ? "assistant" : "user";
  if (!Array.isArray(message.content)) {
    return { role, content: String(message.content || "") };
  }
  const toolResults = message.content.filter((block: any) => block?.type === "tool_result");
  if (toolResults.length) {
    return toolResults.map((block: any) => ({
      role: "tool",
      tool_call_id: block.tool_use_id,
      content: contentToText(block.content),
    }));
  }
  const toolUses = message.content.filter((block: any) => block?.type === "tool_use");
  if (toolUses.length) {
    return {
      role: "assistant",
      content: contentToText(message.content.filter((block: any) => block?.type !== "tool_use")),
      tool_calls: toolUses.map((block: any) => ({
        id: block.id,
        type: "function",
        function: { name: block.name, arguments: JSON.stringify(block.input || {}) },
      })),
    };
  }
  return { role, content: contentToOpenAiParts(message.content) };
}

/**
 * Converts Anthropic content blocks to an OpenAI message `content`. Plain text
 * collapses to a string; when image blocks are present it becomes a multimodal
 * parts array ({type:"text"} + {type:"image_url"}). This is the vision path: it
 * MUST NOT drop image blocks (the old text-only collapse silently lost them).
 */
function contentToOpenAiParts(content: any): string | any[] {
  if (!Array.isArray(content)) {
    return contentToText(content);
  }
  if (!content.some((block) => block?.type === "image")) {
    return contentToText(content);
  }
  const parts: any[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      if (block) parts.push({ type: "text", text: block });
    } else if (block?.type === "text") {
      if (block.text) parts.push({ type: "text", text: block.text });
    } else if (block?.type === "image") {
      const url = imageBlockToUrl(block);
      if (url) parts.push({ type: "image_url", image_url: { url } });
    }
  }
  return parts.length ? parts : "";
}

/** Anthropic image block -> a URL usable in OpenAI `image_url` (data: or remote). */
function imageBlockToUrl(block: any): string | undefined {
  const source = block?.source;
  if (!source) {
    return undefined;
  }
  if (source.type === "base64" && source.data) {
    return `data:${source.media_type || "image/png"};base64,${source.data}`;
  }
  if (source.type === "url" && source.url) {
    return String(source.url);
  }
  return undefined;
}

function contentToText(content: any): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return content == null ? "" : String(content);
  }
  return content
    .map((block) => {
      if (typeof block === "string") {
        return block;
      }
      if (block?.type === "text") {
        return block.text || "";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function toOpenAiTool(tool: any): any {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema || { type: "object", properties: {} },
    },
  };
}

function toOpenAiToolChoice(choice: any): any {
  if (!choice || choice.type === "auto") {
    return "auto";
  }
  if (choice.type === "any") {
    return "required";
  }
  if (choice.type === "tool") {
    return { type: "function", function: { name: choice.name } };
  }
  return undefined;
}

function toAnthropicMessage(payload: any, requestedModel: string): any {
  const choice = payload.choices?.[0];
  const message = choice?.message || {};
  const content: any[] = [];
  const cost = numberValue(payload.usage?.cost) ?? numberValue(payload.__openrouter?.cost);
  if (message.content) {
    content.push({ type: "text", text: message.content });
  }
  for (const toolCall of message.tool_calls || []) {
    content.push({
      type: "tool_use",
      id: toolCall.id,
      name: toolCall.function?.name,
      input: parseJson(toolCall.function?.arguments) || {},
    });
  }
  return {
    id: payload.id || `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: requestedModel,
    content,
    stop_reason: toAnthropicStopReason(choice?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: payload.usage?.prompt_tokens || 0,
      output_tokens: payload.usage?.completion_tokens || 0,
      cost,
      generation_id: payload.id,
      cost_unavailable_reason: typeof cost === "number" ? undefined : payload.__openrouter?.costUnavailableReason,
    },
  };
}

async function fetchOpenRouterGenerationStats(apiKey: string, generationId: string | undefined): Promise<{ cost?: number; costUnavailableReason?: string }> {
  if (!generationId) {
    return { costUnavailableReason: "OpenRouter response did not include a generation id." };
  }
  let lastReason = "";
  for (let attempt = 0; attempt < 4; attempt++) {
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

function toAnthropicStopReason(reason: string | undefined): string {
  if (reason === "tool_calls") {
    return "tool_use";
  }
  if (reason === "length") {
    return "max_tokens";
  }
  return "end_turn";
}

function sendAnthropicSse(res: http.ServerResponse, message: any): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });
  writeSse(res, "message_start", { type: "message_start", message: { ...message, content: [] } });
  message.content.forEach((block: any, index: number) => {
    writeSse(res, "content_block_start", { type: "content_block_start", index, content_block: contentBlockStart(block) });
    if (block.type === "text" && block.text) {
      writeSse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
    } else if (block.type === "tool_use") {
      writeSse(res, "content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input || {}) },
      });
    }
    writeSse(res, "content_block_stop", { type: "content_block_stop", index });
  });
  writeSse(res, "message_delta", { type: "message_delta", delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: message.usage });
  writeSse(res, "message_stop", { type: "message_stop" });
  res.end();
}

function contentBlockStart(block: any): any {
  if (block.type === "text") {
    return { type: "text", text: "" };
  }
  if (block.type === "tool_use") {
    return { type: "tool_use", id: block.id, name: block.name, input: {} };
  }
  return block;
}

function writeSse(res: http.ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function readUpstreamPayload(response: Response): Promise<any> {
  const responseText = await response.text();
  try {
    return responseText ? JSON.parse(responseText) : {};
  } catch {
    return { error: { message: responseText || response.statusText } };
  }
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

function parseJson(value: string | undefined): unknown {
  if (!value) {
    return undefined;
  }
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
