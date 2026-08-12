import { execFileSync } from "node:child_process";

/**
 * Runtime used to execute the packaged party MCP relay.
 *
 * A desktop install must not require a separate Node.js installation. Electron
 * runs ordinary Node scripts with ELECTRON_RUN_AS_NODE=1, while dev/test and
 * WSL engine processes continue to use their native Node runtime. An explicit
 * AGENTPARTY_NODE_BIN always wins for tests and managed deployments.
 */
export function spawnablePartyMcpCommand(): string {
  const resolved = process.env.AGENTPARTY_NODE_BIN
    || (process.versions.electron ? process.execPath : process.env.npm_node_execpath || "node");
  if (process.platform !== "win32" || !resolved.includes(" ")) return resolved;
  try {
    const short = execFileSync("cmd", ["/d", "/c", `for %I in ("${resolved}") do @echo %~sI`], {
      encoding: "utf8",
      windowsHide: true,
    }).trim();
    if (short && !short.includes(" ")) return short;
  } catch {
    // Fall through. The installed path normally has no spaces; a configured
    // external Node remains PATH-resolvable as the final fallback.
  }
  return process.versions.electron ? resolved : "node";
}

/** Environment required only when Electron itself executes the relay script. */
export function partyMcpRuntimeEnv(): Record<string, string> {
  return !process.env.AGENTPARTY_NODE_BIN && Boolean(process.versions.electron)
    ? { ELECTRON_RUN_AS_NODE: "1" }
    : {};
}
