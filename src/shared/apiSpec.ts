export const automationEndpoints = [
  "GET /api/health",
  "GET /api/spec",
  "GET /api/state",
  "GET /api/logs",
  "POST /api/capture",
  "POST /api/settings",
  "POST /api/auth/openrouter",
  "DELETE /api/auth/openrouter",
  "POST /api/auth/openrouter/test",
  "POST /api/sessions",
  "GET /api/sessions/history",
  "POST /api/sessions/resume",
  "POST /api/sessions/:id/send",
  "POST /api/sessions/:id/close",
  "POST /api/sessions/:id/interrupt",
  "POST /api/sessions/:id/restart",
  "POST /api/sessions/:id/compact",
  "POST /api/sessions/:id/model",
  "POST /api/sessions/:id/effort",
  "POST /api/sessions/:id/thinking",
  "POST /api/sessions/:id/permission",
  "POST /api/sessions/:id/codex-policy",
  "POST /api/sessions/:id/approve",
  "GET /api/party",
  "POST /api/parties",
  "POST /api/parties/:id/select",
  "POST /api/party/messages",
  "POST /api/party/members",
  "POST /api/party/members/:name/send",
  "POST /api/party/members/:name/open",
  "POST /api/party/members/:name/start",
  "POST /api/party/members/:name/resume",
  "POST /api/party/members/:name/bind",
  "POST /api/party/members/:name/close",
  "POST /api/party/members/:name/remove",
  "GET /api/harness/party",
  "POST /api/harness/party/messages",
  "GET /api/windows",
  "POST /api/windows",
  "POST /api/windows/:id/workspace",
  "POST /api/window/minimize",
  "POST /api/window/maximize",
  "POST /api/window/close",
  "POST /api/navigation",
  "POST /api/qa/seed",
  "POST /api/qa/members",
  "POST /api/qa/members/:name/emit",
  "POST /api/qa/members/:name/interaction",
  "POST /api/qa/open",
  "POST /api/qa/reset",
] as const;

export interface AutomationApiSpec {
  version: 1;
  baseUrl: string;
  endpoints: readonly string[];
}

export function automationApiSpec(baseUrl: string): AutomationApiSpec {
  return {
    version: 1,
    baseUrl,
    endpoints: automationEndpoints,
  };
}
