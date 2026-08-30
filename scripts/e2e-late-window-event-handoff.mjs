/*
 * Product E2E: a window joining an already-live member reconciles its first IPC
 * batch against the main recorder's transcript cursor before declaring a gap.
 *
 * The large restored transcript keeps the new renderer inside its restore/live
 * handoff while new terminal batches arrive. The old implementation immediately
 * reported "expected 1, received N"; the fixed implementation buffers them,
 * obtains the snapshot cursor, and renders the uncovered tail once.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { waitForLiveBaseUrl } from "./lib/discovery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stamp = Date.now();
const workspace = path.join(os.tmpdir(), `agentparty-late-window-ws-${stamp}`);
const userData = path.join(os.tmpdir(), `agentparty-late-window-ud-${stamp}`);
const failures = [];
const assert = (condition, message) => {
  console.log(`  ${condition ? "ok" : "FAIL"}: ${message}`);
  if (!condition) failures.push(message);
};

let base = "";
let child;
try {
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ workspacePath: workspace }, null, 2));
  const launchedAt = Date.now();
  child = spawn(process.env.ComSpec || "cmd.exe", ["/c", "npm", "run", "start"], {
    cwd: root,
    stdio: ["ignore", "ignore", "inherit"],
    windowsHide: true,
    env: {
      ...process.env,
      AGENTPARTY_QA: "1",
      AGENTPARTY_ALLOW_MULTI_INSTANCE: "1",
      AGENTPARTY_USER_DATA: userData,
      AGENTPARTY_AUTOMATION_PORT: "",
    },
  });
  base = await waitForLiveBaseUrl(workspace, { timeoutMs: 90_000, since: launchedAt });
  assert(Boolean(base), `real app discovered at ${base}`);
  const appRoot = (await get("/api/state")).runtime?.appRoot || "";
  assert((appRoot + path.sep).toLowerCase().startsWith(root.toLowerCase() + path.sep), "running build is this worktree");

  // 750 materialized blocks (~1.5 MiB) make transcript restoration long enough
  // for the live IPC tail below to deterministically overlap it.
  const filler = "x".repeat(2_000);
  const blocks = Array.from({ length: 375 }, (_, index) => ([
    { type: "assistant_text_delta", text: `history-${index}-${filler}` },
    { type: "status", status: `history-boundary-${index}` },
  ])).flat();
  const seed = await post("/api/qa/seed", {
    party: "late-window-event-handoff",
    members: [{ name: "worker", role: "cursor handoff QA", autoReply: false, status: "idle", blocks }],
  });
  const partyId = seed.currentPartyId;
  assert(Boolean(partyId), "large mock transcript seeded");

  // Advance the stream before the second renderer exists.
  for (let index = 0; index < 8; index += 1) {
    await emit(`before-window-${index}`);
  }

  const second = await post("/api/windows", { workspacePath: workspace, partyId });
  const query = `?window=${encodeURIComponent(second.id)}`;
  assert(Boolean(second.id), `late window created (${second.id})`);
  await post(`/api/navigation${query}`, { view: "workbench" });
  await post(`/api/qa/open${query}`, { panels: [["worker"]] });

  // Keep a tail moving while the new renderer parses/restores the large base.
  for (let index = 0; index < 16; index += 1) {
    await emit(`after-window-${index}`);
  }
  await delay(2_500);

  const toast = await post(`/api/measure${query}`, { selector: ".app-toast", limit: 5 })
    .catch(() => ({ elements: [] }));
  const toastText = (toast.elements || []).map((element) => element.text || "").join("\n");
  assert(!/실시간 대화 이벤트 일부가 누락|session event stream gap/i.test(toastText), `late window shows no false event-gap notice (${toastText || "no toast"})`);

  const transcript = await get(`/api/party/members/worker/transcript${query}`);
  const lastText = JSON.stringify(transcript.blocks?.slice(-12) || []);
  assert(lastText.includes("after-window-15"), "late live tail is represented in the materialized transcript");
  assert(Number(transcript.cursor?.seq) > 8, `transcript snapshot advanced beyond the pre-window cursor (seq ${transcript.cursor?.seq})`);
} catch (error) {
  console.error(error);
  failures.push(String(error?.message || error));
} finally {
  if (child?.pid) {
    try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* already gone */ }
  }
  await delay(400);
  for (const target of [workspace, userData]) {
    try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* temp cleanup only */ }
  }
}

console.log(failures.length ? `\nLATE WINDOW EVENT HANDOFF E2E FAILED (${failures.length})` : "\nLATE WINDOW EVENT HANDOFF E2E PASSED");
process.exit(failures.length ? 1 : 0);

async function emit(text) {
  return post("/api/qa/members/worker/emit", {
    events: [
      { type: "assistant_text_delta", text },
      { type: "turn_complete", result: "ok" },
    ],
  });
}

async function get(route) {
  const response = await fetch(base + route);
  if (!response.ok) throw new Error(`${route} ${response.status}: ${await response.text()}`);
  return response.json();
}

async function post(route, body) {
  const response = await fetch(base + route, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (!response.ok) throw new Error(`${route} ${response.status}: ${await response.text()}`);
  return response.json();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
