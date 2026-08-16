import { readJson, sendJson } from "./http";
import type { AutomationRouteContext } from "./routeContext";

/**
 * QA scaffolding is deliberately NOT in the capability table: it fakes state
 * instead of performing it, and it is unreachable over the mobile link. It still
 * belongs in `GET /api/spec` so a QA agent can discover it, hence this list.
 */
export const QA_ENDPOINTS = [
  "POST /api/qa/seed",
  "POST /api/qa/members",
  "POST /api/qa/members/:name/kill-harness",
  "POST /api/qa/members/:name/emit",
  "POST /api/qa/members/:name/subagents",
  "POST /api/qa/members/:name/subagents/open",
  "POST /api/qa/members/:name/interaction",
  "POST /api/qa/gate/open",
  "POST /api/qa/mobile/:action",
  "POST /api/qa/open",
  "POST /api/qa/input",
  "POST /api/qa/window/bounds",
  "POST /api/qa/usage",
  "POST /api/qa/design-gallery",
  "POST /api/qa/environment",
  "POST /api/qa/update",
  "POST /api/qa/reset",
] as const;

/** Handles the QA-only automation surface. Call only for `/api/qa/*` paths. */
export async function handleQaRoute(context: AutomationRouteContext): Promise<void> {
  const { method, url, req, res, controller: c, workspace, windowId } = context;
  if (!c.isQaEnabled()) {
    sendJson(res, 403, {
      error: "qa_disabled",
      detail: "Launch with AGENTPARTY_QA=1 (or E2E mode) to use /api/qa/*.",
    });
    return;
  }
  if (method === "POST" && url.pathname === "/api/qa/seed") {
    sendJson(res, 200, await c.qaSeed(workspace, await readJson(req)));
    return;
  }
  if (method === "POST" && url.pathname === "/api/qa/members") {
    sendJson(res, 200, await c.qaCreateMockMember(workspace, await readJson(req)));
    return;
  }
  if (method === "POST" && url.pathname === "/api/qa/open") {
    const body = await readJson(req);
    sendJson(res, 200, c.qaOpen(windowId, Array.isArray(body.panels) ? body.panels : []));
    return;
  }
  if (method === "POST" && url.pathname === "/api/qa/usage") {
    sendJson(res, 200, c.qaEmitUsage(await readJson(req)));
    return;
  }
  if (method === "POST" && url.pathname === "/api/qa/input") {
    sendJson(res, 200, await c.qaInput(windowId, await readJson(req)));
    return;
  }
  if (method === "POST" && url.pathname === "/api/qa/window/bounds") {
    sendJson(res, 200, c.qaWindowBounds(windowId, await readJson(req)));
    return;
  }
  if (method === "POST" && url.pathname === "/api/qa/design-gallery") {
    sendJson(res, 200, await c.qaDesignGallery(workspace));
    return;
  }
  // Stands a fixed environment report in for the real probe, so the 환경 screen
  // and the blocker cards can be reviewed without breaking the reviewer's
  // machine. `{"reset":true}` puts the real probe back.
  if (method === "POST" && url.pathname === "/api/qa/environment") {
    sendJson(res, 200, c.qaEnvironment(await readJson(req)));
    return;
  }
  // Pins an app-update status so the update pill/modal can be reviewed without
  // publishing a release (a dev run cannot self-update at all). Body is a
  // partial UpdateStatus; `{"reset":true}` restores the real updater.
  if (method === "POST" && url.pathname === "/api/qa/update") {
    const body = await readJson(req);
    sendJson(res, 200, c.setMockUpdateStatus(body?.reset ? undefined : body));
    return;
  }
  if (method === "POST" && url.pathname === "/api/qa/reset") {
    sendJson(res, 200, await c.qaReset(workspace));
    return;
  }
  const killHarnessMatch = url.pathname.match(/^\/api\/qa\/members\/([^/]+)\/kill-harness$/);
  if (method === "POST" && killHarnessMatch) {
    sendJson(res, 200, await c.qaKillHarness(workspace, decodeURIComponent(killHarnessMatch[1])));
    return;
  }
  const emitMatch = url.pathname.match(/^\/api\/qa\/members\/([^/]+)\/emit$/);
  if (method === "POST" && emitMatch) {
    sendJson(res, 200, await c.qaEmit(workspace, decodeURIComponent(emitMatch[1]), await readJson(req)));
    return;
  }
  const subagentsMatch = url.pathname.match(/^\/api\/qa\/members\/([^/]+)\/subagents$/);
  if (method === "POST" && subagentsMatch) {
    sendJson(res, 200, await c.qaEmitSubagents(workspace, decodeURIComponent(subagentsMatch[1]), await readJson(req)));
    return;
  }
  const openSubagentMatch = url.pathname.match(/^\/api\/qa\/members\/([^/]+)\/subagents\/open$/);
  if (method === "POST" && openSubagentMatch) {
    const body = await readJson(req);
    sendJson(res, 200, c.qaOpenSubagent(
      windowId,
      decodeURIComponent(openSubagentMatch[1]),
      String(body?.subId || ""),
    ));
    return;
  }
  const interactionMatch = url.pathname.match(/^\/api\/qa\/members\/([^/]+)\/interaction$/);
  if (method === "POST" && interactionMatch) {
    sendJson(res, 200, await c.qaInteraction(
      workspace,
      decodeURIComponent(interactionMatch[1]),
      await readJson(req),
    ));
    return;
  }
  // Phone simulator for the mock mobile gateway — the only way HTTP can act as
  // the phone (scan, dial in, subscribe, call a method).
  const mobileMatch = url.pathname.match(/^\/api\/qa\/mobile\/([^/]+)$/);
  if (method === "POST" && mobileMatch) {
    sendJson(res, 200, await c.qaMobileSimulate(decodeURIComponent(mobileMatch[1]), await readJson(req)));
    return;
  }
  if (method === "POST" && url.pathname === "/api/qa/gate/open") {
    const body = await readJson(req);
    sendJson(res, 200, c.qaOpenGate(
      windowId,
      body?.kind === "party" ? "party" : "member",
      String(body?.member || ""),
    ));
    return;
  }
  sendJson(res, 404, { error: "not_found" });
}

