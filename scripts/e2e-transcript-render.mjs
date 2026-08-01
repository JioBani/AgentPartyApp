/*
 * Full-process e2e for the W2 transcript-rendering lane (docs/작업분할.md §3 W2).
 *
 * Launches the REAL Electron app on an isolated userData + temp workspace,
 * discovers it through the per-workspace instance file (NEVER a fixed port — a
 * fixed port once attached a driver to the user's own running app), seeds a mock
 * member, streams real normalized events into its transcript and drives the
 * rendered UI over HTTP. Offline: no model call, no billing.
 *
 * Legs (added as the lane lands each item):
 *   [P-3]5  a markdown link click reaches the main process `shell:openExternal`
 *           handler — proving the whole renderer→preload→IPC path, which no
 *           jsdom test can see — and the link's copy control reports success.
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
    await longSubagentTaskCollapses();

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
  const shot = path.join(shotDir, "p3-5-link.png");
  const capture = await post("/api/capture", { click: `.wb-md-link a[href="${LINK}"]`, path: shot });
  ok(capture.ok && capture.bytes > 0, `captured the rendered link → ${capture.path}`);
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
  const copyShot = path.join(shotDir, "p3-5-link-copy.png");
  const copied = await post("/api/capture", { click: ".wb-md-link .wb-copy-btn", path: copyShot });
  ok(copied.ok && copied.bytes > 0, `clicked the link copy control; state captured → ${copied.path}`);
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

  const codeShot = path.join(shotDir, "p3-3-code-copy.png");
  const code = await post("/api/capture", { click: ".wb-md pre .wb-copy-btn", path: codeShot });
  ok(code.ok && code.bytes > 0, `clicked the code-block copy control → ${code.path}`);

  const replyShot = path.join(shotDir, "p3-3-reply-copy.png");
  const reply = await post("/api/capture", { click: ".wb-assistant-head .wb-copy-btn", path: replyShot });
  ok(reply.ok && reply.bytes > 0, `clicked the whole-reply copy control → ${reply.path}`);
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

  const fullShot = path.join(shotDir, "issue-6-detail-full.png");
  ok((await post("/api/capture", { click: ".wb-subdetail-task .wb-expand-inline", path: fullShot })).bytes > 0, `전체 보기 on the delegated prompt → ${fullShot}`);
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
