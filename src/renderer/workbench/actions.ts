import type { RouteLike } from "./routes";

/**
 * Command surface a panel needs, addressed by member name. The App shell maps
 * each member to its live session and the right IPC call, so workbench
 * components never touch `window.agentParty` directly.
 */
export interface WorkbenchActions {
  /** Sends a turn to the member, starting its session first if needed. */
  sendMessage(memberName: string, text: string): void | Promise<void>;
  approve(memberName: string, requestId: string, behavior: "allow" | "deny"): void;
  interrupt(memberName: string): void;
  restart(memberName: string): void;
  compact(memberName: string): void;
  applyRuntime(memberName: string, runtime: { route?: RouteLike; effort: string; thinking: boolean; debug: boolean }): void | Promise<void>;
  setEffort(memberName: string, effort: string): void;
  setPermissionMode(memberName: string, mode: string): void;
}
