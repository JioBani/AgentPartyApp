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
      next = appendBlock(next, sessionId, { id: event.id || crypto.randomUUID(), kind: "tool", name: event.name, status: event.status, input: event.input, result: event.result, at: nowTime() });
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

export function markApprovalResolved(current: Record<string, TranscriptBlock[]>, sessionId: string, requestId: string, decision: "allow" | "deny"): Record<string, TranscriptBlock[]> {
  return {
    ...current,
    [sessionId]: (current[sessionId] || []).map((item) => (
      item.kind === "approval" && item.requestId === requestId ? { ...item, resolved: decision } : item
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
