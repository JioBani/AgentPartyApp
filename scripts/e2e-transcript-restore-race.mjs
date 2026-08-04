/*
 * Billed product E2E for the WSL transcript-restore/session-start race.
 *
 * A background member begins a real Claude turn immediately after the real
 * Electron app starts, while its large WSL transcript is still restoring. The
 * old failure persisted only the new events. Passing means the historical tail
 * survives both that turn and another full app restart.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverBaseUrls } from "./lib/discovery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const leaf = `agentparty-transcript-race-qa-${process.pid}`;
const linuxWorkspace = `/home/spdlqj8876/${leaf}`;
const workspace = `wsl+Ubuntu-20.04:${linuxWorkspace}`;
const uncWorkspace = `\\\\wsl.localhost\\Ubuntu-20.04${linuxWorkspace.replaceAll("/", "\\")}`;
const userData = path.join(os.tmpdir(), `${leaf}-user-data`);
const member = "race";
const oldMarker = "HISTORY_MUST_SURVIVE_0790";
const replyMarker = "RESTORE_RACE_OK";
let base = "";
let child;

async function main() {
  removeExact(uncWorkspace);
  removeExact(userData);
  fs.mkdirSync(uncWorkspace, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ workspacePath: workspace, debugEnabled: true }, null, 2));

  try {
    // Create the real party/member so the fixture uses the product's own store
    // layout and member identity, then stop the app before seeding history.
    child = launchApp();
    await waitForApi();
    const created = await post("/api/parties", { name: "WSL transcript restore race E2E" });
    const partyId = created.currentPartyId;
    assert(Boolean(partyId), "party created in the real Electron process");
    await post("/api/party/members", {
      partyId,
      name: member,
      requirement: "Reply only with the requested marker.",
      runtime: "claude-code",
      model: "claude-haiku-4-5",
      permissionMode: "bypassPermissions",
    });
    await closeApp();

    const transcriptPath = path.join(uncWorkspace, ".agent_party_app", "parties", partyId, "members", member, "transcript.json");
    const history = Array.from({ length: 800 }, (_, index) => ({
      id: `history-${String(index).padStart(4, "0")}`,
      kind: "assistant",
      text: `${index === 790 ? oldMarker : `history-${index}`} ${"x".repeat(1800)}`,
      at: "오전 01:00",
    }));
    fs.writeFileSync(transcriptPath, JSON.stringify({ version: 1, blocks: history }, null, 2) + "\n", "utf8");
    assert(fs.statSync(transcriptPath).size > 1_000_000, "large WSL transcript fixture seeded before restart");

    // Launch and immediately drive the BACKGROUND member over HTTP. Its session
    // events can beat both the party broadcast and the WSL transcript read.
    child = launchApp();
    base = "";
    await waitForApi();
    await post(`/api/party/members/${member}/message`, {
      text: `Reply exactly ${replyMarker}. Do not use tools.`,
    });
    await waitForReply();
    const afterRace = await waitForPersistedHistory();
    assertHistory(afterRace, "immediate out-of-band start");

    await post("/api/navigation", { view: "workbench" });
    await post("/api/qa/open", { panels: [[member]] });
    await delay(800);
    const shot = path.join(os.tmpdir(), `${leaf}.png`);
    const capture = await post("/api/capture", { path: shot });
    assert(capture.ok && fs.existsSync(shot), `restored conversation captured (${shot})`);
    await closeApp();

    // A second process proves it was really persisted, not only retained in the
    // first renderer's memory.
    child = launchApp();
    base = "";
    await waitForApi();
    const restored = await waitForPersistedHistory();
    assertHistory(restored, "second full app restart");
    await closeApp();
    child = undefined;
    console.log("WSL TRANSCRIPT RESTORE RACE E2E PASSED (real Electron + real Haiku turn + restart)");
  } finally {
    killTree(child?.pid);
    removeExact(userData);
    removeExact(uncWorkspace);
  }
}

function launchApp() {
  const logPath = path.join(os.tmpdir(), `${leaf}-${Date.now()}.log`);
  const fd = fs.openSync(logPath, "w");
  const childProcess = spawn(process.execPath, [path.join(root, "scripts", "launch-electron.mjs"), "--workspace", workspace], {
    cwd: root,
    stdio: ["ignore", fd, fd],
    env: {
      ...process.env,
      AGENTPARTY_QA: "1",
      AGENTPARTY_ALLOW_MULTI_INSTANCE: "1",
      AGENTPARTY_USER_DATA: userData,
      AGENTPARTY_WINDOW_DISPLAY: "left",
    },
    windowsHide: true,
  });
  console.log(`app output -> ${logPath}`);
  return childProcess;
}

async function waitForReply() {
  const started = Date.now();
  while (Date.now() - started < 180_000) {
    const state = await getJson("/api/state");
    const partyMember = (state.party?.members || []).find((item) => item.name === member);
    const session = partyMember?.sessionId ? state.sessions.find((item) => item.id === partyMember.sessionId) : undefined;
    if (session?.snapshot?.status === "error") throw new Error(session.snapshot.lastError || "Claude session failed");
    const transcript = await getJson(`/api/party/members/${member}/transcript`);
    if (JSON.stringify(transcript.blocks || []).includes(replyMarker)) return;
    await delay(700);
  }
  throw new Error(`Real Claude turn did not produce ${replyMarker}`);
}

async function waitForPersistedHistory() {
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    const transcript = await getJson(`/api/party/members/${member}/transcript`);
    const blocks = transcript.blocks || [];
    const raw = JSON.stringify(blocks);
    if (raw.includes(oldMarker) && raw.includes(replyMarker)) return blocks;
    await delay(300);
  }
  throw new Error("Historical marker and new reply never coexisted in persisted transcript");
}

function assertHistory(blocks, phase) {
  const raw = JSON.stringify(blocks);
  assert(raw.includes(oldMarker), `${phase}: historical WSL tail survived`);
  assert(raw.includes(replyMarker), `${phase}: new live reply persisted`);
  assert(blocks.filter((block) => String(block?.id || "").startsWith("history-")).length > 700, `${phase}: history was appended/truncated by cap, never wholesale overwritten`);
}

async function waitForApi() {
  const started = Date.now();
  while (Date.now() - started < 90_000) {
    for (const url of discoverBaseUrls(workspace)) {
      base = url;
      try {
        if ((await getJson("/api/health")).ok) return;
      } catch {}
    }
    await delay(500);
  }
  throw new Error("Automation API did not start for WSL restore-race E2E");
}

async function getJson(url) {
  const response = await fetch(base + url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${await response.text()}`);
  return response.json();
}

async function post(url, body) {
  const response = await fetch(base + url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${await response.text()}`);
  return response.json();
}

async function closeApp() {
  await post("/api/window/close", {}).catch(() => {});
  await new Promise((resolve) => {
    const timer = setTimeout(() => { killTree(child?.pid); resolve(); }, 15_000);
    child?.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

function killTree(pid) {
  if (!pid) return;
  try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
}

function removeExact(target) {
  if (!target.includes(leaf)) throw new Error(`Refusing to remove unexpected path: ${target}`);
  try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
}

function assert(value, message) {
  if (!value) throw new Error(`Assertion failed: ${message}`);
  console.log(`  ok: ${message}`);
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

main().catch((error) => { console.error(error); process.exit(1); });
