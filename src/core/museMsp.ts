import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as readline from "node:readline";
import type { ImageAttachment } from "../shared/attachments";

export type MuseMcpServer = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

export interface MuseItem {
  itemId: string;
  kind: string;
  status: string;
  revision: number;
  turnId?: string | null;
  text?: string;
  summary?: string[];
  tool?: string;
  args?: string;
  visibleOutput?: string;
  exitCode?: number;
  durationMs?: number;
  failureReason?: string;
  failureKind?: string;
  background?: boolean;
  fallbackText?: string;
  outcome?: string;
  trigger?: string;
  tokensBefore?: number;
  tokensAfter?: number;
  reason?: string;
  subagentId?: string;
  role?: string;
  objective?: string;
  controlStatus?: string;
  result?: { summary?: string; text?: string };
}

export interface MuseApprovalRequest {
  approvalId: string;
  sessionId: string;
  itemId: string;
  toolName: string;
  rawArgs: string;
  subject: Record<string, unknown>;
  currentRequirementId: { approvalId: string; sourceIndex: number };
  availableChoices: Array<{
    choiceId: string;
    decision: string;
    label: string;
    scope: string;
    acceptsFeedback?: boolean;
    rulePreview?: string;
  }>;
}

export interface MuseUserInputRequest {
  userInputId: string;
  sessionId: string;
  itemId: string;
  toolName: string;
  questions: Array<{
    id: string;
    header: string;
    question: string;
    options: Array<{ label: string; description?: string }>;
    selection: { mode: "single" | "multiple"; minSelections?: number; maxSelections?: number };
  }>;
}

export interface MuseSessionState {
  sessionId: string;
  status: string;
  activeTurnId?: string | null;
  modelId?: string | null;
  providerId?: string | null;
  approvalMode?: { mode?: string };
}

export interface MuseStartResult {
  session: MuseSessionState;
  history?: { items?: MuseItem[] | null };
}

export interface MuseMspOptions {
  command: string;
  cwd: string;
  resumeSessionId?: string;
  modelId?: string;
  approvalMode: "allowAll" | "promptUnmatched" | "onRequest" | "denyUnmatched";
  mcpServers?: Record<string, MuseMcpServer>;
  onNotification: (method: string, params: any) => void;
  onServerRequest: (method: string, params: any) => void;
  onExit: (error: Error) => void;
}

type Pending = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export function museCommandId(): string {
  const bytes = randomBytes(16);
  let time = BigInt(Date.now());
  for (let i = 5; i >= 0; i -= 1) {
    bytes[i] = Number(time & 0xffn);
    time >>= 8n;
  }
  bytes[6] = 0x70 | (bytes[6] & 0x0f);
  bytes[8] = 0x80 | (bytes[8] & 0x3f);
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class MuseMspSession {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private stderr = "";
  private closed = false;
  sessionId = "";

  constructor(private readonly options: MuseMspOptions) {}

  async start(): Promise<MuseStartResult> {
    const child = spawn(this.options.command, ["serve", "--trust-workspace"], {
      cwd: this.options.cwd,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    readline.createInterface({ input: child.stdout }).on("line", (line) => this.onLine(line));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-16_000);
    });
    child.once("error", (error) => this.failAll(error));
    child.once("exit", (code, signal) => {
      if (this.closed) return;
      const detail = this.stderr.trim();
      const error = new Error(`Muse Code MSP exited (${code ?? signal ?? "unknown"})${detail ? `: ${detail}` : ""}`);
      this.failAll(error);
      this.options.onExit(error);
    });

    await this.request("initialize", {
      clientInfo: { name: "agentparty", title: "AgentParty", version: "0.0.0" },
      capabilities: { requestedCapabilities: ["sessionMcp"], userInputDialogs: true },
    }, 30_000);
    this.notify("initialized", {});

    const config = this.options.mcpServers && Object.keys(this.options.mcpServers).length
      ? { mcpServers: Object.fromEntries(Object.entries(this.options.mcpServers).map(([name, server]) => [name, {
          transport: "stdio",
          command: server.command,
          args: server.args,
          env: server.env,
          mode: "required",
          framing: "auto",
        }])) }
      : undefined;

    const result = this.options.resumeSessionId
      ? await this.request("session/resume", {
          commandId: museCommandId(),
          sessionId: this.options.resumeSessionId,
          history: "auto",
          config,
        }, 60_000)
      : await this.request("session/start", {
          commandId: museCommandId(),
          workspaceRoot: this.options.cwd,
          approvalMode: this.options.approvalMode,
          ...(this.options.modelId ? { modelId: this.options.modelId } : {}),
          config,
        }, 60_000);
    this.sessionId = String(result?.session?.sessionId || this.options.resumeSessionId || "");
    if (!this.sessionId) throw new Error("Muse Code MSP did not return a session id.");
    return result as MuseStartResult;
  }

  async startTurn(text: string, effort: string, attachments?: ImageAttachment[]): Promise<{ turnId: string }> {
    const input: Array<Record<string, unknown>> = [{ type: "text", text }];
    for (const image of attachments || []) {
      input.push({ type: "image", mediaType: image.mediaType, base64Data: image.dataBase64 });
    }
    return this.request("turn/start", {
      commandId: museCommandId(),
      sessionId: this.sessionId,
      input,
      displayText: text,
      reasoningEffort: effort,
      ifBusy: "queue",
    });
  }

  interrupt(turnId?: string): Promise<unknown> {
    return this.request("turn/interrupt", { commandId: museCommandId(), sessionId: this.sessionId, turnId, retract: false });
  }

  compact(): Promise<unknown> {
    return this.request("session/compact", { commandId: museCommandId(), sessionId: this.sessionId }, 60_000);
  }

  setModel(modelId: string): Promise<unknown> {
    return this.request("session/setModel", {
      commandId: museCommandId(),
      sessionId: this.sessionId,
      model: { modelId },
    });
  }

  setEffort(reasoningEffort: string): Promise<unknown> {
    return this.request("session/setReasoningEffort", {
      commandId: museCommandId(), sessionId: this.sessionId, reasoningEffort,
    });
  }

  setApprovalMode(mode: MuseMspOptions["approvalMode"]): Promise<unknown> {
    return this.request("session/setApprovalMode", {
      commandId: museCommandId(), sessionId: this.sessionId, mode,
    });
  }

  decideApproval(request: MuseApprovalRequest, choiceId: string, feedback?: string): Promise<unknown> {
    return this.request("approval/decide", {
      commandId: museCommandId(),
      sessionId: this.sessionId,
      approvalId: request.approvalId,
      requirementId: request.currentRequirementId,
      choiceId,
      ...(feedback ? { feedback } : {}),
    });
  }

  answerUserInput(request: MuseUserInputRequest, answers: Record<string, string>): Promise<unknown> {
    return this.request("userInput/answer", {
      commandId: museCommandId(),
      sessionId: this.sessionId,
      userInputId: request.userInputId,
      answers: request.questions.map((question) => {
        const value = answers[question.question] || answers[question.id] || "";
        const labels = value.split(",").map((part) => part.trim()).filter(Boolean);
        const known = labels.every((label) => question.options.some((option) => option.label === label));
        if (!known || question.options.length === 0) return { questionId: question.id, freeText: value };
        return question.selection.mode === "multiple"
          ? { questionId: question.id, selectedLabels: labels }
          : { questionId: question.id, selectedLabel: labels[0] };
      }),
    });
  }

  cancelUserInput(request: MuseUserInputRequest): Promise<unknown> {
    return this.request("userInput/cancel", {
      commandId: museCommandId(), sessionId: this.sessionId, userInputId: request.userInputId,
    });
  }

  listSkills(): Promise<any> { return this.request("skill/list", { sessionId: this.sessionId }); }

  listPending(): Promise<{ approvals?: MuseApprovalRequest[]; userInputs?: MuseUserInputRequest[] }> {
    return this.request("approval/listPending", { sessionId: this.sessionId });
  }

  readUsage(): Promise<{ usage?: unknown }> {
    return this.request("usage/read", {});
  }

  dispose(): void {
    this.closed = true;
    this.failAll(new Error("Muse Code MSP session disposed."));
    if (!this.child) return;
    try {
      this.child.stdin.end();
      this.child.kill("SIGTERM");
    } catch {
      // Process already exited.
    }
    this.child = undefined;
  }

  private request(method: string, params: unknown, timeoutMs = 30_000): Promise<any> {
    if (!this.child?.stdin.writable) return Promise.reject(new Error("Muse Code MSP is not running."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Muse Code MSP timed out on ${method}.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(message: unknown): void {
    this.child?.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onLine(line: string): void {
    let message: any;
    try {
      message = JSON.parse(line.replace(/\r$/, ""));
    } catch {
      return;
    }
    if (message.id != null && (message.result !== undefined || message.error !== undefined) && !message.method) {
      const pending = this.pending.get(Number(message.id));
      if (!pending) return;
      this.pending.delete(Number(message.id));
      clearTimeout(pending.timer);
      if (message.error) {
        const detail = message.error.data ? ` ${JSON.stringify(message.error.data)}` : "";
        pending.reject(new Error(`${message.error.message || "Muse Code MSP request failed."}${detail}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method && message.id != null) {
      this.options.onServerRequest(String(message.method), message.params || {});
      this.write({ jsonrpc: "2.0", id: message.id, result: {} });
      return;
    }
    if (message.method) this.options.onNotification(String(message.method), message.params || {});
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
