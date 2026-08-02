/*
 * Regression for "a member created with model X flips to the global model on
 * first chat". Mounts the real app, opens an idle member whose configured model
 * differs from the global default, sends a message, and asserts startPartyMember
 * is called with the MEMBER's own model/provider — not the global settings model.
 */
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { qaTempDir } from "./lib/qaTemp.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const assert = (c, m) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) failures.push(m); };

const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
const { window } = dom;
const def = (n, v) => { try { Object.defineProperty(globalThis, n, { value: v, configurable: true, writable: true }); } catch {} };
def("window", window); def("document", window.document); def("HTMLElement", window.HTMLElement);
def("getComputedStyle", window.getComputedStyle.bind(window));
def("requestAnimationFrame", (cb) => setTimeout(() => cb(Date.now()), 0)); def("cancelAnimationFrame", clearTimeout);
if (!globalThis.crypto?.randomUUID) def("crypto", { randomUUID: () => "id-" + Math.random().toString(16).slice(2) });
try { window.crypto = globalThis.crypto; } catch {}
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }; globalThis.ResizeObserver = window.ResizeObserver;
window.console = console;

const on = (name) => () => () => {};
const noop = async () => ({ ok: true });
const modelRoutes = [
  { harnessId: "claude-code", providerId: "anthropic", model: "sonnet", label: "Sonnet" },
  { harnessId: "claude-code", providerId: "openrouter", model: "Kimi K2.6", runtimeModel: "claude-kimi", label: "Kimi K2.6" },
];
// kbot is created with Kimi (openrouter); the GLOBAL default is sonnet (anthropic).
const members = [{ partyId: "p1", name: "kbot", status: "idle", runtime: "claude-code", role: "QA", model: "Kimi K2.6", reasoning: "enabled" }];
const party = { parties: [{ id: "p1", name: "P", createdAt: "", updatedAt: "" }], currentPartyId: "p1", members, messages: [] };
const initialState = {
  ok: true,
  settings: { workspacePath: "/w", claudeExecutablePath: "", claudeSafeMode: false, selectedHarnessId: "claude-code", harnessDefaults: { "claude-code": { model: "sonnet", effort: "medium", permissionMode: "default" }, codex: { model: "gpt-5.5", effort: "medium", codexPolicy: { sandbox: "workspace-write", approval: "on-request", guardian: false } } }, debugEnabled: false, routerBaseUrl: "", routerAuthToken: "", openRouterApiKey: "", automationApiPort: 47831 },
  auth: [], sessions: [], modelRoutes, harnesses: [], router: { baseUrl: "" }, automationApi: { baseUrl: "", spec: "" }, logs: { logFilePath: "" }, party, resumableSessions: [],
};

let startArgs = null;
window.agentParty = new Proxy({
  getInitialState: async () => initialState,
  listParty: async () => party,
  startPartyMember: async (name, input) => { startArgs = { name, input }; return { ok: true, message: "", ...party, session: { id: "s-kbot", title: "Kimi K2.6", workspace: "/w", snapshot: { id: "s-kbot", model: "Kimi K2.6", status: "idle" } } }; },
  sendMessage: noop,
  onSessionEvents: on("events"), onSnapshot: on("snapshot"), onSessions: on("sessions"), onPartyUpdate: on("partyUpdate"), onModelsUpdate: on("modelsUpdate"), onQaLayout: on("qaLayout"), onQaOpenSubagent: on("qaOpenSub"), onNavigate: on("nav"), onWorkspaceChoose: on("ws"), onNewSession: on("new"), onRefreshHistory: on("hist"),
}, { get: (t, p) => (p in t ? t[p] : noop) });

window.localStorage.setItem("agentparty.layout.p1", JSON.stringify({ panels: [{ id: "pa", tabs: ["kbot"], active: "kbot", weight: 1 }], focusedPanelId: "pa" }));

const result = await build({ entryPoints: [path.join(projectRoot, "src/renderer/qa/appEntry.tsx")], bundle: true, format: "esm", platform: "browser", jsx: "automatic", loader: { ".css": "empty" }, define: { "process.env.NODE_ENV": '"development"' }, write: false });

const outDir = qaTempDir();
const bundlePath = path.join(outDir, "appEntry-startmodel.mjs"); writeFileSync(bundlePath, result.outputFiles[0].text);
const { mount } = await import(pathToFileURL(bundlePath).href);

mount(document.getElementById("root"));
await new Promise((r) => setTimeout(r, 200));

console.log("\nMember start-model assertions:");
const textarea = document.querySelector(".wb-composer-textarea") || document.querySelector(".wb-composer-input");
assert(Boolean(textarea), "member composer rendered for the idle member");
const setVal = (el, v) => { const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v); el.dispatchEvent(new window.Event("input", { bubbles: true })); };
setVal(textarea, "안녕");
await new Promise((r) => setTimeout(r, 40));
const sendBtn = document.querySelector(".wb-send-labeled, .wb-send");
assert(Boolean(sendBtn) && !sendBtn.disabled, "Send enabled after typing");
sendBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await new Promise((r) => setTimeout(r, 120));

assert(startArgs?.name === "kbot", "startPartyMember called for the member on first chat");
assert(startArgs?.input?.model === "Kimi K2.6", `started with the MEMBER's model, not the global default (got ${JSON.stringify(startArgs?.input?.model)})`);
assert(startArgs?.input?.selectedProviderId === "openrouter", `started with the member model's provider (got ${JSON.stringify(startArgs?.input?.selectedProviderId)})`);
assert(startArgs?.input?.model !== "sonnet", "did NOT fall back to the global sonnet (the reported bug)");

console.log(failures.length ? `\nMEMBER START-MODEL FAILED (${failures.length})` : "\nMEMBER START-MODEL PASSED");
process.exit(failures.length ? 1 : 0);
