/*
 * Captures the app as a NAVIGABLE MOCKUP: one page per view, each the whole app
 * window, wired together so the nav rail, the settings tabs and the controls
 * that open things actually move between pages.
 *
 * The earlier version produced a contact sheet — a list of screenshots with an
 * index page in front of it. That documents an app; it does not let anyone walk
 * through one. Here every page is `.app-shell` (title bar, nav rail, screen), and
 * a second pass rewrites the app's own buttons into links, so clicking the rail
 * or a settings tab lands on the page for that view exactly as the app would.
 *
 * Wiring uses the app's OWN hooks (`data-view` on rail items, `.set-tab` in the
 * settings strip), never a hand-kept list of coordinates: if a view is added to
 * the app, it appears here as soon as it is captured.
 *
 * Run (after `npm run build` and `build-design-bundle.mjs`):
 *   node scripts/capture-app-mockup.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE_DIR = path.join(root, "build", "design-bundle");
const OUT_DIR = path.join(root, "build", "design-project");
const runId = String(Date.now());
const ws = path.join(os.tmpdir(), `agentparty-mockup-ws-${runId}`);
const userData = path.join(os.tmpdir(), `agentparty-mockup-ud-${runId}`);
const port = Number(process.env.MOCKUP_PORT || 39451);
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
 * The pages of the mockup.
 *
 * `view` is the app view this page IS (so the rail can mark itself active and
 * link the others), `tab` the settings tab where that applies, and `back` the
 * page a modal's close button returns to.
 */
const PAGES = [
  { file: "index.html", title: "Workbench", view: "workbench", setup: workbench },
  { file: "workbench-dark.html", title: "Workbench (dark)", view: "workbench", theme: "dark", setup: workbench },
  { file: "usage.html", title: "Token Usage", view: "usage", setup: () => go("usage") },
  { file: "auth.html", title: "인증", view: "auth", setup: () => go("auth") },
  { file: "automation.html", title: "설정", view: "automation", setup: () => go("automation") },
  { file: "runtime-general.html", title: "런타임 — 일반", view: "runtime", tab: "general", setup: () => goTab("general") },
  { file: "runtime-harness.html", title: "런타임 — 하네스 기본값", view: "runtime", tab: "harness", setup: () => goTab("harness") },
  { file: "runtime-environment.html", title: "런타임 — 환경", view: "runtime", tab: "environment", setup: () => goTab("environment") },
  { file: "runtime-gate.html", title: "런타임 — Message Gate", view: "runtime", tab: "gate", setup: () => goTab("gate") },
  { file: "runtime-discord.html", title: "런타임 — Discord", view: "runtime", tab: "discord", setup: () => goTab("discord") },
  { file: "runtime-versions.html", title: "런타임 — 버전", view: "runtime", tab: "versions", setup: () => goTab("versions") },
  { file: "runtime-diagnostics.html", title: "런타임 — 진단", view: "runtime", tab: "diagnostics", setup: () => goTab("diagnostics") },
  // Modal states: the same window with the dialog standing on it, so the mockup
  // can be walked into and back out of.
  { file: "modal-runtime.html", title: "Runtime 모달", view: "workbench", back: "index.html", setup: () => openModal(".wb-model-pill") },
  { file: "modal-compact.html", title: "Auto-compact", view: "workbench", back: "index.html", setup: () => openModal(".wb-ctx-donut") },
  { file: "modal-wizard.html", title: "멤버 만들기", view: "workbench", back: "index.html", setup: () => openModal(".wb-section-add") },
  { file: "modal-gate-member.html", title: "Message Gate (멤버)", view: "workbench", back: "index.html", setup: () => openGate("member") },
  { file: "modal-gate-party.html", title: "Message Gate (파티)", view: "workbench", back: "index.html", setup: () => openGate("party") },
  { file: "modal-palette.html", title: "명령 팔레트", view: "workbench", back: "index.html", setup: openPalette },
];

async function go(view) {
  await closeAnyModal();
  await post("/api/navigation", { view });
  await delay(900);
}
async function goTab(tab) {
  await closeAnyModal();
  await post("/api/navigation", { view: "runtime", tab });
  await delay(900);
}
async function workbench() {
  await closeAnyModal();
  await post("/api/navigation", { view: "workbench" });
  await post("/api/qa/open", { panels: [["impl", "luna"], ["queue-demo"]] });
  await delay(1000);
}
async function openModal(trigger) {
  await workbench();
  await post("/api/capture", { click: trigger });
  // The Runtime dialog assembles the entire model catalog before it paints, so
  // it is the slowest of these to appear.
  await delay(1600);
}
async function openGate(kind) {
  await workbench();
  await post("/api/qa/gate/open", kind === "party" ? { kind: "party" } : { kind: "member", member: "impl" });
  await delay(900);
}
async function openPalette() {
  await workbench();
  await post("/api/qa/input", { selector: ".wb-composer-editor", text: "/" });
  await delay(900);
}
/** Modals ignore Escape by design, so leaving one open would bleed into the next
 *  page — every setup starts by clicking the explicit close. */
async function closeAnyModal() {
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

/**
 * The whole window, exactly as rendered — every top-level layer, not just the
 * app shell.
 *
 * The catalog-style dialogs (Runtime) render through a PORTAL to document.body,
 * so they sit beside the shell rather than inside it. Lifting only `.app-shell`
 * produced a "Runtime modal" page that was byte-for-byte the workbench, with the
 * dialog silently left behind.
 */
const LIFT_WINDOW = `(function () {
  const layers = [...document.body.children].filter((n) => n.tagName !== "SCRIPT");
  if (layers.length === 0) return null;
  return layers.map((layer) => {
    const clone = layer.cloneNode(true);
    clone.querySelectorAll("[contenteditable]").forEach((n) => n.removeAttribute("contenteditable"));
    return clone.outerHTML;
  // Joined without an escape sequence on purpose: this whole function is a
  // string evaluated in the page, and a newline escape inside it would arrive as
  // a real line break mid-literal and break the parse.
  }).join(String.fromCharCode(10));
})()`;

async function main() {
  await waitForApi();
  const appRoot = (await get("/api/state")).runtime?.appRoot || "";
  if (!(appRoot + path.sep).toLowerCase().startsWith(root.toLowerCase() + path.sep)) {
    throw new Error(`the running build is not this worktree (appRoot=${appRoot})`);
  }
  if (!fs.existsSync(path.join(BUNDLE_DIR, "foundations", "tokens.css"))) {
    throw new Error("run scripts/build-design-bundle.mjs first — the mockup links its generated tokens.");
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
      { type: "tool_call", id: "m-bash", name: "Bash", status: "completed", input: { command: "npm run build" }, result: "✓ built in 3.41s", exitCode: 0, durationMs: 3410, cwd: "C:/Project/AgentPartyApp" },
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

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const captured = [];
  for (const spec of PAGES) {
    try {
      await spec.setup();
    } catch (error) {
      problems.push(`${spec.file}: could not be staged (${String(error.message).slice(0, 100)})`);
      continue;
    }
    // A modal page must actually HAVE its dialog. Without this check a click
    // that failed to open one produced a page byte-identical to the workbench —
    // a screen claiming to document a dialog that is not in it.
    if (spec.back) {
      let open = await cdp.eval(`document.querySelectorAll(".wb-modal, .wb-cmd-palette, .wb-wizard").length`);
      if (!open) {
        await spec.setup();
        open = await cdp.eval(`document.querySelectorAll(".wb-modal, .wb-cmd-palette, .wb-wizard").length`);
      }
      if (!open) {
        problems.push(`${spec.file}: nothing opened — page NOT written rather than shipped as a duplicate workbench`);
        continue;
      }
    }
    const html = await cdp.eval(LIFT_WINDOW);
    if (!html) {
      problems.push(`${spec.file}: .app-shell matched nothing`);
      continue;
    }
    fs.writeFileSync(path.join(OUT_DIR, `${spec.file}.raw`), html);
    captured.push(spec);
    console.log(`  ✓ ${spec.file.padEnd(26)} ${(html.length / 1024).toFixed(0)} KB`);
  }

  fs.writeFileSync(path.join(OUT_DIR, "_pages.json"), `${JSON.stringify(captured.map(({ setup, ...rest }) => rest), null, 2)}\n`);
  cdp.close();
  await post("/api/window/close", {}).catch(() => {});

  console.log(`\n${captured.length} window captures → ${OUT_DIR}`);
  console.log("next: node scripts/wire-mockup.mjs   (turns the app's own buttons into links)");
  if (problems.length) {
    console.log(`\n${problems.length} problem(s):`);
    for (const problem of problems) console.log(`  - ${problem}`);
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
