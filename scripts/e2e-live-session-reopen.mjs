/*
 * Billed, minimal live regression for reopened member conversations.
 * Two tiny turns total: native Claude Sonnet/low remembers a code before a real
 * app restart and recalls it after renderer auto-resume. Cross-harness provider
 * routing has its own billed E2E so this lifecycle regression stays independent
 * of OpenRouter credit state.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverBaseUrls } from "./lib/discovery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ws = path.join(os.tmpdir(), `agentparty-reopen-live-ws-${process.pid}`);
const userData = path.join(os.tmpdir(), `agentparty-reopen-live-ud-${process.pid}`);
const claudeModel = process.env.AGENTPARTY_LIVE_CLAUDE_MODEL || "sonnet";
const claudeName = "claude-reopen";
let base = "";

async function main() {
  await removePath(ws);
  await removePath(userData);
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({
    workspacePath: ws,
  }, null, 2));

  let child = launchApp("first");
  try {
    await waitForApi();
    assert((await getJson("/api/health")).ok, "first real app process is healthy");
    const created = await post("/api/parties", { name: "live reopen e2e" });
    const partyId = created.currentPartyId;
    assert(Boolean(partyId), "party created");
    await post("/api/party/members/main/close", {}).catch(() => {});
    await post("/api/party/members", {
      partyId, name: claudeName, requirement: "Minimal Claude reopen regression.",
      runtime: "claude-code", model: claudeModel, effort: "low", permissionMode: "plan",
    });
    // Opening real panels must prewarm; the test never calls /start directly.
    await post("/api/qa/open", { panels: [[claudeName]] });
    const claudeA = await waitForLiveSession(claudeName);
    assert(claudeA.startsWith("session-"), `Claude panel prewarmed session A (${claudeA})`);

    await post(`/api/party/members/${claudeName}/message`, {
      text: "Remember code CLAUDE_REOPEN_7K. Reply exactly CLAUDE_READY. Do not use tools.",
    });
    await waitForAssistantText(claudeName, "CLAUDE_READY");
    const before = await getJson("/api/state");
    const claudeThread = memberOf(before, claudeName)?.harnessSessionId;
    assert(Boolean(claudeThread), `Claude resumable thread persisted (${claudeThread})`);

    await post("/api/navigation", { view: "automation" });
    await delay(300);
    await post("/api/navigation", { view: "workbench" });
    await delay(800);
    const afterMenu = await getJson("/api/state");
    assert(memberOf(afterMenu, claudeName)?.sessionId === claudeA, "menu round-trip keeps Claude open");
    await waitForTranscriptText(claudeName, "CLAUDE_READY");

    // Remove the member's real renderer tab, then add it back. This drives the
    // renderer layout event used by product automation and verifies that panel
    // navigation does not make a still-running member look closed.
    await post("/api/qa/open", { panels: [["main"]] });
    await delay(500);
    await post("/api/qa/open", { panels: [[claudeName]] });
    await delay(800);
    const afterPanelReopen = await getJson("/api/state");
    assert(memberOf(afterPanelReopen, claudeName)?.sessionId === claudeA, "closing and reopening the panel keeps the live session recognized");
    await waitForTranscriptText(claudeName, "CLAUDE_READY");

    // Now close the actual harness session and reopen it through the same
    // AppController start method the sidebar uses. The new adapter must resume
    // the old Claude thread and seed the full persisted transcript.
    await post(`/api/party/members/${claudeName}/close`, {});
    const closed = await getJson("/api/state");
    assert(memberOf(closed, claudeName)?.status === "closed", "member close is reflected as closed, not a phantom live state");
    const resumed = await post(`/api/party/members/${claudeName}/start`, {
      model: claudeModel,
      effort: "low",
      permissionMode: "plan",
    });
    const claudeB = await waitForLiveSession(claudeName, claudeA);
    assert(claudeB.startsWith("resume-"), `explicit reopen resumes session B (${claudeB})`);
    assert(resumed.member?.harnessSessionId === claudeThread, "explicit reopen keeps the same Claude harness thread");
    await waitForTranscriptText(claudeName, "CLAUDE_READY");

    // Compact must always produce a visible lifecycle result. A tiny session
    // may legitimately report that there is nothing to compact; silence is the
    // regression this assertion forbids.
    await post(`/api/sessions/${claudeB}/compact`, {});
    await waitForCompactResult(claudeName);

    await closeApp(child);
    child = launchApp("second");
    base = "";
    await waitForApi();
    assert((await getJson("/api/health")).ok, "second real app process is healthy");

    // No /start: the persisted panel must auto-resume its harness thread.
    const claudeC = await waitForLiveSession(claudeName, claudeB);
    assert(claudeC.startsWith("resume-"), `Claude auto-reopened session C (${claudeC})`);
    const reopened = await getJson("/api/state");
    assert(memberOf(reopened, claudeName)?.harnessSessionId === claudeThread, "Claude kept its harness thread");
    await waitForTranscriptText(claudeName, "CLAUDE_READY");

    // A minimal recall proves provider context, not only transcript files, survived.
    await post(`/api/party/members/${claudeName}/message`, {
      text: "Reply only with the code I asked you to remember in the previous turn.",
    });
    await waitForAssistantText(claudeName, "CLAUDE_REOPEN_7K");
    console.log("LIVE SESSION REOPEN E2E PASSED");
    await closeApp(child);
  } catch (error) {
    killProcessTree(child?.pid);
    throw error;
  } finally {
    await removePath(ws).catch((error) => console.error(`workspace cleanup failed: ${error}`));
    await removePath(userData).catch((error) => console.error(`userData cleanup failed: ${error}`));
  }
}

function launchApp(label) {
  const appLog = path.join(os.tmpdir(), `agentparty-reopen-live-${label}-${process.pid}.log`);
  const logFd = fs.openSync(appLog, "w");
  const child = spawn(process.execPath, [path.join(root, "scripts", "launch-electron.mjs"), "--workspace", ws], {
    cwd: root,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      AGENTPARTY_QA: "1",
      AGENTPARTY_ALLOW_MULTI_INSTANCE: "1",
      AGENTPARTY_USER_DATA: userData,
      AGENTPARTY_WINDOW_DISPLAY: "left",
    },
    windowsHide: true,
  });
  console.log(`${label} app output -> ${appLog}`);
  return child;
}

async function waitForLiveSession(name, previous = "") {
  const started = Date.now();
  let last = "";
  while (Date.now() - started < 90000) {
    const state = await getJson("/api/state");
    const member = memberOf(state, name);
    last = member?.sessionId || last;
    const session = member?.sessionId ? state.sessions.find((item) => item.id === member.sessionId) : undefined;
    if (session?.snapshot?.status === "error") throw new Error(`${name}: ${session.snapshot.lastError || "session error"}`);
    if (member?.sessionId && member.sessionId !== previous && session && session.snapshot.status !== "created") return member.sessionId;
    await delay(500);
  }
  throw new Error(`${name} did not obtain a live session (last=${last || "none"}).`);
}

async function waitForAssistantText(name, expected) {
  const started = Date.now();
  while (Date.now() - started < 180000) {
    const state = await getJson("/api/state");
    const member = memberOf(state, name);
    const session = member?.sessionId ? state.sessions.find((item) => item.id === member.sessionId) : undefined;
    if (session?.snapshot?.status === "error") throw new Error(`${name}: ${session.snapshot.lastError || "session error"}`);
    const blocks = await transcriptOf(name);
    const text = blocks.filter((block) => block?.kind === "assistant").map((block) => String(block.text || "")).join("\n");
    if (text.includes(expected)) { console.log(`  ok: ${name} produced ${expected}`); return; }
    await delay(750);
  }
  throw new Error(`${name} did not produce '${expected}'.`);
}

async function waitForTranscriptText(name, expected) {
  const started = Date.now();
  while (Date.now() - started < 30000) {
    if ((await transcriptOf(name)).some((block) => String(block?.text || "").includes(expected))) {
      console.log(`  ok: ${name} restored ${expected}`);
      return;
    }
    await delay(400);
  }
  throw new Error(`${name} transcript did not restore '${expected}'.`);
}

async function waitForCompactResult(name) {
  const started = Date.now();
  while (Date.now() - started < 60000) {
    const blocks = await transcriptOf(name);
    const visible = blocks.some((block) =>
      /compact/i.test(`${block?.text || ""} ${block?.title || ""} ${block?.detail || ""}`),
    );
    if (visible) {
      console.log(`  ok: ${name} compact produced a visible result`);
      return;
    }
    await delay(500);
  }
  throw new Error(`${name} compact produced no visible result.`);
}

async function transcriptOf(name) {
  const result = await getJson(`/api/party/members/${encodeURIComponent(name)}/transcript`);
  return Array.isArray(result.blocks) ? result.blocks : [];
}

function memberOf(state, name) {
  return (state.party?.members || []).find((member) => member.name === name);
}

async function waitForApi() {
  const started = Date.now();
  while (Date.now() - started < 90000) {
    for (const url of discoverBaseUrls(ws)) {
      base = url;
      try { if ((await getJson("/api/health")).ok) return; } catch {}
    }
    await delay(500);
  }
  throw new Error("Automation API did not start for the live reopen workspace.");
}

async function getJson(url) {
  const response = await fetch(base + url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${await response.text()}`);
  return response.json();
}

async function post(url, body) {
  const response = await fetch(base + url, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}),
  });
  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${await response.text()}`);
  return response.json();
}

async function closeApp(child) {
  await post("/api/window/close", {}).catch(() => {});
  await new Promise((resolve) => {
    const timer = setTimeout(() => { killProcessTree(child?.pid); resolve(); }, 15000);
    child?.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

function killProcessTree(pid) {
  if (!pid) return;
  try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); }
  catch { try { process.kill(pid); } catch {} }
}

async function removePath(target) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try { fs.rmSync(target, { recursive: true, force: true }); return; }
    catch (error) {
      if (error?.code !== "EBUSY" || attempt === 9) throw error;
      await delay(300);
    }
  }
}

function assert(value, message) {
  if (!value) throw new Error(`Assertion failed: ${message}`);
  console.log(`  ok: ${message}`);
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

main().catch((error) => { console.error(error); process.exit(1); });
