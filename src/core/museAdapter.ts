import { EventEmitter } from "node:events";
import type { ImageAttachment } from "../shared/attachments";
import { approvalAnswers } from "../shared/approvalRequest";
import type { TurnTokenBreakdown } from "../shared/tokenUsage";
import { currentSpawnHost, shortCwd, spawnFailureSummary } from "../shared/sessionSpawn";
import { errorEventPayload } from "./environmentError";
import type { ClaudeEffort, ClaudeNormalizedEvent, ClaudeSessionSnapshot, HarnessCommand } from "./events";
import { resolveMuseCli } from "./museCli";
import {
  MuseMspSession,
  type MuseApprovalRequest,
  type MuseItem,
  type MuseMcpServer,
  type MuseUserInputRequest,
} from "./museMsp";

export interface MuseAdapterOptions {
  id: string;
  cwd: string;
  executablePath?: string;
  resumeSessionId?: string;
  model?: string;
  effort?: ClaudeEffort;
  permissionMode?: string;
  mcpServers?: Record<string, MuseMcpServer>;
  partyPrimer?: string;
  sessionFactory?: (options: ConstructorParameters<typeof MuseMspSession>[0]) => MuseMspSession;
  cliResolver?: typeof resolveMuseCli;
}

const now = (): string => new Date().toISOString();

export function museApprovalMode(permissionMode: string | undefined): "allowAll" | "promptUnmatched" | "onRequest" | "denyUnmatched" {
  if (permissionMode === "bypassPermissions") return "allowAll";
  if (permissionMode === "dontAsk" || permissionMode === "plan") return "denyUnmatched";
  if (permissionMode === "auto" || permissionMode === "acceptEdits") return "promptUnmatched";
  return "onRequest";
}

function museEffort(value: string | undefined): ClaudeEffort {
  return value === "none" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max"
    ? value
    : "high";
}

export class MuseAdapter extends EventEmitter {
  private session?: MuseMspSession;
  private snapshot: ClaudeSessionSnapshot;
  private starting?: Promise<void>;
  private disposed = false;
  private primerDelivered: boolean;
  private activeTurnId?: string;
  private items = new Map<string, MuseItem>();
  private streamed = new Map<string, { text: number; reasoning: number; output: number }>();
  private pendingApprovals = new Map<string, MuseApprovalRequest>();
  private pendingUserInputs = new Map<string, MuseUserInputRequest>();
  private turnUsage = new Map<string, TurnTokenBreakdown>();
  private backgroundItems = new Set<string>();
  private desiredModel: string;
  private desiredEffort: ClaudeEffort;
  private desiredPermissionMode: string;

  constructor(private readonly options: MuseAdapterOptions) {
    super();
    this.primerDelivered = Boolean(options.resumeSessionId);
    this.desiredModel = options.model || "muse-default";
    this.desiredEffort = museEffort(options.effort);
    this.desiredPermissionMode = options.permissionMode || "default";
    this.snapshot = {
      id: options.id,
      cwd: options.cwd,
      model: this.desiredModel,
      effort: this.desiredEffort,
      permissionMode: this.desiredPermissionMode,
      status: "starting",
      turnState: "idle",
      harnessAlive: false,
      startedAt: now(),
      debugMode: false,
      turnCount: 0,
      queuedTurnCount: 0,
      pendingApprovalCount: 0,
      backgroundTaskCount: 0,
    };
  }

  start(): void {
    if (this.starting || this.disposed) return;
    this.starting = this.launch().catch((error) => {
      this.emitSpawn("failed", error);
      this.emitEvent({ type: "error", ...errorEventPayload(error), at: now() });
      this.patch({ status: "error", harnessAlive: false, lastError: error instanceof Error ? error.message : String(error) });
    });
  }

  private async launch(): Promise<void> {
    this.emitSpawn("starting");
    const cli = await (this.options.cliResolver || resolveMuseCli)(this.options.executablePath);
    const factory = this.options.sessionFactory || ((options) => new MuseMspSession(options));
    const session = factory({
      command: cli.command,
      cwd: this.options.cwd,
      resumeSessionId: this.snapshot.sessionId || this.options.resumeSessionId,
      // Muse's provider catalog may intentionally be empty. `muse-default` means
      // let the signed-in plan select its current Muse Spark route.
      modelId: this.desiredModel === "muse-default" ? undefined : this.desiredModel,
      approvalMode: museApprovalMode(this.desiredPermissionMode),
      mcpServers: this.options.mcpServers,
      onNotification: (method, params) => this.onNotification(method, params),
      onServerRequest: (method, params) => this.onServerRequest(method, params),
      onExit: (error) => {
        if (this.disposed) return;
        this.emitEvent({ type: "error", message: error.message, at: now() });
        this.patch({ status: "error", harnessAlive: false, lastError: error.message });
      },
    });
    const result = await session.start();
    if (this.options.resumeSessionId || this.snapshot.sessionId) {
      if (this.desiredModel !== "muse-default" && result.session.modelId !== this.desiredModel) {
        await session.setModel(this.desiredModel);
      }
      await session.setEffort(this.desiredEffort);
      await session.setApprovalMode(museApprovalMode(this.desiredPermissionMode));
    }
    this.session = session;
    const actualModel = this.desiredModel !== "muse-default" ? this.desiredModel : result.session.modelId || this.desiredModel;
    this.patch({
      sessionId: result.session.sessionId,
      status: result.session.status || "idle",
      turnState: result.session.status === "running" ? "responding" : "idle",
      harnessAlive: true,
      model: actualModel,
      permissionMode: this.desiredPermissionMode,
    });
    this.emitEvent({
      type: "session",
      sessionId: result.session.sessionId,
      model: actualModel,
      permissionMode: this.desiredPermissionMode,
      at: now(),
    });
    this.emitSpawn("running", undefined, actualModel);
    await this.refreshSkills();
  }

  sendUserTurn(text: string, attachments?: ImageAttachment[]): void {
    const run = async () => {
      if (this.starting) await this.starting;
      if (!this.session) throw new Error("Muse Code session is not ready.");
      let prompt = text;
      if (!this.primerDelivered && this.options.partyPrimer) {
        prompt = `${this.options.partyPrimer}\n\n${text}`;
        this.primerDelivered = true;
      }
      this.patch({ status: "responding", turnState: "responding", lastUserMessageAt: now() });
      const result = await this.session.startTurn(prompt, this.desiredEffort, attachments);
      // Notifications can overtake the JSON-RPC response. Do not resurrect a
      // turn that already completed while `startTurn` was resolving.
      if (this.snapshot.turnState === "responding") this.activeTurnId = result.turnId;
    };
    void run().catch((error) => {
      this.emitEvent({ type: "error", ...errorEventPayload(error), at: now() });
      this.patch({ status: "error", turnState: "idle", lastError: error instanceof Error ? error.message : String(error) });
    });
  }

  interrupt(): void {
    void this.session?.interrupt(this.activeTurnId).catch((error) => this.emitEvent({ type: "error", message: String(error), at: now() }));
  }

  forceStop(): void {
    if (!this.activeTurnId && this.snapshot.turnState !== "interrupting" && this.snapshot.turnState !== "responding") return;
    const turnId = this.activeTurnId;
    void this.session?.interrupt(turnId).catch(() => undefined);
    this.activeTurnId = undefined;
    this.patch({ status: "idle", turnState: "idle" });
  }

  restart(): void {
    this.session?.dispose();
    this.session = undefined;
    this.starting = undefined;
    this.patch({ status: "starting", harnessAlive: false, turnState: "idle" });
    this.start();
  }

  compact(): void {
    this.emitEvent({ type: "compact_state", state: "running", trigger: "manual", at: now() });
    void this.session?.compact().catch((error) => {
      this.emitEvent({ type: "compact_state", state: "failed", trigger: "manual", reason: String(error), at: now() });
    });
  }

  dispose(): void {
    this.disposed = true;
    this.session?.dispose();
    this.session = undefined;
    this.patch({ status: "closed", harnessAlive: false, turnState: "idle" });
  }

  getSnapshot(): ClaudeSessionSnapshot { return { ...this.snapshot, slashCommands: this.snapshot.slashCommands?.map((item) => ({ ...item })) }; }

  setDebugMode(enabled: boolean): void { this.patch({ debugMode: enabled }); }

  setModel(model: string, _providerId?: string, runtimeModel?: string): void {
    this.desiredModel = runtimeModel || model;
    if (this.desiredModel === "muse-default") {
      this.patch({ model: this.desiredModel });
      return;
    }
    void this.session?.setModel(this.desiredModel).catch((error) => this.emitEvent({ type: "error", message: String(error), at: now() }));
  }

  setEffort(effort: string): void {
    this.desiredEffort = museEffort(effort);
    void this.session?.setEffort(this.desiredEffort).catch((error) => this.emitEvent({ type: "error", message: String(error), at: now() }));
  }

  setThinking(_mode: string, _budget?: number): void {}

  setPermissionMode(permissionMode: string): void {
    this.desiredPermissionMode = permissionMode;
    void this.session?.setApprovalMode(museApprovalMode(permissionMode)).catch((error) => this.emitEvent({ type: "error", message: String(error), at: now() }));
    this.patch({ permissionMode });
  }

  respondApproval(requestId: string, behavior: "allow" | "deny", updatedInput?: unknown, message?: string): boolean {
    const userInput = this.pendingUserInputs.get(requestId);
    if (userInput) {
      this.pendingUserInputs.delete(requestId);
      const answers = approvalAnswers(updatedInput) || {};
      const operation = behavior === "allow"
        ? this.session?.answerUserInput(userInput, answers)
        : this.session?.cancelUserInput(userInput);
      void operation?.catch((error) => this.emitEvent({ type: "error", message: String(error), at: now() }));
      this.emitEvent({ type: "approval_resolved", requestId, decision: behavior, answers, at: now() });
      this.patch({ pendingApprovalCount: this.pendingApprovals.size + this.pendingUserInputs.size });
      return true;
    }
    const approval = this.pendingApprovals.get(requestId);
    if (!approval) return false;
    const preferred = behavior === "allow"
      ? ["approved", "approvedForSession", "approvedPolicyAmendment"]
      : ["denied", "deniedPolicyAmendment", "abort"];
    const choice = preferred.map((decision) => approval.availableChoices.find((item) => item.decision === decision)).find(Boolean)
      || approval.availableChoices.find((item) => behavior === "allow" ? !/denied|abort/i.test(item.decision) : /denied|abort/i.test(item.decision));
    if (!choice) return false;
    this.pendingApprovals.delete(requestId);
    void this.session?.decideApproval(approval, choice.choiceId, choice.acceptsFeedback ? message : undefined)
      .catch((error) => this.emitEvent({ type: "error", message: String(error), at: now() }));
    this.emitEvent({ type: "approval_resolved", requestId, decision: behavior, at: now() });
    this.patch({ pendingApprovalCount: this.pendingApprovals.size + this.pendingUserInputs.size });
    return true;
  }

  private onServerRequest(method: string, params: any): void {
    if (method === "approval/request") {
      const request = params as MuseApprovalRequest;
      this.pendingApprovals.set(request.approvalId, request);
      let input: unknown = request.rawArgs;
      try { input = JSON.parse(request.rawArgs); } catch { input = { rawArgs: request.rawArgs }; }
      this.emitEvent({
        type: "approval_request",
        requestId: request.approvalId,
        toolName: request.toolName,
        input: { ...(input && typeof input === "object" ? input as object : { value: input }), subject: request.subject },
        title: request.toolName,
        description: approvalDescription(request.subject),
        suggestions: request.availableChoices,
        blockedPath: typeof request.subject?.path === "string" ? request.subject.path : undefined,
        at: now(),
      });
    } else if (method === "userInput/request") {
      const request = params as MuseUserInputRequest;
      this.pendingUserInputs.set(request.userInputId, request);
      this.emitEvent({
        type: "approval_request",
        requestId: request.userInputId,
        toolName: "AskUserQuestion",
        input: { questions: request.questions.map((question) => ({
          question: question.question,
          header: question.header,
          options: question.options,
          multiSelect: question.selection.mode === "multiple",
        })) },
        title: "Question",
        at: now(),
      });
    }
    this.patch({ pendingApprovalCount: this.pendingApprovals.size + this.pendingUserInputs.size });
  }

  private onNotification(method: string, params: any): void {
    switch (method) {
      case "turn/started":
        this.activeTurnId = String(params.turnId || "");
        this.patch({ status: "responding", turnState: "responding", turnCount: this.snapshot.turnCount + 1 });
        break;
      case "turn/completed":
        this.onTurnCompleted(params);
        break;
      case "item/started":
      case "item/updated":
      case "item/completed":
        this.onItem(method, params.item as MuseItem);
        break;
      case "item/delta":
        this.onItemDelta(params);
        break;
      case "session/statusChanged":
        this.patch({ status: params.status === "running" ? "responding" : String(params.status || "idle"), turnState: params.status === "running" ? "responding" : "idle" });
        break;
      case "session/modelChanged":
        if (params.model?.modelId || params.modelId) this.patch({ model: String(params.model?.modelId || params.modelId) });
        break;
      case "session/reasoningEffortChanged":
        this.desiredEffort = museEffort(params.reasoningEffort);
        this.patch({ effort: this.desiredEffort });
        break;
      case "session/contextUsage":
        this.patch({ contextTokens: numberOrUndefined(params.usedTokens), contextWindow: numberOrUndefined(params.windowTokens) });
        break;
      case "session/tokenUsage":
        this.turnUsage.set(String(params.turnId || ""), usageBreakdown(params));
        break;
      case "approval/resolved":
        this.pendingApprovals.delete(String(params.approvalId));
        this.emitEvent({ type: "approval_resolved", requestId: String(params.approvalId), decision: /denied|abort/i.test(String(params.decision)) ? "deny" : "allow", at: now() });
        this.patch({ pendingApprovalCount: this.pendingApprovals.size + this.pendingUserInputs.size });
        break;
      case "userInput/settled":
        this.pendingUserInputs.delete(String(params.userInputId));
        this.patch({ pendingApprovalCount: this.pendingApprovals.size + this.pendingUserInputs.size });
        break;
      case "skill/changed":
        void this.refreshSkills();
        break;
      case "view/gap":
        this.emitEvent({ type: "diagnostic", severity: "warning", category: "muse-view-gap", title: "Muse Code event gap", detail: "The harness reported a gap in its live event stream. Restart the member to reconcile its durable session history.", at: now() });
        break;
    }
  }

  private onItem(method: string, item: MuseItem): void {
    const previous = this.items.get(item.itemId);
    this.items.set(item.itemId, item);
    const streamed = this.streamed.get(item.itemId) || { text: 0, reasoning: 0, output: 0 };
    if (item.kind === "agentMessage") {
      const text = item.text || "";
      if (text.length > streamed.text) this.emitEvent({ type: "assistant_text_delta", text: text.slice(streamed.text), at: now() });
      streamed.text = text.length;
      this.patch({ lastAssistantMessageAt: now() });
    } else if (item.kind === "reasoning") {
      const text = [...(item.summary || []), item.text || ""].filter(Boolean).join("\n");
      if (text.length > streamed.reasoning) this.emitEvent({ type: "reasoning_delta", text: text.slice(streamed.reasoning), at: now() });
      streamed.reasoning = text.length;
    } else if (item.kind === "toolCall") {
      const input = parseJson(item.args);
      if (!previous || method === "item/started") {
        this.emitEvent({ type: "tool_call", id: item.itemId, name: item.tool || "tool", input, status: "started", at: now() });
      }
      if (item.background && item.status === "inProgress") this.backgroundItems.add(item.itemId);
      if (item.status !== "inProgress") {
        this.backgroundItems.delete(item.itemId);
        const status = item.status === "completed" ? "completed" : item.status === "rejected" ? "denied" : "failed";
        this.emitEvent({
          type: "tool_call", id: item.itemId, name: item.tool || "tool", input, status,
          result: item.visibleOutput || item.failureReason || item.fallbackText,
          exitCode: item.exitCode, durationMs: item.durationMs, at: now(),
        });
      }
      this.patch({ backgroundTaskCount: this.backgroundItems.size });
    } else if (item.kind === "compaction" && item.status !== "inProgress") {
      this.emitEvent({
        type: "compact_state",
        state: item.outcome === "failed" ? "failed" : "done",
        trigger: item.trigger === "auto" ? "auto" : "manual",
        preTokens: item.tokensBefore,
        postTokens: item.tokensAfter,
        reason: item.reason,
        at: now(),
      });
    }
    this.streamed.set(item.itemId, streamed);
  }

  private onItemDelta(params: any): void {
    const itemId = String(params.itemId || "");
    const item = this.items.get(itemId);
    if (!item) return;
    const delta = String(params.delta || "");
    const field = String(params.field || "text");
    const streamed = this.streamed.get(itemId) || { text: 0, reasoning: 0, output: 0 };
    if (item.kind === "agentMessage" && field === "text") {
      streamed.text += delta.length;
      this.emitEvent({ type: "assistant_text_delta", text: delta, at: now() });
      this.patch({ lastAssistantMessageAt: now() });
    } else if (item.kind === "reasoning" && (field === "text" || field.startsWith("summary."))) {
      streamed.reasoning += delta.length;
      this.emitEvent({ type: "reasoning_delta", text: delta, at: now() });
    } else if (item.kind === "toolCall" && field === "output") {
      streamed.output += delta.length;
      this.emitEvent({ type: "tool_call", id: itemId, name: item.tool || "tool", status: "started", outputDelta: delta, at: now() });
    }
    this.streamed.set(itemId, streamed);
  }

  private onTurnCompleted(params: any): void {
    const turnId = String(params.turnId || this.activeTurnId || "");
    const failed = params.terminal === "failed";
    if (failed) {
      const message = String(params.error?.message || params.reason || "Muse Code turn failed.");
      this.emitEvent({ type: "error", message, at: now(), ...(params.error?.kind === "authRequired" ? { environment: { checkId: "harness.muse", raw: message } } : {}) });
    }
    this.emitEvent({
      type: "turn_complete",
      result: String(params.terminal || "completed"),
      stopReason: params.reason || params.error?.kind,
      usage: this.turnUsage.get(turnId) || (params.usage ? usageBreakdown({ usage: params.usage }) : undefined),
      cost: { source: "muse", basis: "subscription", label: "Muse subscription" },
      at: now(),
    });
    this.turnUsage.delete(turnId);
    this.activeTurnId = undefined;
    this.patch({ status: failed ? "error" : "idle", turnState: "idle" });
  }

  private async refreshSkills(): Promise<void> {
    if (!this.session) return;
    try {
      const result = await this.session.listSkills();
      const slashCommands: HarnessCommand[] = Array.isArray(result?.skills) ? result.skills.map((skill: any) => ({
        name: String(skill.selector || ""),
        description: typeof skill.description === "string" ? skill.description : undefined,
        argumentHint: typeof skill.argumentHint === "string" ? skill.argumentHint : undefined,
        source: typeof skill.source === "string" ? skill.source : "skill",
      })).filter((skill: HarnessCommand) => skill.name) : [];
      this.patch({ slashCommands });
    } catch (error) {
      this.emitEvent({ type: "diagnostic", severity: "warning", category: "muse-skills", title: "Muse Code skills could not be loaded", detail: String(error), at: now() });
    }
  }

  private emitEvent(event: ClaudeNormalizedEvent): void {
    this.snapshot.lastEventAt = event.at;
    this.emit("event", event);
  }

  private patch(patch: Partial<ClaudeSessionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.emit("snapshot", this.getSnapshot());
  }

  private emitSpawn(state: "starting" | "running" | "failed", error?: unknown, model?: string): void {
    const failure = state === "failed" ? spawnFailureSummary(error) : undefined;
    this.emitEvent({
      type: "session_spawn",
      state,
      harness: "muse",
      model: model || this.desiredModel,
      host: currentSpawnHost(),
      cwd: shortCwd(this.options.cwd),
      reason: failure?.reason,
      retryable: failure?.retryable,
      at: now(),
    });
  }
}

function parseJson(value: string | undefined): unknown {
  if (!value) return undefined;
  try { return JSON.parse(value); } catch { return value; }
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function usageBreakdown(params: any): TurnTokenBreakdown {
  const usage = params?.usage || {};
  const cacheRead = numberOrUndefined(usage.cacheReadTokens);
  const cacheWrite = numberOrUndefined(usage.cacheWriteTokens);
  const prompt = numberOrUndefined(params?.promptTokens) ?? numberOrUndefined(usage.inputTokens);
  const input = prompt == null ? undefined : Math.max(0, prompt - (cacheRead || 0) - (cacheWrite || 0));
  return {
    input,
    cacheRead,
    cacheWrite,
    output: numberOrUndefined(usage.outputTokens),
  };
}

function approvalDescription(subject: Record<string, unknown> | undefined): string | undefined {
  if (!subject) return undefined;
  return [subject.command, subject.path, subject.target, subject.host].find((value) => typeof value === "string") as string | undefined;
}
