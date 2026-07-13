/*
 * REAL model call through the WSL engine (manual verification, NOT in the test
 * suite — it makes a billed call on the distro's logged-in Claude subscription).
 * Creates a real session in the WSL engine and asks for "PONG".
 *
 * Requires: @anthropic-ai/claude-agent-sdk installed in ~/.agent_party_app/server
 * inside the distro, and the distro logged in (~/.claude credentials).
 */
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const qaDir = path.join(projectRoot, "node_modules/.qa");
mkdirSync(qaDir, { recursive: true });

async function bundle(entry, outName) {
  const out = path.join(qaDir, outName);
  const r = await build({ entryPoints: [path.join(projectRoot, entry)], bundle: true, format: "esm", platform: "node", write: false, external: ["electron"] });
  writeFileSync(out, r.outputFiles[0].text);
  return out;
}

const serverBundle = await bundle("src/main/engine/transport/engineServerEntry.ts", "engine-server.mjs");
const clientBundle = await bundle("src/main/engine/transport/remoteEngineClient.ts", "engine-client.mjs");
const wslBundle = await bundle("src/main/engine/transport/wslEngine.ts", "wsl-engine.mjs");
const { RemoteEngineClient } = await import(pathToFileURL(clientBundle).href);
const { spawnWslEngine } = await import(pathToFileURL(wslBundle).href);

const distro = process.env.QA_WSL_DISTRO || "Ubuntu-22.04";
const wslWs = process.env.QA_WSL_WS || "/home/dev/agentparty-wsl-e2e";
const model = process.env.QA_MODEL || "sonnet";
const harness = process.env.QA_HARNESS || "claude-code";
const openRouterApiKey = process.env.OPENROUTER_API_KEY || "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`REAL model call via WSL engine (${distro} @ ${wslWs}) — harness=${harness}, model=${model}:`);
const handle = spawnWslEngine({
  distro,
  workspacePosix: wslWs,
  serverBundleWinPath: serverBundle,
  codexMcpServerWinPath: path.join(projectRoot, "scripts", "agentparty-codex-mcp-server.mjs"),
  openRouterApiKey,
});
const client = new RemoteEngineClient(handle.transport, wslWs, handle.dispose);

const texts = [];
let completed = false;
let errored = "";
client.onEvent((channel, payload) => {
  if (channel === "session:events" && Array.isArray(payload?.events)) {
    for (const ev of payload.events) {
      if (ev.type === "assistant_text_delta") texts.push(ev.text || "");
      if (ev.type === "turn_complete") completed = true;
      if (ev.type === "error") errored = ev.message || "error";
      if (ev.type === "status" && ev.detail) process.stdout.write(`    · ${ev.status}: ${String(ev.detail).slice(0, 80)}\n`);
    }
  }
});

try {
  const session = await client.createSession({
    selectedHarnessId: harness,
    selectedProviderId: harness === "codex" ? "openai" : undefined,
    model,
    effort: process.env.QA_EFFORT || "low",
    permissionMode: "bypassPermissions",
  });
  console.log(`  session created in WSL engine: ${session.id} (${session.snapshot?.status})`);

  await client.sendUserTurn(session.id, "Reply with exactly the word PONG and nothing else.");
  console.log("  sent turn; awaiting real model response…");

  for (let i = 0; i < 60 && !completed && !errored; i++) {
    await sleep(1000);
  }

  const answer = texts.join("").trim();
  console.log("");
  console.log(`  model said: ${JSON.stringify(answer)}`);
  if (errored) {
    console.log(`  ERROR from harness: ${errored}`);
    process.exitCode = 1;
  } else if (/pong/i.test(answer)) {
    console.log(`REAL WSL MODEL CALL PASSED (live ${harness} response streamed from the WSL engine)`);
  } else if (completed) {
    console.log("turn completed but no PONG — see text above");
  } else {
    console.log("TIMED OUT waiting for the model");
    process.exitCode = 1;
  }
} catch (e) {
  console.error("failed:", e?.message || e);
  process.exitCode = 1;
} finally {
  client.dispose();
}
