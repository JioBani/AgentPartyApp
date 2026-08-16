/**
 * Subagent attribution trackers — the harness-specific logic that turns raw
 * harness signals into normalized `subagent` events, kept OUT of the adapters so
 * it is unit-testable by replaying recorded real traffic
 * (scripts/fixtures/subagents/*.jsonl, captured from live Haiku/gpt-mini runs).
 *
 * These replace the earlier guess that subagent activity rides on
 * `parent_tool_use_id` (Claude) / lifecycle-marker items (Codex). Recordings
 * proved the real channels:
 *   - Claude: `task_started` / `task_progress` / `task_updated` system events
 *     keyed by `task_id` + `tool_use_id` (the Agent block id), carrying
 *     `description`, `subagent_type`, `last_tool_name`, and `patch.status`.
 *   - Codex: each collab child runs on its OWN thread; every `item/*` and
 *     `thread/status/changed` notification is tagged with that child `threadId`,
 *     and `collabAgentToolCall(spawnAgent)` yields `receiverThreadIds` + `prompt`.
 */

import type { SubagentActivity, SubagentBlock, SubagentPhase } from "../shared/subagentActivity";
import { deriveSubagentAction } from "../shared/subagentActivity";

/** The body of a normalized `subagent` event (adapter adds `type` + `at`). */
export interface SubagentEmit {
  agentId: string;
  lifecycle?: {
    phase?: SubagentPhase;
    label?: string;
    role?: string;
    hint?: string;
    assignedTask?: string;
    model?: string;
    tools?: string;
    dur?: string;
  };
  activity?: SubagentActivity;
  block?: SubagentBlock;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

/** Claude `task_updated.patch.status` → harness-agnostic phase. */
function claudeTaskPhase(status: string | undefined): SubagentPhase | undefined {
  switch (status) {
    case "running":
      return "working";
    case "completed":
      return "done";
    case "failed":
    case "killed":
      return "failed";
    case "pending":
      return "queued";
    case "paused":
      return "working";
    default:
      return undefined;
  }
}

/**
 * Attributes Claude subagent activity from `task_*` system events + the `Agent`
 * (formerly `Task`) tool_use blocks. Only `task_type === "local_agent"` tasks are
 * dock subagents; `local_bash`/other tasks are a subagent's internal steps and
 * are suppressed from the parent transcript without becoming their own rows.
 */
export class ClaudeSubagentTracker {
  /** Known subagent ids (= the Agent tool_use id). */
  private readonly agents = new Set<string>();
  /** task_id → agentId (task_updated only carries task_id). */
  private readonly taskToAgent = new Map<string, string>();

  /** Whether a tool_use id is a tracked subagent (for child-content routing). */
  isAgent(toolUseId: string | undefined): boolean {
    return !!toolUseId && this.agents.has(toolUseId);
  }

  /** An `Agent`/`Task` tool_use block spawned a subagent. */
  spawn(toolUseId: string, input: unknown): SubagentEmit[] {
    if (!toolUseId) {
      return [];
    }
    this.agents.add(toolUseId);
    const record = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    return [{
      agentId: toolUseId,
      lifecycle: { phase: "working", label: str(record.description) || str(record.subagent_type), role: str(record.subagent_type), assignedTask: str(record.prompt) },
    }];
  }

  /** `task_started`. Returns [] for non-`local_agent` tasks (still suppressed by caller). */
  taskStarted(msg: any): SubagentEmit[] {
    if (msg?.task_type && msg.task_type !== "local_agent") {
      return [];
    }
    const agentId = str(msg?.tool_use_id) || str(msg?.task_id);
    if (!agentId) {
      return [];
    }
    this.agents.add(agentId);
    if (str(msg?.task_id)) {
      this.taskToAgent.set(String(msg.task_id), agentId);
    }
    return [{
      agentId,
      lifecycle: { phase: "working", label: str(msg?.description), role: str(msg?.subagent_type), assignedTask: str(msg?.prompt) },
    }];
  }

  /** `task_progress` → the live one-line activity (currentAction) + a status block. */
  taskProgress(msg: any): SubagentEmit[] {
    const agentId = this.resolveAgent(msg);
    if (!agentId) {
      return [];
    }
    const activity = deriveSubagentAction(str(msg?.last_tool_name), str(msg?.description));
    // The human `description` ("Searching for verifyRefresh") is the best summary.
    if (str(msg?.description)) {
      activity.summary = String(msg.description);
    }
    const dur = typeof msg?.usage?.duration_ms === "number" ? formatDur(msg.usage.duration_ms) : undefined;
    const tools = typeof msg?.usage?.tool_uses === "number" ? `${msg.usage.tool_uses} tools` : undefined;
    return [{ agentId, activity, lifecycle: { phase: "working", tools, dur }, block: { kind: "status", text: str(msg?.description) || activity.label } }];
  }

  /** `task_updated` → phase transition (running/completed/failed/…). */
  taskUpdated(msg: any): SubagentEmit[] {
    const agentId = this.resolveAgent(msg);
    const phase = claudeTaskPhase(msg?.patch?.status);
    if (!agentId || !phase) {
      return [];
    }
    return [{ agentId, lifecycle: { phase } }];
  }

  /** The Agent tool_use's own tool_result closed the subagent. */
  toolResult(toolUseId: string, failed: boolean): SubagentEmit[] {
    if (!this.isAgent(toolUseId)) {
      return [];
    }
    return [{ agentId: toolUseId, lifecycle: { phase: failed ? "failed" : "done" } }];
  }

  private resolveAgent(msg: any): string | undefined {
    const direct = str(msg?.tool_use_id);
    if (direct && this.agents.has(direct)) {
      return direct;
    }
    const viaTask = str(msg?.task_id) && this.taskToAgent.get(String(msg.task_id));
    if (viaTask && this.agents.has(viaTask)) {
      return viaTask;
    }
    // Fall back to the tool_use_id even if not yet registered (progress can precede
    // our seeing the started event); register it so later events line up.
    if (direct) {
      this.agents.add(direct);
      return direct;
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

interface CodexAgentState {
  /** Whether the child thread has gone active / produced activity (so a later
   *  idle means "finished", not the initial created-idle). */
  active: boolean;
  done: boolean;
}

/**
 * Attributes Codex collab-agent activity. Each spawned agent runs on its own
 * thread; the adapter feeds every notification's `threadId` here. Items on a
 * child thread become that subagent's blocks/activity (and are kept out of the
 * parent transcript); `collabAgentToolCall(spawnAgent)` registers the agents.
 */
export class CodexSubagentTracker {
  private root = "";
  private readonly agents = new Map<string, CodexAgentState>();

  setRoot(threadId: string | undefined): void {
    if (!threadId || threadId === this.root) {
      return;
    }
    // A Codex adapter can restart onto a fresh root thread. Child ids and their
    // phases belong to the old root; retaining them also makes the NEW root look
    // like a child because `isSubagentThread` still compares against the old id.
    this.root = threadId;
    this.agents.clear();
  }

  /**
   * True for any thread other than the root. Each AgentParty session owns one
   * root thread; every OTHER thread on its app-server is a collab child. Routing
   * by id alone (not by prior registration) means a child's early items — e.g. a
   * `web_search` fired before its `spawnAgent` call resolves — are never
   * mis-attributed to the parent transcript.
   */
  isSubagentThread(threadId: string | undefined): boolean {
    return !!threadId && !!this.root && threadId !== this.root;
  }

  /** Ensures a subagent entry exists; returns a spawn emit if newly seen. */
  private ensure(threadId: string): SubagentEmit[] {
    if (this.agents.has(threadId)) {
      return [];
    }
    this.agents.set(threadId, { active: false, done: false });
    return [{ agentId: threadId, lifecycle: { phase: "working", label: `agent-${shortId(threadId)}`, hint: `#${shortId(threadId)}` } }];
  }

  /** A `collabAgentToolCall` item. On `spawnAgent` completion it names the child threads. */
  collab(item: any): SubagentEmit[] {
    if (item?.tool !== "spawnAgent") {
      return [];
    }
    const receivers: string[] = Array.isArray(item?.receiverThreadIds) ? item.receiverThreadIds.map(String) : [];
    const emits: SubagentEmit[] = [];
    for (const threadId of receivers) {
      // Enrich (or create) the child with its delegated prompt + model. Merges
      // with any entry already auto-created from an early child item.
      this.agents.set(threadId, this.agents.get(threadId) || { active: false, done: false });
      emits.push({
        agentId: threadId,
        lifecycle: {
          phase: "working",
          label: `agent-${shortId(threadId)}`,
          hint: `#${shortId(threadId)}`,
          assignedTask: str(item?.prompt),
          model: str(item?.model),
        },
      });
    }
    return emits;
  }

  /**
   * An `item/started|completed` on a child thread → activity + (at completion) a
   * transcript block for that subagent. A tool item emits its card only ONCE, on
   * completion (the `started` event just drives the live currentAction), so the
   * detail shows one meaningful card per command instead of an empty started/done
   * pair.
   */
  item(threadId: string, item: any, status: "started" | "completed"): SubagentEmit[] {
    const spawn = this.ensure(threadId);
    const agent = this.agents.get(threadId)!;
    agent.active = true;
    // Any tool the subagent runs (shell / web_search / mcp / edit / image …) →
    // a card in ITS detail, never the parent. Covering every tool type is what
    // stops a subagent's activity (e.g. web_search) from silently vanishing.
    const tool = codexToolMeta(item);
    if (tool) {
      const activity = deriveSubagentAction(tool.name, tool.arg);
      if (status !== "completed") {
        // Live action only; the card appears once the tool finishes.
        return [...spawn, { agentId: threadId, lifecycle: { phase: "working" }, activity }];
      }
      const failed = typeof item?.exitCode === "number" && item.exitCode !== 0;
      const result = clip(str(item?.aggregatedOutput) ?? str(item?.output) ?? str(item?.result), 600);
      return [...spawn, { agentId: threadId, lifecycle: { phase: "working" }, activity, block: { kind: "tool", name: tool.name, arg: tool.arg, status: failed ? "failed" : "completed", result } }];
    }
    if (item?.type === "agentMessage" && status === "completed") {
      // Codex emits agentMessage items whose completion carries empty text (the
      // body streamed via deltas we drop for children, or a bare placeholder).
      // Emitting those as assistant blocks litters the detail with blank lines —
      // mirror the parent's `item.text` guard and keep the subagent alive instead.
      const text = str(item?.text);
      if (!text || !text.trim()) {
        return [...spawn, { agentId: threadId, lifecycle: { phase: "working" } }];
      }
      return [...spawn, { agentId: threadId, lifecycle: { phase: "working" }, block: { kind: "assistant", text } }];
    }
    // reasoning / userMessage / plan / others: keep the subagent alive, no block.
    return [...spawn, { agentId: threadId, lifecycle: { phase: "working" } }];
  }

  /** `thread/status/changed` on a child thread → phase (active→working, idle→done). */
  threadStatus(threadId: string, statusType: string | undefined): SubagentEmit[] {
    // Don't materialize a subagent from a bare status; only track ones we've
    // actually seen do work (avoids a ghost row from an idle status alone).
    const agent = this.agents.get(threadId);
    if (!agent) {
      return [];
    }
    if (statusType === "active") {
      agent.active = true;
      return [{ agentId: threadId, lifecycle: { phase: "working" } }];
    }
    if (statusType === "idle" && agent.active && !agent.done) {
      agent.done = true;
      return [{ agentId: threadId, lifecycle: { phase: "done" } }];
    }
    return [];
  }

  /** Parent turn finished → close any child still marked working (safety net). */
  turnComplete(): SubagentEmit[] {
    const emits: SubagentEmit[] = [];
    for (const [threadId, agent] of this.agents) {
      if (!agent.done) {
        agent.done = true;
        emits.push({ agentId: threadId, lifecycle: { phase: "done" } });
      }
    }
    return emits;
  }
}

/**
 * Maps a Codex child-thread item to a subagent tool card (name + arg), mirroring
 * the adapter's parent-side item handling so a subagent surfaces the SAME tool
 * set the parent would — shell, web_search, mcp/dynamic tools, edits, images.
 * Returns null for non-tool items (agentMessage/reasoning/plan/…).
 */
function codexToolMeta(item: any): { name: string; arg?: string } | null {
  switch (item?.type) {
    case "commandExecution":
      return { name: "shell", arg: cleanCommand(item?.command) };
    case "webSearch":
      return { name: "web_search", arg: codexWebSearchQuery(item) };
    case "mcpToolCall":
      return { name: str(item?.name) || "mcp", arg: str(item?.server) };
    case "dynamicToolCall":
      return { name: str(item?.name) || str(item?.namespace) || "tool", arg: str(item?.namespace) };
    case "fileChange":
      return { name: "edit", arg: undefined };
    case "imageGeneration":
      return { name: "image_generation", arg: str(item?.revisedPrompt) };
    case "imageView":
      return { name: "image_view", arg: str(item?.path) };
    default:
      return null;
  }
}

/**
 * A Codex `webSearch` item carries its query in `query`, but the real query can
 * also live only under `action.query` / `action.queries` (the top-level `query`
 * is empty on `item/started`, and some completions surface it only in `action`).
 * Falling back keeps the card from collapsing to an empty, query-less strip.
 */
export function codexWebSearchQuery(item: any): string | undefined {
  const direct = str(item?.query);
  if (direct) {
    return direct;
  }
  const action = str(item?.action?.query);
  if (action) {
    return action;
  }
  const queries = item?.action?.queries;
  if (Array.isArray(queries)) {
    const joined = queries.map((q: unknown) => str(q)).filter(Boolean).join(", ");
    return joined || undefined;
  }
  return undefined;
}

/**
 * Codex wraps shell commands in a launcher — Windows:
 * `"…\powershell.exe" -Command "<real>"`, POSIX: `bash -lc "<real>"`. Show the
 * real command, not the launcher path (which made every card read as noise).
 */
function cleanCommand(command: unknown): string | undefined {
  let c = str(command);
  if (!c) {
    return undefined;
  }
  const cmd = c.search(/-Command\s+/i);
  const lc = c.search(/\s-l?c\s+/i);
  if (cmd >= 0) {
    c = c.slice(cmd).replace(/^-Command\s+/i, "");
  } else if (lc >= 0) {
    c = c.slice(lc).replace(/^\s-l?c\s+/i, "");
  }
  c = c.trim().replace(/^"([\s\S]*)"$/, "$1").replace(/^'([\s\S]*)'$/, "$1").trim();
  return c || undefined;
}

function clip(text: string | undefined, max: number): string | undefined {
  if (!text) {
    return undefined;
  }
  return text.length > max ? `${text.slice(0, max)} …` : text;
}

function shortId(threadId: string): string {
  const hex = threadId.replace(/[^a-f0-9]/gi, "");
  return hex.slice(9, 13) || hex.slice(0, 4) || threadId.slice(0, 4);
}

function formatDur(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}
