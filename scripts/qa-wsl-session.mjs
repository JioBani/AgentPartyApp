/*
 * WSL live session plane E2E (Stage 7, the WSL remote-engine design §7). Proves the part
 * that was missing: send a turn to a member whose session lives in the WSL
 * engine, and receive its streamed reply back over wsl.exe — control routed to
 * the owning engine, events pushed from the distro. Uses a mock member, so no
 * credentials/model are needed; only the model's *content* is mocked, the whole
 * transport path is real. Skips where wsl.exe is absent.
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
  const result = await build({ entryPoints: [path.join(projectRoot, entry)], bundle: true, format: "esm", platform: "node", write: false, external: ["electron"] });
  writeFileSync(out, result.outputFiles[0].text);
  return out;
}

let hasWsl = true;
try { execFileSync("wsl.exe", ["-e", "true"], { stdio: "ignore" }); } catch { hasWsl = false; }
if (!hasWsl) { console.log("WSL not available — skipping WSL session E2E."); process.exit(0); }

const serverBundle = await bundle("src/main/engine/transport/engineServerEntry.ts", "engine-server.mjs");
const clientBundle = await bundle("src/main/engine/transport/remoteEngineClient.ts", "engine-client.mjs");
const wslBundle = await bundle("src/main/engine/transport/wslEngine.ts", "wsl-engine.mjs");
const { RemoteEngineClient } = await import(pathToFileURL(clientBundle).href);
const { spawnWslEngine } = await import(pathToFileURL(wslBundle).href);

const distro = process.env.QA_WSL_DISTRO || "Ubuntu-22.04";
const wslWs = process.env.QA_WSL_WS || "/home/dev/agentparty-wsl-e2e";

const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`WSL live session E2E (${distro} @ ${wslWs}):`);

execFileSync("wsl.exe", ["-d", distro, "-e", "bash", "-lc", `rm -rf "${wslWs}/.agent_party_app" && mkdir -p "${wslWs}"`], { encoding: "utf8" });

const handle = spawnWslEngine({ distro, workspacePosix: wslWs, serverBundleWinPath: serverBundle });
const client = new RemoteEngineClient(handle.transport, wslWs, handle.dispose);

// Collect events pushed from the distro engine.
const received = [];
client.onEvent((channel, payload) => received.push({ channel, payload }));

try {
  const seed = await client.qaSeed({ party: "Live", members: [{ name: "wr-live", role: "backend", autoReply: true }] });
  const member = seed.listing.members.find((m) => m.name === "wr-live");
  assert(Boolean(member?.sessionId), `mock member created with a session in the WSL engine (${member?.sessionId || "none"})`);

  // Send a user turn — control routed to the owning (WSL) engine.
  await client.sendUserTurn(member.sessionId, "ping from Windows");
  assert(true, "sendUserTurn routed to the WSL engine without error");

  // The mock replies (assistant @350ms, turn_complete @700ms); allow margin.
  await sleep(1200);
  const events = received.filter((e) => e.channel === "session:events");
  const flat = events.flatMap((e) => (Array.isArray(e.payload?.events) ? e.payload.events : []));
  const forThisSession = events.some((e) => e.payload?.sessionId === member.sessionId);
  const gotReply = flat.some((ev) => ev.type === "assistant_text_delta" && /mock/.test(ev.text || ""));
  const gotComplete = flat.some((ev) => ev.type === "turn_complete");

  assert(events.length > 0, `received session:events pushed from the distro engine (${events.length} batch(es))`);
  assert(forThisSession, "events are tagged with the WSL session id");
  assert(gotReply, "streamed the mock assistant reply back to Windows");
  assert(gotComplete, "streamed turn_complete back to Windows");
} finally {
  client.dispose();
}

console.log("");
if (failures.length) {
  console.log(`WSL SESSION FAILED: ${failures.length} assertion(s)`);
  process.exit(1);
}
console.log("WSL SESSION PASSED (turn sent to a WSL session; reply streamed back over wsl.exe)");
process.exit(0);
