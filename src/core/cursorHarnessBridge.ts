import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { CursorAcpPool, type CursorAcpMcpServer, type CursorAcpPromptBlock, type CursorAcpPromptResult, type CursorAcpSession } from "./cursorAcp";

/**
 * Cursor cross-harness bridge — serves Cursor-subscription models to harnesses
 * that speak Anthropic Messages (Claude Code), WITH full tool round-trips.
 *
 * Topology per conversation (keyed by the harness's per-session router token):
 *
 *   Claude Code ──HTTP /v1/messages──▶ EmbeddedHarnessRouter ──▶ this bridge
 *        ▲                                                        │ prompt
 *        │ tool_use / tool_result                                 ▼
 *        │                                       cursor-agent acp (ACP session)
 *        │                                                        │ spawns
 *        └──────── /acp-bridge/call ◀── relay MCP stub ◀──────────┘
 *
 * The harness's own tools are mirrored to the agent as MCP tools via the relay
 * stub (scripts/agentparty-acp-mcp-relay.mjs). When the agent calls one, the
 * bridge answers the CURRENT HTTP request with a `tool_use` block; the harness
 * executes the tool itself and sends `tool_result` in its NEXT request, which
 * resolves the held relay call — the ACP turn was never interrupted.
 *
 * Hard constraint (measured): Cursor's MCP client times out a tools/call at
 * ~60s and silently retries; it sends no progressToken, so progress keepalive
 * cannot extend it. Relay calls are therefore held at most RELAY_HOLD_MS and
 * then answered with a PENDING instruction; the model re-calls until the real
 * result exists. A 130s execution was verified end-to-end through this loop.
 *
 * Failure policy per AGENTS.md: every failure surfaces as an Anthropic-shaped
 * error to the harness. There is no fallback model and no silent recovery —
 * except one deliberate case: a conversation whose bridge state was lost (app
 * restart, idle eviction) is REPLAYED from the harness's own full history,
 * which the wire always carries. That path is logged.
 */

export interface CursorHarnessBridgeOptions {
  /** Absolute path to the relay MCP stub script (dev: scripts/, packaged: resources). */
  relayScriptPath: string;
  /** Node-capable command used by cursor-agent to spawn the relay. */
  relayNodeCommand?: string;
  /** Shared secret between the bridge and its relay stubs. */
  bridgeToken: string;
  /** The LIVE router base URL (relay stubs call back into it). */
  routerBaseUrl: () => string;
  /** Settings override for the cursor-agent executable. */
  cursorExecutablePath?: () => string | undefined;
  /** Directory for the isolated per-conversation ACP workspaces. */
  workspacesDir: string;
  log?: (level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>) => void;
}

/** Cursor's measured per-tools/call timeout is ~60s; hold safely below it. (Env override is a QA seam.) */
const RELAY_HOLD_MS = Number(process.env.AGENTPARTY_ACP_RELAY_HOLD_MS || "") || 45_000;
/** Collect parallel tool calls arriving within this window into one tool_use batch. */
const TOOL_BATCH_MS = 250;
/** A turn with no chunk, tool call, or result for this long is declared stuck. */
const TURN_STALL_MS = 10 * 60_000;

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: unknown;
}

interface RelayContent {
  type: "text";
  text: string;
}

interface RelayOutcome {
  content: RelayContent[];
  isError: boolean;
}

interface PendingRelayWaiter {
  resolve: (outcome: RelayOutcome | undefined) => void;
  timer: NodeJS.Timeout;
}

interface Turn {
  prompt: Promise<CursorAcpPromptResult>;
  /** Full agent text so far; sinks stream the suffix they have not sent yet. */
  text: string;
  /**
   * Chars of `text` already delivered to the harness in EARLIER responses of
   * this turn. Each Anthropic response is its own assistant message, so
   * re-sending already-delivered narration would duplicate it in transcripts.
   */
  sentChars: number;
  /** Set when the ACP prompt finished (the turn may outlive several HTTP requests). */
  done?: CursorAcpPromptResult;
  error?: Error;
  sink?: TurnSink;
  batch: Array<{ toolUseId: string; name: string; args: unknown }>;
  batchTimer?: NodeJS.Timeout;
  lastActivityAt: number;
}

interface Conversation {
  key: string;
  workspaceDir: string;
  tools: McpToolDef[];
  consumedMessages: number;
  session?: CursorAcpSession;
  turn?: Turn;
  toolUseSeq: number;
  /** tool_use blocks already sent to the harness, by id. */
  emitted: Map<string, { name: string; argsKey: string; resultDelivered: boolean }>;
  /** tool_result payloads from the harness, waiting for the relay to pick up. */
  results: Map<string, RelayOutcome>;
  /** Held relay calls, by toolUseId. */
  relayWaiters: Map<string, PendingRelayWaiter[]>;
}

/** Streams one HTTP response worth of a turn (SSE or buffered JSON). */
class TurnSink {
  private textOpen = false;
  private blockIndex = 0;
  private closed = false;
  private readonly encoder = new TextEncoder();
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  readonly body: ReadableStream<Uint8Array>;
  private readonly buffered: { content: any[]; stopReason: string } = { content: [], stopReason: "end_turn" };
  private bufferedText = "";

  constructor(
    private readonly streaming: boolean,
    private readonly model: string,
    private readonly onClientGone: () => void,
  ) {
    this.body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
      cancel: () => {
        this.closed = true;
        this.onClientGone();
      },
    });
    if (this.streaming) {
      this.event("message_start", {
        type: "message_start",
        message: {
          id: `msg_acp_${Date.now().toString(36)}`,
          type: "message",
          role: "assistant",
          model: this.model,
          content: [],
          stop_reason: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
    }
  }

  appendText(text: string): void {
    if (this.closed || !text) {
      return;
    }
    if (!this.streaming) {
      this.bufferedText += text;
      return;
    }
    if (!this.textOpen) {
      this.event("content_block_start", { type: "content_block_start", index: this.blockIndex, content_block: { type: "text", text: "" } });
      this.textOpen = true;
    }
    this.event("content_block_delta", { type: "content_block_delta", index: this.blockIndex, delta: { type: "text_delta", text } });
  }

  finishWithToolUses(calls: Array<{ toolUseId: string; name: string; args: unknown }>): void {
    if (this.closed) {
      return;
    }
    if (!this.streaming) {
      if (this.bufferedText) {
        this.buffered.content.push({ type: "text", text: this.bufferedText });
      }
      for (const call of calls) {
        this.buffered.content.push({ type: "tool_use", id: call.toolUseId, name: call.name, input: call.args ?? {} });
      }
      this.buffered.stopReason = "tool_use";
      this.endJson();
      return;
    }
    this.closeTextBlock();
    for (const call of calls) {
      this.event("content_block_start", {
        type: "content_block_start",
        index: this.blockIndex,
        content_block: { type: "tool_use", id: call.toolUseId, name: call.name, input: {} },
      });
      this.event("content_block_delta", {
        type: "content_block_delta",
        index: this.blockIndex,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(call.args ?? {}) },
      });
      this.event("content_block_stop", { type: "content_block_stop", index: this.blockIndex });
      this.blockIndex += 1;
    }
    this.endStream("tool_use");
  }

  finishFinal(stopReason: string): void {
    if (this.closed) {
      return;
    }
    if (!this.streaming) {
      if (this.bufferedText) {
        this.buffered.content.push({ type: "text", text: this.bufferedText });
      }
      this.buffered.stopReason = stopReason;
      this.endJson();
      return;
    }
    this.closeTextBlock();
    this.endStream(stopReason);
  }

  fail(message: string): void {
    if (this.closed) {
      return;
    }
    if (this.streaming) {
      this.event("error", { type: "error", error: { type: "api_error", message } });
      this.close();
    } else {
      this.write(JSON.stringify({ type: "error", error: { type: "api_error", message } }));
      this.close();
    }
  }

  get contentType(): string {
    return this.streaming ? "text/event-stream" : "application/json";
  }

  private closeTextBlock(): void {
    if (this.textOpen) {
      this.event("content_block_stop", { type: "content_block_stop", index: this.blockIndex });
      this.blockIndex += 1;
      this.textOpen = false;
    }
  }

  private endStream(stopReason: string): void {
    this.event("message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 0 } });
    this.event("message_stop", { type: "message_stop" });
    this.close();
  }

  private endJson(): void {
    this.write(JSON.stringify({
      id: `msg_acp_${Date.now().toString(36)}`,
      type: "message",
      role: "assistant",
      model: this.model,
      content: this.buffered.content,
      stop_reason: this.buffered.stopReason,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    }));
    this.close();
  }

  private event(name: string, payload: unknown): void {
    this.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
  }

  private write(text: string): void {
    if (!this.closed) {
      try {
        this.controller.enqueue(this.encoder.encode(text));
      } catch {
        this.closed = true;
      }
    }
  }

  private close(): void {
    if (!this.closed) {
      this.closed = true;
      try {
        this.controller.close();
      } catch {
        // Already errored/cancelled by the client.
      }
    }
  }
}

export class CursorHarnessBridge {
  private readonly pool = new CursorAcpPool();
  private readonly conversations = new Map<string, Conversation>();

  constructor(private readonly options: CursorHarnessBridgeOptions) {}

  dispose(): void {
    this.pool.disposeAll();
    this.conversations.clear();
  }

  /**
   * Serves POST /v1/messages for a cursor-subscription target. Returns a
   * WHATWG Response (SSE or JSON) that the router relays verbatim.
   */
  async handleMessages(conversationKey: string, acpModelId: string, body: any): Promise<Response> {
    const conv = this.conversation(conversationKey);
    conv.tools = mapAnthropicTools(body.tools);
    const streaming = body.stream !== false;
    const messages: any[] = Array.isArray(body.messages) ? body.messages : [];
    const incomingResults = extractToolResults(messages);
    const knownResults = incomingResults.filter((r) => conv.emitted.has(r.toolUseId));

    if (conv.turn && !conv.turn.done && !conv.turn.error && knownResults.length > 0) {
      // Continuation of the in-flight ACP turn: hand results to the held relay
      // calls and re-attach a sink for whatever the agent does next.
      conv.consumedMessages = messages.length;
      for (const result of knownResults) {
        this.deliverToolResult(conv, result.toolUseId, result.outcome);
      }
      return this.attachSink(conv, streaming, acpModelId);
    }

    // A brand-new turn. If an old turn is still around, it can only be stale
    // (the harness never sends a fresh user turn while awaiting tool results).
    if (conv.turn) {
      this.abortTurn(conv, "superseded by a new turn from the harness");
    }

    const session = await this.pool.acquire(conv.key, {
      cwd: conv.workspaceDir,
      modelId: acpModelId,
      executablePath: this.options.cursorExecutablePath?.(),
      mcpServers: [this.relayServer(conv.key)],
    });
    conv.session = session;

    // Replay the whole history whenever the incremental cursor is unusable:
    // first contact, a shrunken history (harness restart/compact), or a history
    // that did not grow (the harness RETRIED a request with identical history —
    // an incremental slice would be an empty prompt).
    const replayAll = conv.consumedMessages === 0 || conv.consumedMessages >= messages.length;
    if (replayAll && conv.consumedMessages !== 0) {
      this.options.log?.("warn", "cursor bridge replaying conversation (history did not grow — retry, restart, or compact)", { conversation: conv.key });
    }
    const promptBlocks = buildPrompt({
      system: body.system,
      messages,
      fromIndex: replayAll ? 0 : conv.consumedMessages,
      includePreamble: replayAll,
    });
    conv.consumedMessages = messages.length;

    const turn: Turn = {
      prompt: undefined as unknown as Promise<CursorAcpPromptResult>,
      text: "",
      sentChars: 0,
      batch: [],
      lastActivityAt: Date.now(),
    };
    conv.turn = turn;
    turn.prompt = session.prompt(promptBlocks, {
      onChunk: (text) => {
        turn.text += text;
        turn.lastActivityAt = Date.now();
        if (turn.sink) {
          turn.sink.appendText(text);
          turn.sentChars = turn.text.length;
        }
      },
    });
    turn.prompt
      .then((result) => {
        turn.done = result;
        this.finishTurnIfIdle(conv, turn);
      })
      .catch((error: Error) => {
        turn.error = error;
        turn.sink?.fail(`Cursor bridge turn failed: ${error.message}`);
        if (conv.turn === turn) {
          this.clearTurn(conv);
        }
      });

    return this.attachSink(conv, streaming, acpModelId);
  }

  /** Serves the relay stub. `pathname` is /acp-bridge/tools or /acp-bridge/call. */
  async handleRelay(pathname: string, token: string, payload: any): Promise<{ status: number; body: unknown }> {
    if (token !== this.options.bridgeToken) {
      return { status: 401, body: { error: "invalid bridge token" } };
    }
    const conv = this.conversations.get(String(payload?.conversation || ""));
    if (!conv) {
      return { status: 404, body: { error: "unknown bridge conversation" } };
    }
    if (pathname === "/acp-bridge/tools") {
      return { status: 200, body: { tools: conv.tools } };
    }
    if (pathname === "/acp-bridge/call") {
      const outcome = await this.handleRelayCall(conv, String(payload?.name || ""), payload?.arguments ?? {});
      return { status: 200, body: outcome };
    }
    return { status: 404, body: { error: "unknown bridge path" } };
  }

  /** Interrupts a conversation's in-flight turn (harness abort). */
  private abortTurn(conv: Conversation, reason: string): void {
    this.options.log?.("info", "cursor bridge turn aborted", { conversation: conv.key, reason });
    conv.session?.cancel();
    if (conv.turn) {
      for (const [toolUseId, waiters] of conv.relayWaiters) {
        for (const waiter of waiters) {
          clearTimeout(waiter.timer);
          waiter.resolve({ content: [{ type: "text", text: `Tool execution aborted: ${reason}` }], isError: true });
        }
        conv.relayWaiters.delete(toolUseId);
      }
    }
    this.clearTurn(conv);
  }

  private clearTurn(conv: Conversation): void {
    if (conv.turn?.batchTimer) {
      clearTimeout(conv.turn.batchTimer);
    }
    conv.turn = undefined;
  }

  private conversation(key: string): Conversation {
    let conv = this.conversations.get(key);
    if (!conv) {
      const workspaceDir = path.join(this.options.workspacesDir, crypto.createHash("sha256").update(key).digest("hex").slice(0, 16));
      fs.mkdirSync(workspaceDir, { recursive: true });
      conv = {
        key,
        workspaceDir,
        tools: [],
        consumedMessages: 0,
        toolUseSeq: 0,
        emitted: new Map(),
        results: new Map(),
        relayWaiters: new Map(),
      };
      this.conversations.set(key, conv);
    }
    return conv;
  }

  private relayServer(conversationKey: string): CursorAcpMcpServer {
    return {
      name: "agentparty-harness-tools",
      command: this.options.relayNodeCommand || process.execPath,
      args: [this.options.relayScriptPath],
      env: [
        { name: "ELECTRON_RUN_AS_NODE", value: "1" },
        { name: "AGENTPARTY_ACP_BRIDGE_URL", value: this.options.routerBaseUrl() },
        { name: "AGENTPARTY_ACP_BRIDGE_TOKEN", value: this.options.bridgeToken },
        { name: "AGENTPARTY_ACP_BRIDGE_CONVERSATION", value: conversationKey },
      ],
    };
  }

  private attachSink(conv: Conversation, streaming: boolean, model: string): Response {
    const turn = conv.turn;
    if (!turn) {
      throw new Error("Cursor bridge has no active turn to attach to.");
    }
    const sink = new TurnSink(streaming, model, () => {
      // The harness dropped this response mid-turn. If no newer sink replaced
      // this one, treat it as an interrupt.
      if (conv.turn === turn && turn.sink === sink && !turn.done && !turn.error) {
        this.abortTurn(conv, "harness disconnected");
      }
    });
    turn.sink = sink;
    const pending = turn.text.slice(turn.sentChars);
    if (pending) {
      sink.appendText(pending);
      turn.sentChars = turn.text.length;
    }
    if (turn.error) {
      sink.fail(`Cursor bridge turn failed: ${turn.error.message}`);
    } else if (turn.done) {
      this.finishTurnIfIdle(conv, turn);
    } else {
      this.watchStall(conv, turn);
    }
    return new Response(sink.body, {
      status: 200,
      headers: { "Content-Type": sink.contentType, "Cache-Control": "no-store" },
    });
  }

  /**
   * Completes the attached sink when the ACP prompt has finished AND no tool
   * results are still owed to the harness. stopReason "cancelled" maps to
   * end_turn — the harness initiated the cancel and expects a clean close.
   */
  private finishTurnIfIdle(conv: Conversation, turn: Turn): void {
    if (conv.turn !== turn || !turn.done || !turn.sink) {
      return;
    }
    turn.sink.finishFinal("end_turn");
    this.clearTurn(conv);
    if (conv.key.startsWith("oneshot-")) {
      // Stateless callers (gate reviewer, ad-hoc) never come back: release the
      // ACP child and forget the conversation instead of waiting for idle TTL.
      this.pool.release(conv.key);
      this.conversations.delete(conv.key);
    }
  }

  private watchStall(conv: Conversation, turn: Turn): void {
    const timer = setInterval(() => {
      if (conv.turn !== turn || turn.done || turn.error) {
        clearInterval(timer);
        return;
      }
      if (Date.now() - turn.lastActivityAt > TURN_STALL_MS) {
        clearInterval(timer);
        turn.sink?.fail(`Cursor bridge turn stalled for ${Math.round(TURN_STALL_MS / 1000)}s and was cancelled.`);
        this.abortTurn(conv, "stalled");
      }
    }, 15_000);
    timer.unref?.();
  }

  private async handleRelayCall(conv: Conversation, name: string, args: unknown): Promise<RelayOutcome> {
    const turn = conv.turn;
    const argsKey = `${name}:${stableJson(args)}`;
    if (turn) {
      turn.lastActivityAt = Date.now();
    }

    // A re-call of a tool_use the harness already knows about (PENDING loop):
    // wait for its result instead of emitting a duplicate tool_use.
    const emittedId = [...conv.emitted.entries()].find(([, meta]) => meta.argsKey === argsKey && !meta.resultDelivered)?.[0];
    if (emittedId) {
      const ready = conv.results.get(emittedId);
      if (ready) {
        conv.results.delete(emittedId);
        const meta = conv.emitted.get(emittedId);
        if (meta) {
          meta.resultDelivered = true;
        }
        return ready;
      }
      const outcome = await this.waitForResult(conv, emittedId);
      return outcome ?? pendingOutcome(name);
    }

    if (!turn || turn.done || turn.error) {
      return { content: [{ type: "text", text: "The calling harness is not waiting on this conversation anymore." }], isError: true };
    }

    // Fresh call: batch it (parallel tool calls arrive within milliseconds),
    // emit tool_use to the harness, then hold for the result.
    const toolUseId = `toolu_acp_${(++conv.toolUseSeq).toString(36)}${Date.now().toString(36)}`;
    conv.emitted.set(toolUseId, { name, argsKey, resultDelivered: false });
    turn.batch.push({ toolUseId, name, args });
    if (!turn.batchTimer) {
      turn.batchTimer = setTimeout(() => {
        turn.batchTimer = undefined;
        const batch = turn.batch.splice(0);
        if (batch.length > 0 && conv.turn === turn) {
          turn.sink?.finishWithToolUses(batch);
          turn.sink = undefined;
        }
      }, TOOL_BATCH_MS);
    }
    const outcome = await this.waitForResult(conv, toolUseId);
    return outcome ?? pendingOutcome(name);
  }

  private deliverToolResult(conv: Conversation, toolUseId: string, outcome: RelayOutcome): void {
    const waiters = conv.relayWaiters.get(toolUseId);
    if (waiters && waiters.length > 0) {
      conv.relayWaiters.delete(toolUseId);
      const meta = conv.emitted.get(toolUseId);
      if (meta) {
        meta.resultDelivered = true;
      }
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(outcome);
      }
      return;
    }
    conv.results.set(toolUseId, outcome);
  }

  private waitForResult(conv: Conversation, toolUseId: string): Promise<RelayOutcome | undefined> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const waiters = conv.relayWaiters.get(toolUseId) || [];
        conv.relayWaiters.set(toolUseId, waiters.filter((w) => w.timer !== timer));
        resolve(undefined);
      }, RELAY_HOLD_MS);
      timer.unref?.();
      const waiters = conv.relayWaiters.get(toolUseId) || [];
      waiters.push({ resolve, timer });
      conv.relayWaiters.set(toolUseId, waiters);
    });
  }
}

function pendingOutcome(name: string): RelayOutcome {
  return {
    content: [{
      type: "text",
      text: `STILL RUNNING: '${name}' has not finished yet. Call '${name}' again immediately with the SAME arguments to keep waiting — repeat until you receive the real result. Do not give up or answer without it.`,
    }],
    isError: false,
  };
}

function mapAnthropicTools(tools: unknown): McpToolDef[] {
  if (!Array.isArray(tools)) {
    return [];
  }
  return tools
    .filter((tool: any) => tool && typeof tool.name === "string")
    .map((tool: any) => ({
      name: tool.name,
      description: String(tool.description || ""),
      inputSchema: tool.input_schema ?? { type: "object", properties: {} },
    }));
}

function extractToolResults(messages: any[]): Array<{ toolUseId: string; outcome: RelayOutcome }> {
  const results: Array<{ toolUseId: string; outcome: RelayOutcome }> = [];
  for (const message of messages) {
    if (message?.role !== "user" || !Array.isArray(message.content)) {
      continue;
    }
    for (const block of message.content) {
      if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
        results.push({
          toolUseId: block.tool_use_id,
          outcome: { content: toRelayContent(block.content), isError: block.is_error === true },
        });
      }
    }
  }
  return results;
}

function toRelayContent(content: unknown): RelayContent[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (Array.isArray(content)) {
    const texts = content
      .map((block: any) => (block?.type === "text" ? String(block.text || "") : block?.type ? `[${block.type} omitted by the bridge]` : ""))
      .filter(Boolean);
    return [{ type: "text", text: texts.join("\n") || "(empty tool result)" }];
  }
  return [{ type: "text", text: "(empty tool result)" }];
}

const BRIDGE_PREAMBLE = [
  "You are the model backend for another coding harness, reached through a bridge.",
  "The harness executes ALL tools: use the MCP tools from 'agentparty-harness-tools' exactly as if they were your native tools, and use no other capability.",
  "If a tool answers with STILL RUNNING, call the same tool again with the same arguments until the real result arrives.",
  "Everything below is the harness's own system context and conversation. Continue it faithfully.",
].join(" ");

/**
 * Flattens Anthropic messages into ACP prompt blocks: one text block carrying
 * the rendered conversation, plus every image in range as its own image block
 * (verified live: ACP accepts base64 image content). On replay (fresh ACP
 * session), the whole history including tool exchanges is rendered as text so
 * the model regains full context; on incremental turns only the new tail goes.
 */
function buildPrompt(input: { system: unknown; messages: any[]; fromIndex: number; includePreamble: boolean }): CursorAcpPromptBlock[] {
  const parts: string[] = [];
  const images: CursorAcpPromptBlock[] = [];
  if (input.includePreamble) {
    parts.push(BRIDGE_PREAMBLE);
    const system = systemText(input.system);
    if (system) {
      parts.push(`<harness_system>\n${system}\n</harness_system>`);
    }
  }
  for (const message of input.messages.slice(input.fromIndex)) {
    const role = message?.role === "assistant" ? "assistant" : "user";
    const rendered = renderMessageContent(message?.content, input.includePreamble);
    if (rendered) {
      parts.push(input.includePreamble || role === "assistant" ? `[${role}]\n${rendered}` : rendered);
    }
    if (Array.isArray(message?.content)) {
      for (const block of message.content) {
        if (block?.type === "image" && block.source?.type === "base64" && typeof block.source.data === "string") {
          images.push({ type: "image", data: block.source.data, mimeType: String(block.source.media_type || "image/png") });
        }
      }
    }
  }
  return [{ type: "text", text: parts.join("\n\n") }, ...images];
}

function renderMessageContent(content: unknown, includeToolBlocks: boolean): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content) {
    if (block?.type === "text" && block.text) {
      parts.push(String(block.text));
    } else if (includeToolBlocks && block?.type === "tool_use") {
      parts.push(`[called tool ${block.name} with ${JSON.stringify(block.input ?? {})}]`);
    } else if (includeToolBlocks && block?.type === "tool_result") {
      parts.push(`[tool result: ${toRelayContent(block.content)[0]?.text || ""}]`);
    }
  }
  return parts.join("\n");
}

function systemText(system: unknown): string {
  if (typeof system === "string") {
    return system;
  }
  if (Array.isArray(system)) {
    return system.map((block: any) => (block?.type === "text" ? String(block.text || "") : "")).filter(Boolean).join("\n");
  }
  return "";
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      return Object.fromEntries(Object.entries(val).sort(([a], [b]) => a.localeCompare(b)));
    }
    return val;
  });
}
