import type { EngineConnection } from "../engine/engineConnection";
import type { CodexPolicy } from "../../shared/codexPolicy";
import type { CursorPolicy } from "../../shared/cursorPolicy";
import { sanitizeAttachments } from "../../shared/attachments";

export type SessionActionName =
  | "send"
  | "interrupt"
  | "force-stop"
  | "close"
  | "restart"
  | "compact"
  | "model"
  | "effort"
  | "thinking"
  | "permission"
  | "codex-policy"
  | "cursor-policy"
  | "approve";

type SessionActionHandler = (engine: EngineConnection, sessionId: string, body: any) => Promise<unknown>;

const SESSION_ACTIONS: Record<SessionActionName, SessionActionHandler> = {
  send: (engine, sessionId, body) => engine.sendUserTurn(sessionId, String(body.text || ""), sanitizeAttachments(body.attachments)),
  interrupt: (engine, sessionId) => engine.interruptSession(sessionId),
  "force-stop": (engine, sessionId) => engine.forceStopSession(sessionId),
  close: (engine, sessionId) => engine.closeSession(sessionId),
  restart: (engine, sessionId) => engine.restartSession(sessionId),
  compact: (engine, sessionId) => engine.compactSession(sessionId),
  model: (engine, sessionId, body) => engine.setSessionModel(sessionId, String(body.model || ""), body.providerId, body.runtimeModel),
  effort: (engine, sessionId, body) => engine.setSessionEffort(sessionId, String(body.effort || "")),
  thinking: (engine, sessionId, body) => engine.setSessionThinking(sessionId, String(body.mode || ""), typeof body.budget === "number" ? body.budget : undefined),
  permission: (engine, sessionId, body) => engine.setSessionPermissionMode(sessionId, String(body.permissionMode || "")),
  "codex-policy": (engine, sessionId, body) => engine.setSessionCodexPolicy(sessionId, body.policy as CodexPolicy),
  "cursor-policy": (engine, sessionId, body) => engine.setSessionCursorPolicy(sessionId, body.policy as CursorPolicy),
  approve: (engine, sessionId, body) => engine.approveSession(sessionId, String(body.requestId || ""), body.behavior, body.updatedInput, body.message),
};

/**
 * The complete action list, in declaration order. The API route table expands
 * this into one endpoint + one RPC method per action, so adding an action here
 * publishes it everywhere instead of needing a matching route edit.
 */
export const SESSION_ACTION_NAMES = Object.keys(SESSION_ACTIONS) as SessionActionName[];

/**
 * Runs one named session action and returns whatever it produced. Most produce
 * nothing; `approve` returns whether the harness actually took the answer, which
 * the caller must not discard — see `src/shared/approvals.ts`.
 */
export async function runSessionAction(engine: EngineConnection, sessionId: string, action: string, body: any): Promise<unknown> {
  const handler = SESSION_ACTIONS[action as SessionActionName];
  if (!handler) {
    throw new Error(`Unknown session action '${action}'.`);
  }
  return handler(engine, sessionId, body || {});
}
