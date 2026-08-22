/*
 * Full-process e2e for transcript rendering.
 *
 * Launches the REAL Electron app on an isolated userData + temp workspace,
 * discovers it through the per-workspace instance file (NEVER a fixed port — a
 * fixed port once attached a driver to the user's own running app), seeds a mock
 * member, streams real normalized events into its transcript and drives the
 * rendered UI over HTTP. Offline: no model call, no billing.
 *
 * Legs, one per lane item: [P-3]5 external links · [P-3]3 one-click copy ·
 * [P-3]7 progress indicator · [#6] long subagent prompt · [#16] modals ignoring
 * an outside click · 전체 보기 on a COLLAPSED tool block · [P-8] harness badge · [#14] a code block surviving a
 * message sent mid-stream · [#13] a dead member reading as disconnected.
 *
 * Every click asserts `applied.clicked`. A selector that matches nothing now
 * FAILS the request, so a click leg can no longer pass by rendering something
 * else — before that landed these legs only checked that a PNG came back, and
 * a human had to read it.
 *
 * Run: node scripts/e2e-transcript-render.mjs   (after `npm run build`)
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { firstBaseUrl } from "./lib/discovery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ws = path.join(os.tmpdir(), "agentparty-w2-transcript-e2e-workspace");
const userData = path.join(os.tmpdir(), "agentparty-w2-transcript-e2e-user-data");
const shotDir = path.join(os.tmpdir(), "agentparty-w2-shots");

// A URL that is unmistakable in the IPC log and harmless if the OS browser does
// open it (the handler ends in a real `shell.openExternal`).
const LINK = "https://example.com/agentparty-w2-e2e";

let base = "";
const failures = [];
const ok = (condition, message) => {
  console.log(`  ${condition ? "ok" : "FAIL"}: ${message}`);
  if (!condition) failures.push(message);
};

async function main() {
  await removePath(ws);
  await removePath(userData);
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(shotDir, { recursive: true });
  // The launch workspace comes from the isolated settings file — with no
  // `workspacePath` the app falls back to its own cwd and would drop its
  // discovery file into the source tree. No `automationApiPort`: the port stays
  // ephemeral and is discovered from the workspace's instance file.
  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ workspacePath: ws }, null, 2));

  const child = spawn(process.env.ComSpec || "cmd.exe", ["/c", "npm", "run", "start"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      AGENTPARTY_QA: "1",
      AGENTPARTY_ALLOW_MULTI_INSTANCE: "1",
      AGENTPARTY_USER_DATA: userData,
      AGENTPARTY_WINDOW_DISPLAY: "left",
      // Never inherit a pinned port: discovery is by instance file.
      AGENTPARTY_AUTOMATION_PORT: "",
    },
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  try {
    base = await discover();
    const health = await get("/api/health");
    ok(health.ok, `app is up at ${base}`);
    await assertRunningBuildIsThisWorktree();
    // The served workspace must be OURS — never the user's real one.
    const windows = (await get("/api/windows")).windows || [];
    ok(windows[0]?.workspacePath === ws, `window serves the e2e workspace (${windows[0]?.workspacePath})`);

    await post("/api/qa/seed", {
      party: "w2 transcript e2e",
      members: [{ name: "renderer", model: "claude-sonnet-4.5", role: "렌더링 QA" }],
    });
    await post("/api/navigation", { view: "workbench" });
    await post("/api/qa/open", { panels: [["renderer"]] });

    await linkOpensInOsBrowser();
    await oneClickCopy();
    // The indicator leg runs before the subagent leg: the drill-in detail is an
    // overlay that covers the panel header the indicator lives in.
    await progressIndicator();
    await longSubagentTaskCollapses();
    await harnessIsVisible();
    await codeBlockSurvivesInterjection();
    await modalsIgnoreOutsideClicks();
    await collapsedToolOpensItsPopup();
    await deadMemberReadsAsDisconnected();

    await post("/api/window/close", {}).catch(() => {});
    await waitForExit(child);
  } catch (error) {
    killProcessTree(child.pid);
    throw error;
  }

  console.log(failures.length ? `\nW2 TRANSCRIPT E2E FAILED (${failures.length})` : "\nW2 TRANSCRIPT E2E PASSED");
  process.exit(failures.length ? 1 : 0);
}

/**
 * Step 0 — the build now running IS this worktree.
 *
 * A driver launched from a worktree can easily end up measuring a DIFFERENT
 * checkout (a hardcoded root did exactly that across this project's scripts), and
 * every later assertion would then describe someone else's code while passing.
 * `runtime.appRoot` is read by the app from its OWN running module, so unlike
 * `workspacePath` it is not a value this script fed in.
 *
 * Compared on a path BOUNDARY, never a bare prefix: `C:\…\AgentPartyApp` is a
 * string prefix of `C:\…\AgentPartyApp-w2`, so `startsWith` alone would accept a
 * main-worktree build as this one — reproducing, inside the check, the exact
 * false green the check exists to prevent.
 */
async function assertRunningBuildIsThisWorktree() {
  const appRoot = (await get("/api/state")).runtime?.appRoot || "";
  const within = (appRoot + path.sep).toLowerCase().startsWith(root.toLowerCase() + path.sep);
  ok(Boolean(appRoot) && within, `running build is THIS worktree (appRoot=${appRoot || "<missing>"}, expected under ${root})`);
}

/**
 * Clicks a selector in the real window and asserts the click actually landed.
 * A selector matching nothing fails the request outright, so `applied.clicked`
 * is a real signal rather than a restatement of `ok`.
 */
async function clickAndCapture(selector, shotName, message) {
  const shot = path.join(shotDir, shotName);
  try {
    const result = await post("/api/capture", { click: selector, path: shot });
    ok(result.applied?.clicked === true && result.bytes > 0, `${message} → ${shotName}`);
    return result;
  } catch (error) {
    ok(false, `${message} — click failed: ${error.message}`);
    return null;
  }
}

/**
 * [P-3]5 — a link in model output must reach the OS default browser, not
 * navigate the Electron window. The proof is the main process's own IPC log
 * recording `shell:openExternal` with the URL after a real click in the real
 * renderer.
 */
async function linkOpensInOsBrowser() {
  console.log("\n[P-3]5 links open in the OS default browser:");
  await post("/api/qa/members/renderer/emit", {
    events: [{ type: "assistant_text_delta", text: `문서는 [여기](${LINK}) 를 보세요.` }],
  });
  await delay(600);

  const before = ipcLogLines().length;
  await clickAndCapture(`.wb-md-link a[href="${LINK}"]`, "p3-5-link.png", "clicked the rendered link");
  await delay(500);

  const opened = ipcLogLines().slice(before).filter((line) => line.includes("shell:openExternal"));
  ok(opened.length > 0, "clicking the link invoked the main-process shell:openExternal handler");
  ok(opened.some((line) => line.includes(LINK)), "…with the link's own URL");

  // The window must still be the workbench — an in-app navigation would have
  // replaced the renderer document entirely.
  const stillUp = await get("/api/health");
  ok(stillUp.ok, "the app window did not navigate away (workbench still serving)");

  // The copy control writes the target; the capture right after the click shows
  // its honest outcome — a check when the write landed, an ✗ when the platform
  // refused (it never claims a copy that did not happen).
  await clickAndCapture(".wb-md-link .wb-copy-btn", "p3-5-link-copy.png", "clicked the link copy control");
}

/**
 * [P-3]3 — a code block and a whole reply are one click from the clipboard.
 * jsdom locks WHAT gets copied; what only the real app can show is that the
 * controls are reachable in the rendered transcript and that the real Electron
 * clipboard accepts the write (the button paints its check only on a write that
 * actually resolved).
 */
async function oneClickCopy() {
  console.log("\n[P-3]3 one-click copy of code blocks and replies:");
  await post("/api/qa/members/renderer/emit", {
    events: [{ type: "assistant_text_delta", text: "\n\n수정안:\n\n```ts\nexport const answer = 42;\n```\n" }],
  });
  await delay(600);

  await clickAndCapture(".wb-md pre .wb-copy-btn", "p3-3-code-copy.png", "clicked the code-block copy control");
  await clickAndCapture(".wb-assistant-head .wb-copy-btn", "p3-3-reply-copy.png", "clicked the whole-reply copy control");
}

/**
 * [#6] — a long delegated prompt filled the whole drill-in view. Injected as a
 * real `subagent` event (not a canned scenario, since every canned task is
 * short), so the whole normalization → fold → render path runs. The capture is
 * the assertion the DOM tests cannot make: that the subagent's own work is still
 * on screen next to the prompt.
 */
async function longSubagentTaskCollapses() {
  console.log("\n[#6] a long subagent prompt is collapsed:");
  const longTask = Array.from({ length: 40 }, (_, i) => `${i + 1}. 리팩터링 대상 파일과 검증 절차를 순서대로 기술한 지시 라인`).join("\n");
  const at = new Date().toISOString();
  await post("/api/qa/members/renderer/emit", {
    events: [
      { type: "subagent", agentId: "long-1", at, lifecycle: { phase: "working", label: "refactorer", hint: "src/**", assignedTask: longTask } },
      { type: "subagent", agentId: "long-1", at, block: { kind: "assistant", text: "대상 파일 12개를 확인했습니다." } },
    ],
  });
  await delay(700);

  // The dock is expanded by default, so the row is already on screen.
  const dockShot = path.join(shotDir, "issue-6-dock.png");
  ok((await post("/api/capture", { path: dockShot })).bytes > 0, `subagent dock row → ${dockShot}`);

  // Drill in through the app's own UI route (not a blind DOM click): this one
  // reports whether it actually ran.
  const opened = await post("/api/qa/members/renderer/subagents/open", { subId: "long-1" });
  ok(opened.ok && opened.subId === "long-1", "drilled into the subagent through the real open route");
  await delay(400);
  const detailShot = path.join(shotDir, "issue-6-detail.png");
  ok((await post("/api/capture", { path: detailShot })).bytes > 0, `drill-in detail with the collapsed prompt → ${detailShot}`);

  await clickAndCapture(".wb-subdetail-task .wb-expand-inline", "issue-6-detail-full.png", "opened 전체 보기 on the delegated prompt");
}

/**
 * [P-8] — which harness a member runs on, wherever the member is named. Creates
 * REAL members on all three harnesses (member creation does not start a session,
 * so this stays offline) and opens them as tabs, proving the badge is driven by
 * each member's own persisted `runtime` rather than a render-time default.
 */
async function harnessIsVisible() {
  console.log("\n[P-8] the harness is shown next to the member:");
  for (const [name, runtime] of [["codexy", "codex"], ["cursory", "cursor"]]) {
    await post("/api/party/members", { name, runtime, requirement: "harness badge e2e" });
  }
  const listed = (await get("/api/party")).members || [];
  const runtimes = Object.fromEntries(listed.map((m) => [m.name, m.runtime]));
  ok(runtimes.codexy === "codex" && runtimes.cursory === "cursor", `members persist their own harness (${JSON.stringify(runtimes)})`);

  await post("/api/qa/open", { panels: [["renderer", "codexy", "cursory"]] });
  await delay(700);
  const shot = path.join(shotDir, "p8-harness.png");
  ok((await post("/api/capture", { path: shot })).bytes > 0, `sidebar rows + tabs carrying each member's harness → ${shot}`);
}

/**
 * [#14] — a message sent WHILE a reply streams used to end the assistant's block
 * mid-markdown, leaving a fence opened in one block and closed in another, which
 * renders as broken prose. Streams an unterminated fence, sends a real user turn
 * through the same AppController path the composer uses, then finishes the fence.
 */
async function codeBlockSurvivesInterjection() {
  console.log("\n[#14] a code block survives a message sent mid-stream:");
  await post("/api/qa/open", { panels: [["talker"]] }).catch(() => {});
  // autoReply off: a real harness QUEUES a message sent mid-turn and answers it
  // only after the running turn completes. The mock would answer instantly,
  // which is a sequence the real app never produces.
  await post("/api/qa/members", { name: "talker", role: "스트리밍 재현", model: "claude-sonnet-4.5", autoReply: false });
  await post("/api/qa/open", { panels: [["talker"]] });
  await delay(400);

  await post("/api/qa/members/talker/emit", {
    events: [{ type: "assistant_text_delta", text: "패치는 이렇습니다:\n\n```ts\nexport function a() {\n" }],
  });
  await delay(400);
  await post("/api/party/members/talker/message", { text: "테스트도 같이 넣어줘" });
  await delay(400);
  await post("/api/qa/members/talker/emit", {
    events: [{ type: "assistant_text_delta", text: "  return 1;\n}\n```\n\n이상입니다." }],
  });
  await delay(700);

  const shot = path.join(shotDir, "issue-14-stream.png");
  ok((await post("/api/capture", { path: shot })).bytes > 0, `reply + interjected message + finished code block → ${shot}`);
}

/**
 * [#16] — a modal must close by its own control, never by a stray click outside.
 * Only the real app can show this: the popup has to be OPEN, the backdrop has to
 * be a real element under a real pointer, and the modal has to still be there
 * afterwards. Both clicks assert `applied.clicked`, so a mistyped selector fails
 * instead of "proving" the modal survived a click that never happened.
 */
/**
 * 전체 보기 must work from a tool block that is CLOSED — the state the button
 * exists for, since a block whose output already fits needs no popup at all.
 *
 * It did not. The popup was rendered among the <details> children, and a closed
 * disclosure hides every child but its summary, so one click set the state and
 * painted nothing; only opening the block first made the same click "work".
 * That reads as a dead button, which is why the assertion here is not "the
 * state changed" but "the popup has a box on screen while the block stays shut".
 */
async function collapsedToolOpensItsPopup() {
  console.log("\n… 전체 보기 works while the tool block is collapsed:");
  await post("/api/qa/open", { panels: [["renderer"]] });
  await post("/api/qa/members/renderer/emit", {
    events: [{
      type: "tool_call", id: "e2e-collapsed-tool", name: "Bash", status: "completed", exitCode: 0,
      input: { command: "npm run test:layout -- --reporter=verbose" },
      // Longer than the 6-line / 320-char inline preview, which is what makes
      // the button appear in the first place.
      result: "$ npm run test:layout\n" + "  ok  wb-panel — measured 1, 0 overflow\n".repeat(18) + "18 assertions, 0 failures",
    }],
  });
  await delay(700);

  // A wide panel opens tool blocks by default; close it, because closed is the
  // case under test.
  const before = await measureOne(".wb-tool", ["open"]);
  if (before?.attributes?.open !== null && before?.attributes?.open !== undefined) {
    await clickAndCapture(".wb-tool > summary .wb-tool-name", "tool-collapse.png", "collapsed the tool block");
  }
  const closed = await measureOne(".wb-tool", ["open"]);
  ok(closed?.attributes?.open === null || closed?.attributes?.open === undefined, "the tool block is closed");

  await clickAndCapture(".wb-tool > summary .wb-tool-expand", "tool-expand-collapsed.png", "clicked 전체 보기 once, on the closed block");

  const modal = await measureOne(".wb-tool-modal", []);
  ok(Boolean(modal && modal.box?.height > 0), `the popup is on screen (${modal ? Math.round(modal.box.width) + "×" + Math.round(modal.box.height) : "not rendered"})`);

  const still = await measureOne(".wb-tool", ["open"]);
  ok(still?.attributes?.open === null || still?.attributes?.open === undefined, "…and the block behind it did not spring open");

  await clickAndCapture(".wb-tool-modal-head .wb-icon-btn", "tool-expand-closed.png", "the popup closes on its own 닫기 button");
}

/** One measured element, or null when the selector matches nothing. */
async function measureOne(selector, attributes) {
  try {
    const result = await post("/api/measure", { selector, attributes });
    return (result.elements || result.nodes || [])[0] || null;
  } catch {
    return null;
  }
}

async function modalsIgnoreOutsideClicks() {
  console.log("\n[#16] modals ignore a click outside:");
  await post("/api/qa/open", { panels: [["renderer"]] });
  await post("/api/qa/members/renderer/emit", {
    events: [{ type: "assistant_text_delta", text: "\n\n" + "긴 메시지 줄\n".repeat(40) }],
  });
  await delay(700);

  await clickAndCapture(".wb-expand-inline", "issue-16-open.png", "opened the 전체 보기 popup");
  await clickAndCapture(".wb-tool-modal-backdrop", "issue-16-outside-click.png", "clicked the backdrop OUTSIDE the popup");
  // The decisive assertion: the popup is still mounted after that click. If the
  // backdrop still dismissed, this selector would be gone and the click fails.
  await clickAndCapture(".wb-tool-modal-head .wb-icon-btn", "issue-16-closed.png", "the popup survived, and closes on its own 닫기 button");
}

/**
 * [#13] — a member whose harness is gone must not read as ready to chat. The
 * dead state is created for real through W1's `kill-harness` QA route (the
 * session object stays, the harness behind it does not), which is the exact
 * condition users hit and which no state injection reproduces.
 */
async function deadMemberReadsAsDisconnected() {
  console.log("\n[#13] a member whose session is gone reads as disconnected:");
  const before = memberByName(await get("/api/party"), "talker");
  ok(before?.status !== "missing_session", `the member starts alive (status=${before?.status})`);

  await post("/api/qa/members/talker/kill-harness", {});
  await delay(900);

  const after = memberByName(await get("/api/party"), "talker");
  ok(after?.status === "missing_session", `the app now reports the member as missing_session (got ${after?.status})`);
  ok(Boolean(after?.sessionId), "…while still bound to a session — this is the dead-binding case, not the app-restart one");

  const shot = path.join(shotDir, "issue-13-disconnected.png");
  ok((await post("/api/capture", { path: shot })).bytes > 0, `sidebar + panel header showing the member's state → ${shot}`);
}

/** Finds a member in a `/api/party` listing by name. */
function memberByName(listing, name) {
  return (listing.members || []).find((member) => member.name === name);
}

/**
 * [P-3]7 — a running turn reads as motion, not as the word "working". The state
 * is driven by the session status the harness reports (`responding`), so this
 * exercises the same status → view → render path a live turn does. The capture
 * is what proves the indicator is legible at real size in both surfaces.
 */
async function progressIndicator() {
  console.log("\n[P-3]7 in-flight turns show a moving indicator:");
  await post("/api/qa/members/renderer/emit", { status: "working" });
  await delay(600);
  const busyShot = path.join(shotDir, "p3-7-working.png");
  ok((await post("/api/capture", { path: busyShot })).bytes > 0, `member mid-turn (panel pill + sidebar row) → ${busyShot}`);

  await post("/api/qa/members/renderer/emit", { status: "idle" });
  await delay(600);
  const idleShot = path.join(shotDir, "p3-7-idle.png");
  ok((await post("/api/capture", { path: idleShot })).bytes > 0, `same member back at idle (labels, no indicator) → ${idleShot}`);
}

async function discover() {
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    const url = firstBaseUrl(ws);
    if (url) {
      try {
        const response = await fetch(`${url}/api/health`);
        if (response.ok && (await response.json()).ok) return url;
      } catch { /* still starting */ }
    }
    await delay(500);
  }
  throw new Error("App did not advertise an automation endpoint for the e2e workspace.");
}

/**
 * The main process's own NDJSON log — the generic IPC `handle()` wrapper records
 * every channel + its (bounded) arguments there, which is how a renderer→main
 * call can be proven from outside the app.
 */
function ipcLogLines() {
  const dir = path.join(userData, "logs");
  try {
    const newest = fs.readdirSync(dir).filter((f) => f.endsWith(".ndjson")).sort().at(-1);
    return newest ? fs.readFileSync(path.join(dir, newest), "utf8").split("\n").filter(Boolean) : [];
  } catch {
    return [];
  }
}

async function get(route) {
  const response = await fetch(base + route);
  if (!response.ok) throw new Error(`${route} ${response.status}: ${await response.text()}`);
  return response.json();
}

async function post(route, body) {
  const response = await fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  if (!response.ok) throw new Error(`${route} ${response.status}: ${await response.text()}`);
  return response.json();
}

async function removePath(target) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try { fs.rmSync(target, { recursive: true, force: true }); return; } catch (error) {
      if (error?.code !== "EBUSY" || attempt === 9) return;
      await delay(300);
    }
  }
}

function waitForExit(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(() => { killProcessTree(child.pid); resolve(); }, 10_000);
    child.once("exit", () => { clearTimeout(timeout); resolve(); });
  });
}

function killProcessTree(pid) {
  if (!pid) return;
  try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* already gone */ }
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

main().catch((error) => { console.error(error); process.exit(1); });
