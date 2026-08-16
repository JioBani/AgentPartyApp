import type { Subagent } from "../workbench/types";
import type { SubagentBlock } from "../../shared/subagentActivity";
import { deriveSubagentAction } from "../../shared/subagentActivity";

/**
 * Folds `subagent` normalized events into a per-session list of subagents,
 * mirroring `applyEvents` for the main transcript but kept in a SEPARATE state
 * slice — this is what keeps subagent output out of the parent chat. Each event
 * carries any of: lifecycle (identity/status), a live activity, and a new block
 * for the subagent's own transcript. All three are merged into the subagent
 * addressed by `agentId` (created on first sighting).
 */
export function applySubagentEvents(
  current: Record<string, Subagent[]>,
  sessionId: string,
  events: any[],
): Record<string, Subagent[]> {
  let next = current;
  for (const event of events) {
    // The dock describes the current turn, matching the harness task counter.
    // Keeping terminal rows forever made the badge a session-lifetime total:
    // two agents in each of three Claude turns displayed as six on the third.
    // A new user turn cannot overlap the previous one in AgentParty (busy sends
    // queue), so its `sent` boundary is the safe point to start a fresh list.
    if (event?.type === "status" && event.status === "sent") {
      if ((next[sessionId] || []).length) {
        next = { ...next, [sessionId]: [] };
      }
      continue;
    }
    if (event?.type === "subagent" && typeof event.agentId === "string") {
      next = upsertSubagent(next, sessionId, event);
    }
  }
  return next;
}

function upsertSubagent(current: Record<string, Subagent[]>, sessionId: string, event: any): Record<string, Subagent[]> {
  const list = current[sessionId] || [];
  const index = list.findIndex((sub) => sub.id === event.agentId);
  const base: Subagent = index >= 0 ? list[index] : {
    id: event.agentId,
    name: event.agentId,
    phase: "working",
    blocks: [],
  };
  const merged = mergeSubagent(base, event);
  const nextList = index >= 0 ? list.slice() : [...list, merged];
  if (index >= 0) {
    nextList[index] = merged;
  }
  return { ...current, [sessionId]: nextList };
}

/** Applies one event's facets (lifecycle / activity / block) onto a subagent. */
function mergeSubagent(prev: Subagent, event: any): Subagent {
  const life = event.lifecycle || {};
  const next: Subagent = {
    ...prev,
    name: str(life.label) ?? prev.name,
    hint: str(life.hint) ?? prev.hint,
    role: str(life.role) ?? prev.role,
    phase: (typeof life.phase === "string" ? life.phase : prev.phase) as Subagent["phase"],
    task: str(life.assignedTask) ?? prev.task,
    tools: str(life.tools) ?? prev.tools,
    dur: str(life.dur) ?? prev.dur,
    updatedAt: typeof event.at === "string" ? event.at : prev.updatedAt,
  };
  if (event.activity) {
    next.activity = event.activity;
  }
  if (event.block) {
    next.blocks = appendSubBlock(prev.blocks, event.block);
    // A tool block with no explicit activity still drives the one-liner, so the
    // dock reflects "what it's doing" even for mock/real streams that omit it.
    if (!event.activity && event.block.kind === "tool") {
      next.activity = deriveSubagentAction(event.block.name, event.block.arg);
    }
  }
  return next;
}

/**
 * Appends a block to the subagent transcript. A trailing `typing` placeholder is
 * replaced by the next real block (and re-appended by a later `typing`), matching
 * the prototype's live-typing behavior.
 */
function appendSubBlock(blocks: SubagentBlock[], block: SubagentBlock): SubagentBlock[] {
  const trimmed = blocks.length && blocks[blocks.length - 1].kind === "typing" ? blocks.slice(0, -1) : blocks;
  return [...trimmed, block];
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
