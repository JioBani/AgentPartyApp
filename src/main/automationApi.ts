import * as http from "node:http";
import { log } from "./logger";
import { ApiError, type MethodContext, type MethodParams } from "./api/methodRegistry";
import { methodRoutes } from "./api/methodRoutes";
import type { AppController } from "./application/appController";
import type { WindowRegistry } from "./windowRegistry";
import { listen, readJson, sendJson } from "./automation/http";
import { handleQaRoute } from "./automation/qaRoutes";

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

/**
 * The local automation HTTP server. It owns transport concerns only — resolving
 * the window/party scope, merging parameters, and mapping results to status
 * codes. What each endpoint DOES lives in the capability table
 * (`src/main/api/methodRoutes.ts`), which the mobile link dispatches too, so
 * neither transport can drift from the other.
 */
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

  /**
   * One parameter object per call, so a handler reads `p.name` without caring
   * whether it arrived as a path segment, a query string, or a JSON body — the
   * same object shape a phone's RPC passes. Path segments win: they are the
   * addressed resource and must not be overridable by a body field.
   */
  private async paramsFor(req: http.IncomingMessage, url: URL, pathParams: Record<string, string>): Promise<MethodParams> {
    const params: MethodParams = {};
    for (const [key, value] of url.searchParams) {
      params[key] = value;
    }
    if (req.method === "POST") {
      Object.assign(params, await readJson(req));
    }
    return Object.assign(params, pathParams);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const verb = req.method || "GET";
    const url = new URL(req.url || "/", this.baseUrl);
    log("info", "api", "request", { method: verb, path: url.pathname });
    const windowId = this.targetWindowId(url, req);
    const partyId = this.partyIdentityHeader(req, "party");
    const workspace = this.targetWorkspace(windowId);
    try {
      // QA scaffolding keeps its own adapter: it fabricates state for tests
      // rather than performing a product capability, so it stays out of the
      // table the phone dispatches.
      if (url.pathname.startsWith("/api/qa/")) {
        await handleQaRoute({ method: verb, url, req, res, controller: this.deps.controller, workspace, windowId, partyId });
        return;
      }
      const match = methodRoutes.matchHttp(verb, url.pathname);
      if (!match) {
        // A known path called with the wrong verb says so, instead of looking
        // like a missing endpoint the caller should stop using.
        const allow = methodRoutes.allowedVerbs(url.pathname);
        sendJson(res, allow.length ? 405 : 404, allow.length ? { error: "method_not_allowed", allow } : { error: "not_found" });
        return;
      }
      const context: MethodContext = {
        controller: this.deps.controller,
        workspace,
        windowId,
        partyId,
        caller: this.partyIdentityHeader(req, "member"),
        apiBaseUrl: this.baseUrl,
      };
      sendJson(res, 200, await match.route.handler(await this.paramsFor(req, url, match.pathParams), context));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = error instanceof ApiError ? error.status : 500;
      log(status >= 500 ? "error" : "warn", "api", "request failed", { path: url.pathname, status, error: message });
      sendJson(res, status, { ok: false, error: message });
    }
  }
}
