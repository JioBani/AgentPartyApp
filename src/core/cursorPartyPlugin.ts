import * as fs from "node:fs";
import * as path from "node:path";
import { buildPartyPrimer, type PartyIdentity } from "./partyBridge";
import { partyMcpRuntimeEnv, spawnablePartyMcpCommand } from "./partyMcpRuntime";

export interface CursorPartyRuntime {
  pluginDir: string;
  primer: string;
}

/**
 * Builds a session-scoped Cursor plugin so Cursor members use the same local
 * automation API as the UI, Claude Code, and Codex. No workspace files or user
 * Cursor config are modified.
 */
export function prepareCursorPartyRuntime(input: {
  baseDir: string;
  sessionId: string;
  automationBaseUrl: string;
  identity: PartyIdentity;
}): CursorPartyRuntime {
  const safeId = input.sessionId.replace(/[^a-zA-Z0-9_.-]/g, "_");
  // Cursor derives the provider identifier from the plugin directory basename,
  // not from plugin.json. Put each session in an isolated parent while keeping
  // the loaded plugin basename stable so resumed chats never retain a stale
  // `plugin-<old-session>-agentparty-app` identifier after respawn.
  const pluginDir = path.join(input.baseDir, safeId, "agentparty-session");
  const manifestDir = path.join(pluginDir, ".cursor-plugin");
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.writeFileSync(path.join(manifestDir, "plugin.json"), JSON.stringify({
    // Cursor includes the plugin manifest name in its MCP provider identifier
    // and stores that identifier in resumed chats. Keep it stable even though
    // the directory and credentials remain isolated per AgentParty session.
    name: "agentparty-session",
    version: "0.1.0",
    description: "Session-scoped AgentParty communication tools.",
    author: { name: "AgentParty" },
    license: "UNLICENSED",
  }, null, 2));
  fs.writeFileSync(path.join(pluginDir, "mcp.json"), JSON.stringify({
    mcpServers: {
      "agentparty-app": {
        command: spawnablePartyMcpCommand(),
        args: [resolvePartyMcpServerScript()],
        env: {
          AGENTPARTY_AUTOMATION_BASE_URL: input.automationBaseUrl,
          AGENTPARTY_MEMBER: input.identity.member,
          AGENTPARTY_PARTY: input.identity.party,
          ...partyMcpRuntimeEnv(),
        },
      },
    },
  }, null, 2));
  return { pluginDir, primer: buildPartyPrimer(input.identity) };
}

function resolvePartyMcpServerScript(): string {
  if (process.env.AGENTPARTY_CODEX_MCP_SERVER) {
    return process.env.AGENTPARTY_CODEX_MCP_SERVER;
  }
  const moduleDir = typeof __dirname === "string" ? __dirname : process.cwd();
  const devPath = path.resolve(moduleDir, "../../scripts", "agentparty-codex-mcp-server.mjs");
  if (fs.existsSync(devPath)) {
    return devPath;
  }
  const packagedPath = process.resourcesPath
    ? path.join(process.resourcesPath, "bin", "agentparty-codex-mcp-server.mjs")
    : "";
  return packagedPath && fs.existsSync(packagedPath) ? packagedPath : devPath;
}
