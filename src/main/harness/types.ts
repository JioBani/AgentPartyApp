import { EventEmitter } from "node:events";
import { ClaudeNormalizedEvent, ClaudeSessionSnapshot } from "../../core/events";

export type HarnessId = "claude-code" | "codex";

export interface HarnessSession extends EventEmitter {
  start(): void;
  sendUserTurn(text: string): void;
  interrupt(): void;
  restart(): void;
  compact(): void;
  dispose(): void;
  getSnapshot(): ClaudeSessionSnapshot;
  setDebugMode(enabled: boolean): void;
  setModel(model: string, providerId?: string, runtimeModel?: string): void;
  setEffort(effort: string): void;
  setThinking(mode: string, budget?: number): void;
  setPermissionMode(permissionMode: string): void;
  respondApproval(requestId: string, behavior: "allow" | "deny", updatedInput?: unknown, message?: string): void;
  on(event: "event", listener: (event: ClaudeNormalizedEvent) => void): this;
  on(event: "snapshot", listener: (snapshot: ClaudeSessionSnapshot) => void): this;
}

export interface HarnessDescriptor {
  id: HarnessId;
  label: string;
  status: "available" | "planned";
  description: string;
}

export const harnesses: HarnessDescriptor[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    status: "available",
    description: "Primary local harness backed by the Claude Code SDK.",
  },
  {
    id: "codex",
    label: "Codex",
    status: "planned",
    description: "Reserved for a Codex CLI/runtime adapter behind the same session contract.",
  },
];
