import type { SessionView } from "../../shared/types";
import type { TranscriptBlock } from "../workbench/types";

// The party write-tools as the agent sees them (mcp__<server>__<tool>). Mirrors
// PARTY_TOOL_PREFIX in src/core/partyBridge.ts; inlined so the renderer bundle
// doesn't pull in that module's zod dependency just for a constant.
const PARTY_SEND_TOOL = "mcp__agentparty-app__send";
const PARTY_CREATE_TOOL = "mcp__agentparty-app__member-create";
const PARTY_REMOVE_TOOL = "mcp__agentparty-app__member-remove";

export function applyEvents(current: Record<string, TranscriptBlock[]>, sessionId: string, events: any[]): Record<string, TranscriptBlock[]> {
  let next = current;
  for (const event of events) {
    if (event.type === "assistant_text_delta") {
      next = appendText(next, sessionId, "assistant", event.text || "");
    } else if (event.type === "reasoning_delta") {
      next = appendText(next, sessionId, "reasoning", event.text || "");
    } else if (event.type === "status") {
      // An inbound inter-member message arrives as a "sent" turn carrying the
      // <channel> envelope; render it as a clean message card, not raw XML.
      const channel = event.status === "sent" ? parseChannel(event.detail) : null;
      if (channel) {
        next = appendBlock(next, sessionId, { id: crypto.randomUUID(), kind: "channel", direction: "in", from: channel.from, to: channel.to, text: channel.text, at: nowTime() });
      } else {
        next = appendBlock(next, sessionId, { id: crypto.randomUUID(), kind: "status", text: [event.status, event.detail].filter(Boolean).join(": "), at: nowTime() });
      }
    } else if (event.type === "tool_call") {
      // Party write-tools render as purpose-built cards instead of raw tool boxes.
      if (event.name === PARTY_SEND_TOOL) {
        next = upsertChannelSendBlock(next, sessionId, event);
      } else if (event.name === PARTY_CREATE_TOOL || event.name === PARTY_REMOVE_TOOL) {
        next = upsertPartyActionBlock(next, sessionId, event, event.name === PARTY_CREATE_TOOL ? "create" : "remove");
      } else {
        next = upsertToolBlock(next, sessionId, event);
      }
    } else if (event.type === "diagnostic") {
      next = appendBlock(next, sessionId, { id: crypto.randomUUID(), kind: "diagnostic", severity: event.severity, category: event.category, title: event.title, detail: event.detail, recovery: event.recovery, at: nowTime() });
    } else if (event.type === "plan") {
      next = upsertPlanBlock(next, sessionId, event);
    } else if (event.type === "file_change") {
      if (Array.isArray(event.changes) && event.changes.length > 0) {
        next = appendBlock(next, sessionId, { id: crypto.randomUUID(), kind: "fileChange", changes: event.changes, status: event.status, at: nowTime() });
      }
    } else if (event.type === "approval_request") {
      next = appendBlock(next, sessionId, { id: event.requestId || crypto.randomUUID(), kind: "approval", requestId: event.requestId, toolName: event.toolName, title: event.title, description: event.description, input: event.input, codex: event.codex, at: nowTime() });
    } else if (event.type === "approval_resolved") {
      next = markApprovalResolved(next, sessionId, event.requestId, event.decision);
    } else if (event.type === "turn_complete") {
      const cost = event.cost ? ` - ${event.cost.label}` : "";
      next = appendBlock(next, sessionId, { id: crypto.randomUUID(), kind: "status", text: `turn complete${cost}${event.stopReason ? ` - ${event.stopReason}` : ""}`, at: nowTime() });
    } else if (event.type === "error") {
      next = appendBlock(next, sessionId, { id: crypto.randomUUID(), kind: "error", text: event.message, at: nowTime() });
    }
  }
  return next;
}

export function appendBlock(current: Record<string, TranscriptBlock[]>, sessionId: string, item: TranscriptBlock): Record<string, TranscriptBlock[]> {
  return { ...current, [sessionId]: [...(current[sessionId] || []), item] };
}

/**
 * The adapter emits several `tool_call` events for one tool use across its
 * lifecycle (start → stop → assistant/user snapshot → tool_result), all sharing
 * the same `id`. Appending each one stacks duplicate (often empty) boxes in the
 * transcript. Instead we keep a single block per id and merge later signals into
 * it, so the chat shows one tool entry that fills in as it progresses.
 */
function upsertToolBlock(current: Record<string, TranscriptBlock[]>, sessionId: string, event: any): Record<string, TranscriptBlock[]> {
  const id = event.id || crypto.randomUUID();
  const items = current[sessionId] || [];
  const index = items.findIndex((item) => item.kind === "tool" && item.id === id);
  if (index < 0) {
    return appendBlock(current, sessionId, {
      id, kind: "tool", name: event.name, status: event.status, input: event.input, result: event.result,
      source: event.source, cwd: event.cwd, exitCode: event.exitCode, durationMs: event.durationMs,
      output: event.outputDelta || undefined, at: nowTime(),
    });
  }
  const prev = items[index] as Extract<TranscriptBlock, { kind: "tool" }>;
  const merged: TranscriptBlock = {
    ...prev,
    name: preferToolName(prev.name, event.name),
    status: preferToolStatus(prev.status, event.status),
    input: preferInput(prev.input, event.input),
    result: event.result ?? prev.result,
    source: event.source ?? prev.source,
    cwd: event.cwd ?? prev.cwd,
    // Command live output streams in as deltas — append rather than replace.
    output: event.outputDelta ? (prev.output || "") + event.outputDelta : prev.output,
    exitCode: typeof event.exitCode === "number" ? event.exitCode : prev.exitCode,
    durationMs: typeof event.durationMs === "number" ? event.durationMs : prev.durationMs,
  };
  const next = items.slice();
  next[index] = merged;
  return { ...current, [sessionId]: next };
}

/** A single evolving plan card per session: the latest plan event replaces it. */
function upsertPlanBlock(current: Record<string, TranscriptBlock[]>, sessionId: string, event: any): Record<string, TranscriptBlock[]> {
  const items = current[sessionId] || [];
  const index = items.findIndex((item) => item.kind === "plan");
  const steps = Array.isArray(event.steps) ? event.steps : [];
  if (index < 0) {
    return appendBlock(current, sessionId, { id: "plan", kind: "plan", steps, explanation: event.explanation, at: nowTime() });
  }
  const prev = items[index] as Extract<TranscriptBlock, { kind: "plan" }>;
  // Keep prior steps if this update only carried explanation text (plan item).
  const merged: TranscriptBlock = { ...prev, steps: steps.length ? steps : prev.steps, explanation: event.explanation ?? prev.explanation };
  const next = items.slice();
  next[index] = merged;
  return { ...current, [sessionId]: next };
}

const PLACEHOLDER_TOOL_NAMES = new Set(["", "tool", "tool_result"]);

/** Keeps the most specific tool name (a real name beats "tool"/"tool_result"). */
function preferToolName(prev: string, incoming: string | undefined): string {
  if (incoming && !PLACEHOLDER_TOOL_NAMES.has(incoming)) {
    return incoming;
  }
  return PLACEHOLDER_TOOL_NAMES.has(prev) && incoming ? incoming : prev;
}

/** A terminal status (completed/failed) should not regress back to "started". */
function preferToolStatus(prev: string | undefined, incoming: string | undefined): string | undefined {
  const rank = (status?: string) => (status === "completed" || status === "failed" ? 2 : status ? 1 : 0);
  return rank(incoming) >= rank(prev) ? incoming ?? prev : prev;
}

/** Prefer a populated input object over the empty `{}` seen at content_block_start. */
function preferInput(prev: unknown, incoming: unknown): unknown {
  const size = (value: unknown) => (value && typeof value === "object" ? Object.keys(value as object).length : value ? 1 : 0);
  return size(incoming) >= size(prev) ? incoming ?? prev : prev;
}

export function markApprovalResolved(current: Record<string, TranscriptBlock[]>, sessionId: string, requestId: string, decision: "allow" | "deny", answers?: Record<string, string>): Record<string, TranscriptBlock[]> {
  return {
    ...current,
    [sessionId]: (current[sessionId] || []).map((item) => (
      item.kind === "approval" && item.requestId === requestId ? { ...item, resolved: decision, answers: answers ?? item.answers } : item
    )),
  };
}

export function upsertSession(sessions: SessionView[], session: SessionView): SessionView[] {
  return sessions.some((item) => item.id === session.id)
    ? sessions.map((item) => (item.id === session.id ? session : item))
    : [session, ...sessions];
}

function appendText(current: Record<string, TranscriptBlock[]>, sessionId: string, kind: "assistant" | "reasoning", text: string): Record<string, TranscriptBlock[]> {
  const items = [...(current[sessionId] || [])];
  const last = items[items.length - 1];
  if (last && last.kind === kind) {
    items[items.length - 1] = { ...last, text: last.text + text };
  } else {
    items.push({ id: crypto.randomUUID(), kind, text, at: nowTime() });
  }
  return { ...current, [sessionId]: items };
}

// Matches the inbound envelope produced by the main process
// (`buildChannelPayload`): <channel source="agentparty" from=".." to="..">body</channel>.
// from/to attributes are entity-escaped (& " <); the body is raw.
const CHANNEL_RE = /^<channel source="agentparty" from="([^"]*)" to="([^"]*)">\s*([\s\S]*?)\s*<\/channel>/;

function parseChannel(detail: unknown): { from: string; to: string; text: string } | null {
  if (typeof detail !== "string") {
    return null;
  }
  const match = CHANNEL_RE.exec(detail);
  if (!match) {
    return null;
  }
  return { from: unescapeAttr(match[1]), to: unescapeAttr(match[2]), text: match[3] };
}

function unescapeAttr(value: string): string {
  return value.replace(/&lt;/g, "<").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

/**
 * Folds the multiple `tool_call` events for one party `send` into a single
 * outgoing message card (mirrors `upsertToolBlock`). `from` is left blank — the
 * transcript belongs to the sender, so the view renders its own name.
 */
function upsertChannelSendBlock(current: Record<string, TranscriptBlock[]>, sessionId: string, event: any): Record<string, TranscriptBlock[]> {
  const id = event.id || crypto.randomUUID();
  const items = current[sessionId] || [];
  const index = items.findIndex((item) => item.kind === "channel" && item.id === id);
  const input = event.input && typeof event.input === "object" ? (event.input as Record<string, unknown>) : {};
  const to = typeof input.to === "string" ? input.to : "";
  const text = typeof input.content === "string" ? input.content : "";
  const state = channelSendState(event);
  if (index < 0) {
    return appendBlock(current, sessionId, { id, kind: "channel", direction: "out", from: "", to, text, state, at: nowTime() });
  }
  const prev = items[index] as Extract<TranscriptBlock, { kind: "channel" }>;
  const merged: TranscriptBlock = { ...prev, to: to || prev.to, text: text || prev.text, state: state ?? prev.state };
  const nextItems = items.slice();
  nextItems[index] = merged;
  return { ...current, [sessionId]: nextItems };
}

/** Resolves a send's delivery state from the tool event (failed if the bridge returned !ok). */
function channelSendState(event: any): "ok" | "failed" | undefined {
  return partyToolResult(event).state;
}

/**
 * Folds the `member-create` / `member-remove` tool_calls for one action into a
 * single party-action card. `member`/`role`/`model`/`harness` come from the tool
 * input; state + error come from the bridge's result envelope.
 */
function upsertPartyActionBlock(current: Record<string, TranscriptBlock[]>, sessionId: string, event: any, action: "create" | "remove"): Record<string, TranscriptBlock[]> {
  const id = event.id || crypto.randomUUID();
  const items = current[sessionId] || [];
  const index = items.findIndex((item) => item.kind === "partyAction" && item.id === id);
  const input = event.input && typeof event.input === "object" ? (event.input as Record<string, unknown>) : {};
  const str = (value: unknown) => (typeof value === "string" && value ? value : undefined);
  const { state, error } = partyToolResult(event);
  const incoming: Extract<TranscriptBlock, { kind: "partyAction" }> = {
    id, kind: "partyAction", action,
    member: str(input.name) || "",
    role: str(input.role),
    model: str(input.model),
    harness: str(input.harness),
    state, error, at: nowTime(),
  };
  if (index < 0) {
    return appendBlock(current, sessionId, incoming);
  }
  const prev = items[index] as Extract<TranscriptBlock, { kind: "partyAction" }>;
  const merged: TranscriptBlock = {
    ...prev,
    member: incoming.member || prev.member,
    role: incoming.role ?? prev.role,
    model: incoming.model ?? prev.model,
    harness: incoming.harness ?? prev.harness,
    state: incoming.state ?? prev.state,
    error: incoming.error ?? prev.error,
  };
  const nextItems = items.slice();
  nextItems[index] = merged;
  return { ...current, [sessionId]: nextItems };
}

/** Reads a party tool's result envelope into a {state, error} pair (failed if the bridge returned !ok). */
function partyToolResult(event: any): { state: "ok" | "failed" | undefined; error?: string } {
  if (event.status === "failed") {
    return { state: "failed" };
  }
  const result = event.result;
  if (result && typeof result === "object") {
    const text = Array.isArray((result as any).content) ? (result as any).content.map((part: any) => part?.text).filter(Boolean).join("") : "";
    let parsedError: string | undefined;
    if (text) {
      try {
        const parsed = JSON.parse(text);
        if (parsed?.ok === false) {
          return { state: "failed", error: typeof parsed.error === "string" ? parsed.error : undefined };
        }
        parsedError = typeof parsed?.error === "string" ? parsed.error : undefined;
      } catch {
        // Non-JSON result text — treat as informational, not a failure signal.
      }
    }
    if ((result as any).isError) {
      return { state: "failed", error: parsedError };
    }
  }
  return { state: event.status === "completed" ? "ok" : undefined };
}

export function nowTime(): string {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
