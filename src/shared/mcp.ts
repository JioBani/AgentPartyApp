import type { HarnessId } from "./types";

/**
 * Provider-neutral MCP (Model Context Protocol) **client** status + actions —
 * the external servers a member connects to, NOT the app's own in-process
 * `agentparty-app` server (that's Boundary 2 in the party-communication design).
 *
 * Both harnesses expose a live MCP control surface, but with different shapes
 * and different capabilities, so this module is the single neutral vocabulary
 * the UI + HTTP API speak:
 *  - Claude Code (SDK `query`): `mcpServerStatus()` + `reconnectMcpServer()` +
 *    `toggleMcpServer()`. No programmatic OAuth (interactive `/mcp` only).
 *  - Codex (app-server): `mcpServerStatus/list` + `mcpServer/startupStatus/updated`
 *    notifications + `config/mcpServer/reload` (reconnect) + `mcpServer/oauth/login`.
 *    No live enable/disable RPC (config-file driven).
 *
 * Per-server capability flags tell the UI which actions THIS harness actually
 * supports for THIS server, so we never present an action that would silently
 * no-op (the project's no-silent-fallback rule).
 */

export type McpServerState =
  | "connected"
  | "connecting"
  | "failed"
  | "needs-auth"
  | "disabled"
  | "unknown";

export interface McpToolInfo {
  name: string;
  description?: string;
}

export interface McpServerInfo {
  name: string;
  state: McpServerState;
  /** stdio (local command) · http · sse (remote); unknown when the harness omits it. */
  transport?: "stdio" | "http" | "sse" | "unknown";
  /** Config scope (project/user/local/…) when the harness reports it. */
  scope?: string;
  /** Remote server URL (http/sse) when known. */
  url?: string;
  /** Server-advertised version (available once connected). */
  version?: string;
  /** Human-readable failure / auth message; surfaced, never swallowed. */
  error?: string;
  tools: McpToolInfo[];
  /** Live-action support for THIS server on THIS harness (drives which buttons show). */
  canReconnect: boolean;
  canToggle: boolean;
  canAuthenticate: boolean;
}

export interface McpServerSnapshot {
  /** Whether this session's harness exposes MCP status at all. */
  supported: boolean;
  harness: HarnessId;
  servers: McpServerInfo[];
  /** Set when the snapshot could not be produced (e.g. session not live yet). */
  error?: string;
  /** Harness-level note (e.g. Claude: OAuth only via the interactive `/mcp`). */
  note?: string;
}

export type McpActionName = "reconnect" | "toggle" | "authenticate";

export interface McpAuthResult {
  /** OAuth authorization URL to open in a browser (Codex remote servers). */
  authorizationUrl?: string;
  /** Set when the action isn't supported here / needs the interactive client. */
  note?: string;
}

/** An empty, harness-tagged snapshot — the honest "nothing to show yet" shape. */
export function emptyMcpSnapshot(harness: HarnessId, note?: string): McpServerSnapshot {
  return { supported: true, harness, servers: [], note };
}
