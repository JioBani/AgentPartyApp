import { EventEmitter } from "node:events";
import type { ClaudeNormalizedEvent, ClaudeSessionSnapshot } from "../../core/events";
import type { HarnessSession } from "./types";

/** Distributes `Omit` across the event union so each member keeps its own keys. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A normalized event with an optional `at` (the mock stamps it if missing). */
type EventInput = DistributiveOmit<ClaudeNormalizedEvent, "at"> & { at?: string };

export interface MockHarnessOptions {
  id: string;
  cwd: string;
  model: string;
  effort: string;
  permissionMode: string;
  /** When true, a user turn auto-produces a canned reply (nice for manual QA). */
  autoReply?: boolean;
}

/**
 * A fake harness session that satisfies the same `HarnessSession` contract as
 * the real `ClaudeAdapter`, but is driven by QA API calls instead of a model
 * process. Because it emits the same normalized events through the same
 * SessionManager path, the renderer cannot tell it apart from a live session —
 * which is exactly what makes it useful for end-to-end frontend QA.
 *
 * It performs no network/model calls and is only ever created in QA mode.
 */
export class MockHarnessSession extends EventEmitter implements HarnessSession {
  private snapshot: ClaudeSessionSnapshot;
  private disposed = false;
  private timers = new Set<NodeJS.Timeout>();
  private autoReply: boolean;

  constructor(options: MockHarnessOptions) {
    super();
    this.autoReply = options.autoReply ?? true;
    this.snapshot = {
      id: options.id,
      cwd: options.cwd,
      sessionId: `mock-${options.id}`,
      model: options.model,
      effort: options.effort as ClaudeSessionSnapshot["effort"],
      permissionMode: options.permissionMode,
      status: "idle",
      startedAt: new Date().toISOString(),
      debugMode: false,
      turnCount: 0,
      queuedTurnCount: 0,
      pendingApprovalCount: 0,
    };
  }

  start(): void {
    this.emitEvent({ type: "session", sessionId: this.snapshot.sessionId || this.snapshot.id, model: this.snapshot.model, permissionMode: this.snapshot.permissionMode, at: now() });
    this.pushSnapshot();
  }

  /** Streams a normalized event to the renderer and updates derived snapshot state. */
  inject(partial: EventInput): void {
    if (this.disposed) {
      return;
    }
    const event = { ...partial, at: partial.at || now() } as ClaudeNormalizedEvent;
    switch (event.type) {
      case "assistant_text_delta":
      case "reasoning_delta":
      case "tool_call":
        this.snapshot.status = "responding";
        break;
      case "approval_request":
        this.snapshot.pendingApprovalCount = (this.snapshot.pendingApprovalCount || 0) + 1;
        break;
      case "approval_resolved":
        this.snapshot.pendingApprovalCount = Math.max(0, (this.snapshot.pendingApprovalCount || 0) - 1);
        break;
      case "turn_complete":
        this.snapshot.status = "idle";
        this.snapshot.turnCount += 1;
        break;
      default:
        break;
    }
    this.snapshot.lastEventAt = event.at;
    this.emitEvent(event);
    this.pushSnapshot();
  }

  /** Sets the busy/idle state without adding a transcript line. */
  setStatus(status: string): void {
    this.snapshot.status = status;
    this.snapshot.lastEventAt = now();
    this.pushSnapshot();
  }

  sendUserTurn(text: string): void {
    this.snapshot.lastUserMessageAt = now();
    if (!this.autoReply) {
      this.pushSnapshot();
      return;
    }
    this.setStatus("responding");
    this.schedule(() => {
      this.inject({ type: "assistant_text_delta", text: `(mock) "${truncate(text)}" 잘 받았습니다. QA 응답입니다.` });
    }, 350);
    this.schedule(() => {
      this.inject({ type: "turn_complete", result: "ok", stopReason: "end_turn" });
    }, 700);
  }

  interrupt(): void {
    this.setStatus("idle");
    this.inject({ type: "status", status: "interrupted", at: now() });
  }

  restart(): void {
    this.snapshot.turnCount = 0;
    this.snapshot.pendingApprovalCount = 0;
    this.setStatus("idle");
    this.inject({ type: "status", status: "restarted", at: now() });
  }

  compact(): void {
    this.inject({ type: "status", status: "compacted", at: now() });
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.removeAllListeners();
  }

  getSnapshot(): ClaudeSessionSnapshot {
    return this.snapshot;
  }

  setDebugMode(enabled: boolean): void {
    this.snapshot.debugMode = enabled;
    this.pushSnapshot();
  }

  setModel(model: string): void {
    this.snapshot.model = model;
    this.pushSnapshot();
  }

  setEffort(effort: string): void {
    this.snapshot.effort = effort as ClaudeSessionSnapshot["effort"];
    this.pushSnapshot();
  }

  setPermissionMode(permissionMode: string): void {
    this.snapshot.permissionMode = permissionMode;
    this.pushSnapshot();
  }

  respondApproval(requestId: string, behavior: "allow" | "deny"): void {
    this.inject({ type: "approval_resolved", requestId, decision: behavior, at: now() });
  }

  private schedule(fn: () => void, delay: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, delay);
    this.timers.add(timer);
  }

  private emitEvent(event: ClaudeNormalizedEvent): void {
    this.emit("event", event);
  }

  private pushSnapshot(): void {
    this.emit("snapshot", { ...this.snapshot });
  }
}

function now(): string {
  return new Date().toISOString();
}

function truncate(text: string): string {
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}
