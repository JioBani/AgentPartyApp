/*
 * Headless renderer smoke test.
 *
 * Electron's GUI cannot launch in CI/sandbox, so this mounts the real React
 * renderer in jsdom with a mocked `window.agentParty`, seeds a two-panel
 * layout, streams mock agent events, and asserts the Workbench actually paints
 * the expected members, transcript blocks, and approval card — catching runtime
 * crashes that a typecheck/build cannot.
 */
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { qaTempDir } from "./lib/qaTemp.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(root, "..");

const failures = [];
const consoleErrors = [];
function assert(condition, message) {
  if (!condition) {
    failures.push(message);
    console.log(`  ✗ ${message}`);
  } else {
    console.log(`  ✓ ${message}`);
  }
}

// --- jsdom environment ----------------------------------------------------
const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
const { window } = dom;

function defineGlobal(name, value) {
  try {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  } catch {
    // Some globals (e.g. navigator in Node 22) are read-only; jsdom's window
    // copy is still reachable via window.<name>, which is all React needs.
  }
}

defineGlobal("window", window);
defineGlobal("document", window.document);
defineGlobal("HTMLElement", window.HTMLElement);
defineGlobal("getComputedStyle", window.getComputedStyle.bind(window));
defineGlobal("requestAnimationFrame", window.requestAnimationFrame?.bind(window) || ((cb) => setTimeout(() => cb(Date.now()), 0)));
defineGlobal("cancelAnimationFrame", window.cancelAnimationFrame?.bind(window) || clearTimeout);
// Font settings probe canvas metrics. jsdom deliberately omits a canvas
// implementation; deterministic widths are enough for this renderer smoke.
window.HTMLCanvasElement.prototype.getContext = () => ({
  font: "",
  measureText: (text) => ({ width: String(text).length * 10 }),
});
if (!globalThis.crypto?.randomUUID) {
  defineGlobal("crypto", { randomUUID: () => "id-" + Math.random().toString(16).slice(2) });
}
try { window.crypto = globalThis.crypto; } catch { /* read-only in jsdom */ }
// jsdom lacks ResizeObserver; panels fall back to the default (wide) density.
window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
globalThis.ResizeObserver = window.ResizeObserver;

window.console = console;
const origError = console.error;
console.error = (...args) => {
  consoleErrors.push(args.map(String).join(" "));
  origError.apply(console, args);
};

// --- mock window.agentParty ----------------------------------------------
const listeners = {};
const on = (name) => (cb) => {
  (listeners[name] ||= []).push(cb);
  return () => {};
};
const emit = (name, payload) => (listeners[name] || []).forEach((cb) => cb(payload));

function snapshot(id, model, status, contextTokens) {
  return { id, cwd: "/dev/acme-api", model, effort: "high", permissionMode: "default", status, startedAt: "", debugMode: false, turnCount: 1, queuedTurnCount: 0, pendingApprovalCount: status === "approval" ? 1 : 0, contextTokens };
}

const modelRoutes = [
  { harnessId: "claude-code", providerId: "anthropic", model: "claude-opus-4.1", label: "claude-opus-4.1" },
  { harnessId: "claude-code", providerId: "anthropic", model: "claude-sonnet-4.5", label: "claude-sonnet-4.5", meta: { context: "1M" } },
  { harnessId: "claude-code", providerId: "anthropic", model: "claude-haiku-4", label: "claude-haiku-4" },
  { harnessId: "claude-code", providerId: "openai", model: "gpt-5", label: "gpt-5" },
  { harnessId: "claude-code", providerId: "openai", model: "o4-mini", label: "o4-mini" },
  { harnessId: "claude-code", providerId: "openrouter", model: "deepseek-v3.2", label: "deepseek-v3.2" },
];

const sessions = [
  { id: "s-backend", title: "claude-sonnet-4.5", workspace: "/dev/acme-api", snapshot: snapshot("s-backend", "claude-sonnet-4.5", "responding", 320000) },
  { id: "s-reviewer", title: "o4-mini", workspace: "/dev/acme-api", snapshot: snapshot("s-reviewer", "o4-mini", "idle") },
  { id: "s-tester", title: "gpt-5", workspace: "/dev/acme-api", snapshot: snapshot("s-tester", "gpt-5", "responding") },
];

const members = [
  { partyId: "p1", name: "backend", status: "running", runtime: "claude-code", role: "API", sessionId: "s-backend", model: "claude-sonnet-4.5" },
  { partyId: "p1", name: "frontend", status: "idle", runtime: "claude-code", role: "UI", model: "claude-sonnet-4.5" },
  // Idle session with no live contextTokens BUT persisted occupancy from a prior
  // turn — exercises the "last known" (stale) meter a reopened app shows.
  { partyId: "p1", name: "reviewer", status: "running", runtime: "claude-code", role: "Review", sessionId: "s-reviewer", model: "o4-mini", lastContextTokens: 150000, lastContextWindow: 200000 },
  { partyId: "p1", name: "tester", status: "running", runtime: "claude-code", role: "QA", sessionId: "s-tester", model: "gpt-5" },
  // No tab in the seeded layout and no live session. Its history is not this
  // window's to hold, so its transcript must never be fetched — one member's
  // file reaches ~15MB on disk and several times that once parsed.
  { partyId: "p1", name: "archivist", status: "sleeping", runtime: "claude-code", role: "Docs", model: "claude-sonnet-4.5" },
];

const initialState = {
  ok: true,
  settings: { workspacePath: "/dev/acme-api", claudeExecutablePath: "", claudeSafeMode: false, selectedHarnessId: "claude-code", harnessDefaults: { "claude-code": { model: "claude-sonnet-4.5", effort: "high", permissionMode: "default" }, codex: { model: "gpt-5.5", effort: "medium", codexPolicy: { sandbox: "workspace-write", approval: "on-request", guardian: false } }, cursor: { model: "auto", effort: "" }, grok: { model: "grok-4.6", effort: "high", permissionMode: "default" } }, debugEnabled: false, routerBaseUrl: "", routerAuthToken: "", openRouterApiKey: "", automationApiPort: 47831,
    // Settings the real app always fills in (main/settings.ts normalizes them on
    // read). They were absent here while nothing rendered the settings screen;
    // the 유휴 슬립 assertions below do, and the cards read these directly.
    compactDefault: { on: false, at: 80 }, idleSleep: { enabled: true, timeoutMinutes: 5 }, gateDefaults: { model: "haiku", effort: "low" } },
  auth: [],
  sessions,
  modelRoutes,
  harnesses: [],
  router: { baseUrl: "http://127.0.0.1:3455" },
  automationApi: { baseUrl: "http://127.0.0.1:47831", spec: "http://127.0.0.1:47831/api/spec" },
  logs: { logFilePath: "/tmp/agentparty.log" },
  party: { parties: [{ id: "p1", name: "Refactor Auth", createdAt: "", updatedAt: "" }, { id: "p2", name: "Payments Migration", createdAt: "", updatedAt: "" }], currentPartyId: "p1", members, messages: [] },
  resumableSessions: [],
};

const noop = async () => ({ ok: true });
// Records members whose session was closed via the tab × (close-tab-closes-session).
const closedMembers = [];
// Records members respawned via the toolbar reset button (reload, keep convo).
const respawnedMembers = [];
// Records session ids hard-restarted via the member right-click menu.
const restartedSessions = [];
// New-party-window requests must let IPC resolve the sender BrowserWindow's
// workspace instead of forwarding the shared settings.workspacePath.
const newWindowCalls = [];
// Every member whose transcript this window asked the main process for.
const transcriptFetches = [];
// The main process's copy of the party tab layout, and every push this window made.
let storedLayout;
const persistedLayouts = [];
const keepAwakeCalls = [];
const sleepCalls = [];
const wakeCalls = [];
// Reopen regression: an inactive member has persisted history but no live
// session. Activating it prewarms a resumed session; navigating away, losing
// that session, and returning must prewarm again without dropping the history.
const startedMembers = [];
const frontendHistory = [
  { id: "front-old-user", kind: "user", text: "keep this old question", at: "09:00" },
  { id: "front-old-answer", kind: "assistant", text: "KEEP_FRONTEND_HISTORY", at: "09:01" },
];
window.agentParty = {
  getInitialState: async () => initialState,
  updateSettings: async (patch) => ({ ...initialState.settings, ...patch }),
  chooseWorkspace: async () => initialState.settings,
  listMemberLocations: async () => ({ ok: true, members: [] }),
  listAuth: async () => [],
  setOpenRouterKey: noop,
  clearOpenRouterKey: noop,
  testOpenRouterKey: async () => [],
  createSession: async () => sessions[0],
  listResumableSessions: async () => ({ sessions: [] }),
  resumeSession: async () => sessions[0],
  closeSession: noop,
  sendMessage: noop,
  interrupt: noop,
  restart: async (sessionId) => { restartedSessions.push(sessionId); return { ok: true }; },
  compact: noop,
  setModel: noop,
  setEffort: noop,
  setPermissionMode: noop,
  approve: noop,
  minimizeWindow: noop,
  maximizeWindow: noop,
  closeWindow: noop,
  newWindow: async (workspacePath, partyId) => {
    newWindowCalls.push({ workspacePath, partyId });
    return { id: "new-party-window", workspacePath: "/dev/acme-api", focused: false };
  },
  listParty: async () => initialState.party,
  getMemberTranscript: async (name) => { transcriptFetches.push(name); return name === "frontend" ? frontendHistory : []; },
  saveMemberTranscript: noop,
  createParty: async () => ({ ok: true, message: "", ...initialState.party }),
  selectParty: async () => ({ ok: true, message: "", ...initialState.party }),
  createPartyMember: async () => ({ ok: true, message: "", ...initialState.party }),
  sendPartyMessage: async () => ({ ok: true, message: "", ...initialState.party }),
  bindPartyMember: noop,
  openPartyMember: async () => ({ ok: true, message: "", ...initialState.party }),
  closePartyMember: async (name) => { closedMembers.push(name); return { ok: true, message: "", ...initialState.party }; },
  resumePartyMember: async () => ({ ok: true, message: "", ...initialState.party }),
  respawnPartyMember: async (name) => { respawnedMembers.push(name); return { ok: true, message: "", ...initialState.party }; },
  startPartyMember: async (name) => {
    startedMembers.push(name);
    const member = members.find((item) => item.name === name);
    const sid = `s-${name}-resume-${startedMembers.filter((item) => item === name).length}`;
    const session = { id: sid, title: member?.model || "model", workspace: "/dev/acme-api", snapshot: snapshot(sid, member?.model || "claude-sonnet-4.5", "idle") };
    sessions.push(session);
    if (member) {
      member.sessionId = sid;
      member.status = "running";
    }
    // Startup traffic deliberately wins the race with the command result. The
    // renderer must still prepend persisted history to this already-created log.
    emit("events", { sessionId: sid, events: [{ type: "status", status: "idle", detail: "session resumed" }] });
    emit("sessions", [...sessions]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { ok: true, message: "", ...initialState.party, member, session };
  },
  removePartyMember: async () => ({ ok: true, message: "", ...initialState.party }),
  // Idle-sleep controls reached from the member context menu. Record the calls so
  // the menu is proven to drive the party actions and not just to render.
  setMemberKeepAwake: async (name, keepAwake) => { keepAwakeCalls.push({ name, keepAwake }); return { ok: true, message: "", ...initialState.party }; },
  sleepPartyMember: async (name) => { sleepCalls.push(name); return { ok: true, message: "", ...initialState.party }; },
  wakePartyMember: async (name) => { wakeCalls.push(name); return { ok: true, message: "", ...initialState.party }; },
  listModels: async () => ({ ok: true, modelRoutes: initialState.modelRoutes, codexModels: initialState.codexModels }),
  refreshCodexModels: noop,
  onSessionEvents: on("events"),
  onSnapshot: on("snapshot"),
  onSessions: on("sessions"),
  onPartyUpdate: on("partyUpdate"),
  // Tab layout is party state owned by the main process; these stand in for it.
  getPartyLayout: async () => storedLayout,
  setPartyLayout: async (layout) => { persistedLayouts.push(layout); storedLayout = layout; return { changed: true, layout }; },
  onPartyLayout: on("partyLayout"),
  onModelsUpdate: on("modelsUpdate"),
  onQaLayout: on("qaLayout"),
  onQaOpenSubagent: on("qaOpenSub"),
  onNavigate: on("nav"),
  onWorkspaceChoose: on("ws"),
  onNewSession: on("new"),
  onRefreshHistory: on("hist"),
};

// Seed a two-panel layout so multi-panel rendering is exercised. It comes from
// the MAIN process now (getPartyLayout), not localStorage: the layout is party
// state shared by every window, not each renderer's private copy.
storedLayout = {
  panels: [
    { id: "pa", tabs: ["backend", "frontend"], active: "backend", weight: 1 },
    { id: "pb", tabs: ["reviewer", "tester"], active: "reviewer", weight: 1 },
  ],
  focusedPanelId: "pa",
};

// --- bundle the app entry and run ----------------------------------------
const result = await build({
  entryPoints: [path.join(projectRoot, "src/renderer/qa/appEntry.tsx")],
  bundle: true,
  format: "esm",
  platform: "browser",
  jsx: "automatic",
  loader: { ".css": "empty" },
  define: { "process.env.NODE_ENV": '"development"' },
  write: false,
});

const outDir = qaTempDir();
const bundlePath = path.join(outDir, "appEntry.mjs");
writeFileSync(bundlePath, result.outputFiles[0].text);

const { mount } = await import(pathToFileURL(bundlePath).href);

let crashed = null;
try {
  mount(document.getElementById("root"));
  // Let React commit and run effects so onSessionEvents has registered before
  // we stream mock events.
  await new Promise((resolve) => setTimeout(resolve, 150));
  emit("events", { sessionId: "s-backend", events: [
    { type: "reasoning_delta", text: "token lifecycle reasoning" },
    { type: "assistant_text_delta", text: "추적 결과, verifyRefresh() 가 TokenExpiredError 를 던지는데 가드보다 먼저 발생합니다." },
    { type: "tool_call", id: "t1", name: "read_file", status: "completed", input: { path: "src/auth/refresh.ts" }, result: "48 export async function verifyRefresh(t){" },
  ] });
  emit("events", { sessionId: "s-reviewer", events: [
    { type: "assistant_text_delta", text: "src/auth 디프를 리뷰 중입니다." },
    { type: "approval_request", requestId: "a1", toolName: "apply_patch", description: "좁은 패치를 적용합니다", input: { command: "git apply auth-narrow.patch" } },
  ] });
  emit("events", { sessionId: "s-tester", events: [
    { type: "assistant_text_delta", text: "regression suite running" },
  ] });
} catch (error) {
  crashed = error;
}

await new Promise((resolve) => setTimeout(resolve, 600));

// --- assertions -----------------------------------------------------------
console.log("\nRenderer smoke assertions:");
assert(!crashed, `mount did not throw${crashed ? `: ${crashed.stack || crashed}` : ""}`);
const html = document.getElementById("root").innerHTML;
const text = document.getElementById("root").textContent || "";
assert(html.length > 2000, "root rendered substantial markup");
assert(text.includes("Workbench"), "workbench nav label shown");
assert(text.includes("Refactor Auth"), "active party name shown in sidebar");
assert(document.querySelectorAll('[data-panel-id]').length === 2, "two panels rendered from seeded layout");

for (const name of ["backend", "frontend", "reviewer", "tester"]) {
  assert(text.includes(name), `member '${name}' present`);
}
assert(text.includes("verifyRefresh"), "backend assistant transcript streamed");
assert(text.includes("read_file"), "tool block rendered");
// The heading names the approval TYPE now, in Korean like the rest of the card.
assert(text.includes("승인"), "reviewer approval card rendered");
assert(document.querySelector(".wb-tab") !== null, "tabs rendered");
assert(document.querySelector(".wb-model-pill") !== null, "model pill rendered in toolbar");

// [P-3]7 A member whose turn is in flight shows a moving indicator, not the word
// "working". Other states stay as labels — they are facts, not progress.
const workingPill = document.querySelector(".wb-status-pill.is-working");
assert(Boolean(workingPill?.querySelector(".wb-working-dots")), "panel header shows the progress indicator while a turn runs");
assert(!/working/.test(workingPill?.textContent || ""), "…and no longer prints the word 'working'");
const workingRow = [...document.querySelectorAll(".wb-member-row")].find((row) => row.textContent.includes("backend"));
assert(Boolean(workingRow?.querySelector(".wb-working-dots")), "sidebar row shows the progress indicator for a working member");
assert(!/working/.test(workingRow?.textContent || ""), "…instead of the grey word 'working'");
const idleRow = [...document.querySelectorAll(".wb-member-row")].find((row) => row.textContent.includes("frontend"));
assert(/not started|idle/.test(idleRow?.textContent || "") && !idleRow?.querySelector(".wb-working-dots"), "a member that is not running keeps its status label and shows no indicator");

// [P-8] The model alone does not identify a member — the same model behaves
// differently per harness — so the harness is shown where the member is named.
const rowChip = workingRow?.querySelector(".wb-harness-chip");
assert(rowChip?.querySelector('svg[data-harness="claude-code"]') && rowChip?.getAttribute("title") === "Claude Code", "sidebar row shows the official harness mark + full name on hover");
const tabChip = document.querySelector(".wb-tab .wb-harness-chip");
assert(tabChip?.querySelector('svg[data-harness="claude-code"]'), "tab strip shows the harness mark");
const activeTab = document.querySelector(".wb-tab.is-active");
assert(/Claude Code/.test(activeTab?.getAttribute("title") || ""), "the tab's tooltip names the harness in full");
// The context indicator is now a DONUT (ring), not a bar. Clicking it opens the
// Auto-compact dialog (covered by qa-compact-dialog); here we lock that it renders
// with the live K/K range + % on a wide panel.
const donut = document.querySelector('[data-panel-id="pa"] .wb-ctx-donut');
assert(donut !== null, "context donut rendered for a session with usage");
assert(Boolean(donut) && donut.textContent.includes("320K") && donut.textContent.includes("1M"), "donut shows used/total (320K / 1M)");
assert(Boolean(donut) && donut.querySelector(".wb-donut-ring") !== null, "donut is a ring, not a fill bar");
// Reviewer's live session reports no usage, but its persisted last-known occupancy
// still resolves the donut (stale) — the value a reopened app shows before turn 1.
const staleDonut = document.querySelector('[data-panel-id="pb"] .wb-ctx-donut');
assert(Boolean(staleDonut) && staleDonut.textContent.includes("150K") && staleDonut.textContent.includes("200K"), "stale donut shows used/total (150K / 200K)");
assert(document.documentElement.getAttribute("data-theme") === "light", "default theme is light");
assert(document.getElementById("agentparty-theme-vars") !== null, "theme variables injected");

// Session restart moved OFF the toolbar into the header ⋯ menu (Stop now lives in
// the composer). Open panel pb's (reviewer, idle) ⋯ menu and click 세션 재시작.
const moreBtn = document.querySelector('[data-panel-id="pb"] .wb-header-more');
assert(moreBtn !== null, "header ⋯ (more) button rendered");
if (moreBtn) {
  moreBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 60));
}
const menuItems = [...document.querySelectorAll('[data-panel-id="pb"] .wb-menu-item')];
const restartMenuItem = menuItems.find((b) => /세션 재시작/.test(b.textContent || ""));
const mcpMenuItem = menuItems.find((b) => /MCP/.test(b.textContent || ""));
const gateMenuItem = menuItems.find((b) => /Message Gate/.test(b.textContent || ""));
const cliMenuItem = menuItems.find((b) => /CLI로 이어가기/.test(b.textContent || ""));
assert(restartMenuItem != null, "⋯ menu offers 세션 재시작");
assert(gateMenuItem != null, "⋯ menu offers Message Gate 설정");
assert(mcpMenuItem != null && cliMenuItem != null && menuItems.length === 4, "⋯ menu has restart, Message Gate, MCP, and CLI continuation actions");
// A busy member's composer offers 대기열에 추가 — NOT Stop. While a member works,
// that slot is the only way to put a message in its queue, so Stop cannot own it.
const busySend = document.querySelector('[data-panel-id="pa"] .wb-send-labeled.is-queueing, [data-panel-id="pa"] .wb-send.is-queueing');
assert(busySend !== null, "a busy member's composer offers 대기열에 추가 (the send slot stays a send)");
assert(document.querySelector('[data-panel-id="pa"] .wb-send-labeled.is-stop') === null, "Stop no longer takes over the composer's send slot");
assert(document.querySelector('.wb-stop-pill') === null, "obsolete toolbar Stop pills are not rendered");

// Party right-click -> new window carries only the stable party id. The main
// process derives cwd from the sender window; forwarding settings.workspacePath
// is the cross-workspace regression this test guards.
const firstPartyRow = document.querySelector(".wb-party-row");
if (firstPartyRow) {
  firstPartyRow.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, clientX: 30, clientY: 30 }));
  await new Promise((resolve) => setTimeout(resolve, 60));
  const openPartyWindowItem = document.querySelector(".wb-ctx-menu .wb-ctx-item");
  openPartyWindowItem?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 60));
}
assert(newWindowCalls.length === 1, "party right-click opens one new window");
assert(newWindowCalls[0]?.partyId === "p1", "party right-click routes by party id, not duplicate-prone name");
assert(newWindowCalls[0]?.workspacePath === undefined, "party right-click leaves cwd resolution to the sender window");
if (restartMenuItem) {
  restartMenuItem.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 100));
}
assert(respawnedMembers.includes("reviewer"), "⋯ 세션 재시작 respawned the active member (respawnPartyMember called)");

// Closing a tab (×) must ALSO close that member's session, not just hide the view.
const closeBtn = document.querySelector('[data-panel-id="pa"] .wb-tab-close');
assert(closeBtn !== null, "tab close (×) button rendered");
const tabsBefore = document.querySelectorAll('[data-panel-id="pa"] .wb-tab').length;
if (closeBtn) {
  closeBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 100));
}
assert(closedMembers.includes("backend"), "tab × closed the 'backend' member session (closePartyMember called)");
const tabsAfter = document.querySelectorAll('[data-panel-id="pa"] .wb-tab').length;
assert(tabsAfter === tabsBefore - 1, "tab × removed the tab from the panel");
assert(startedMembers.filter((name) => name === "frontend").length === 1, "activating a persisted member without a live session prewarms it");
assert((document.getElementById("root").textContent || "").includes("KEEP_FRONTEND_HISTORY"), "prewarm keeps restored history even when startup events arrive before the session result");

// Leaving Workbench unmounts its panels. Simulate the frontend harness session
// disappearing while another menu is open, then return. A lifetime name-only
// prewarm guard used to leave the member permanently 'not started' here until a
// user sent chat; remount must now retry exactly once and preserve its history.
emit("nav", { view: "automation" });
await new Promise((resolve) => setTimeout(resolve, 60));
const frontend = members.find((item) => item.name === "frontend");
const firstFrontendSession = frontend?.sessionId;
const firstIndex = sessions.findIndex((session) => session.id === firstFrontendSession);
if (firstIndex >= 0) sessions.splice(firstIndex, 1);
if (frontend) frontend.status = "missing_session";
emit("sessions", [...sessions]);
emit("partyUpdate", initialState.party);
emit("nav", { view: "workbench" });
await new Promise((resolve) => setTimeout(resolve, 180));
assert(startedMembers.filter((name) => name === "frontend").length === 2, "returning to Workbench retries prewarm after the member session disappeared");
assert(frontend?.sessionId !== firstFrontendSession, "reopened member is bound to a fresh resumed app session");
assert((document.getElementById("root").textContent || "").includes("KEEP_FRONTEND_HISTORY"), "reopened member still shows its persisted conversation");

// Hard restart moved to the member's right-click menu. Right-clicking reviewer's
// sidebar row opens a context menu offering "하드 리스타트"; clicking it restarts
// that member's live session (window.agentParty.restart with its session id).
const memberRows = [...document.querySelectorAll(".wb-member-row")];
const reviewerRow = memberRows.find((row) => row.querySelector(".wb-member-name")?.textContent === "reviewer");
assert(reviewerRow != null, "reviewer row present in the party sidebar");
if (reviewerRow) {
  reviewerRow.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, clientX: 40, clientY: 40 }));
  await new Promise((resolve) => setTimeout(resolve, 60));
}
const ctxMenu = document.querySelector(".wb-ctx-menu");
assert(ctxMenu != null, "right-click opens the member context menu");
const ctxItems = ctxMenu ? [...ctxMenu.querySelectorAll(".wb-ctx-item")] : [];
const restartItem = ctxItems.find((b) => /하드 리스타트/.test(b.textContent || ""));
assert(restartItem != null, "context menu offers 하드 리스타트");
assert(ctxItems.some((b) => /삭제하기/.test(b.textContent || "")), "context menu still offers 삭제하기 for a removable member");
if (restartItem) {
  restartItem.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 60));
}
assert(restartedSessions.includes("s-reviewer"), "하드 리스타트 restarted the member's live session (restart called with its session id)");

// Idle sleep is otherwise reachable only over HTTP, so the menu is the whole UI
// for it: 항상 실행 상태 유지 must pin the member and 지금 프로세스 종료 must release it.
if (reviewerRow) {
  reviewerRow.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, clientX: 40, clientY: 40 }));
  await new Promise((resolve) => setTimeout(resolve, 60));
}
const sleepMenuItems = [...(document.querySelector(".wb-ctx-menu")?.querySelectorAll(".wb-ctx-item") || [])];
const keepAwakeItem = sleepMenuItems.find((b) => /항상 실행 상태 유지/.test(b.textContent || ""));
const sleepItem = sleepMenuItems.find((b) => /지금 프로세스 종료/.test(b.textContent || ""));
assert(keepAwakeItem != null, "context menu offers 항상 실행 상태 유지");
assert(sleepItem != null, "context menu offers 지금 프로세스 종료 for an awake member");
if (sleepItem) {
  sleepItem.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 60));
}
assert(sleepCalls.includes("reviewer"), "지금 프로세스 종료 released the member's process (sleepPartyMember called)");
if (reviewerRow) {
  reviewerRow.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, clientX: 40, clientY: 40 }));
  await new Promise((resolve) => setTimeout(resolve, 60));
}
const pinItem = [...(document.querySelector(".wb-ctx-menu")?.querySelectorAll(".wb-ctx-item") || [])]
  .find((b) => /항상 실행 상태 유지/.test(b.textContent || ""));
if (pinItem) {
  pinItem.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 60));
}
assert(
  keepAwakeCalls.some((call) => call.name === "reviewer" && call.keepAwake === true),
  "항상 실행 상태 유지 pinned the member awake (setMemberKeepAwake called with true)",
);

// A window holds the history of members it has OPEN (or that hold a live
// session), not the whole party: a transcript reaches ~15MB on disk and several
// times that once parsed, so loading every member made each window pay for the
// party's entire history — three windows on one party, three times over.
assert(transcriptFetches.includes("frontend"), "an open member's transcript is fetched");
assert(transcriptFetches.includes("tester"), "a background tab's transcript is fetched too (one click from being read)");
assert(!transcriptFetches.includes("archivist"), "a member with no tab and no session is NOT fetched", transcriptFetches.join(","));

// Opening it must load it — skipping is about what is not needed YET, not a
// member the window can never show.
const beforeOpenFetches = transcriptFetches.length;
const archivistRow = [...document.querySelectorAll(".wb-member-row")]
  .find((row) => row.querySelector(".wb-member-name")?.textContent === "archivist");
assert(archivistRow != null, "archivist row present in the sidebar");
if (archivistRow) {
  archivistRow.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 150));
}
assert(transcriptFetches.includes("archivist"), "opening it fetches its transcript", `${transcriptFetches.length - beforeOpenFetches} new fetch(es)`);

// Tab layout is party state owned by the main process, so a change here must be
// PUSHED there — the localStorage version was per-renderer and let two windows
// on one party disagree about which tabs are open.
assert(persistedLayouts.length > 0, "closing a tab pushed the layout to the main process", `${persistedLayouts.length} pushes`);
assert(
  !(persistedLayouts.at(-1)?.panels || []).some((panel) => panel.tabs.includes("backend")),
  "and the pushed layout no longer carries the closed tab",
  JSON.stringify(persistedLayouts.at(-1)?.panels?.map((p) => p.tabs)),
);

// The other half: a layout produced by ANOTHER window on this party must land
// here. This is the reported bug — a tab closed in one window stayed open in
// the other, and that window then wrote its stale layout back over the shared one.
const pushesBeforeBroadcast = persistedLayouts.length;
emit("partyLayout", {
  partyId: "p1",
  layout: { panels: [{ id: "pa", tabs: ["frontend"], active: "frontend", weight: 1 }], focusedPanelId: "pa" },
});
await new Promise((resolve) => setTimeout(resolve, 120));
const tabsAfterBroadcast = [...document.querySelectorAll(".wb-tab")].map((el) => (el.textContent || "").trim());
assert(
  tabsAfterBroadcast.some((label) => label.includes("frontend")) && !tabsAfterBroadcast.some((label) => label.includes("reviewer")),
  "another window's layout is adopted here",
  tabsAfterBroadcast.join(",") || "no tabs",
);
// An adopted layout must not be echoed back: two windows trading the same
// layout would keep overwriting each other while the user is still dragging.
assert(persistedLayouts.length === pushesBeforeBroadcast, "and is not pushed back to the main process", `${persistedLayouts.length - pushesBeforeBroadcast} echo(es)`);

// Settings → Runtime carries the only UI for the global idle-sleep policy, so a
// card that fails to render leaves the feature on with no way to turn it off.
emit("nav", { view: "agent", tab: "general" });
await new Promise((resolve) => setTimeout(resolve, 120));
const runtimeText = document.getElementById("root").textContent || "";
assert(runtimeText.includes("유휴 절전"), "settings show the 유휴 절전 card");
assert(runtimeText.includes("유휴 멤버의 프로세스 종료"), "the card explains what sleeping does");
assert(runtimeText.includes("5분"), "the card shows the current quiet period");

// React surfaces render errors via console.error; treat those as failures.
const realErrors = consoleErrors.filter((line) => !line.includes("not wrapped in act"));
assert(realErrors.length === 0, `no console errors (${realErrors.length})${realErrors.length ? ": " + realErrors[0].slice(0, 200) : ""}`);

console.log("");
if (failures.length) {
  console.log(`RENDER SMOKE FAILED: ${failures.length} assertion(s)`);
  process.exit(1);
}
console.log("RENDER SMOKE PASSED");
process.exit(0);
