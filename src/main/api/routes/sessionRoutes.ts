import { SESSION_ACTION_NAMES } from "../../application/sessionActions";
import type { MethodRoute } from "../methodRegistry";
import { camelAction, text } from "../methodRegistry";

/** The MCP sub-actions `sessionMcpAction` dispatches. */
const MCP_ACTIONS = ["reconnect", "toggle", "authenticate"] as const;

/**
 * Sessions are addressed globally by id; the workspace only picks which engine
 * owns them. The per-action endpoints are expanded from the action tables so the
 * HTTP surface, the RPC catalog, and the dispatcher cannot drift apart.
 */
export const sessionRoutes: MethodRoute[] = [
  {
    name: "session.create",
    http: "POST /api/sessions",
    handler: (p, ctx) => ctx.controller.createSession(ctx.workspace, p),
  },
  {
    name: "session.history",
    http: "GET /api/sessions/history",
    handler: (_p, ctx) => ctx.controller.listResumableSessions(ctx.workspace),
  },
  {
    name: "session.resume",
    http: "POST /api/sessions/resume",
    handler: (p, ctx) => ctx.controller.resumeSession(text(p.workspacePath, ctx.workspace), text(p.sessionId)),
  },
  {
    name: "session.mcp",
    http: "GET /api/sessions/:id/mcp",
    handler: (p, ctx) => ctx.controller.listSessionMcpServers(ctx.workspace, text(p.id)),
  },
  ...MCP_ACTIONS.map((action): MethodRoute => ({
    name: `session.mcp${action[0].toUpperCase()}${action.slice(1)}`,
    http: `POST /api/sessions/:id/mcp/${action}`,
    handler: (p, ctx) => ctx.controller.sessionMcpAction(ctx.workspace, text(p.id), action, p),
  })),
  ...SESSION_ACTION_NAMES.map((action): MethodRoute => ({
    name: `session.${camelAction(action)}`,
    http: `POST /api/sessions/:id/${action}`,
    handler: (p, ctx) => ctx.controller.handleSessionAction(ctx.workspace, text(p.id), action, p),
  })),
];
