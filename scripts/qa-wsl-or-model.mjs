/*
 * LIVE e2e for an OpenRouter-backed PARTY MEMBER (regression for the
 * "No explicit AgentParty router mapping for 'GLM-5.2 (OpenRouter)'" bug, where a
 * stale persisted model id was selectable and only failed at chat time).
 * NOT in the suite — billed (real OpenRouter call on the configured key).
 *
 * Creates a member with the catalog OR model "GLM-5.2", starts its session and
 * sends a turn, asserting the session does NOT hit the router-mapping error and
 * the real model responds. Covers the OR-model member path my earlier party
 * e2e (sonnet only) missed.
 */
import { build } from "esbuild";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
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

function readOrKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  try {
    const s = JSON.parse(readFileSync(path.join(os.homedir(), "AppData", "Roaming", "AgentParty", "settings.json"), "utf8"));
    return s.openRouterApiKey || "";
  } catch { return ""; }
}

const distro = process.env.QA_WSL_DISTRO || "Ubuntu-22.04";
const wslWs = process.env.QA_WSL_WS || "/home/dev/agentparty-wsl-e2e";
const model = process.env.QA_MODEL || "GLM-5.2";
const openRouterApiKey = readOrKey();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };

console.log(`LIVE OR-model member e2e (${distro} @ ${wslWs}) — model=${model}, orKey=${openRouterApiKey ? "set" : "MISSING"}:`);
const handle = spawnWslEngine({ distro, workspacePosix: wslWs, serverBundleWinPath: serverBundle, openRouterApiKey });
const client = new RemoteEngineClient(handle.transport, wslWs, handle.dispose);

let sid = "";
const texts = [];
let completed = false;
let errored = "";
client.onEvent((channel, payload) => {
  if (channel !== "session:events" || !Array.isArray(payload?.events)) return;
  if (sid && payload.sessionId && payload.sessionId !== sid) return;
  for (const ev of payload.events) {
    if (ev.type === "assistant_text_delta") texts.push(ev.text || "");
    if (ev.type === "turn_complete") completed = true;
    if (ev.type === "error") errored = ev.message || "error";
    if (ev.type === "status" && ev.detail) process.stdout.write(`    · ${ev.status}: ${String(ev.detail).slice(0, 90)}\n`);
  }
});

try {
  await client.createParty({ name: "or-qa" });
  await client.removeMember("orbot").catch(() => {});
  const made = await client.createMember({ name: "orbot", requirement: "OR routing check", runtime: "claude-code", model });
  assert(made?.ok !== false, "OR-model member created");
  const started = await client.startMember("orbot", { model, effort: "high", permissionMode: "bypassPermissions" });
  sid = started?.session?.id || "";
  assert(Boolean(sid), `member session started (${sid})`);

  await client.sendUserTurn(sid, "Reply with exactly the word PONG and nothing else.");
  console.log("  sent turn; awaiting real OpenRouter response…");
  for (let i = 0; i < 90 && !completed && !errored; i++) await sleep(1000);

  const answer = texts.join("").trim();
  console.log(`\n  model said: ${JSON.stringify(answer.slice(0, 120))}`);
  if (errored) console.log(`  harness error: ${errored}`);

  assert(!/router mapping|Refusing to fall back/i.test(errored), "NO router-mapping error (the reported bug is gone)");
  assert(!errored, "session ran without a harness error");
  assert(completed, "turn completed");
  assert(/pong/i.test(answer), "real OpenRouter model produced a response (PONG)");
} catch (e) {
  console.error("failed:", e?.message || e);
  failures.push(String(e?.message || e));
} finally {
  client.dispose();
}

console.log(failures.length ? `\nOR-MODEL e2e FAILED (${failures.length})` : "\nOR-MODEL e2e PASSED");
process.exit(failures.length ? 1 : 0);
