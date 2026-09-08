import type { AppController } from "../application/appController";

/**
 * One capability table, two transports.
 *
 * `src/main/automationApi.ts` (local HTTP) and `src/main/mobile` (phone RPC)
 * both dispatch THIS table, so a capability registered once is reachable from
 * an agent's HTTP call, the desktop UI's IPC path, and a paired phone without
 * anyone hand-maintaining a second mapping. See
 * `AgentPartyMobile/docs/아키텍처/04-데스크톱-확장.md` §붙이는 지점 1.
 */

export type HttpVerb = "GET" | "POST" | "DELETE";

const HTTP_VERBS: readonly HttpVerb[] = ["GET", "POST", "DELETE"];

/** Ambient request scope: everything a handler needs that is not a parameter. */
export interface MethodContext {
  controller: AppController;
  /** Workspace the call acts on. HTTP resolves it from the window; RPC from `workspacePath`. */
  workspace: string;
  /** Desktop window scope. Undefined for phone calls — they own no window. */
  windowId?: string;
  /** Party pin carried by an agent's identity header. */
  partyId?: string;
  /** Member the call acts AS, for routes that refuse to take an identity from the body. */
  caller?: string;
  /** Base URL of the local automation server, for the spec route. */
  apiBaseUrl: string;
  /**
   * The phone's event-stream position, for a handler that reads state the phone
   * also receives as events. Present only on the mobile transport — an HTTP
   * caller receives no events, so there is no position to report.
   *
   * Call it BEFORE reading, never after. The read lands somewhere inside the
   * await; a seq taken afterwards makes the phone skip events the answer does
   * not contain, which is loss rather than duplication (01 §5.3 chose the same
   * way for the rewind snapshot).
   */
  currentSeq?: () => number;
}

/**
 * Request parameters. HTTP merges query + body + path segments into one object;
 * mobile RPC passes its `p` object straight through. Typed loosely on purpose —
 * this is the untyped wire edge, exactly as the parsed HTTP body always was.
 */
export type MethodParams = Record<string, any>;

export interface MethodRoute {
  /** `<domain>.<verb>` — the mobile RPC name and the catalog key (문서 08). */
  name: string;
  /** `"<VERB> /api/path/:param"`. Also the entry published in the API spec. */
  http: string;
  /**
   * `false` keeps the route off the phone: it drives desktop-local surfaces
   * (this window's screenshot, this window's chrome) that mean nothing remotely.
   * Defaults to exposed — a new capability reaches the phone unless it opts out.
   */
  remote?: boolean;
  handler(params: MethodParams, ctx: MethodContext): unknown | Promise<unknown>;
}

/** A failure a handler wants reported with a specific HTTP status. */
export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

/** `String(value || fallback)` with the wire's undefined/null handled once. */
export function text(value: unknown, fallback = ""): string {
  return value === undefined || value === null || value === "" ? fallback : String(value);
}

/** Same, but keeps "absent" distinguishable from "empty" for optional arguments. */
export function optText(value: unknown): string | undefined {
  const resolved = text(value);
  return resolved ? resolved : undefined;
}

/**
 * `force-stop` → `forceStop`. Action tables are keyed by their kebab-case URL
 * segment, while an RPC name must stay `<domain>.<verb>`.
 */
export function camelAction(action: string): string {
  return action.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

/**
 * A parameter the capability cannot run without. Reported as a 400 naming the
 * field, rather than letting `undefined` travel into the domain and fail later
 * as an unexplained 500.
 */
export function required(value: unknown, field: string): string {
  const resolved = text(value);
  if (!resolved) {
    throw new ApiError(400, `'${field}' is required.`);
  }
  return resolved;
}

/**
 * A number from the wire, or undefined when the field was absent.
 *
 * Undefined rather than a default matters where the callee clamps: a budget of
 * "not given" must reach the clamp as absent so it can apply ITS default, while
 * a given-but-out-of-range value is reported back as clamped. Turning absence
 * into 0 here would make those two indistinguishable.
 */
export function num(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * A boolean that survives both transports: HTTP query strings can only carry
 * `?refresh=1`, while a phone sends real JSON `true`.
 */
export function flag(value: unknown): boolean {
  return value === true || value === "1" || value === "true";
}

interface CompiledRoute {
  route: MethodRoute;
  verb: HttpVerb;
  /** Literal path when the route has no `:param`, else undefined. */
  literal?: string;
  pattern?: RegExp;
  paramNames: string[];
}

export interface HttpMatch {
  route: MethodRoute;
  /** Decoded `:param` segments. */
  pathParams: Record<string, string>;
}

function compile(route: MethodRoute): CompiledRoute {
  const [verb, path] = route.http.split(" ");
  if (!HTTP_VERBS.includes(verb as HttpVerb) || !path?.startsWith("/")) {
    throw new Error(`Route '${route.name}' has a malformed http pattern: '${route.http}'.`);
  }
  const paramNames: string[] = [];
  const source = path.replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) => {
    paramNames.push(name);
    return "([^/]+)";
  });
  return paramNames.length === 0
    ? { route, verb: verb as HttpVerb, literal: path, paramNames }
    : { route, verb: verb as HttpVerb, pattern: new RegExp(`^${source}$`), paramNames };
}

/**
 * The compiled capability table. Declaration order decides HTTP matching, the
 * same way the if-chain it replaced did, so a specific path can still be listed
 * ahead of a broader one.
 */
export class MethodRouteTable {
  private readonly compiled: CompiledRoute[];
  private readonly byMethodName = new Map<string, MethodRoute>();

  constructor(readonly routes: readonly MethodRoute[]) {
    this.compiled = routes.map(compile);
    for (const route of routes) {
      // A duplicate name would silently shadow a capability over RPC. Fail at
      // load time instead of leaving one method permanently unreachable.
      if (this.byMethodName.has(route.name)) {
        throw new Error(`Duplicate method name '${route.name}' in the route table.`);
      }
      this.byMethodName.set(route.name, route);
    }
  }

  matchHttp(verb: string, pathname: string): HttpMatch | undefined {
    for (const entry of this.compiled) {
      if (entry.verb !== verb) continue;
      if (entry.literal) {
        if (entry.literal === pathname) return { route: entry.route, pathParams: {} };
        continue;
      }
      const found = entry.pattern!.exec(pathname);
      if (!found) continue;
      const pathParams: Record<string, string> = {};
      entry.paramNames.forEach((name, index) => {
        pathParams[name] = decodeURIComponent(found[index + 1]);
      });
      return { route: entry.route, pathParams };
    }
    return undefined;
  }

  /** Verbs this path would answer, so a wrong-verb call is told what is allowed. */
  allowedVerbs(pathname: string): HttpVerb[] {
    const allowed = new Set<HttpVerb>();
    for (const entry of this.compiled) {
      if (entry.literal ? entry.literal === pathname : entry.pattern!.test(pathname)) {
        allowed.add(entry.verb);
      }
    }
    return [...allowed];
  }

  byName(name: string): MethodRoute | undefined {
    return this.byMethodName.get(name);
  }

  /** The endpoint list published by `GET /api/spec`. */
  endpoints(): string[] {
    return this.routes.map((route) => route.http);
  }

  /** The methods a paired phone may call. */
  remoteRoutes(): MethodRoute[] {
    return this.routes.filter((route) => route.remote !== false);
  }
}
