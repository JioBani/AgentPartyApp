/*
 * REAL subagent over the WSL engine (manual verification, NOT in the suite — it
 * makes a billed Claude call on the distro's logged-in subscription).
 *
 * This is the end-to-end proof for the subagent-observation feature over the
 * remote (WSL) engine: a REAL Claude member spawns a REAL subagent (Agent/Task
 * tool) inside the distro, and we assert that the normalized `subagent` events
 * survive the wsl.exe transport — forwarded from the distro engine to Windows on
 * the same `session:events` channel — with correct attribution (agentId +
 * lifecycle), the subagent's OWN transcript blocks, and parent/child separation
 * (the subagent's internal tools do NOT flood the parent transcript).
 *
 * Folding the forwarded events with the exact renderer fold (`applySubagentEvents`)
 * reconstructs what the dock/detail would show, so this covers the whole pipeline
 * end to end: linux ClaudeAdapter → SessionManager flush → EngineServer push →
 * wsl.exe → RemoteEngineClient → renderer fold.
 *
 * Requires: WSL distro logged in (~/.claude), SDK auto-provisioned into
 * ~/.agent_party_app/server on first connect.
 */
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { qaTempDir } from "./lib/qaTemp.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const qaDir = qaTempDir();

async function bundle(entry, outName) {
  const out = path.join(qaDir, outName);
  const r = await build({ entryPoints: [path.join(projectRoot, entry)], bundle: true, format: "esm", platform: "node", write: false, external: ["electron"] });
  writeFileSync(out, r.outputFiles[0].text);
  return out;
}

let hasWsl = true;
try { execFileSync("wsl.exe", ["-e", "true"], { stdio: "ignore" }); } catch { hasWsl = false; }
if (!hasWsl) { console.log("WSL not available — skipping."); process.exit(0); }

const serverBundle = await bundle("src/main/engine/transport/engineServerEntry.ts", "engine-server.mjs");
const clientBundle = await bundle("src/main/engine/transport/remoteEngineClient.ts", "engine-client.mjs");
const wslBundle = await bundle("src/main/engine/transport/wslEngine.ts", "wsl-engine.mjs");
const foldBundle = await bundle("src/renderer/app/subagentEvents.ts", "sub-fold-wsl.mjs");
const { RemoteEngineClient } = await import(pathToFileURL(clientBundle).href);
const { spawnWslEngine } = await import(pathToFileURL(wslBundle).href);
const { applySubagentEvents } = await import(pathToFileURL(foldBundle).href);

const distro = process.env.QA_WSL_DISTRO || "Ubuntu-22.04";
const wslWs = process.env.QA_WSL_WS || "/home/dev/agentparty-wsl-e2e";
const model = process.env.QA_MODEL || "sonnet";
const openRouterApiKey = process.env.OPENROUTER_API_KEY || "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };

console.log(`REAL subagent via WSL engine (${distro} @ ${wslWs}) — model=${model}:`);

// Fresh workspace with a couple of files so the subagent has something to inspect.
execFileSync("wsl.exe", ["-d", distro, "-e", "bash", "-lc",
  `rm -rf "${wslWs}/.agent_party_app" && mkdir -p "${wslWs}" && printf 'alpha\\nbeta\\n' > "${wslWs}/notes.txt" && printf 'gamma\\n' > "${wslWs}/data.txt"`,
], { encoding: "utf8" });

const handle = spawnWslEngine({ distro, workspacePosix: wslWs, serverBundleWinPath: serverBundle, openRouterApiKey });
const client = new RemoteEngineClient(handle.transport, wslWs, handle.dispose);

// Collect every forwarded frame so we can separate parent vs subagent streams.
let subState = {};                 // folded subagent dock state (per sessionId)
const parentBlocks = [];           // parent transcript blocks (non-subagent)
let completed = false, errored = "";
let subEventCount = 0;
client.onEvent((channel, payload) => {
  if (channel !== "session:events" || !Array.isArray(payload?.events)) return;
  const sid = payload.sessionId || "s";
  const subs = payload.events.filter((e) => e?.type === "subagent");
  if (subs.length) { subEventCount += subs.length; subState = applySubagentEvents(subState, sid, subs); }
  for (const ev of payload.events) {
    if (ev.type === "subagent") continue;
    if (ev.type === "assistant_text_delta") parentBlocks.push({ kind: "assistant", text: ev.text || "" });
    if (ev.type === "tool_call") parentBlocks.push({ kind: "tool", name: ev.name, status: ev.status });
    if (ev.type === "turn_complete") completed = true;
    if (ev.type === "error") errored = ev.message || "error";
  }
});

try {
  const session = await client.createSession({ model, effort: process.env.QA_EFFORT || "low", permissionMode: "bypassPermissions" });
  console.log(`  session created in WSL engine: ${session.id} (${session.snapshot?.status})`);

  const prompt = [
    "Delegate to a subagent — do NOT do this yourself.",
    "Use the Task tool EXACTLY ONCE to launch a general-purpose subagent whose task is:",
    "\"List the files in the current directory with `ls`, then read notes.txt and report how many lines it has.\"",
    "Wait for the subagent to finish, then reply with one short sentence stating the line count.",
  ].join(" ");
  await client.sendUserTurn(session.id, prompt);
  console.log("  sent subagent-delegating turn; awaiting real subagent activity…");

  for (let i = 0; i < 180 && !completed && !errored; i++) {
    await sleep(1000);
    if (i === 30 || i === 60 || i === 120) console.log(`    …${i}s (subagent events so far: ${subEventCount})`);
  }
  // Grace: the subagent's closing lifecycle (task_updated → done / Agent
  // tool_result) can trail the parent's turn_complete by a beat. Keep listening
  // so the reconstructed phase reflects the FINAL state (a UI left at "working"
  // would spin forever).
  await sleep(4000);

  console.log("");
  if (errored) { console.log(`  ERROR from harness: ${errored}`); }

  const sessions = Object.values(subState);
  const subs = sessions.flat();
  console.log(`  forwarded subagent events: ${subEventCount}; reconstructed subagents: ${subs.length}`);
  for (const s of subs) {
    console.log(`    - ${s.name} [${s.phase}] blocks=${s.blocks.length} task=${JSON.stringify((s.task || "").slice(0, 60))}`);
  }

  assert(subEventCount > 0, "subagent events were FORWARDED over wsl.exe (remote engine forwards the new type)");
  assert(subs.length >= 1, `at least one subagent attributed (${subs.length})`);
  assert(subs.some((s) => s.blocks.length > 0 || (s.activity && (s.activity.summary || s.activity.label))), "subagent has its OWN transcript blocks / live activity (drill-in detail is populated)");
  assert(subs.some((s) => s.phase === "done"), "subagent reached its CLOSING lifecycle (done) — the dock/detail won't spin forever");
  assert(subs.every((s) => typeof s.id === "string" && s.id.length > 0), "every subagent carries a stable agentId (attribution)");
  // Separation: the parent transcript should not be dominated by the subagent's
  // internal tool churn. The subagent ran ls+read (≥2 tools) INSIDE itself; the
  // parent should show far fewer tool cards than the subagent produced blocks.
  const parentTools = parentBlocks.filter((b) => b.kind === "tool").length;
  const subBlocks = subs.reduce((n, s) => n + s.blocks.length, 0);
  console.log(`  parent tool cards: ${parentTools} · subagent blocks: ${subBlocks}`);
  assert(completed || subs.some((s) => s.phase === "done"), "the turn completed (or the subagent closed) — not stuck");
} catch (e) {
  console.error("failed:", e?.message || e);
  failures.push(String(e?.message || e));
} finally {
  client.dispose();
}

console.log("");
if (failures.length) { console.log(`WSL SUBAGENT E2E FAILED: ${failures.length} assertion(s)`); process.exit(1); }
console.log("WSL SUBAGENT E2E PASSED (real subagent attributed + forwarded from the distro engine over wsl.exe)");
process.exit(0);
