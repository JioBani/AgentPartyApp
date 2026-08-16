import type { MethodRoute } from "../methodRegistry";
import { tokenUsageQueryFrom, tokenUsageTurnsQueryFrom } from "../tokenUsageQueries";

/** Model catalogs plus the two usage reads: provider rate limits and token spend. */
export const modelRoutes: MethodRoute[] = [
  {
    name: "models.list",
    http: "GET /api/models",
    handler: (_p, ctx) => ctx.controller.listModels(ctx.workspace),
  },
  {
    name: "harness.cursorStatus",
    http: "GET /api/harnesses/cursor/status",
    handler: (_p, ctx) => ctx.controller.getCursorHarnessStatus(ctx.workspace),
  },
  {
    name: "models.refreshCodex",
    http: "POST /api/models/codex/refresh",
    handler: (_p, ctx) => ctx.controller.refreshCodexModels(ctx.workspace),
  },
  {
    // Account-global provider rate limits — no workspace scope.
    name: "usage.get",
    http: "GET /api/usage",
    handler: (_p, ctx) => ctx.controller.getUsageLimits(),
  },
  {
    name: "usage.refresh",
    http: "POST /api/usage/refresh",
    handler: (_p, ctx) => ctx.controller.refreshUsageLimits(),
  },
  {
    name: "tokenUsage.get",
    http: "GET /api/token-usage",
    handler: (p, ctx) => ctx.controller.getTokenUsage(ctx.workspace, tokenUsageQueryFrom(p)),
  },
  {
    name: "tokenUsage.turns",
    http: "GET /api/token-usage/turns",
    handler: (p, ctx) => ctx.controller.getTokenUsageTurns(ctx.workspace, tokenUsageTurnsQueryFrom(p)),
  },
];
