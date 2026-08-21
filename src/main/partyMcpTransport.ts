import { spawn } from "node:child_process";
import readline from "node:readline";
import { resolvePartyMcpServerScript, spawnableNodeCommand } from "../core/codexAdapter";
import { partyMcpRuntimeEnv } from "../core/partyMcpRuntime";
import type { PartyMcpToolSpec, PartyToolResult } from "../core/partyBridge";

export interface PartyMcpTransportIdentity {
  automationBaseUrl: string;
  member: string;
  party: string;
}

export interface PartyMcpTransportInput extends PartyMcpTransportIdentity {
  tool: string;
  args: unknown;
}

type PartyMcpExchange =
  | ({ kind: "call" } & PartyMcpTransportInput)
  | ({ kind: "list" } & PartyMcpTransportIdentity);

/**
 * Calls the shipped `agentparty-app` stdio MCP server on THIS engine host.
 *
 * This is intentionally not a shortcut to `invokePartyToolAs`: it exercises
 * JSON-RPC framing, the packaged relay script, identity environment, local HTTP
 * bridge, and (for WSL) the engine-to-desktop host channel. The automation API
 * uses it for deterministic product E2E without asking a model to choose a tool.
 */
export function invokePartyMcpTransport(input: PartyMcpTransportInput): Promise<PartyToolResult> {
  return exchangePartyMcp({ kind: "call", ...input }) as Promise<PartyToolResult>;
}

/** Lists tools through the actual stdio relay running on this engine host. */
export function listPartyMcpTransport(input: PartyMcpTransportIdentity): Promise<PartyMcpToolSpec[]> {
  return exchangePartyMcp({ kind: "list", ...input }) as Promise<PartyMcpToolSpec[]>;
}

function exchangePartyMcp(input: PartyMcpExchange): Promise<PartyToolResult | PartyMcpToolSpec[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(spawnableNodeCommand(), [resolvePartyMcpServerScript()], {
      env: {
        ...process.env,
        ...partyMcpRuntimeEnv(),
        AGENTPARTY_AUTOMATION_BASE_URL: input.automationBaseUrl,
        AGENTPARTY_MEMBER: input.member,
        AGENTPARTY_PARTY: input.party,
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const lines = readline.createInterface({ input: child.stdout });
    let stderr = "";
    let settled = false;
    const operation = input.kind === "call" ? `tool '${input.tool}'` : "tool discovery";
    const timeout = setTimeout(() => finish(new Error(`Party MCP ${operation} timed out after 45 seconds.`)), 45_000);

    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-4_000);
    });
    child.on("error", (error) => finish(error));
    child.on("exit", (code) => {
      if (!settled) {
        finish(new Error(`Party MCP relay exited before replying (code ${code ?? "unknown"})${stderr.trim() ? `: ${stderr.trim()}` : "."}`));
      }
    });
    lines.on("line", (line) => {
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message?.id === 1) {
        if (message.error) {
          finish(new Error(`Party MCP initialize failed: ${message.error.message || JSON.stringify(message.error)}`));
          return;
        }
        write({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
        write(input.kind === "call"
          ? { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: input.tool, arguments: input.args || {} } }
          : { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        return;
      }
      if (message?.id === 2) {
        if (message.error) {
          finish(new Error(`Party MCP call failed: ${message.error.message || JSON.stringify(message.error)}`));
          return;
        }
        if (input.kind === "list") {
          if (!Array.isArray(message.result?.tools)) {
            finish(new Error("Party MCP discovery returned no tools array."));
            return;
          }
          finish(undefined, message.result.tools as PartyMcpToolSpec[]);
          return;
        }
        const text = message.result?.content?.find((entry: any) => entry?.type === "text")?.text;
        if (typeof text !== "string") {
          finish(new Error("Party MCP call returned no text result."));
          return;
        }
        try {
          const result = JSON.parse(text);
          if (!result || typeof result.ok !== "boolean") {
            throw new Error("result has no boolean ok field");
          }
          finish(undefined, result as PartyToolResult);
        } catch (error) {
          finish(new Error(`Party MCP returned invalid tool JSON: ${error instanceof Error ? error.message : String(error)}`));
        }
      }
    });

    write({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "agentparty-automation-e2e", version: "1.0.0" },
      },
    });

    function write(message: unknown): void {
      if (!child.stdin.writable) {
        finish(new Error("Party MCP relay stdin closed before the call was sent."));
        return;
      }
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    function finish(error?: Error, result?: PartyToolResult | PartyMcpToolSpec[]): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      lines.close();
      child.kill();
      if (error) reject(error);
      else resolve(result as PartyToolResult | PartyMcpToolSpec[]);
    }
  });
}
