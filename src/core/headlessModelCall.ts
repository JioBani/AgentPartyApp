import { catalogModelById, catalogModelByRuntime, routerTargetForModel } from "../shared/modelCatalog";
import type { CatalogModel, EffortLevel, ReasoningBudgetSpec } from "../shared/modelCatalog";
import { assertSubscriptionModelAvailable, type SubscriptionProxyConfig } from "./subscriptionProxy";

/**
 * One-shot HEADLESS model call — a single request/response with no harness, no
 * session and no accumulated context.
 *
 * Extracted from the Message Gate reviewer, which proved this routing against
 * real traffic: it reuses the app's existing auth/transport exactly the way a
 * real session reaches each model, and the two wires disagree in ways that are
 * NOT soft failures.
 *   - Anthropic subscription (sonnet, haiku …): POST the subscription proxy
 *     directly — the embedded router deliberately refuses native Anthropic.
 *   - codex-subscription / openrouter / …: POST the embedded router
 *     `/v1/messages`, which rewrites the catalog id to the concrete provider.
 * Both speak the Anthropic Messages wire with `stream:false`.
 *
 * Callers own their own prompt and their own parsing; this module owns only
 * "which endpoint, which credentials, which reasoning fields, and what did it
 * cost".
 */

/** Live transport handed in by the wiring layer (never guessed here). */
export interface HeadlessTransport {
  /** The LIVE embedded router base URL (actual bound port), e.g. http://127.0.0.1:PORT. */
  routerBaseUrl: string;
  routerAuthToken: string;
  subscriptionProxy: SubscriptionProxyConfig;
  /** Abort the call after this many ms. */
  timeoutMs?: number;
}

export interface HeadlessRequest {
  /** Catalog model id (e.g. `sonnet`, `GPT-5.6 Luna`). */
  model: string;
  /** Reasoning effort; scaled onto whichever reasoning knob the wire accepts. */
  effort: string;
  system: string;
  user: string;
  /** Answer budget. Reasoning headroom is added on top — a cap is not a spend. */
  maxTokens: number;
}

export interface HeadlessUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface HeadlessResult {
  /** The assistant's text content, concatenated. Never empty (throws instead). */
  text: string;
  /** The provider's own reported spend — a missing field means "not reported", never 0. */
  usage?: HeadlessUsage;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Token headroom added to `max_tokens` whenever reasoning is on. The model
 * spends thinking tokens out of `max_tokens` BEFORE the answer, so without
 * headroom a thoughtful call is truncated to a bare thinking block and zero
 * text. Both flavors were reproduced live:
 *   - no budget knob (`adaptive`, router `effort`): sonnet + max_tokens 400
 *     returned stop_reason "max_tokens" with an empty thinking block;
 *   - explicit budget (`enabled`): `budget_tokens` is a target, NOT a hard
 *     cap — haiku with budget 1024 spent 1424 thinking tokens, consuming the
 *     whole 400+1024 cap and truncating the answer away.
 */
const REASONING_HEADROOM = 8_192;

export async function callHeadlessModel(request: HeadlessRequest, transport: HeadlessTransport): Promise<HeadlessResult> {
  const entry = catalogModelById(request.model) || catalogModelByRuntime(request.model);
  if (!entry) {
    throw new Error(`Model '${request.model}' is not in the catalog.`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), transport.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    let endpoint: string;
    let apiKey: string;
    let model: string;
    let viaRouter: boolean;
    if (entry.provider === "anthropic" && entry.claudeSubscriptionModel) {
      await assertSubscriptionModelAvailable(entry.claudeSubscriptionModel, "claude", transport.subscriptionProxy);
      endpoint = joinUrl(transport.subscriptionProxy.baseUrl, "messages");
      apiKey = transport.subscriptionProxy.apiKey;
      model = entry.claudeSubscriptionModel;
      viaRouter = false;
    } else {
      const target = routerTargetForModel(request.model);
      if (!target) {
        throw new Error(`Model '${request.model}' has no routable provider target.`);
      }
      if (target.kind === "codex-subscription") {
        // The router relays to the same local subscription proxy, so a missing
        // Codex login has to be reported as "connect the subscription", not as
        // an opaque router error several layers down.
        await assertSubscriptionModelAvailable(target.model, "codex", transport.subscriptionProxy);
      }
      endpoint = joinUrl(transport.routerBaseUrl, "v1/messages");
      apiKey = transport.routerAuthToken || "dummy";
      // The router maps the alias → concrete target itself; hand it the catalog id.
      model = request.model;
      viaRouter = true;
    }

    const reasoning = reasoningPayload(entry, request.effort, viaRouter);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "x-api-key": apiKey,
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: request.maxTokens + (reasoning.budgetTokens ?? 0),
        system: request.system,
        messages: [{ role: "user", content: request.user }],
        stream: false,
        ...reasoning.body,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = (await safeText(response)).slice(0, 300);
      throw new Error(`Model call failed (${response.status})${detail ? `: ${detail}` : ""}`);
    }
    const payload = await response.json();
    const text = anthropicText(payload);
    if (!text) {
      const stop = (payload as { stop_reason?: unknown })?.stop_reason;
      throw new Error(`Model returned no text content${typeof stop === "string" && stop ? ` (stop_reason: ${stop})` : ""}.`);
    }
    return { text, usage: usageOf(payload) };
  } finally {
    clearTimeout(timer);
  }
}

/** The reasoning fields to merge into a request, plus any budget the cap must clear. */
interface ReasoningPayload {
  body: Record<string, unknown>;
  budgetTokens?: number;
}

/**
 * Translates an `effort` setting into the reasoning fields the chosen transport
 * actually accepts.
 *
 * The two wires disagree, and getting it wrong is NOT a soft failure: the
 * Anthropic Messages wire rejects `effort` with 400 "Extra inputs are not
 * permitted". So `effort` goes only to the router; Anthropic gets `thinking`.
 *
 * Which `thinking` shapes a model accepts is read from its catalog reasoning
 * spec rather than hardcoded — `adaptive` is real for sonnet/opus but 400s on
 * haiku, and a new model must remain a catalog-only change.
 */
export function reasoningPayload(entry: CatalogModel, effort: string, viaRouter: boolean): ReasoningPayload {
  const spec = entry.reasoning;
  if (!spec || !effort) {
    return { body: {} };
  }
  if (viaRouter) {
    const options = spec.effort?.options;
    if (!options?.includes(effort as EffortLevel)) {
      return { body: {} };
    }
    // Router-side reasoning also draws from max_tokens, with no explicit budget.
    return { body: { effort }, budgetTokens: REASONING_HEADROOM };
  }
  const modes = spec.thinking?.modes;
  if (!modes?.length) {
    return { body: {} };
  }
  if (modes.includes("adaptive")) {
    // Adaptive has no budget knob; reserve headroom so thinking cannot starve the answer.
    return { body: { thinking: { type: "adaptive" } }, budgetTokens: REASONING_HEADROOM };
  }
  if (modes.includes("enabled")) {
    const budgetTokens = thinkingBudgetFor(spec.budget, effort);
    // budget_tokens is a target the model can overshoot; reserve extra cap.
    return { body: { thinking: { type: "enabled", budget_tokens: budgetTokens } }, budgetTokens: budgetTokens + REASONING_HEADROOM };
  }
  return { body: {} };
}

/** Maps an effort level onto the model's own catalog budget range (min → max). */
function thinkingBudgetFor(budget: ReasoningBudgetSpec | undefined, effort: string): number {
  const min = budget?.min ?? 1024;
  const max = budget?.max ?? budget?.default ?? min;
  const fallback = budget?.default ?? min;
  const scale: Record<string, number> = { low: 0, medium: 0.25, high: 0.5, xhigh: 0.75, max: 1 };
  const ratio = scale[effort];
  if (ratio === undefined) {
    return fallback;
  }
  return Math.round(min + (max - min) * ratio);
}

function usageOf(payload: any): HeadlessUsage | undefined {
  const u = payload?.usage;
  if (!u || typeof u !== "object") {
    return undefined;
  }
  return {
    input: typeof u.input_tokens === "number" ? u.input_tokens : undefined,
    output: typeof u.output_tokens === "number" ? u.output_tokens : undefined,
    cacheRead: typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : undefined,
    cacheWrite: typeof u.cache_creation_input_tokens === "number" ? u.cache_creation_input_tokens : undefined,
  };
}

/** Concatenates the text blocks of an Anthropic Messages response. */
export function anthropicText(payload: unknown): string {
  const content = (payload as { content?: unknown })?.content;
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((block: any) => block?.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text)
    .join("")
    .trim();
}

function joinUrl(base: string, suffix: string): string {
  return `${base.replace(/\/+$/, "")}/${suffix.replace(/^\/+/, "")}`;
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
