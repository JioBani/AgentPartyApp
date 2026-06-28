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
  /**
   * Answers an AskUserQuestion interaction: allows the tool with the chosen
   * answers folded into its input (`answers` = question text -> selected label),
   * which is the shape the SDK expects to feed the model.
   */
  answerQuestion(memberName: string, requestId: string, input: unknown, answers: Record<string, string>): void;
  interrupt(memberName: string): void;
  restart(memberName: string): void;
  compact(memberName: string): void;
  applyRuntime(memberName: string, runtime: { route?: RouteLike; effort?: string; thinkingMode?: string; thinkingBudget?: number; debug: boolean }): void | Promise<void>;
  setEffort(memberName: string, effort: string): void;
  setThinking(memberName: string, mode: string, budget?: number): void;
  setPermissionMode(memberName: string, mode: string): void;
}
