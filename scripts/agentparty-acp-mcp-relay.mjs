/*
 * Cursor-ACP tool relay — the MCP stdio server the Cursor Agent spawns inside
 * a cross-harness bridge session.
 *
 * It owns NO tools of its own. It mirrors whatever tools the CALLING harness
 * (e.g. Claude Code) declared on the current Anthropic Messages request, and
 * forwards every tools/call back to the bridge over loopback HTTP. The bridge
 * turns that into a `tool_use` block for the harness, waits for the harness's
 * `tool_result`, and answers this relay.
 *
 * Cursor's MCP client enforces a hard ~60s timeout per tools/call with silent
 * retries (measured; no progressToken is sent, so progress keepalives cannot
 * extend it). The bridge therefore long-polls in <=50s slices and answers
 * "PENDING — call the tool again" when the harness's execution is still
 * running; the model re-calls until the real result is ready. Measured live:
 * a 130s tool execution completes correctly through this loop.
 */
import readline from "node:readline";

const baseUrl = (process.env.AGENTPARTY_ACP_BRIDGE_URL || "").replace(/\/+$/, "");
const token = process.env.AGENTPARTY_ACP_BRIDGE_TOKEN || "";
const conversation = process.env.AGENTPARTY_ACP_BRIDGE_CONVERSATION || "";

const rl = readline.createInterface({ input: process.stdin });
const send = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`);
const fail = (id, message) => send({ jsonrpc: "2.0", id, error: { code: -32000, message } });

async function bridge(pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ conversation, ...body }),
  });
  if (!response.ok) {
    throw new Error(`bridge ${pathname} returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  return response.json();
}

rl.on("line", async (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  try {
    if (message.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "agentparty-harness-tools", version: "1.0.0" },
        },
      });
    } else if (message.method === "tools/list") {
      const { tools } = await bridge("/acp-bridge/tools", {});
      send({ jsonrpc: "2.0", id: message.id, result: { tools } });
    } else if (message.method === "tools/call") {
      const { name, arguments: args } = message.params || {};
      const outcome = await bridge("/acp-bridge/call", { name, arguments: args ?? {} });
      send({ jsonrpc: "2.0", id: message.id, result: { content: outcome.content, isError: outcome.isError === true } });
    } else if (message.method === "notifications/initialized") {
      // notification — no response
    } else if (message.id != null) {
      send({ jsonrpc: "2.0", id: message.id, result: {} });
    }
  } catch (error) {
    if (message.id != null) {
      fail(message.id, error instanceof Error ? error.message : String(error));
    }
  }
});
