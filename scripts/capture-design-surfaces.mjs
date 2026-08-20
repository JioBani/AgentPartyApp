/*
 * Captures the SHIPPING UI out of the running app into the design bundle.
 *
 * The point of the whole exercise: nothing here is re-drawn. The app is booted
 * for real (QA mode, isolated userData, mock harness — no model calls), driven
 * into each state through the same automation API a QA run uses, and the actual
 * rendered DOM is lifted out over the DevTools protocol. A card in the design
 * project is therefore the app's markup under the app's stylesheet, which is the
 * only way "최대한 동일" survives the next refactor.
 *
 * Two details make the lifted markup render correctly on its own:
 *
 *  - ANCESTORS. The app's CSS is full of descendant selectors
 *    (`.wb-tabstrip .wb-tab`, `.wb-panel .wb-toolbar`), so a node pulled out
 *    alone would lose most of its styling. Each capture is re-wrapped in stripped
 *    clones of its ancestor chain — same tags, classes and inline styles, no
 *    siblings — so every selector that applied in the app still applies.
 *  - SIZE. Panels and lists size themselves against the window; the ancestor
 *    chain carries the same flex/grid rules, and the stage gives the outermost
 *    wrapper a fixed height so the card is not one pixel tall.
 *
 * Run (after `npm run build` and `node scripts/build-design-bundle.mjs`):
 *   node scripts/capture-design-surfaces.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { page } from "./build-design-bundle.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE_DIR = path.join(root, "build", "design-bundle");
const runId = String(Date.now());
const ws = path.join(os.tmpdir(), `agentparty-design-ws-${runId}`);
const userData = path.join(os.tmpdir(), `agentparty-design-userdata-${runId}`);
const port = Number(process.env.DESIGN_CAPTURE_PORT || 39421);
const base = `http://127.0.0.1:${port}`;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const written = [];
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
 * Lifts `selector` (with its ancestor chain) out of the live document.
 *
 * Returns `null` when the selector matches nothing — a missing surface is
 * REPORTED at the end rather than silently producing an empty card, since an
 * empty card looks like a design decision.
 */
const LIFT_FN = `(function lift(selector, stageHeight) {
  const el = document.querySelector(selector);
  if (!el) return null;
  const clone = el.cloneNode(true);
  // Strip live-only state that would render as a stuck spinner or an open menu
  // the card never explains.
  clone.querySelectorAll("[contenteditable]").forEach((node) => node.removeAttribute("contenteditable"));
  let node = clone;
  let parent = el.parentElement;
  while (parent && parent !== document.body) {
    const wrapper = document.createElement(parent.tagName.toLowerCase());
    for (const attribute of ["class", "style", "data-theme", "data-panel-id", "role"]) {
      const value = parent.getAttribute(attribute);
      if (value !== null) wrapper.setAttribute(attribute, value);
    }
    wrapper.appendChild(node);
    // Sizing is applied to EVERY wrapper, not just the outermost. The chain ends
    // at React's own root div, so a rule like the app shell's height:100vh sat
    // one level inside the outermost wrapper and kept every component card a
    // full viewport tall no matter what the outer div said.
    if (stageHeight) {
      wrapper.style.height = stageHeight;
    } else {
      wrapper.style.height = "auto";
      wrapper.style.minHeight = "0";
      wrapper.style.overflow = "visible";
    }
    node = wrapper;
    parent = parent.parentElement;
  }
  if (stageHeight) {
    node.style.height = stageHeight;
  } else {
    // Without an explicit height the chain still ends at the app shell, which is
    // sized to the viewport — so a 90px tab strip rendered as a 900px card with
    // 800px of nothing under it. Only the OUTERMOST wrapper is relaxed; every
    // inner rule stays exactly as the app wrote it, so the component itself is
    // not being restyled to look good in the gallery.
    node.style.height = "auto";
    node.style.minHeight = "0";
    node.style.overflow = "visible";
  }
  return node.outerHTML;
})`;

/** Captures one surface into the bundle as a design card. */
async function capture(cdp, spec) {
  const { file, group, name, subtitle, selector, height, theme = "light", flush = false, note } = spec;
  const html = await cdp.eval(`${LIFT_FN}(${JSON.stringify(selector)}, ${JSON.stringify(height || "")})`);
  if (!html) {
    problems.push(`${name}: selector '${selector}' matched nothing — not captured`);
    return;
  }
  const body = note
    ? `<p class="ds-note">${note}</p>\n${html}`
    : html;
  const target = path.join(BUNDLE_DIR, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, page({
    group,
    name,
    subtitle,
    theme,
    body,
    bodyClass: flush ? "is-flush" : "",
    depth: file.split("/").length - 1,
  }));
  written.push({ file, group, name, bytes: html.length });
  console.log(`  ✓ ${group} / ${name}  (${(html.length / 1024).toFixed(1)} KB)`);
}

/** Rich transcript content for the showcase member — one of each block kind. */
const SHOWCASE_EVENTS = [
  { type: "queue_dequeued", count: 1, text: '@luna 이 "C:/Project/AgentPartyApp/src/main.ts" 파일의 빌드 실패 좀 같이 봐줘' },
  { type: "assistant_text_delta", text: "빌드 로그부터 확인했습니다.\n\n## 원인\n\n`tsconfig.json` 의 `moduleResolution` 이 `bundler` 인데, 이 패키지는 `node16` 을 기대합니다.\n\n1. 설정을 맞추거나\n2. 해당 import 를 상대경로로 바꾸면 됩니다.\n\n```ts\n// tsconfig.json\n{ \"compilerOptions\": { \"moduleResolution\": \"node16\" } }\n```\n\n| 옵션 | 영향 |\n| --- | --- |\n| bundler | 지금 실패 |\n| node16 | 통과 |\n" },
  { type: "tool_call", id: "sc-bash", name: "Bash", status: "completed", input: { command: "npm run build" }, result: "> agentparty@0.5.0 build\n> tsc -p tsconfig.json && vite build\n\n✓ built in 3.41s", exitCode: 0, durationMs: 3410, cwd: "C:/Project/AgentPartyApp" },
  { type: "plan", steps: [
    { title: "tsconfig 의 moduleResolution 조정", status: "completed" },
    { title: "빌드 재실행", status: "inProgress" },
    { title: "실패한 테스트만 다시 돌리기", status: "pending" },
  ] },
];

async function main() {
  await waitForApi();
  const appRoot = (await get("/api/state")).runtime?.appRoot || "";
  const within = (appRoot + path.sep).toLowerCase().startsWith(root.toLowerCase() + path.sep);
  if (!within) throw new Error(`the running build is not this worktree (appRoot=${appRoot})`);
  if (!fs.existsSync(path.join(BUNDLE_DIR, "foundations", "tokens.css"))) {
    throw new Error("run scripts/build-design-bundle.mjs first — the pages link its generated tokens.");
  }
  const cdp = await attachRenderer();

  console.log("\nWorkbench:");
  await post("/api/qa/seed", {
    party: "디자인 미러",
    members: [
      { name: "impl", runtime: "claude-code", model: "claude-sonnet-4.5", role: "구현 담당" },
      // A second harness on purpose: the tab strip, toolbar and badges all carry
      // harness identity, and a party of one harness would document only half of
      // what those controls show. The runtime must MATCH the model — the beta
      // locks cross-harness pairs, and seeding one fails outright.
      { name: "luna", runtime: "codex", model: "gpt-5.4-mini", role: "리뷰 담당" },
      { name: "queue-demo", runtime: "claude-code", model: "claude-sonnet-4.5", role: "대기열" },
    ],
  });
  await post("/api/navigation", { view: "workbench" });
  await post("/api/qa/open", { panels: [["impl", "luna"], ["queue-demo"]] });
  await post("/api/qa/members/impl/emit", { events: SHOWCASE_EVENTS, status: "idle" });
  // A busy member with messages parked behind it — the queue panel's real state.
  // `working` is the QA vocabulary ("responding" is the harness-side status it
  // maps to); passing the harness word leaves the member idle and the messages
  // are then DELIVERED instead of queued, so the queue never renders.
  await post("/api/qa/members/queue-demo/emit", { status: "working" });
  await delay(400);
  await post("/api/party/members/queue-demo/message", { text: "리뷰 끝나면 이어서 부탁해" });
  await post("/api/party/members/queue-demo/message", { text: "그리고 릴리스 노트 초안도 같이 봐줘" });
  // A named recording from src/shared/subagentScenarios.ts — an unknown name
  // fails loudly there, which is what we want: a silently empty dock would ship
  // as a card claiming the app has no subagent UI.
  await post("/api/qa/members/impl/subagents", { scenario: "claude-test-shards" });
  // Live context occupancy, so the toolbar donut (and the Auto-compact dialog it
  // opens) show real numbers. Without it the donut does not render at all and
  // the card would document a control the app appears not to have.
  await post("/api/qa/members/impl/emit", {
    events: [{ type: "status", status: "idle", contextTokens: 118_400, contextWindow: 200_000, at: new Date().toISOString() }],
  });
  await delay(1500);

  for (const spec of [
    { file: "workbench/app-window.html", group: "Screens", name: "Workbench", subtitle: "타이틀바 · 사이드바 · 2패널", selector: ".app-shell", height: "760px", flush: true },
    { file: "workbench/app-window-dark.html", group: "Screens", name: "Workbench (dark)", subtitle: "같은 화면, dark 테마 토큰", selector: ".app-shell", height: "760px", flush: true, theme: "dark" },
    { file: "workbench/sidebar.html", group: "Workbench", name: "Party sidebar", subtitle: "파티 목록 · 멤버 행 · 상태", selector: ".wb-sidebar", height: "620px" },
    { file: "workbench/tabstrip.html", group: "Workbench", name: "Tab strip", subtitle: "활성/비활성 탭 · 하네스 칩 · 배지", selector: ".wb-tabstrip" },
    { file: "workbench/toolbar.html", group: "Workbench", name: "Panel toolbar", subtitle: "멤버 · 모델 필 · 컨텍스트 도넛", selector: ".wb-toolbar" },
    { file: "workbench/composer.html", group: "Workbench", name: "Composer", subtitle: "입력 · 전송 · 권한 컨트롤", selector: ".wb-composer" },
    { file: "workbench/panel.html", group: "Workbench", name: "Panel", subtitle: "탭 · 툴바 · 트랜스크립트 · 컴포저", selector: ".wb-panel", height: "700px" },
    { file: "transcript/user-message.html", group: "Transcript", name: "User message", subtitle: "멘션 · 경로 칩", selector: ".wb-user" },
    { file: "transcript/assistant.html", group: "Transcript", name: "Assistant reply", subtitle: "마크다운 · 코드 · 표", selector: ".wb-assistant" },
    { file: "transcript/tool-block.html", group: "Transcript", name: "Tool call", subtitle: "명령 · 결과 미리보기 · exit/소요", selector: ".wb-tool" },
    { file: "transcript/plan.html", group: "Transcript", name: "Plan", subtitle: "단계별 상태 체크리스트", selector: ".wb-plan" },
    { file: "workbench/queue.html", group: "Workbench", name: "Message queue", subtitle: "대기 중인 메시지 · 편집/취소", selector: ".wb-queue" },
    { file: "workbench/subagent-dock.html", group: "Workbench", name: "Subagent dock", subtitle: "서브에이전트 목록 + 현재 동작", selector: ".wb-subdock" },
  ]) {
    await capture(cdp, spec);
  }

  console.log("\nCard gallery (approvals · questions · compaction · environment):");
  const gallery = await post("/api/qa/design-gallery", {});
  const cases = gallery.members || [];
  // The gallery lives in its OWN party, and a window keeps its own party
  // context — building the gallery does not move the window to it. Without this
  // select, every `qa/open` below names a member the window's party does not
  // have, the panel renders empty, and all 26 cards come back blank.
  const galleryParty = (await get("/api/party")).parties?.find((party) => party.name === gallery.party);
  if (!galleryParty) {
    throw new Error(`the gallery party '${gallery.party}' is not in the listing — cannot open its members.`);
  }
  // ⚠️ The window id is passed EXPLICITLY. `POST /api/parties/:id/select` with no
  // `?window=` returns ok but leaves the window on its old party — the selection
  // is recorded per window and the focused window is not resolved for the HTTP
  // caller. Without this the panel below opens members the window's party does
  // not have and every gallery card comes back blank while the API says "ok".
  const windowId = (await get("/api/windows")).windows?.[0]?.id;
  await post(`/api/parties/${galleryParty.id}/select?window=${encodeURIComponent(windowId)}`, {});
  await delay(1500);
  for (const member of cases) {
    await post("/api/qa/open", { panels: [[member]] });
    // The panel has to mount and paint the card before it can be lifted;
    // measured, ~450ms was not enough and every gallery card came back empty.
    await delay(1200);
    const slug = member.replace(/[^0-9A-Za-z가-힣-]/g, "-");
    await capture(cdp, {
      file: `cards/${slug}.html`,
      group: "Cards",
      name: member,
      selector: ".wb-approval, .wb-question, .wb-compact, .wb-env",
      note: `QA 갤러리 케이스 <code>${member}</code> — 실제 하네스 기록에서 나온 페이로드.`,
    });
  }

  console.log("\nModals & popovers:");
  // Back to the showcase party: the gallery pass moved the window, and these
  // modals belong to `impl` (its donut, its runtime, its gate). Opened against
  // the gallery party they would silently target a member the window no longer
  // has — which is exactly how the first run produced empty cards.
  const mirrorParty = (await get("/api/party")).parties?.find((party) => party.name === "디자인 미러");
  if (!mirrorParty) {
    throw new Error("the showcase party disappeared — the modal pass has nothing to open against.");
  }
  await post(`/api/parties/${mirrorParty.id}/select?window=${encodeURIComponent(windowId)}`, {});
  await delay(1200);
  // Each is opened the way a person opens it — a click on the real control, or
  // the QA route the app itself exposes — so what gets lifted is the modal the
  // product shows, not a hand-built stand-in.
  await post("/api/qa/open", { panels: [["impl"]] });
  await delay(700);
  // Closing is EXPLICIT in this app — a modal ignores both the scrim and Escape
  // by design, so each spec says how it is dismissed. A modal left open is not a
  // cosmetic problem: the next capture lifts `.wb-modal` and silently gets the
  // previous dialog again, which is exactly what happened before this loop
  // checked. Hence the assertion after every close.
  const MODAL_X = ".wb-modal-head .wb-icon-btn";
  for (const spec of [
    { open: () => post("/api/capture", { click: ".wb-ctx-donut" }), selector: ".wb-modal", close: MODAL_X, file: "modals/compact.html", name: "Auto-compact 대화상자", subtitle: "현재 사용량 · 임계값 · 지금 압축" },
    { open: () => post("/api/capture", { click: ".wb-model-pill" }), selector: ".wb-modal", close: MODAL_X, file: "modals/runtime.html", name: "Runtime 모달", subtitle: "모델 · 추론 · 권한" },
    { open: () => post("/api/qa/gate/open", { kind: "member", member: "impl" }), selector: ".wb-modal", close: MODAL_X, file: "modals/message-gate.html", name: "Message Gate (멤버)", subtitle: "발신 검문 규칙 · 리뷰어" },
    { open: () => post("/api/qa/gate/open", { kind: "party" }), selector: ".wb-modal", close: MODAL_X, file: "modals/party-gate.html", name: "Message Gate (파티)", subtitle: "파티 기본 검문 규칙" },
    // The member wizard is not a modal: it opens INSIDE the sidebar, so it is
    // captured with the sidebar around it and closed by the same + / ✕ toggle.
    { open: () => post("/api/capture", { click: ".wb-section-add" }), selector: ".wb-wizard", close: ".wb-section-add", file: "modals/member-wizard.html", name: "멤버 만들기", subtitle: "하네스 · 모델 · 초기 권한 단계" },
    { open: () => post("/api/qa/input", { selector: ".wb-composer-editor", text: "/" }), selector: ".wb-cmd-palette", closeKey: "Escape", file: "modals/command-palette.html", name: "명령 팔레트", subtitle: "`/` 로 여는 하네스 명령 목록" },
  ]) {
    try {
      await spec.open();
    } catch (error) {
      problems.push(`${spec.name}: could not be opened (${String(error.message).slice(0, 90)})`);
      continue;
    }
    await delay(900);
    // A modal scrim is position:fixed, so it contributes NO layout height — let
    // the chain collapse to content and the card is 0×0. These get a stage
    // instead, and the dialog centres in it exactly as it does in the window.
    await capture(cdp, { file: spec.file, group: "Modals", name: spec.name, subtitle: spec.subtitle, selector: spec.selector, height: spec.height || "640px", flush: true });
    if (spec.close) {
      await post("/api/capture", { click: spec.close }).catch((error) => problems.push(`${spec.name}: close click failed (${String(error.message).slice(0, 80)})`));
    }
    if (spec.closeKey) {
      await post("/api/qa/input", { selector: ".wb-composer-editor", key: spec.closeKey }).catch(() => {});
    }
    await delay(600);
    const stillOpen = await cdp.eval(`document.querySelectorAll(".wb-modal, .wb-cmd-palette, .wb-wizard").length`);
    if (stillOpen > 0) {
      problems.push(`${spec.name}: still open after its close step — later captures would have lifted it instead of their own surface`);
      // Recover rather than poison every later card.
      await post("/api/capture", { click: MODAL_X }).catch(() => {});
      await delay(400);
    }
  }

  console.log("\nScreens:");
  for (const [tab, name] of [["general", "일반"], ["harness", "하네스 기본값"], ["environment", "환경"], ["gate", "Message Gate"], ["discord", "Discord"], ["versions", "버전"], ["diagnostics", "진단"]]) {
    await post("/api/navigation", { view: "runtime", tab });
    await delay(700);
    await capture(cdp, {
      file: `screens/runtime-${tab}.html`,
      group: "Settings",
      name: `런타임 — ${name}`,
      selector: ".set-view, .app-main, .app-body",
      height: "760px",
      flush: true,
    });
  }
  for (const [view, name, file] of [["usage", "Token Usage", "usage"], ["auth", "인증", "auth"], ["automation", "설정", "automation"]]) {
    await post("/api/navigation", { view });
    await delay(900);
    await capture(cdp, { file: `screens/${file}.html`, group: "Screens", name, selector: ".app-body", height: "760px", flush: true });
  }

  cdp.close();
  await post("/api/window/close", {}).catch(() => {});

  const index = {
    capturedAt: new Date().toISOString(),
    appRoot,
    cards: written.map(({ file, group, name }) => ({ file, group, name })),
    notCaptured: problems,
  };
  fs.writeFileSync(path.join(BUNDLE_DIR, "_capture.json"), `${JSON.stringify(index, null, 2)}\n`);
  console.log(`\ncaptured ${written.length} cards into ${BUNDLE_DIR}`);
  if (problems.length) {
    console.log(`\n${problems.length} surface(s) NOT captured — reported, never faked:`);
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
