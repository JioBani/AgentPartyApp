import * as http from "node:http";
import * as net from "node:net";
import { automationApiSpec } from "../shared/apiSpec";
import { sanitizeAttachments } from "../shared/attachments";
import { log } from "./logger";
import type { AppController } from "./application/appController";
import type { WindowRegistry } from "./windowRegistry";

export interface AutomationApiDeps {
  port: number;
  controller: AppController;
  windowRegistry: WindowRegistry;
}

export class AutomationApiServer {
  private server: http.Server | undefined;
  private port = 0;

  constructor(private readonly deps: AutomationApiDeps) {}

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port || this.deps.port}`;
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }
    this.server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    this.port = await listen(this.server, this.deps.port);
    log("info", "api", "automation api started", { baseUrl: this.baseUrl });
  }

  dispose(): void {
    this.server?.close();
    this.server = undefined;
  }

  /** Resolves the target window from `?window=<id>` (or header); else focused. */
  private targetWindowId(url: URL, req: http.IncomingMessage): string | undefined {
    const fromQuery = url.searchParams.get("window");
    const header = typeof req.headers["x-agentparty-window"] === "string" ? req.headers["x-agentparty-window"] : "";
    return fromQuery || header || undefined;
  }

  private targetWorkspace(windowId: string | undefined): string {
    return this.deps.windowRegistry.resolve(windowId)?.workspacePath || process.cwd();
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method || "GET";
    const url = new URL(req.url || "/", this.baseUrl);
    log("info", "api", "request", { method, path: url.pathname });
    const c = this.deps.controller;
    const windowId = this.targetWindowId(url, req);
    const workspace = this.targetWorkspace(windowId);
    try {
      if (method === "GET" && (url.pathname === "/api/health" || url.pathname === "/api/state")) {
        sendJson(res, 200, await c.getState(workspace));
        return;
      }
      if (method === "GET" && url.pathname === "/api/spec") {
        sendJson(res, 200, automationApiSpec(this.baseUrl));
        return;
      }
      if (method === "GET" && url.pathname === "/api/logs") {
        sendJson(res, 200, c.getLogs());
        return;
      }
      if (method === "GET" && url.pathname === "/api/windows") {
        sendJson(res, 200, { windows: c.listWindows() });
        return;
      }
      if (method === "POST" && url.pathname === "/api/windows") {
        const body = await readJson(req);
        sendJson(res, 200, await c.openWindow(body.workspacePath));
        return;
      }
      const windowWorkspaceMatch = url.pathname.match(/^\/api\/windows\/([^/]+)\/workspace$/);
      if (method === "POST" && windowWorkspaceMatch) {
        const body = await readJson(req);
        sendJson(res, 200, await c.setWindowWorkspace(decodeURIComponent(windowWorkspaceMatch[1]), String(body.workspacePath || "")));
        return;
      }
      if (method === "POST" && url.pathname === "/api/capture") {
        sendJson(res, 200, await c.captureWindow(windowId, await readJson(req)));
        return;
      }
      if (method === "POST" && url.pathname === "/api/settings") {
        sendJson(res, 200, c.updateSettings(await readJson(req)));
        return;
      }
      if (method === "POST" && url.pathname === "/api/auth/openrouter") {
        const body = await readJson(req);
        sendJson(res, 200, c.setOpenRouterKey(String(body.key || "")));
        return;
      }
      if (method === "DELETE" && url.pathname === "/api/auth/openrouter") {
        sendJson(res, 200, c.clearOpenRouterKey());
        return;
      }
      if (method === "POST" && url.pathname === "/api/auth/openrouter/test") {
        sendJson(res, 200, await c.testOpenRouterKey());
        return;
      }
      if (method === "GET" && url.pathname === "/api/models") {
        sendJson(res, 200, await c.listModels(workspace));
        return;
      }
      if (method === "POST" && url.pathname === "/api/models/codex/refresh") {
        sendJson(res, 200, await c.refreshCodexModels(workspace));
        return;
      }
      if (method === "GET" && url.pathname === "/api/usage") {
        sendJson(res, 200, c.getUsageLimits());
        return;
      }
      if (method === "POST" && url.pathname === "/api/usage/refresh") {
        sendJson(res, 200, await c.refreshUsageLimits());
        return;
      }
      if (method === "POST" && url.pathname === "/api/sessions") {
        sendJson(res, 200, await c.createSession(workspace, await readJson(req)));
        return;
      }
      if (method === "GET" && url.pathname === "/api/sessions/history") {
        sendJson(res, 200, await c.listResumableSessions(workspace));
        return;
      }
      if (method === "POST" && url.pathname === "/api/sessions/resume") {
        const body = await readJson(req);
        sendJson(res, 200, await c.resumeSession(body.workspacePath || workspace, String(body.sessionId || "")));
        return;
      }
      // MCP status + actions. Placed BEFORE the generic 2-segment session route
      // so `/api/sessions/:id/mcp` isn't captured as action="mcp".
      const sessionMcpMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/mcp(?:\/([^/]+))?$/);
      if (sessionMcpMatch) {
        const sessionId = decodeURIComponent(sessionMcpMatch[1]);
        const action = sessionMcpMatch[2];
        if (method === "GET" && !action) {
          sendJson(res, 200, await c.listSessionMcpServers(workspace, sessionId));
          return;
        }
        if (method === "POST" && action) {
          sendJson(res, 200, await c.sessionMcpAction(workspace, sessionId, action, await readJson(req)));
          return;
        }
      }
      const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/([^/]+)$/);
      if (method === "POST" && sessionMatch) {
        sendJson(res, 200, await c.handleSessionAction(workspace, sessionMatch[1], sessionMatch[2], await readJson(req)));
        return;
      }
      if (method === "GET" && (url.pathname === "/api/party" || url.pathname === "/api/harness/party")) {
        sendJson(res, 200, await c.listPartyMembers(workspace, windowId));
        return;
      }
      if (method === "POST" && url.pathname === "/api/parties") {
        sendJson(res, 200, await c.createParty(workspace, await readJson(req), windowId));
        return;
      }
      const partySelectMatch = url.pathname.match(/^\/api\/parties\/([^/]+)\/select$/);
      if (method === "POST" && partySelectMatch) {
        sendJson(res, 200, await c.selectParty(workspace, decodeURIComponent(partySelectMatch[1]), windowId));
        return;
      }
      const partyDeleteMatch = url.pathname.match(/^\/api\/parties\/([^/]+)\/delete$/);
      if (method === "POST" && partyDeleteMatch) {
        sendJson(res, 200, await c.removeParty(workspace, decodeURIComponent(partyDeleteMatch[1]), windowId));
        return;
      }
      if (method === "POST" && (url.pathname === "/api/party/messages" || url.pathname === "/api/harness/party/messages")) {
        const body = await readJson(req);
        const headerMember = typeof req.headers["x-agentparty-member"] === "string" ? req.headers["x-agentparty-member"] : "";
        sendJson(res, 200, await c.sendPartyMessage(workspace, String(body.to || ""), String(body.content || ""), String(body.from || headerMember || "agent"), sanitizeAttachments(body.attachments), windowId, { interrupt: body.interrupt === true }));
        return;
      }
      const memberMessageMatch = url.pathname.match(/^\/api\/party\/members\/([^/]+)\/message$/);
      if (method === "POST" && memberMessageMatch) {
        const body = await readJson(req);
        sendJson(res, 200, await c.sendMemberMessage(workspace, decodeURIComponent(memberMessageMatch[1]), String(body.text || ""), sanitizeAttachments(body.attachments), windowId));
        return;
      }
      if (method === "POST" && url.pathname === "/api/party/members") {
        sendJson(res, 200, await c.createPartyMember(workspace, await readJson(req), windowId));
        return;
      }
      const transcriptMatch = url.pathname.match(/^\/api\/party\/members\/([^/]+)\/transcript$/);
      if (method === "GET" && transcriptMatch) {
        sendJson(res, 200, { ok: true, blocks: await c.getMemberTranscript(workspace, decodeURIComponent(transcriptMatch[1]), windowId) });
        return;
      }
      // Party-wide conveniences (agents' broadcast / stop-all / status-all):
      // routed through the same party-action dispatch with the "*" member name.
      if (method === "POST" && url.pathname === "/api/party/broadcast") {
        sendJson(res, 200, await c.handlePartyAction(workspace, "*", "broadcast", await readJson(req), windowId));
        return;
      }
      if (method === "POST" && url.pathname === "/api/party/interrupt") {
        sendJson(res, 200, await c.handlePartyAction(workspace, "*", "interrupt", await readJson(req), windowId));
        return;
      }
      if (method === "GET" && url.pathname === "/api/party/status") {
        sendJson(res, 200, await c.handlePartyAction(workspace, "*", "status", {}, windowId));
        return;
      }
      const partyMatch = url.pathname.match(/^\/api\/party\/members\/([^/]+)\/([^/]+)$/);
      if (method === "POST" && partyMatch) {
        sendJson(res, 200, await c.handlePartyAction(workspace, decodeURIComponent(partyMatch[1]), partyMatch[2], await readJson(req), windowId));
        return;
      }
      if (method === "POST" && url.pathname === "/api/window/minimize") {
        sendJson(res, 200, c.minimizeWindow(windowId));
        return;
      }
      if (method === "POST" && url.pathname === "/api/window/maximize") {
        sendJson(res, 200, c.toggleMaximizeWindow(windowId));
        return;
      }
      if (method === "POST" && url.pathname === "/api/window/close") {
        sendJson(res, 200, c.closeWindow(windowId));
        return;
      }
      if (method === "POST" && url.pathname === "/api/navigation") {
        const body = await readJson(req);
        sendJson(res, 200, c.navigate(windowId, String(body.view || "workbench")));
        return;
      }
      if (url.pathname.startsWith("/api/qa/")) {
        await this.handleQa(method, url, req, res, workspace, windowId);
        return;
      }
      sendJson(res, 404, { error: "not_found" });
    } catch (error) {
      log("error", "api", "request failed", { path: url.pathname, error: error instanceof Error ? error.message : String(error) });
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async handleQa(method: string, url: URL, req: http.IncomingMessage, res: http.ServerResponse, workspace: string, windowId: string | undefined): Promise<void> {
    const c = this.deps.controller;
    if (!c.isQaEnabled()) {
      sendJson(res, 403, { error: "qa_disabled", detail: "Launch with AGENTPARTY_QA=1 (or E2E mode) to use /api/qa/*." });
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
    if (method === "POST" && url.pathname === "/api/qa/reset") {
      sendJson(res, 200, await c.qaReset(workspace));
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
    const openSubMatch = url.pathname.match(/^\/api\/qa\/members\/([^/]+)\/subagents\/open$/);
    if (method === "POST" && openSubMatch) {
      const body = await readJson(req);
      sendJson(res, 200, c.qaOpenSubagent(windowId, decodeURIComponent(openSubMatch[1]), String(body?.subId || "")));
      return;
    }
    const interactionMatch = url.pathname.match(/^\/api\/qa\/members\/([^/]+)\/interaction$/);
    if (method === "POST" && interactionMatch) {
      sendJson(res, 200, await c.qaInteraction(workspace, decodeURIComponent(interactionMatch[1]), await readJson(req)));
      return;
    }
    sendJson(res, 404, { error: "not_found" });
  }

}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "http://127.0.0.1",
  });
  res.end(JSON.stringify(payload));
}

function readJson(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function listen(server: http.Server, preferredPort: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off("error", onError);
      if (error.code === "EADDRINUSE") {
        server.listen(0, "127.0.0.1");
        return;
      }
      reject(error);
    };
    server.once("error", onError);
    server.on("listening", () => {
      server.off("error", onError);
      resolve((server.address() as net.AddressInfo).port);
    });
    server.listen(preferredPort, "127.0.0.1");
  });
}
