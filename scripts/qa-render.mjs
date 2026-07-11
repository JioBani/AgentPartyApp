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
];

const initialState = {
  ok: true,
  settings: { workspacePath: "/dev/acme-api", claudeExecutablePath: "", claudeSafeMode: false, selectedHarnessId: "claude-code", harnessDefaults: { "claude-code": { model: "claude-sonnet-4.5", effort: "high", permissionMode: "default" }, codex: { model: "gpt-5.5", effort: "medium", codexPolicy: { sandbox: "workspace-write", approval: "on-request", guardian: false } } }, debugEnabled: false, routerBaseUrl: "", routerAuthToken: "", openRouterApiKey: "", automationApiPort: 47831 },
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
window.agentParty = {
  getInitialState: async () => initialState,
  updateSettings: async (patch) => ({ ...initialState.settings, ...patch }),
  chooseWorkspace: async () => initialState.settings,
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
  restart: noop,
  compact: noop,
  setModel: noop,
  setEffort: noop,
  setPermissionMode: noop,
  approve: noop,
  minimizeWindow: noop,
  maximizeWindow: noop,
  closeWindow: noop,
  listParty: async () => initialState.party,
  createParty: async () => ({ ok: true, message: "", ...initialState.party }),
  selectParty: async () => ({ ok: true, message: "", ...initialState.party }),
  createPartyMember: async () => ({ ok: true, message: "", ...initialState.party }),
  sendPartyMessage: async () => ({ ok: true, message: "", ...initialState.party }),
  bindPartyMember: noop,
  openPartyMember: async () => ({ ok: true, message: "", ...initialState.party }),
  closePartyMember: async () => ({ ok: true, message: "", ...initialState.party }),
  resumePartyMember: async () => ({ ok: true, message: "", ...initialState.party }),
  startPartyMember: async () => ({ ok: true, message: "", ...initialState.party }),
  removePartyMember: async () => ({ ok: true, message: "", ...initialState.party }),
  listModels: async () => ({ ok: true, modelRoutes: initialState.modelRoutes, codexModels: initialState.codexModels }),
  refreshCodexModels: noop,
  onSessionEvents: on("events"),
  onSnapshot: on("snapshot"),
  onSessions: on("sessions"),
  onPartyUpdate: on("partyUpdate"),
  onModelsUpdate: on("modelsUpdate"),
  onQaLayout: on("qaLayout"),
  onQaOpenSubagent: on("qaOpenSub"),
  onNavigate: on("nav"),
  onWorkspaceChoose: on("ws"),
  onNewSession: on("new"),
  onRefreshHistory: on("hist"),
};

// Seed a two-panel layout so multi-panel rendering is exercised.
window.localStorage.setItem("agentparty.layout.p1", JSON.stringify({
  panels: [
    { id: "pa", tabs: ["backend", "frontend"], active: "backend", weight: 1 },
    { id: "pb", tabs: ["reviewer", "tester"], active: "reviewer", weight: 1 },
  ],
  focusedPanelId: "pa",
}));

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
const outDir = path.join(projectRoot, "node_modules/.qa");
mkdirSync(outDir, { recursive: true });
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
assert(text.includes("Approval required"), "reviewer approval card rendered");
assert(document.querySelector(".wb-tab") !== null, "tabs rendered");
assert(document.querySelector(".wb-model-pill") !== null, "model pill rendered in toolbar");
const meter = document.querySelector(".wb-ctx-meter");
assert(meter !== null, "context-capacity meter rendered for a session with usage");
assert(Boolean(meter) && meter.textContent.includes("320K") && meter.textContent.includes("1M"), "meter shows used/total (320K/1M)");
assert(Boolean(meter) && meter.classList.contains("is-ok") && meter.querySelector(".wb-ctx-fill") !== null, "meter shows an ok-level fill bar at 32%");
// Reviewer's live session reports no usage, but its persisted last-known occupancy
// drives a STALE meter — the value a reopened app shows before the first turn.
const staleMeter = document.querySelector(".wb-ctx-meter.is-stale");
assert(staleMeter !== null, "stale (last-known) meter rendered from persisted occupancy");
assert(Boolean(staleMeter) && staleMeter.textContent.includes("~150K") && staleMeter.textContent.includes("200K"), "stale meter shows ~used/total (~150K/200K)");
assert(document.documentElement.getAttribute("data-theme") === "light", "default theme is light");
assert(document.getElementById("agentparty-theme-vars") !== null, "theme variables injected");

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
