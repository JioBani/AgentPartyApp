import type { SessionView } from "../../shared/types";
import type { TranscriptBlock } from "../workbench/types";

export function applyEvents(current: Record<string, TranscriptBlock[]>, sessionId: string, events: any[]): Record<string, TranscriptBlock[]> {
  let next = current;
  for (const event of events) {
    if (event.type === "assistant_text_delta") {
      next = appendText(next, sessionId, "assistant", event.text || "");
    } else if (event.type === "reasoning_delta") {
      next = appendText(next, sessionId, "reasoning", event.text || "");
    } else if (event.type === "status") {
      next = appendBlock(next, sessionId, { id: crypto.randomUUID(), kind: "status", text: [event.status, event.detail].filter(Boolean).join(": "), at: nowTime() });
    } else if (event.type === "tool_call") {
      next = upsertToolBlock(next, sessionId, event);
    } else if (event.type === "approval_request") {
      next = appendBlock(next, sessionId, { id: event.requestId || crypto.randomUUID(), kind: "approval", requestId: event.requestId, toolName: event.toolName, title: event.title, description: event.description, input: event.input, at: nowTime() });
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
    return appendBlock(current, sessionId, { id, kind: "tool", name: event.name, status: event.status, input: event.input, result: event.result, at: nowTime() });
  }
  const prev = items[index] as Extract<TranscriptBlock, { kind: "tool" }>;
  const merged: TranscriptBlock = {
    ...prev,
    name: preferToolName(prev.name, event.name),
    status: preferToolStatus(prev.status, event.status),
    input: preferInput(prev.input, event.input),
    result: event.result ?? prev.result,
  };
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

export function nowTime(): string {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
