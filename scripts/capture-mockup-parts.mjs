/*
 * Captures the app in PARTS — each part exactly once — for the single-page mockup.
 *
 * The page-per-state mockup duplicated the workbench into 8 files, the settings
 * screen into 7 and the window chrome into all 19, so redesigning any of them
 * meant editing every copy. The app itself has no such duplication: one window,
 * one chrome, views swapped inside it, dialogs laid over the top. This captures
 * along those same seams so the assembled page has one copy of each.
 *
 * The runtime view is a single capture that already contains all seven settings
 * tabs: the app mounts every tab panel and hides the inactive ones (so a staged
 * edit survives a tab switch), which means one lift brings them all.
 *
 * Run (after `npm run build` and `build-design-bundle.mjs`):
 *   node scripts/capture-mockup-parts.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PARTS_DIR = path.join(root, "build", "mockup-parts");
const runId = String(Date.now());
const ws = path.join(os.tmpdir(), `agentparty-parts-ws-${runId}`);
const userData = path.join(os.tmpdir(), `agentparty-parts-ud-${runId}`);
const port = Number(process.env.MOCKUP_PARTS_PORT || 39471);
const base = `http://127.0.0.1:${port}`;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const post = async (route, body) => {
  const r = await fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${route} ${r.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text || "{}");
};
const get = async (route) => {
  const r = await fetch(base + route);
  if (!r.ok) throw new Error(`${route} ${r.status}`);
  return r.json();
};

/**
 * Every part of the mockup, and the state the app must be in to lift it.
 *
 * `kind` says where the part belongs in the assembled page: `chrome` is the
 * window frame, `view` swaps inside it, `overlay` lies over everything, and
 * `inline` is a panel the app renders in place (the member wizard inside the
 * sidebar, the command palette above the composer) — those cannot be moved to
 * the overlay layer without lying about where the app puts them.
 */
const PARTS = [
  { id: "titlebar", kind: "chrome", selector: ".app-titlebar", scene: "workbench" },
  { id: "rail", kind: "chrome", selector: ".nav-rail", scene: "workbench" },

  { id: "workbench", kind: "view", label: "Workbench", selector: ".program-main", scene: "workbench" },
  { id: "sessions", kind: "view", label: "세션", selector: ".program-main", scene: "sessions" },
  { id: "usage", kind: "view", label: "Token Usage", selector: ".program-main", scene: "usage" },
  { id: "auth", kind: "view", label: "인증", selector: ".program-main", scene: "auth" },
  { id: "automation", kind: "view", label: "설정", selector: ".program-main", scene: "automation" },
  // One lift, all seven tabs — they are mounted and hidden, not unmounted.
  { id: "runtime", kind: "view", label: "런타임", selector: ".program-main", scene: "runtime" },

  { id: "runtime-modal", kind: "overlay", label: "Runtime", selector: ".wb-modal-scrim", scene: "modal-runtime" },
  { id: "compact", kind: "overlay", label: "Auto-compact", selector: ".wb-modal-scrim", scene: "modal-compact" },
  { id: "gate-member", kind: "overlay", label: "Message Gate (멤버)", selector: ".wb-modal-scrim", scene: "modal-gate-member" },
  { id: "gate-party", kind: "overlay", label: "Message Gate (파티)", selector: ".wb-modal-scrim", scene: "modal-gate-party" },

  { id: "wizard", kind: "inline", label: "멤버 만들기", selector: ".wb-wizard", scene: "wizard", host: ".wb-members-section" },
  { id: "palette", kind: "inline", label: "명령 팔레트", selector: ".wb-cmd-palette", scene: "palette", host: ".wb-composer" },
];

const SCENES = {
  async workbench() {
    await closeOverlays();
    await post("/api/navigation", { view: "workbench" });
    await post("/api/qa/open", { panels: [["impl", "luna"], ["queue-demo"]] });
    await delay(1000);
  },
  sessions: () => goto("sessions"),
  usage: () => goto("usage"),
  auth: () => goto("auth"),
  automation: () => goto("automation"),
  async runtime() {
    await closeOverlays();
    // The harness tab is the one whose sub-tabs are worth seeing; every other
    // tab panel comes along hidden.
    await post("/api/navigation", { view: "runtime", tab: "harness" });
    await delay(1000);
  },
  "modal-runtime": () => openOverlay(".wb-model-pill", 1600),
  "modal-compact": () => openOverlay(".wb-ctx-donut", 1000),
  async "modal-gate-member"() {
    await SCENES.workbench();
    await post("/api/qa/gate/open", { kind: "member", member: "impl" });
    await delay(1000);
  },
  async "modal-gate-party"() {
    await SCENES.workbench();
    await post("/api/qa/gate/open", { kind: "party" });
    await delay(1000);
  },
  async wizard() {
    await SCENES.workbench();
    await post("/api/capture", { click: ".wb-section-add" });
    await delay(900);
  },
  async palette() {
    await SCENES.workbench();
    await post("/api/qa/input", { selector: ".wb-composer-editor", text: "/" });
    await delay(900);
  },
};

async function goto(view) {
  await closeOverlays();
  await post("/api/navigation", { view });
  await delay(1000);
}
async function openOverlay(trigger, wait) {
  await SCENES.workbench();
  await post("/api/capture", { click: trigger });
  await delay(wait);
}
/** Dialogs here ignore the scrim and Escape, so each scene starts by closing. */
async function closeOverlays() {
  await post("/api/capture", { click: ".wb-modal-head .wb-icon-btn" }).catch(() => {});
  await post("/api/capture", { click: ".wb-section-add.is-open" }).catch(() => {});
  await delay(300);
}

fs.mkdirSync(ws, { recursive: true });
fs.mkdirSync(userData, { recursive: true });
fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ workspacePath: ws, automationApiPort: port }, null, 2));
const child = spawn(process.execPath, [path.join(root, "scripts", "launch-electron.mjs"), "--remote-debugging-port=0"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
  env: { ...process.env, AGENTPARTY_QA: "1", AGENTPARTY_AUTOMATION_PORT: String(port), AGENTPARTY_USER_DATA: userData, AGENTPARTY_WINDOW_DISPLAY: "left" },
});
child.stderr.on("data", () => {});

async function attachRenderer() {
  const portFile = path.join(userData, "DevToolsActivePort");
  const started = Date.now();
  let cdpPort = 0;
  while (Date.now() - started < 60000) {
    try {
      cdpPort = Number(fs.readFileSync(portFile, "utf8").split("\n")[0].trim());
      if (cdpPort > 0) break;
    } catch { /* not written yet */ }
    await delay(250);
  }
  if (!cdpPort) throw new Error(`Electron never wrote ${portFile}.`);
  let target;
  while (Date.now() - started < 60000) {
    const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
    target = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (target) break;
    await delay(250);
  }
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error("CDP open failed")); });
  let nextId = 1;
  const pending = new Map();
  socket.onmessage = (e) => { const m = JSON.parse(e.data); const p = pending.get(m.id); if (p) { pending.delete(m.id); p(m); } };
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
    socket.send(JSON.stringify({ id, method, params }));
  });
  return {
    async eval(expression) {
      const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    },
    close() { socket.close(); },
  };
}

const LIFT = `(function (selector) {
  const el = document.querySelector(selector);
  if (!el) return null;
  const clone = el.cloneNode(true);
  clone.querySelectorAll("[contenteditable]").forEach((n) => n.removeAttribute("contenteditable"));
  return clone.outerHTML;
})`;

async function main() {
  await waitForApi();
  const appRoot = (await get("/api/state")).runtime?.appRoot || "";
  if (!(appRoot + path.sep).toLowerCase().startsWith(root.toLowerCase() + path.sep)) {
    throw new Error(`the running build is not this worktree (appRoot=${appRoot})`);
  }
  const cdp = await attachRenderer();

  await post("/api/qa/seed", {
    party: "AgentParty",
    members: [
      { name: "impl", runtime: "claude-code", model: "claude-sonnet-4.5", role: "구현 담당" },
      { name: "luna", runtime: "codex", model: "gpt-5.4-mini", role: "리뷰 담당" },
      { name: "queue-demo", runtime: "claude-code", model: "claude-sonnet-4.5", role: "릴리스 노트" },
    ],
  });
  await post("/api/qa/members/impl/emit", {
    events: [
      { type: "queue_dequeued", count: 1, text: '@luna 이 "C:/Project/AgentPartyApp/src/main.ts" 빌드 실패 같이 봐줘' },
      { type: "assistant_text_delta", text: "빌드 로그부터 확인했습니다.\n\n## 원인\n\n`moduleResolution` 이 `bundler` 인데 이 패키지는 `node16` 을 기대합니다.\n\n1. 설정을 맞추거나\n2. 해당 import 를 상대경로로 바꾸면 됩니다.\n\n```ts\n{ \"compilerOptions\": { \"moduleResolution\": \"node16\" } }\n```\n" },
      { type: "tool_call", id: "p-bash", name: "Bash", status: "completed", input: { command: "npm run build" }, result: "✓ built in 3.41s", exitCode: 0, durationMs: 3410, cwd: "C:/Project/AgentPartyApp" },
      { type: "plan", steps: [
        { title: "tsconfig 조정", status: "completed" },
        { title: "빌드 재실행", status: "inProgress" },
        { title: "실패한 테스트만 재실행", status: "pending" },
      ] },
      { type: "status", status: "idle", contextTokens: 118_400, contextWindow: 200_000, at: new Date().toISOString() },
    ],
  });
  await post("/api/qa/members/impl/subagents", { scenario: "claude-test-shards" });
  await post("/api/qa/members/queue-demo/emit", { status: "working" });
  await delay(300);
  await post("/api/party/members/queue-demo/message", { text: "리뷰 끝나면 이어서 부탁해" }).catch(() => {});
  await post("/api/party/members/queue-demo/message", { text: "릴리스 노트 초안도 같이 봐줘" }).catch(() => {});
  await post("/api/qa/environment", {}).catch(() => {});
  await delay(1200);

  fs.rmSync(PARTS_DIR, { recursive: true, force: true });
  fs.mkdirSync(PARTS_DIR, { recursive: true });

  // Group by scene so the app is driven once per state, not once per part.
  const byScene = new Map();
  for (const part of PARTS) {
    if (!byScene.has(part.scene)) byScene.set(part.scene, []);
    byScene.get(part.scene).push(part);
  }

  const written = [];
  for (const [scene, parts] of byScene) {
    try {
      await SCENES[scene]();
    } catch (error) {
      problems.push(`scene '${scene}' could not be staged: ${String(error.message).slice(0, 110)}`);
      continue;
    }
    for (const part of parts) {
      const html = await cdp.eval(`${LIFT}(${JSON.stringify(part.selector)})`);
      if (!html) {
        problems.push(`${part.id}: '${part.selector}' matched nothing in scene '${scene}'`);
        continue;
      }
      fs.writeFileSync(path.join(PARTS_DIR, `${part.id}.html`), html);
      written.push({ ...part, bytes: html.length });
      console.log(`  ✓ ${part.kind.padEnd(8)} ${part.id.padEnd(14)} ${(html.length / 1024).toFixed(0)} KB`);
    }
  }

  fs.writeFileSync(path.join(PARTS_DIR, "_parts.json"), `${JSON.stringify(written, null, 2)}\n`);
  cdp.close();
  await post("/api/window/close", {}).catch(() => {});

  console.log(`\n${written.length} parts → ${PARTS_DIR}`);
  console.log("next: node scripts/build-mockup-page.mjs");
  if (problems.length) {
    console.log(`\n${problems.length} problem(s) — reported, never faked:`);
    for (const problem of problems) console.log(`  - ${problem}`);
    process.exitCode = 1;
  }
}

async function waitForApi() {
  const started = Date.now();
  while (Date.now() - started < 60000) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok && (await r.json()).ok) return;
    } catch { /* still starting */ }
    await delay(400);
  }
  throw new Error("automation API never came up");
}

main().catch(async (error) => {
  console.error(error);
  try { await post("/api/window/close", {}); } catch { /* already gone */ }
  process.exit(1);
});
