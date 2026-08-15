import type { SessionView, TranscriptSave } from "./types";
import type { TranscriptBlock } from "./transcript";

// The party write-tools as the agent sees them (mcp__<server>__<tool>). Mirrors
// PARTY_TOOL_PREFIX in src/core/partyBridge.ts; inlined so the renderer bundle
// doesn't pull in that module's zod dependency just for a constant.
const PARTY_SEND_TOOL = "mcp__agentparty-app__send";
const PARTY_CREATE_TOOL = "mcp__agentparty-app__member-create";
const PARTY_REMOVE_TOOL = "mcp__agentparty-app__member-remove";
const PARTY_ATTACH_IMAGE_TOOL = "mcp__agentparty-app__attach-image";

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
      if (channel && drawnFromQueue(next[sessionId], channel)) {
        // The app already drew this, block by block, from `queue_dequeued` right
        // before handing the turn over. Drawing the echo too would render the
        // member's message twice — and the echo cannot be split back into its
        // author blocks, so the dequeue's rendering is the one that survives.
      } else if (channel) {
        next = appendBlock(next, sessionId, { id: crypto.randomUUID(), kind: "channel", direction: "in", source: channel.source, from: channel.from, to: channel.to, text: channel.text, at: nowTime() });
      } else {
        // A plain "sent" status is the harness echoing back the turn the app just
        // submitted — the user's own message, tagged so it does not cut a reply
        // that is still streaming ([#14]).
        //
        // The echo of a QUEUE delivery keeps the tag but drops the body: the
        // queue already drew every block of that turn just above, so repeating
        // it here says the same thing twice — and for a turn carrying a member's
        // block it repeats it as the raw <channel> XML the card exists to hide.
        const echoed = event.status === "sent" && echoOfQueuedTurn(next[sessionId], event.detail);
        next = appendBlock(next, sessionId, {
          id: crypto.randomUUID(),
          kind: "status",
          text: echoed ? String(event.status) : [event.status, event.detail].filter(Boolean).join(": "),
          sent: event.status === "sent",
          at: nowTime(),
        });
      }
    } else if (event.type === "queue_dequeued") {
      // The queue was just handed over. THIS is when it enters the conversation
      // — not when it was typed — so the transcript order matches what the agent
      // actually read.
      //
      // One delivery, several author blocks: the whole queue leaves as ONE turn
      // and each same-sender run keeps its own author, so each run is drawn as
      // what it is (the user's bubble, a member's inbound card). The harness
      // then echoes that turn as a single "sent" line carrying every block at
      // once, which can no longer be split back apart — so the blocks are drawn
      // from THIS event, and `drawnFromQueue` keeps the echo from drawing them
      // again.
      const blocks: Array<{ from?: string | null; text?: string; count?: number }> = Array.isArray(event.blocks) ? event.blocks : [];
      for (const block of blocks) {
        const count = block.count || 1;
        if (block.from) {
          next = appendBlock(next, sessionId, {
            id: crypto.randomUUID(),
            kind: "channel",
            direction: "in",
            source: "agentparty",
            from: block.from,
            to: event.to || "",
            text: block.text || "",
            at: nowTime(),
            fromQueue: true,
            queuedN: count,
          });
        } else {
          next = appendBlock(next, sessionId, {
            id: crypto.randomUUID(),
            kind: "user",
            text: block.text || "",
            fromQueue: true,
            queuedN: count,
            from: null,
            at: nowTime(),
          });
        }
      }
    } else if (event.type === "tool_call") {
      // Party write-tools render as purpose-built cards instead of raw tool boxes.
      // Claude reports the eventual tool_result with the SAME id but the generic
      // name `tool_result`. Route that terminal event back to the purpose-built
      // card instead of appending a second raw tool box.
      const existing = (next[sessionId] || []).find((item) => item.id === event.id);
      if (event.name === PARTY_SEND_TOOL || (existing?.kind === "channel" && existing.direction === "out")) {
        next = upsertChannelSendBlock(next, sessionId, event);
      } else if (event.name === PARTY_ATTACH_IMAGE_TOOL || existing?.kind === "image") {
        next = upsertImageBlock(next, sessionId, event);
      } else if (event.name === PARTY_CREATE_TOOL || event.name === PARTY_REMOVE_TOOL || existing?.kind === "partyAction") {
        const action = existing?.kind === "partyAction" ? existing.action : event.name === PARTY_CREATE_TOOL ? "create" : "remove";
        next = upsertPartyActionBlock(next, sessionId, event, action);
      } else if (PLACEHOLDER_TOOL_NAMES.has(event.name || "") && !existing && partyToolResult(event).state !== "failed") {
        // A successful orphan result has no user-facing meaning. This can occur
        // after reconnect when the corresponding start event predates the live
        // stream; rendering `{\"ok\":true}` only exposes transport internals.
        continue;
      } else {
        next = upsertToolBlock(next, sessionId, event);
      }
    } else if (event.type === "diagnostic") {
      next = appendDiagnosticBlock(next, sessionId, event);
    } else if (event.type === "plan") {
      next = upsertPlanBlock(next, sessionId, event);
    } else if (event.type === "file_change") {
      if (Array.isArray(event.changes) && event.changes.length > 0) {
        next = appendBlock(next, sessionId, { id: crypto.randomUUID(), kind: "fileChange", changes: event.changes, status: event.status, at: nowTime() });
      }
    } else if (event.type === "approval_request") {
      next = appendBlock(next, sessionId, { id: event.requestId || crypto.randomUUID(), kind: "approval", requestId: event.requestId, toolName: event.toolName, title: event.title, description: event.description, input: event.input, codex: event.codex, suggestions: event.suggestions, blockedPath: event.blockedPath, agentID: event.agentID, at: nowTime() });
    } else if (event.type === "approval_resolved") {
      next = markApprovalResolved(next, sessionId, event.requestId, event.decision, event.answers);
    } else if (event.type === "compact_state") {
      next = applyCompactState(next, sessionId, event);
    } else if (event.type === "turn_complete") {
      const cost = event.cost ? ` - ${event.cost.label}` : "";
      next = appendBlock(next, sessionId, { id: crypto.randomUUID(), kind: "status", text: `turn complete${cost}${event.stopReason ? ` - ${event.stopReason}` : ""}`, at: nowTime() });
    } else if (event.type === "gate") {
      // Message Gate outcome for an outgoing send — an inline badge in the
      // SENDER's transcript (never part of any model context).
      next = appendBlock(next, sessionId, { id: crypto.randomUUID(), kind: "gate", gate: event.gate, to: event.to, from: event.from, reason: event.reason, rule: event.rule, errcode: event.errcode, at: nowTime() });
    } else if (event.type === "error") {
      next = event.environment
        ? upsertEnvironmentBlock(next, sessionId, event.environment.checkId, event.message, event.environment.raw)
        : appendBlock(next, sessionId, { id: crypto.randomUUID(), kind: "error", text: event.message, at: nowTime() });
    }
  }
  return next;
}

/**
 * Whether this inbound channel message is already on screen because the queue
 * drew it. Matched on CONTENT, not on a flag carried between the two events:
 * the dequeue and the harness's echo of the same turn routinely land in
 * different batches, and a per-batch flag let the echo draw a second card
 * whenever they did. Only the tail is scanned — the echo follows immediately.
 */
/**
 * Whether this "sent" echo is the harness repeating a turn the queue just drew.
 * Matched by containment because one delivery is several blocks joined into one
 * payload, and a member's block is wrapped in its envelope on the way out.
 */
function echoOfQueuedTurn(blocks: TranscriptBlock[] | undefined, detail: unknown): boolean {
  const body = typeof detail === "string" ? detail : "";
  if (!body) {
    return false;
  }
  return (blocks || []).slice(-8).some((block) => "fromQueue" in block && block.fromQueue && block.text && body.includes(block.text));
}

function drawnFromQueue(blocks: TranscriptBlock[] | undefined, channel: { from?: string; text: string }): boolean {
  for (const block of (blocks || []).slice(-8)) {
    if (block.kind === "channel" && block.direction === "in" && block.fromQueue && block.from === channel.from && block.text === channel.text) {
      return true;
    }
  }
  return false;
}

export function appendBlock(current: Record<string, TranscriptBlock[]>, sessionId: string, item: TranscriptBlock): Record<string, TranscriptBlock[]> {
  return { ...current, [sessionId]: [...(current[sessionId] || []), item] };
}

/**
 * Retracts a block the app optimistically added and then learned was wrong —
 * specifically the echo of a message the backend parked in the member's queue
 * rather than delivering. The message is not lost: it is in the queue list, and
 * a `queue_dequeued` event re-adds it to the transcript when it is really sent.
 * A no-op when the id is already gone, so a double retraction is harmless.
 */
export function removeBlock(current: Record<string, TranscriptBlock[]>, sessionId: string, id: string): Record<string, TranscriptBlock[]> {
  const items = current[sessionId];
  if (!items?.some((item) => item.id === id)) {
    return current;
  }
  return { ...current, [sessionId]: items.filter((item) => item.id !== id) };
}

/**
 * The SAME diagnostic re-firing back-to-back (a polled read failing each tick,
 * a watchdog re-flagging) must not stack a new banner per occurrence — the
 * transcript filled with identical rate-limit blocks. When the newest block is
 * an identical diagnostic, tick its `repeat` counter (rendered as ×N) and
 * refresh the timestamp instead of appending. A different diagnostic — or any
 * other block in between — still appends normally.
 */
function appendDiagnosticBlock(current: Record<string, TranscriptBlock[]>, sessionId: string, event: any): Record<string, TranscriptBlock[]> {
  const items = current[sessionId] || [];
  const last = items[items.length - 1];
  if (
    last &&
    last.kind === "diagnostic" &&
    last.severity === event.severity &&
    last.category === event.category &&
    last.title === event.title &&
    (last.detail || "") === (event.detail || "")
  ) {
    const next = items.slice();
    next[next.length - 1] = { ...last, repeat: (last.repeat || 1) + 1, at: nowTime() };
    return { ...current, [sessionId]: next };
  }
  return appendBlock(current, sessionId, { id: crypto.randomUUID(), kind: "diagnostic", severity: event.severity, category: event.category, title: event.title, detail: event.detail, recovery: event.recovery, at: nowTime() });
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

/**
 * One card per environment problem, always at the bottom.
 *
 * A machine missing a harness CLI fails EVERY turn with the identical error, so
 * appending would bury the conversation under copies of one wall of text (the
 * behaviour this replaces). Re-firing therefore removes the previous card and
 * re-appends it: the user's messages stay where they are, and the card stays
 * next to the attempt that just failed instead of scrolling out of reach.
 */
function upsertEnvironmentBlock(
  current: Record<string, TranscriptBlock[]>,
  sessionId: string,
  checkId: string,
  text: string,
  raw: string | undefined,
): Record<string, TranscriptBlock[]> {
  const id = `env:${checkId}`;
  const items = (current[sessionId] || []).filter((item) => item.id !== id);
  return { ...current, [sessionId]: [...items, { id, kind: "environment", checkId, text, raw, at: nowTime() }] };
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

/**
 * Folds a compaction into ONE block: the first event inserts it, every later
 * one REPLACES it in place. Appending instead would leave the "압축 중" card
 * sitting above its own result, which is the trail of log lines this block
 * exists to remove.
 *
 * A terminal event with no running block still inserts one — a compaction can
 * finish in a window that opened mid-flight, and dropping it there would lose
 * the only record that the conversation was compacted at all.
 */
export function applyCompactState(
  current: Record<string, TranscriptBlock[]>,
  sessionId: string,
  event: { state: "running" | "done" | "failed"; trigger?: "manual" | "auto"; preTokens?: number; postTokens?: number; durationMs?: number; keptCount?: number; reason?: string },
): Record<string, TranscriptBlock[]> {
  const blocks = current[sessionId] || [];
  const index = blocks.findIndex((item) => item.kind === "compact" && item.state === "running");
  const running = index >= 0 ? (blocks[index] as Extract<TranscriptBlock, { kind: "compact" }>) : undefined;
  const merged: TranscriptBlock = {
    id: running?.id || crypto.randomUUID(),
    kind: "compact",
    state: event.state,
    // The running block knows the trigger; the SDK's boundary repeats it. Keep
    // whichever is present so a replacement never blanks what was shown.
    trigger: event.trigger ?? running?.trigger,
    preTokens: event.preTokens ?? running?.preTokens,
    postTokens: event.postTokens,
    durationMs: event.durationMs,
    keptCount: event.keptCount,
    reason: event.reason,
    at: running?.at || nowTime(),
    startedMs: running?.startedMs ?? Date.now(),
  };
  if (index >= 0) {
    return { ...current, [sessionId]: blocks.map((item, i) => (i === index ? merged : item)) };
  }
  return appendBlock(current, sessionId, merged);
}

export function upsertSession(sessions: SessionView[], session: SessionView): SessionView[] {
  return sessions.some((item) => item.id === session.id)
    ? sessions.map((item) => (item.id === session.id ? session : item))
    : [session, ...sessions];
}

/**
 * Appends a streamed delta to the block it belongs to.
 *
 * The block being streamed is the newest one of `kind` — but the user can send a
 * message WHILE it streams, and that echo is inserted straight into the
 * transcript (App.tsx). Looking only at the very last block therefore ended the
 * assistant's block at the user's message and started a fresh one for the rest
 * of the same reply. A markdown fence opened before the interruption was then
 * never closed in its own block, so the code block rendered as broken prose
 * ([#14]).
 *
 * The user's own message is the only thing that can land inside a running turn
 * without ending it, and it arrives TWICE: as the app's optimistic `user` echo
 * and as the harness's `sent` status line (every adapter emits one per turn), so
 * both are skipped. Anything else — a tool call, any other status line, an
 * error, and above all the `turn_complete` status that ends every turn — still
 * closes the block, which is what keeps two replies from merging into one.
 */
function appendText(current: Record<string, TranscriptBlock[]>, sessionId: string, kind: "assistant" | "reasoning", text: string): Record<string, TranscriptBlock[]> {
  const items = [...(current[sessionId] || [])];
  const streaming = indexOfStreamingBlock(items, kind);
  const block = streaming >= 0 ? items[streaming] : undefined;
  if (block && block.kind === kind) {
    items[streaming] = { ...block, text: block.text + text };
  } else {
    items.push({ id: crypto.randomUUID(), kind, text, at: nowTime() });
  }
  return { ...current, [sessionId]: items };
}

/** The index of the still-open block of `kind`, or -1 when the stream must start a new one. */
function indexOfStreamingBlock(items: TranscriptBlock[], kind: "assistant" | "reasoning"): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const block = items[index];
    if (block.kind === kind) {
      return index;
    }
    const isUserTurnEcho = block.kind === "user" || (block.kind === "status" && block.sent === true);
    if (!isUserTurnEcho) {
      return -1;
    }
  }
  return -1;
}

// Matches an inbound envelope produced by the main process: a member-to-member
// message (`buildChannelPayload`)
//   <channel source="agentparty" from=".." to="..">body</channel>
// or one relayed from the Discord bridge, which has no `to` (it is addressed to
// whichever member owns the channel)
//   <channel source="discord" from="..">body</channel>
// from/to attributes are entity-escaped (& " <); the body is raw.
const CHANNEL_RE = /^<channel source="(agentparty|discord)" from="([^"]*)"(?: to="([^"]*)")?>\s*([\s\S]*?)\s*<\/channel>/;

function parseChannel(detail: unknown): { source: "agentparty" | "discord"; from: string; to: string; text: string } | null {
  if (typeof detail !== "string") {
    return null;
  }
  const match = CHANNEL_RE.exec(detail);
  if (!match) {
    return null;
  }
  return { source: match[1] as "agentparty" | "discord", from: unescapeAttr(match[2]), to: unescapeAttr(match[3] || ""), text: match[4] };
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
  const { state, error } = partyToolResult(event);
  if (index < 0) {
    // content_block_start normally carries `{}` while Claude is still streaming
    // the arguments. Wait for the populated update so interrupted tool starts do
    // not leave a blank `member -> ?` card behind.
    if (!to && !text) {
      return current;
    }
    return appendBlock(current, sessionId, { id, kind: "channel", direction: "out", from: "", to, text, state, error, at: nowTime() });
  }
  const prev = items[index] as Extract<TranscriptBlock, { kind: "channel" }>;
  const merged: TranscriptBlock = { ...prev, to: to || prev.to, text: text || prev.text, state: state ?? prev.state, error: error ?? prev.error };
  const nextItems = items.slice();
  nextItems[index] = merged;
  return { ...current, [sessionId]: nextItems };
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
    // Claude announces the tool before its streamed input contains the member.
    if (!incoming.member) {
      return current;
    }
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
/**
 * The image card a member produced with `attach-image`.
 *
 * The picture is NOT in this event: the bridge stored it and returned only a
 * reference, which is the whole point — the bytes must stay out of the model's
 * conversation. `file` names an entry in the workspace image store, `url` is a
 * remote address kept as given.
 */
function upsertImageBlock(current: Record<string, TranscriptBlock[]>, sessionId: string, event: any): Record<string, TranscriptBlock[]> {
  const id = event.id || crypto.randomUUID();
  const items = current[sessionId] || [];
  const index = items.findIndex((item) => item.kind === "image" && item.id === id);
  const input = event.input && typeof event.input === "object" ? (event.input as Record<string, unknown>) : {};
  const str = (value: unknown) => (typeof value === "string" && value ? value : undefined);
  const payload = resultPayload(event.result);
  const { state, error } = partyToolResult(event);
  const incoming: Extract<TranscriptBlock, { kind: "image" }> = {
    id, kind: "image",
    file: str(payload.file),
    url: str(payload.url) || str(input.url),
    mediaType: str(payload.mediaType),
    bytes: typeof payload.bytes === "number" ? payload.bytes : undefined,
    caption: str(input.caption),
    // What the member asked for, kept so a failed card can say what it wanted.
    origin: str(input.path) || str(input.url),
    state, error, at: nowTime(),
  };
  if (index < 0) {
    // The tool is announced before its streamed input names anything; an empty
    // card would flash on every call.
    if (!incoming.origin && !incoming.file && !incoming.url) {
      return current;
    }
    return appendBlock(current, sessionId, incoming);
  }
  const prev = items[index] as Extract<TranscriptBlock, { kind: "image" }>;
  const nextItems = items.slice();
  nextItems[index] = {
    ...prev,
    file: incoming.file ?? prev.file,
    url: incoming.url ?? prev.url,
    mediaType: incoming.mediaType ?? prev.mediaType,
    bytes: incoming.bytes ?? prev.bytes,
    caption: incoming.caption ?? prev.caption,
    origin: incoming.origin ?? prev.origin,
    state: incoming.state ?? prev.state,
    error: incoming.error ?? prev.error,
  };
  return { ...current, [sessionId]: nextItems };
}

/** The bridge's `data` object, dug out of whichever result shape an adapter used. */
function resultPayload(result: unknown): Record<string, unknown> {
  let value: unknown = result;
  if (Array.isArray(value)) {
    value = value.map((part: any) => part?.text).filter(Boolean).join("");
  } else if (value && typeof value === "object" && Array.isArray((value as any).content)) {
    value = (value as any).content.map((part: any) => part?.text).filter(Boolean).join("");
  }
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function partyToolResult(event: any): { state: "ok" | "failed" | undefined; error?: string } {
  if (event.status === "failed") {
    return { state: "failed", error: resultEnvelope(event.result).error };
  }
  const result = event.result;
  const envelope = resultEnvelope(result);
  if (envelope.ok === false || (result && typeof result === "object" && (result as any).isError)) {
    return { state: "failed", error: envelope.error };
  }
  // content_block_stop only means invocation arguments finished streaming. The
  // bridge result that follows is what proves delivery succeeded.
  return { state: result !== undefined && event.status === "completed" ? "ok" : undefined };
}

/** Normalizes the string/array/MCP-envelope result shapes emitted by adapters. */
function resultEnvelope(result: unknown): { ok?: boolean; error?: string } {
  let value: unknown = result;
  if (Array.isArray(value)) {
    value = value.map((part: any) => part?.text).filter(Boolean).join("");
  } else if (value && typeof value === "object" && Array.isArray((value as any).content)) {
    value = (value as any).content.map((part: any) => part?.text).filter(Boolean).join("");
  }
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (!value || typeof value !== "object") {
    return {};
  }
  return {
    ok: typeof (value as any).ok === "boolean" ? (value as any).ok : undefined,
    error: typeof (value as any).error === "string" ? (value as any).error : undefined,
  };
}

/**
 * Repairs transcripts produced by the old Claude lifecycle folding.
 *
 * A restore can contain duplicate purpose-built cards followed by a raw
 * `tool_result` block with the same id. Coalesce those into one card, propagate
 * its terminal state, and discard incomplete empty starts. The original array
 * and block identities are retained when no repair is needed.
 */
export function normalizeTranscriptBlocks(blocks: TranscriptBlock[]): TranscriptBlock[] {
  const next: TranscriptBlock[] = [];
  const indexById = new Map<string, number>();
  let changed = false;

  for (const block of blocks) {
    const priorIndex = indexById.get(block.id);
    const prior = priorIndex === undefined ? undefined : next[priorIndex];

    if (prior?.kind === "channel" && block.kind === "channel" && prior.direction === "out" && block.direction === "out") {
      next[priorIndex!] = {
        ...prior,
        to: block.to || prior.to,
        text: block.text || prior.text,
        state: block.state ?? prior.state,
        error: block.error ?? prior.error,
      };
      changed = true;
      continue;
    }
    if (prior?.kind === "partyAction" && block.kind === "partyAction" && prior.action === block.action) {
      next[priorIndex!] = {
        ...prior,
        member: block.member || prior.member,
        role: block.role ?? prior.role,
        model: block.model ?? prior.model,
        harness: block.harness ?? prior.harness,
        state: block.state ?? prior.state,
        error: block.error ?? prior.error,
      };
      changed = true;
      continue;
    }
    if (block.kind === "tool" && PLACEHOLDER_TOOL_NAMES.has(block.name || "") && prior) {
      if (prior.kind === "channel" && prior.direction === "out") {
        const outcome = partyToolResult(block);
        next[priorIndex!] = { ...prior, state: outcome.state ?? prior.state, error: outcome.error ?? prior.error };
        changed = true;
        continue;
      }
      if (prior.kind === "partyAction") {
        const outcome = partyToolResult(block);
        next[priorIndex!] = { ...prior, state: outcome.state ?? prior.state, error: outcome.error ?? prior.error };
        changed = true;
        continue;
      }
      if (prior.kind === "tool") {
        next[priorIndex!] = {
          ...prior,
          name: preferToolName(prior.name, block.name),
          status: preferToolStatus(prior.status, block.status),
          result: block.result ?? prior.result,
        };
        changed = true;
        continue;
      }
    }

    next.push(block);
    if (block.id) {
      indexById.set(block.id, next.length - 1);
    }
  }

  const filtered = next.filter((block) => {
    if (block.kind === "channel" && block.direction === "out" && !block.to && !block.text) {
      changed = true;
      return false;
    }
    if (block.kind === "partyAction" && !block.member) {
      changed = true;
      return false;
    }
    if (block.kind === "tool" && PLACEHOLDER_TOOL_NAMES.has(block.name || "") && partyToolResult(block).state !== "failed") {
      changed = true;
      return false;
    }
    return true;
  });
  return changed ? filtered : blocks;
}

/**
 * Prepends the persisted transcript to events already observed for a new live
 * session. Identity is preserved when no merge is needed so append persistence
 * can still detect its unchanged prefix without serializing the whole history.
 */
export function mergeRestoredTranscript(restored: TranscriptBlock[], live: TranscriptBlock[]): TranscriptBlock[] {
  if (!restored.length) {
    return live;
  }
  if (!live.length) {
    return restored;
  }
  const restoredIds = new Set(restored.map((block) => block.id));
  if (live.some((block) => restoredIds.has(block.id))) {
    return live;
  }
  return [...restored, ...live];
}

export function nowTime(): string {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Builds the persist payload for a member whose transcript changed.
 *
 * Blocks are rebuilt immutably by {@link applyEvents} — a block the events did
 * not touch keeps its identity — so the longest identity-equal prefix of
 * `persisted` and `next` is exactly the part already on disk. Everything after
 * it becomes an anchored append, turning a multi-MB save into a few KB.
 *
 * Falls back to a full save when there is no usable anchor (nothing in common,
 * or the anchor block carries no id), because an append that cannot be anchored
 * is not something the engine can apply.
 */
export function buildTranscriptSave(persisted: TranscriptBlock[] | undefined, next: TranscriptBlock[]): TranscriptSave {
  if (!persisted || !persisted.length) {
    return { blocks: next };
  }
  let common = 0;
  const limit = Math.min(persisted.length, next.length);
  while (common < limit && persisted[common] === next[common]) {
    common += 1;
  }
  const afterId = common > 0 ? persisted[common - 1]?.id : undefined;
  if (!afterId) {
    return { blocks: next };
  }
  return { afterId, blocks: next.slice(common) };
}
