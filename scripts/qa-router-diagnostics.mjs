/*
 * Router-backed model startup diagnostics.
 *
 * A GPT model on the CLAUDE CODE harness is not served by Anthropic: the local
 * AgentParty router forwards it to a local CLIProxyAPI (the subscription proxy).
 * When that chain is down the user sees "the gpt backend does not work", and the
 * error has to say WHICH link to start — naming only the router sent people
 * looking at the wrong process.
 *
 * Drives the real ClaudeAdapter (fake SDK, so no harness process) against:
 *   1. no router at all            → names the router AND the CLIProxyAPI chain
 *   2. a router with the proxy off → names the CLIProxyAPI specifically
 *   3. an Anthropic model          → unaffected (no router in its path)
 */
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const assert = (c, m) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) failures.push(m); };
const outDir = path.join(projectRoot, "node_modules/.qa"); mkdirSync(outDir, { recursive: true });

const built = await build({
  entryPoints: [path.join(projectRoot, "src/core/claudeAdapter.ts")],
  bundle: true, format: "esm", platform: "node", write: false,
  external: ["electron", "@anthropic-ai/claude-agent-sdk"],
});
const file = path.join(outDir, "claude-adapter-router.mjs");
writeFileSync(file, built.outputFiles[0].text);
const { ClaudeAdapter } = await import(pathToFileURL(file).href);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GPT_ON_CLAUDE = "claude-gpt-5.5"; // catalog: provider openai + codexModel → codex-subscription

function idleSdk() {
  return {
    query: () => ({
      async interrupt() {}, close() {}, async setModel() {}, async applyFlagSettings() {},
      async *[Symbol.asyncIterator]() { await new Promise(() => {}); },
      supportedCommands: async () => [], supportedModels: async () => [], mcpServerStatus: async () => ({}),
    }),
    createSdkMcpServer: () => ({}), tool: () => ({}),
  };
}

/** Collects the first error the adapter surfaces while starting. */
async function startupError(model, routerBaseUrl) {
  const errors = [];
  const adapter = new ClaudeAdapter({
    id: `s-router-${errors.length}-${model}`, cwd: os.tmpdir(), model,
    effort: "medium", permissionMode: "default",
    storageDir: path.join(outDir, "router-store"),
    routerBaseUrl, routerAuthToken: "t",
    sdkLoader: async () => idleSdk(),
  });
  adapter.on("event", (event) => { if (event.type === "error") errors.push(event.message); });
  adapter.start();
  await sleep(600);
  adapter.dispose();
  return errors.join("\n");
}

async function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

console.log("\nrouter down:");
{
  const port = await freePort(); // nothing listening here
  const message = await startupError(GPT_ON_CLAUDE, `http://127.0.0.1:${port}`);
  assert(/not reachable/i.test(message), "startup fails instead of retrying against an unavailable backend");
  assert(/CLIProxyAPI/i.test(message), "the error names the CLIProxyAPI this model actually depends on");
}

console.log("\nrouter up but the subscription proxy is not configured:");
{
  const port = await freePort();
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, subscriptionProxyConfigured: false, subscriptionProxyBaseUrl: "http://127.0.0.1:8317" }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const message = await startupError(GPT_ON_CLAUDE, `http://127.0.0.1:${port}`);
  server.close();
  assert(/CLIProxyAPI/i.test(message), "a running router with no proxy still names the CLIProxyAPI as the cause");
  assert(/127\.0\.0\.1:8317/.test(message), "and states where it was expected");
  assert(!/not reachable/i.test(message), "it does not blame router reachability when the router answered");
}

console.log("\nan Anthropic model is unaffected:");
{
  const port = await freePort();
  const message = await startupError("sonnet", `http://127.0.0.1:${port}`);
  assert(!/not reachable|CLIProxyAPI/i.test(message), `no router diagnostics for a direct Anthropic model (got: ${message || "none"})`);
}

console.log(failures.length ? `\n${failures.length} FAILED` : "\nall passed");
process.exit(failures.length ? 1 : 0);
