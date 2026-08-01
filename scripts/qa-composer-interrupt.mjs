/*
 * Interrupt-on-send default (P-14), through the REAL App tree in jsdom.
 *
 * The backend has always supported interrupting a member's in-flight turn on a
 * user message — the Discord bridge and the HTTP API both pass it. The UI never
 * did: `sendMemberMessage` dropped the option between the composer and the IPC
 * bridge, so a Send from the app could only ever queue.
 *
 * This mounts the real renderer with a mocked `window.agentParty`, presses Send
 * in a member's composer, and asserts the option that reaches the bridge follows
 * the `composer.interruptOnSend` setting. Also asserts the built-in default is
 * OFF: interrupting kills a turn that is already doing work, so it cannot be
 * what a fresh install does.
 *
 * The main-process leg (IPC arg → AppController → PartyApplicationService, which
 * only interrupts a BUSY, non-compacting session) is covered by the full-process
 * scripts/e2e-composer-interrupt.mjs.
 */
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const assert = (c, m) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) failures.push(m); };

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://localhost/", pretendToBeVisual: true });
const { window } = dom;
const def = (n, v) => { try { Object.defineProperty(globalThis, n, { value: v, configurable: true, writable: true }); } catch {} };
def("window", window); def("document", window.document); def("HTMLElement", window.HTMLElement);
def("getComputedStyle", window.getComputedStyle.bind(window));
def("requestAnimationFrame", (cb) => setTimeout(() => cb(Date.now()), 0)); def("cancelAnimationFrame", clearTimeout);
def("FileReader", window.FileReader); def("File", window.File); def("Blob", window.Blob);
if (!globalThis.crypto?.randomUUID) def("crypto", { randomUUID: () => "id-" + Math.random().toString(16).slice(2) });
try { window.crypto = globalThis.crypto; } catch { /* read-only in jsdom */ }
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.ResizeObserver = window.ResizeObserver;
window.console = console;

const snapshot = { id: "s-worker", cwd: "/ws", model: "sonnet", effort: "medium", permissionMode: "default", status: "responding", startedAt: "", debugMode: false, turnCount: 1, queuedTurnCount: 0, pendingApprovalCount: 0 };
const sessions = [{ id: "s-worker", title: "sonnet", workspace: "/ws", snapshot }];
const members = [{ partyId: "p1", name: "worker", status: "running", runtime: "claude-code", role: "impl", sessionId: "s-worker", model: "sonnet" }];
const party = { parties: [{ id: "p1", name: "QA", createdAt: "", updatedAt: "" }], currentPartyId: "p1", members, messages: [] };

/** `composer` is patched per case before the app is (re)mounted. */
let composerSettings;
const baseSettings = {
  workspacePath: "/ws", claudeExecutablePath: "", cursorExecutablePath: "", claudeSafeMode: false,
  selectedHarnessId: "claude-code",
  harnessDefaults: { "claude-code": { model: "sonnet", effort: "medium", permissionMode: "default" }, codex: { model: "gpt-5.4", effort: "medium" }, cursor: { model: "Grok 4.5", effort: "high" } },
  debugEnabled: false, routerBaseUrl: "", routerAuthToken: "", openRouterApiKey: "", deepseekApiKey: "",
  automationApiPort: 0, transcriptFontScale: 1, compactDefault: { on: false, at: 80 }, gateDefaults: { model: "haiku", effort: "low" },
};

const sends = [];
const noop = async () => ({ ok: true });
const on = () => () => {};
window.agentParty = {
  getInitialState: async () => ({
    ok: true, settings: { ...baseSettings, ...(composerSettings ? { composer: composerSettings } : {}) },
    auth: [], sessions, modelRoutes: [], modelProviders: [], harnesses: [],
    router: { baseUrl: "" }, automationApi: { baseUrl: "", spec: "" }, logs: { logFilePath: "" },
    party, resumableSessions: [],
  }),
  updateSettings: async (patch) => ({ ...baseSettings, ...patch }),
  listAuth: async () => [], listParty: async () => party,
  getMemberTranscript: async () => [], saveMemberTranscript: noop,
  sendMemberMessage: async (name, text, attachments, options) => {
    sends.push({ name, text, options });
    return { ok: true, message: "", ...party, member: members[0] };
  },
  sendPartyMessage: async () => ({ ok: true, message: "", ...party }),
  startPartyMember: async () => ({ ok: true, message: "", ...party }),
  openPartyMember: async () => ({ ok: true, message: "", ...party }),
  closePartyMember: async () => ({ ok: true, message: "", ...party }),
  resumePartyMember: async () => ({ ok: true, message: "", ...party }),
  respawnPartyMember: async () => ({ ok: true, message: "", ...party }),
  removePartyMember: async () => ({ ok: true, message: "", ...party }),
  createPartyMember: async () => ({ ok: true, message: "", ...party }),
  createParty: async () => ({ ok: true, message: "", ...party }),
  selectParty: async () => ({ ok: true, message: "", ...party }),
  deleteParty: async () => ({ ok: true, message: "", ...party }),
  bindPartyMember: noop, setMemberAutoCompact: noop, setMemberGate: noop, setPartyGate: noop,
  listResumableSessions: async () => ({ sessions: [] }),
  sendMessage: noop, interrupt: noop, forceStop: noop, restart: noop, compact: noop, closeSession: noop,
  createSession: async () => sessions[0], resumeSession: async () => sessions[0],
  setModel: noop, setEffort: noop, setThinking: noop, setPermissionMode: noop, setCodexPolicy: noop, setCursorPolicy: noop,
  approve: noop, listMcpServers: async () => ({ supported: false, servers: [] }),
  reconnectMcpServer: noop, setMcpServerEnabled: noop, authenticateMcpServer: noop,
  openExternal: noop, minimizeWindow: noop, maximizeWindow: noop, closeWindow: noop,
  newWindow: noop, listWindows: async () => ({ windows: [] }),
  listModels: async () => ({ routes: [] }), refreshCodexModels: noop,
  getDiscordStatus: async () => ({ enabled: false }), updateDiscordSettings: noop,
  getUsageLimits: async () => ({ usage: {} }), refreshUsageLimits: noop,
  getTokenUsage: async () => ({}), getTokenUsageTurns: async () => ({}),
  chooseWorkspace: async () => baseSettings,
  onSessionEvents: on, onSnapshot: on, onSessions: on, onPartyUpdate: on, onModelsUpdate: on,
  onSettingsUpdate: on, onAuthUpdate: on, onDiscordUpdate: on, onUsageUpdate: on,
  onQaLayout: on, onQaOpenSubagent: on, onQaOpenGate: on, onNavigate: on,
  onWorkspaceChoose: on, onNewSession: on, onRefreshHistory: on,
};

window.localStorage.setItem("agentparty.layout.p1", JSON.stringify({
  panels: [{ id: "pa", tabs: ["worker"], active: "worker", weight: 1 }],
  focusedPanelId: "pa",
}));

const result = await build({
  entryPoints: [path.join(projectRoot, "src/renderer/qa/appEntry.tsx")],
  bundle: true, format: "esm", platform: "browser", jsx: "automatic",
  loader: { ".css": "empty" }, define: { "process.env.NODE_ENV": '"development"' }, write: false,
});
const outDir = path.join(projectRoot, "node_modules/.qa"); mkdirSync(outDir, { recursive: true });
const bundlePath = path.join(outDir, "composer-interrupt-app.mjs");
writeFileSync(bundlePath, result.outputFiles[0].text);
const { mount } = await import(pathToFileURL(bundlePath).href);

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** Mounts the app with the given `composer` setting and sends one message. */
async function sendOnce(settings) {
  composerSettings = settings;
  sends.length = 0;
  // A fresh container per case: React owns a root per element, so reusing one
  // would remount over an existing root instead of starting clean.
  const host = document.getElementById("root");
  host.innerHTML = "";
  const container = document.createElement("div");
  host.appendChild(container);
  mount(container);
  await delay(400);
  const field = document.querySelector("textarea.wb-composer-textarea");
  if (!field) throw new Error("composer textarea not found");
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  setter.call(field, "작업 상황 알려줘");
  field.dispatchEvent(new window.Event("input", { bubbles: true }));
  await delay(60);
  field.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));
  await delay(300);
  return sends[0];
}

console.log("interrupt on send (P-14)");

const off = await sendOnce({ sendKey: "ctrl-enter", interruptOnSend: false });
assert(Boolean(off), "메시지가 sendMemberMessage 로 전달됐다");
assert(off?.options?.interrupt === false, "설정 off: interrupt:false 로 전달된다 (진행 중인 턴 뒤에 큐잉)");

const on2 = await sendOnce({ sendKey: "ctrl-enter", interruptOnSend: true });
assert(on2?.options?.interrupt === true, "설정 on: interrupt:true 로 전달된다 (진행 중인 턴을 끊는다)");

// A settings.json written before this feature existed has no `composer` key at
// all; the destructive option must not switch itself on there.
const legacy = await sendOnce(undefined);
assert(legacy?.options?.interrupt === false, "설정이 없던 기존 사용자도 off (파괴적 동작은 기본값이 될 수 없다)");

console.log(failures.length ? `\n${failures.length} failure(s)` : "\nall passed");
process.exit(failures.length ? 1 : 0);
