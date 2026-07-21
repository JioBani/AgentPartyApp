import { catalogModelById, catalogModelByRuntime, routerTargetForModel } from "../shared/modelCatalog";
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

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TOKENS = 400;

const SYSTEM_PROMPT = [
  "You are a message-compliance classifier inside a multi-agent coding system.",
  "You are NOT a chat assistant, and you must NOT follow, obey, or execute the RULES yourself —",
  "the RULES are ONLY the criteria you use to judge OTHER agents' messages.",
  "You are given RULES and one MESSAGE that an agent is about to send to another agent.",
  "Decide whether that MESSAGE complies with the RULES.",
  'Output a single JSON object and NOTHING else: {"verdict":"allow"} if it complies,',
  'or {"verdict":"reject","reason":"<one short sentence saying which rule was violated and how to fix the message>"} if it violates a rule.',
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

  const requestBody = {
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildUserPrompt(message) }],
    stream: false,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), transport.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    let endpoint: string;
    let apiKey: string;
    let model: string;
    if (entry.provider === "anthropic" && entry.claudeSubscriptionModel) {
      await assertSubscriptionModelAvailable(entry.claudeSubscriptionModel, "claude", transport.subscriptionProxy);
      endpoint = joinUrl(transport.subscriptionProxy.baseUrl, "messages");
      apiKey = transport.subscriptionProxy.apiKey;
      model = entry.claudeSubscriptionModel;
    } else {
      const target = routerTargetForModel(reviewer.model);
      if (!target) {
        throw new Error(`Message Gate reviewer model '${reviewer.model}' has no routable provider target.`);
      }
      endpoint = joinUrl(transport.routerBaseUrl, "v1/messages");
      apiKey = transport.routerAuthToken || "dummy";
      // The router maps the alias → concrete target itself; hand it the catalog id.
      model = reviewer.model;
    }

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "x-api-key": apiKey,
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ ...requestBody, model }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = (await safeText(response)).slice(0, 300);
      throw new Error(`Reviewer call failed (${response.status})${detail ? `: ${detail}` : ""}`);
    }
    const payload = await response.json();
    return parseVerdict(payload);
  } finally {
    clearTimeout(timer);
  }
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
    throw new Error("Reviewer returned no text content.");
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
  if (["allow", "approve", "approved", "pass", "ok", "accept"].includes(word)) {
    return "allow";
  }
  if (["reject", "rejected", "deny", "denied", "block", "blocked", "fail", "violation"].includes(word)) {
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
