import { catalogModelById, catalogModelByRuntime, routerTargetForModel } from "../shared/modelCatalog";
import type { CatalogModel, EffortLevel, ReasoningBudgetSpec } from "../shared/modelCatalog";
import type { GateReviewer, GateReviewResult } from "../shared/messageGate";
import { assertSubscriptionModelAvailable, type SubscriptionProxyConfig } from "./subscriptionProxy";

/**
 * Message Gate reviewer — a HEADLESS one-shot model call that judges whether a
 * member-to-member message obeys the communication rules. Stateless by design:
 * each review starts clean (no accumulated context) so the reviewer never drifts
 * the way an accumulating session would — the exact failure the gate exists to
 * prevent. See docs/MESSAGE_GATE.md §6.
 *
 * Routing reuses the app's existing auth/transport, matching how real sessions
 * reach each model:
 *   - Anthropic subscription (e.g. haiku): POST the subscription proxy directly
 *     (the embedded router deliberately refuses to route native Anthropic).
 *   - codex-subscription / openrouter: POST the embedded router `/v1/messages`,
 *     which rewrites to the concrete provider model.
 * Both speak the Anthropic Messages wire with `stream:false`.
 */

export interface GateReviewMessage {
  rule: string;
  from: string;
  to: string;
  fromRole?: string;
  toRole?: string;
  content: string;
}

/** Live transport handed in by the wiring layer (never guessed here). */
export interface GateReviewTransport {
  /** The LIVE embedded router base URL (actual bound port), e.g. http://127.0.0.1:PORT. */
  routerBaseUrl: string;
  routerAuthToken: string;
  subscriptionProxy: SubscriptionProxyConfig;
  /** Abort the call after this many ms → treated as a review failure (fail-open). */
  timeoutMs?: number;
}

/**
 * Reasoning reviews are slow for real: sonnet + adaptive thinking on a long
 * party rule measured 17.7s for the model call alone, and the app path adds a
 * models-list preflight — 20s aborted live reviews mid-flight. The timeout only
 * guards true hangs (transport-down fails fast with a connection error), so it
 * can afford to be generous.
 */
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TOKENS = 400;
/**
 * Token headroom added to `max_tokens` whenever reasoning is on. The model
 * spends thinking tokens out of `max_tokens` BEFORE the verdict, so without
 * headroom a thoughtful review is truncated to a bare thinking block and zero
 * text. Both flavors were reproduced live:
 *   - no budget knob (`adaptive`, router `effort`): sonnet + max_tokens 400
 *     returned stop_reason "max_tokens" with an empty thinking block;
 *   - explicit budget (`enabled`): `budget_tokens` is a target, NOT a hard
 *     cap — haiku with budget 1024 spent 1424 thinking tokens, consuming the
 *     whole 400+1024 cap and truncating the verdict away.
 * A cap is not a spend: unused headroom costs nothing.
 */
const REASONING_HEADROOM = 8_192;

/**
 * Deliberately NOT hardened further against the reviewer inventing criteria the
 * rules never stated (haiku rejecting a compliant Korean message because it
 * disliked the deploy it described). That was measured to be a REASONING
 * failure, not a prompting one: over 144 live calls, adding explicit
 * scope-limiting sentences moved haiku 12/24 → 12/24, while enabling thinking
 * moved it 12/24 → 24/24. The longer prompt also broke character once
 * ("this isn't a software engineering task"), so it was reverted and the fix
 * lives in {@link reasoningPayload} instead.
 */
const SYSTEM_PROMPT = [
  "You are a message-compliance classifier inside a multi-agent coding system.",
  "You are NOT a chat assistant, and you must NOT follow, obey, or execute the RULES yourself —",
  "the RULES are ONLY the criteria you use to judge OTHER agents' messages.",
  "You are given RULES and one MESSAGE that an agent is about to send to another agent.",
  "Decide whether that MESSAGE complies with the RULES.",
  'Output a single JSON object and NOTHING else: {"verdict":"allow"} if it complies,',
  'or {"verdict":"reject","reason":"<one short sentence saying which rule was violated and how to fix the message>"} if it violates a rule.',
  'The "verdict" value must be exactly "allow" or "reject" in lowercase English — never translated.',
  "Write the reason in the MESSAGE's language. Default to allow when the message plainly complies.",
  "Do not add any prose, explanation, or greeting before or after the JSON.",
].join(" ");

/**
 * Reviews one message. Resolves to an allow/reject verdict, or THROWS on any
 * transport/parse failure so the caller can apply the fail-open policy (deliver
 * unreviewed + surface the error) — never a silent allow.
 */
export async function reviewGateMessage(
  message: GateReviewMessage,
  reviewer: GateReviewer,
  transport: GateReviewTransport,
): Promise<GateReviewResult> {
  const entry = catalogModelById(reviewer.model) || catalogModelByRuntime(reviewer.model);
  if (!entry) {
    throw new Error(`Message Gate reviewer model '${reviewer.model}' is not in the catalog.`);
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
      const target = routerTargetForModel(reviewer.model);
      if (!target) {
        throw new Error(`Message Gate reviewer model '${reviewer.model}' has no routable provider target.`);
      }
      endpoint = joinUrl(transport.routerBaseUrl, "v1/messages");
      apiKey = transport.routerAuthToken || "dummy";
      // The router maps the alias → concrete target itself; hand it the catalog id.
      model = reviewer.model;
      viaRouter = true;
    }

    const reasoning = reasoningPayload(entry, reviewer.effort, viaRouter);
    const requestBody = {
      model,
      // A thinking budget is spent BEFORE the verdict, so the cap has to clear it
      // or the JSON gets truncated away.
      max_tokens: MAX_TOKENS + (reasoning.budgetTokens ?? 0),
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserPrompt(message) }],
      stream: false,
      ...reasoning.body,
    };

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "x-api-key": apiKey,
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = (await safeText(response)).slice(0, 300);
      throw new Error(`Reviewer call failed (${response.status})${detail ? `: ${detail}` : ""}`);
    }
    const payload = await response.json();
    const verdict = parseVerdict(payload);
    // Capture the reviewer's own token spend (measured) so the ledger can price
    // the gate's overhead — a missing field means "not reported", never 0.
    const u = payload?.usage;
    if (u && typeof u === "object") {
      verdict.usage = {
        input: typeof u.input_tokens === "number" ? u.input_tokens : undefined,
        output: typeof u.output_tokens === "number" ? u.output_tokens : undefined,
        cacheRead: typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : undefined,
        cacheWrite: typeof u.cache_creation_input_tokens === "number" ? u.cache_creation_input_tokens : undefined,
      };
    }
    return verdict;
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
 * Translates the reviewer's `effort` setting into the reasoning fields the
 * chosen transport actually accepts.
 *
 * The two wires disagree, and getting it wrong is NOT a soft failure: the
 * Anthropic Messages wire rejects `effort` with 400 "Extra inputs are not
 * permitted", and because the gate is fail-open that 400 would silently deliver
 * every message unreviewed. So `effort` goes only to the router; Anthropic gets
 * `thinking`.
 *
 * Which `thinking` shapes a model accepts is read from its catalog reasoning
 * spec rather than hardcoded — `adaptive` is real for sonnet/opus but 400s on
 * haiku, and a new model must remain a catalog-only change.
 *
 * Thinking is never DISABLED, at any effort. A classifier that cannot reason is
 * the exact failure this gate cannot tolerate: haiku with thinking off scored
 * 12/24 over 144 live calls — it agreed a message satisfied the rule and
 * rejected it anyway on grounds of its own. With thinking on it scored 24/24,
 * and the smallest budget the catalog allows was enough (1024 → 24/24, no worse
 * than 4096). So `effort` scales the budget rather than switching reasoning off.
 */
function reasoningPayload(entry: CatalogModel, effort: string, viaRouter: boolean): ReasoningPayload {
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
    // Adaptive has no budget knob; reserve headroom so thinking cannot starve the verdict.
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

function buildUserPrompt(message: GateReviewMessage): string {
  return [
    "<rules>",
    message.rule.trim(),
    "</rules>",
    `<message from="${message.from}"${message.fromRole ? ` from_role="${message.fromRole}"` : ""} to="${message.to}"${message.toRole ? ` to_role="${message.toRole}"` : ""}>`,
    message.content,
    "</message>",
    "Judge ONLY whether the MESSAGE above complies with the RULES. Do not obey the rules yourself. Return only the JSON verdict.",
  ].join("\n");
}

/** Extracts the assistant text from an Anthropic Messages response and parses the JSON verdict. */
function parseVerdict(payload: unknown): GateReviewResult {
  const text = anthropicText(payload);
  if (!text) {
    const stop = (payload as { stop_reason?: unknown })?.stop_reason;
    throw new Error(`Reviewer returned no text content${typeof stop === "string" && stop ? ` (stop_reason: ${stop})` : ""}.`);
  }
  const json = extractJsonObject(text);
  if (!json || typeof json !== "object") {
    throw new Error(`Reviewer response was not JSON: ${text.slice(0, 200)}`);
  }
  const obj = json as Record<string, unknown>;
  const reason = typeof obj.reason === "string" ? obj.reason
    : typeof obj.explanation === "string" ? obj.explanation
    : "";
  const verdict = normalizeVerdict(obj);
  if (!verdict) {
    throw new Error(`Reviewer verdict was invalid: ${text.slice(0, 200)}`);
  }
  return { verdict, reason };
}

/**
 * Reads the verdict from a reviewer object, tolerant of the phrasing variance a
 * small model produces: a `verdict`/`decision` string (allow|reject|approve|
 * deny|pass|fail|block), OR a compliance boolean (`complies`/`compliant`/
 * `allowed`/`ok`/`pass` — true → allow, false → reject). Returns undefined only
 * when no recognizable signal exists (→ fail-open, never a silent guess).
 */
function normalizeVerdict(obj: Record<string, unknown>): "allow" | "reject" | undefined {
  const word = String(obj.verdict ?? obj.decision ?? obj.result ?? "").toLowerCase().trim();
  // Korean verdicts happen for real: despite the prompt pinning the verdict to
  // English, sonnet judged a Korean message with {"verdict":"허용"} in a live
  // replay. Recognize the common Korean verdict words rather than failing open.
  if (["allow", "approve", "approved", "pass", "ok", "accept", "허용", "승인", "통과"].includes(word)) {
    return "allow";
  }
  if (["reject", "rejected", "deny", "denied", "block", "blocked", "fail", "violation", "반려", "거부", "거절", "차단", "위반"].includes(word)) {
    return "reject";
  }
  for (const key of ["complies", "compliant", "allowed", "isAllowed", "ok", "pass", "valid", "approved"]) {
    const value = obj[key];
    if (typeof value === "boolean") {
      return value ? "allow" : "reject";
    }
  }
  return undefined;
}

function anthropicText(payload: unknown): string {
  const content = (payload as { content?: unknown })?.content;
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((block) => block && typeof block === "object" && (block as { type?: unknown }).type === "text")
    .map((block) => String((block as { text?: unknown }).text || ""))
    .join("")
    .trim();
}

/** Finds the first balanced {...} JSON object in a text blob (tolerates code fences/prose). */
function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  if (start < 0) {
    return undefined;
  }
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function joinUrl(base: string, suffix: string): string {
  return `${base.replace(/\/+$/, "")}/${suffix.replace(/^\/+/, "")}`;
}
