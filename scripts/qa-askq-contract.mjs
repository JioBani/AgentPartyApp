/*
 * EXPERIMENT (manual, billed on subscription): determine how AskUserQuestion
 * answers must be delivered back through the canUseTool/approve path. Forces the
 * model to call AskUserQuestion, then approves with a candidate `updatedInput`
 * and prints every following event (tool_result, assistant text, errors) so we
 * can see the real contract instead of guessing. Run against the WSL engine.
 */
import { build } from "esbuild";
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const handle = spawnWslEngine({ distro, workspacePosix: wslWs, serverBundleWinPath: serverBundle, openRouterApiKey: "" });
const client = new RemoteEngineClient(handle.transport, wslWs, handle.dispose);

let approval = null;
let done = false;
let errored = "";
const texts = [];
client.onEvent((channel, payload) => {
  if (channel !== "session:events" || !Array.isArray(payload?.events)) return;
  for (const ev of payload.events) {
    if (ev.type === "approval_request") { approval = ev; console.log(`\n>>> approval_request tool=${ev.toolName}\n    input=${JSON.stringify(ev.input)}\n`); }
    else if (ev.type === "tool_call" && ev.name === "tool_result") console.log(`    [tool_result] ${JSON.stringify(ev.result).slice(0, 400)}`);
    else if (ev.type === "tool_call") console.log(`    [tool_call ${ev.status}] ${ev.name}`);
    else if (ev.type === "assistant_text_delta") texts.push(ev.text || "");
    else if (ev.type === "turn_complete") { done = true; console.log(`    [turn_complete] stop=${ev.stopReason || ""}`); }
    else if (ev.type === "error") { errored = ev.message || "error"; console.log(`    [ERROR] ${errored}`); }
    else if (ev.type === "status") console.log(`    · ${ev.status}: ${String(ev.detail ?? "").slice(0, 70)}`);
  }
});

try {
  const session = await client.createSession({ model: "sonnet", effort: "low", permissionMode: "default" });
  console.log(`session: ${session.id}`);
  await client.sendUserTurn(session.id,
    "Call the AskUserQuestion tool exactly once to ask me: 'Which lunch?' with header 'Lunch' and two options: label '김밥' (description '간단하게') and label '라멘' (description '뜨끈하게'). Do not say anything else first — just call the tool.");

  for (let i = 0; i < 40 && !approval; i++) await sleep(500);
  if (!approval) { console.log("NO approval_request arrived (model did not call AskUserQuestion)"); }
  else {
    const q = approval.input?.questions?.[0];
    const chosen = q?.options?.[0]?.label || "김밥";
    const candidate = { ...approval.input, answers: { [q.question]: chosen } };
    console.log(`>>> approving allow with candidate updatedInput=${JSON.stringify(candidate)}\n`);
    await client.approveSession(session.id, approval.requestId, "allow", candidate);
    for (let i = 0; i < 60 && !done && !errored; i++) await sleep(500);
  }
  console.log(`\n=== RESULT ===\ncompleted=${done} errored=${JSON.stringify(errored)}\nassistant: ${JSON.stringify(texts.join("").slice(0, 300))}`);
} catch (e) {
  console.error("failed:", e?.message || e);
  process.exitCode = 1;
} finally {
  client.dispose();
}
