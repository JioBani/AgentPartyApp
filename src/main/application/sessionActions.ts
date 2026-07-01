import type { EngineConnection } from "../engine/engineConnection";

export type SessionActionName =
  | "send"
  | "interrupt"
  | "close"
  | "restart"
  | "compact"
  | "model"
  | "effort"
  | "thinking"
  | "permission"
  | "approve";

type SessionActionHandler = (engine: EngineConnection, sessionId: string, body: any) => Promise<unknown>;

const SESSION_ACTIONS: Record<SessionActionName, SessionActionHandler> = {
  send: (engine, sessionId, body) => engine.sendUserTurn(sessionId, String(body.text || "")),
  interrupt: (engine, sessionId) => engine.interruptSession(sessionId),
  close: (engine, sessionId) => engine.closeSession(sessionId),
  restart: (engine, sessionId) => engine.restartSession(sessionId),
  compact: (engine, sessionId) => engine.compactSession(sessionId),
  model: (engine, sessionId, body) => engine.setSessionModel(sessionId, String(body.model || ""), body.providerId, body.runtimeModel),
  effort: (engine, sessionId, body) => engine.setSessionEffort(sessionId, String(body.effort || "")),
  thinking: (engine, sessionId, body) => engine.setSessionThinking(sessionId, String(body.mode || ""), typeof body.budget === "number" ? body.budget : undefined),
  permission: (engine, sessionId, body) => engine.setSessionPermissionMode(sessionId, String(body.permissionMode || "")),
  approve: (engine, sessionId, body) => engine.approveSession(sessionId, String(body.requestId || ""), body.behavior, body.updatedInput, body.message),
};

export async function runSessionAction(engine: EngineConnection, sessionId: string, action: string, body: any): Promise<void> {
  const handler = SESSION_ACTIONS[action as SessionActionName];
  if (!handler) {
    throw new Error(`Unknown session action '${action}'.`);
  }
  await handler(engine, sessionId, body || {});
}
