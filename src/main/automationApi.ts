import * as http from "node:http";
import { automationApiSpec } from "../shared/apiSpec";
import { sanitizeAttachments } from "../shared/attachments";
import { parseQueueCommand } from "../shared/messageQueue";
import { log } from "./logger";
import type { AppController } from "./application/appController";
import type { WindowRegistry } from "./windowRegistry";
import { handleDiscordRoute } from "./automation/discordRoutes";
import { listen, readJson, sendJson } from "./automation/http";
import { handleQaRoute } from "./automation/qaRoutes";
import { tokenUsageQueryFrom, tokenUsageTurnsQueryFrom } from "./automation/tokenUsageQueries";

export interface AutomationApiDeps {
  port: number;
  controller: AppController;
  windowRegistry: WindowRegistry;
  /**
   * Workspace to serve when no window resolves the request (no `?window` and no
   * registered windows). The desktop always has windows, so it omits this; the
   * headless engine-server (e.g. inside a WSL distro) serves exactly one
   * workspace and passes it here so its in-distro Codex party MCP server reaches
   * the right party state instead of falling back to `process.cwd()` (the
   * engine's server dir, not the workspace).
   */
  defaultWorkspace?: string;
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
    return this.deps.windowRegistry.resolve(windowId)?.workspacePath || this.deps.defaultWorkspace || process.cwd();
  }

  /** Pins an agent member's HTTP tools to the party that spawned its session. */
  private targetPartyId(req: http.IncomingMessage): string | undefined {
    return this.partyIdentityHeader(req, "party");
  }

  /**
   * Reads an exact UTF-8 party identity from an ASCII-safe base64url header.
   * Raw headers remain supported for older relays, but cannot represent every
   * user-facing member name through Fetch's ByteString header contract.
   */
  private partyIdentityHeader(req: http.IncomingMessage, field: "member" | "party"): string | undefined {
    const encoded = req.headers[`x-agentparty-${field}-base64url`];
    if (typeof encoded === "string" && encoded) {
      try {
        const value = Buffer.from(encoded, "base64url").toString("utf8");
        const canonical = Buffer.from(value, "utf8").toString("base64url");
        if (value && canonical === encoded.replace(/=+$/, "")) {
          return value;
        }
      } catch {
        // Fall through to the legacy header. A missing caller is reported by
        // the tool route instead of silently inventing an identity.
      }
    }
    const legacy = req.headers[`x-agentparty-${field}`];
    return typeof legacy === "string" && legacy.trim() ? legacy.trim() : undefined;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method || "GET";
    const url = new URL(req.url || "/", this.baseUrl);
    log("info", "api", "request", { method, path: url.pathname });
    const c = this.deps.controller;
    const windowId = this.targetWindowId(url, req);
    const partyId = this.targetPartyId(req);
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
      // Same two controller methods the settings 진단 card calls, so a report a
      // user pastes and a report an agent pulls are byte-identical.
      if (method === "GET" && url.pathname === "/api/diagnostics") {
        sendJson(res, 200, await c.getDiagnostics(workspace));
        return;
      }
      if (method === "POST" && url.pathname === "/api/diagnostics/open-logs") {
        sendJson(res, 200, await c.openLogFolder());
        return;
      }
      // Readiness, not build facts — the environment tab and an agent driving
      // QA read the same report. `includeWsl` is opt-in because it boots distros.
      if (method === "GET" && url.pathname === "/api/environment") {
        sendJson(res, 200, await c.getEnvironment({
          refresh: url.searchParams.get("refresh") === "1",
          includeWsl: url.searchParams.get("wsl") === "1",
        }));
        return;
      }
      if (method === "POST" && url.pathname === "/api/environment/repair") {
        const body = await readJson(req) as { repairId?: string };
        sendJson(res, 200, await c.repairEnvironment(String(body.repairId || "")));
        return;
      }
      // App self-update. Account-global like usage, so no window/workspace scope.
      // `check` and `download` report failure inside the status; `install` quits
      // the app, so it answers only if the installer could NOT be started.
      if (method === "GET" && url.pathname === "/api/update") {
        sendJson(res, 200, c.getUpdateStatus());
        return;
      }
      // Release history for the 버전 tab. `?refresh=1` bypasses the 10-minute
      // cache that keeps us inside GitHub's anonymous rate limit.
      if (method === "GET" && url.pathname === "/api/update/versions") {
        sendJson(res, 200, await c.listReleaseVersions({ refresh: url.searchParams.get("refresh") === "1" }));
        return;
      }
      if (method === "POST" && url.pathname === "/api/update/check") {
        sendJson(res, 200, await c.checkForUpdate());
        return;
      }
      if (method === "POST" && url.pathname === "/api/update/download") {
        sendJson(res, 200, await c.downloadUpdate());
        return;
      }
      if (method === "POST" && url.pathname === "/api/update/install") {
        sendJson(res, 200, c.installUpdate());
        return;
      }
      if (method === "GET" && url.pathname === "/api/windows") {
        sendJson(res, 200, { windows: c.listWindows() });
        return;
      }
      if (method === "POST" && url.pathname === "/api/windows") {
        const body = await readJson(req);
        // Defaults to the CALLING window's workspace, not the global setting: a
        // `partyId` only means anything inside one workspace, so falling back to
        // the setting opened the window on a DIFFERENT workspace where that id
        // does not exist — and it then silently showed that workspace's own party.
        sendJson(res, 200, await c.openWindow(body.workspacePath || workspace, body.partyId));
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
      if (method === "POST" && url.pathname === "/api/measure") {
        sendJson(res, 200, await c.measureWindow(windowId, await readJson(req)));
        return;
      }
      if (method === "POST" && url.pathname === "/api/clipboard/image") {
        sendJson(res, 200, await c.writeImageToClipboard(await readJson(req)));
        return;
      }
      if (method === "POST" && url.pathname === "/api/settings") {
        sendJson(res, 200, c.updateSettings(await readJson(req)));
        return;
      }
      if (method === "POST" && url.pathname === "/api/shell/open-path") {
        const body = await readJson(req);
        sendJson(res, 200, await c.openLocalPath(windowId, String(body?.path || ""), { reveal: body?.reveal === true }));
        return;
      }
      if (method === "GET" && url.pathname === "/api/appearance/fonts") {
        sendJson(res, 200, await c.getFontCatalog(windowId, url.searchParams.get("q") || undefined));
        return;
      }
      if (method === "GET" && url.pathname === "/api/auth") {
        sendJson(res, 200, { providers: await c.getAuthProviders() });
        return;
      }
      if (method === "POST" && url.pathname === "/api/auth/deepseek") {
        const body = await readJson(req);
        sendJson(res, 200, await c.setDeepseekKey(String(body.key || "")));
        return;
      }
      if (method === "DELETE" && url.pathname === "/api/auth/deepseek") {
        sendJson(res, 200, await c.clearDeepseekKey());
        return;
      }
      if (method === "POST" && url.pathname === "/api/auth/deepseek/test") {
        sendJson(res, 200, await c.testDeepseekKey());
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
      if (method === "GET" && url.pathname === "/api/auth/subscriptions") {
        sendJson(res, 200, await c.getSubscriptionAuthState());
        return;
      }
      const subscriptionLoginMatch = url.pathname.match(/^\/api\/auth\/subscriptions\/(codex|claude)\/login$/);
      if (method === "POST" && subscriptionLoginMatch) {
        sendJson(res, 200, await c.loginSubscriptionProvider(subscriptionLoginMatch[1] as "codex" | "claude"));
        return;
      }
      const subscriptionDisconnectMatch = url.pathname.match(/^\/api\/auth\/subscriptions\/(codex|claude|cursor)$/);
      if (method === "DELETE" && subscriptionDisconnectMatch) {
        sendJson(res, 200, await c.disconnectSubscriptionProvider(subscriptionDisconnectMatch[1] as "codex" | "claude" | "cursor"));
        return;
      }
      // --- Discord bridge (docs/기획 노트.md §11) ---------------------------
      if (await handleDiscordRoute({
        method,
        url,
        req,
        res,
        controller: c,
        workspace,
        windowId,
        partyId,
      })) {
        return;
      }
      if (method === "GET" && url.pathname === "/api/models") {
        sendJson(res, 200, await c.listModels(workspace));
        return;
      }
      if (method === "GET" && url.pathname === "/api/harnesses/cursor/status") {
        sendJson(res, 200, await c.getCursorHarnessStatus(workspace));
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
      if (method === "GET" && url.pathname === "/api/token-usage") {
        sendJson(res, 200, await c.getTokenUsage(workspace, tokenUsageQueryFrom(url)));
        return;
      }
      if (method === "GET" && url.pathname === "/api/token-usage/turns") {
        sendJson(res, 200, await c.getTokenUsageTurns(workspace, tokenUsageTurnsQueryFrom(url)));
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
        sendJson(res, 200, await c.listPartyMembers(workspace, windowId, partyId));
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
      // Party-wide Message Gate default (enablement + rule). Body: { enabled, rule }.
      const partyGateMatch = url.pathname.match(/^\/api\/parties\/([^/]+)\/gate$/);
      if (method === "POST" && partyGateMatch) {
        sendJson(res, 200, await c.setPartyGate(workspace, decodeURIComponent(partyGateMatch[1]), await readJson(req), windowId));
        return;
      }
      const partyToolMatch = url.pathname.match(/^\/api\/harness\/party\/tools\/([^/]+)$/);
      if (method === "POST" && partyToolMatch) {
        // The party tool surface for a harness whose tools run OUTSIDE this
        // process (Codex, via scripts/agentparty-codex-mcp-server.mjs). The
        // caller is the member named in the header, never a body field, so an
        // agent cannot act as somebody else — and the answer is the compact
        // agent-facing tool result rather than the UI command result the other
        // party routes return.
        const toolCaller = this.partyIdentityHeader(req, "member") || "";
        if (!toolCaller) {
          sendJson(res, 400, {
            ok: false,
            error: "x-agentparty-member-base64url (or legacy x-agentparty-member) header is required.",
          });
          return;
        }
        sendJson(res, 200, await c.invokePartyToolAs(workspace, toolCaller, decodeURIComponent(partyToolMatch[1]), await readJson(req), partyId));
        return;
      }
      if (method === "POST" && (url.pathname === "/api/party/messages" || url.pathname === "/api/harness/party/messages")) {
        const body = await readJson(req);
        const headerMember = this.partyIdentityHeader(req, "member") || "";
        sendJson(res, 200, await c.sendPartyMessage(workspace, String(body.to || ""), String(body.content || ""), String(body.from || headerMember || "agent"), sanitizeAttachments(body.attachments), windowId, { interrupt: typeof body.interrupt === "boolean" ? body.interrupt : undefined, force: body.force === true, forceReason: typeof body.forceReason === "string" ? body.forceReason : undefined }, partyId));
        return;
      }
      const memberMessageMatch = url.pathname.match(/^\/api\/party\/members\/([^/]+)\/message$/);
      if (method === "POST" && memberMessageMatch) {
        const body = await readJson(req);
        sendJson(res, 200, await c.sendMemberMessage(workspace, decodeURIComponent(memberMessageMatch[1]), String(body.text || ""), sanitizeAttachments(body.attachments), windowId, { interrupt: body.interrupt === true }));
        return;
      }
      if (method === "POST" && url.pathname === "/api/party/members") {
        sendJson(res, 200, await c.createPartyMember(workspace, await readJson(req), windowId));
        return;
      }
      // Message queue: what a busy member has been sent but not yet handed.
      // One mutating endpoint carrying a discriminated action, so the HTTP
      // surface and the UI buttons provably run the same code path.
      const queueMatch = url.pathname.match(/^\/api\/party\/members\/([^/]+)\/queue$/);
      if (queueMatch) {
        const member = decodeURIComponent(queueMatch[1]);
        if (method === "GET") {
          sendJson(res, 200, { ok: true, queue: await c.getMemberQueue(workspace, member, windowId) });
          return;
        }
        if (method === "POST") {
          // An unknown or malformed action is rejected here rather than being
          // coerced into some default mutation the caller never asked for.
          sendJson(res, 200, await c.runQueueCommand(workspace, member, parseQueueCommand(await readJson(req)), windowId));
          return;
        }
      }
      // The workbench tab layout for the calling window's party. One copy shared
      // by every window on that party, so a POST here moves the other windows too.
      if (url.pathname === "/api/party/layout") {
        if (method === "GET") {
          sendJson(res, 200, { ok: true, layout: await c.getPartyLayout(workspace, windowId) });
          return;
        }
        if (method === "POST") {
          sendJson(res, 200, { ok: true, ...(await c.setPartyLayout(workspace, (await readJson(req)).layout, windowId)) });
          return;
        }
      }
      const transcriptMatch = url.pathname.match(/^\/api\/party\/members\/([^/]+)\/transcript$/);
      if (method === "GET" && transcriptMatch) {
        sendJson(res, 200, { ok: true, blocks: await c.getMemberTranscript(workspace, decodeURIComponent(transcriptMatch[1]), windowId) });
        return;
      }
      // A transcript stores screenshots out-of-line, so its blocks carry a file
      // reference. This is how a caller (or the UI) turns one back into bytes.
      const transcriptImageMatch = url.pathname.match(/^\/api\/party\/transcript-image\/([^/]+)$/);
      if (method === "GET" && transcriptImageMatch) {
        sendJson(res, 200, await c.getTranscriptImage(workspace, decodeURIComponent(transcriptImageMatch[1])));
        return;
      }
      // The app's transcript has a retention window; the harness's own copy does
      // not. This names where the rest of the history still is.
      const originalMatch = url.pathname.match(/^\/api\/party\/members\/([^/]+)\/harness-original$/);
      if (method === "GET" && originalMatch) {
        sendJson(res, 200, await c.getHarnessOriginal(workspace, decodeURIComponent(originalMatch[1]), windowId));
        return;
      }
      // Party-wide conveniences (agents' broadcast / stop-all / status-all):
      // routed through the same party-action dispatch with the "*" member name.
      if (method === "POST" && url.pathname === "/api/party/broadcast") {
        sendJson(res, 200, await c.handlePartyAction(workspace, "*", "broadcast", await readJson(req), windowId, partyId));
        return;
      }
      if (method === "POST" && url.pathname === "/api/party/interrupt") {
        sendJson(res, 200, await c.handlePartyAction(workspace, "*", "interrupt", await readJson(req), windowId, partyId));
        return;
      }
      if (method === "GET" && url.pathname === "/api/party/status") {
        sendJson(res, 200, await c.handlePartyAction(workspace, "*", "status", {}, windowId, partyId));
        return;
      }
      // `open` is routed explicitly rather than through the generic action
      // dispatch below: opening a member means giving it a TAB, which is window
      // state the engine-side action table cannot reach. Sent through the same
      // AppController method the IPC `party:open` uses, so a click in the
      // sidebar and this call do the same thing.
      const openMatch = url.pathname.match(/^\/api\/party\/members\/([^/]+)\/open$/);
      if (method === "POST" && openMatch) {
        sendJson(res, 200, await c.openPartyMember(workspace, decodeURIComponent(openMatch[1]), windowId));
        return;
      }
      const partyMatch = url.pathname.match(/^\/api\/party\/members\/([^/]+)\/([^/]+)$/);
      if (method === "POST" && partyMatch) {
        sendJson(res, 200, await c.handlePartyAction(workspace, decodeURIComponent(partyMatch[1]), partyMatch[2], await readJson(req), windowId, partyId));
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
        sendJson(res, 200, c.navigate(windowId, String(body.view || "workbench"), body.tab ? String(body.tab) : undefined, body.harness ? String(body.harness) : undefined));
        return;
      }
      if (url.pathname.startsWith("/api/qa/")) {
        await handleQaRoute({
          method,
          url,
          req,
          res,
          controller: c,
          workspace,
          windowId,
          partyId,
        });
        return;
      }
      sendJson(res, 404, { error: "not_found" });
    } catch (error) {
      log("error", "api", "request failed", { path: url.pathname, error: error instanceof Error ? error.message : String(error) });
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  }
}
