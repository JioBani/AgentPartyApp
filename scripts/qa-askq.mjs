/*
 * Regression test for the AskUserQuestion chat rendering.
 *
 * Replays the exact adapter event sequence for an AskUserQuestion turn into the
 * real renderer and asserts: (1) the duplicate tool_call lifecycle events
 * collapse to a single block (no empty/stacked boxes), (2) AskUserQuestion is
 * shown as an interactive choice card — not a raw allow/deny prompt, and
 * (3) choosing an option approves with the SDK-correct `{...input, answers}`
 * shape and reflects the chosen answer. Guards the two bugs fixed for the
 * Workbench transcript.
 */
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const consoleErrors = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };

const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
const { window } = dom;
const define = (n, v) => { try { Object.defineProperty(globalThis, n, { value: v, configurable: true, writable: true }); } catch {} };
define("window", window); define("document", window.document); define("HTMLElement", window.HTMLElement);
define("getComputedStyle", window.getComputedStyle.bind(window));
define("requestAnimationFrame", (cb) => setTimeout(() => cb(Date.now()), 0));
define("cancelAnimationFrame", clearTimeout);
if (!globalThis.crypto?.randomUUID) define("crypto", { randomUUID: () => "id-" + Math.random().toString(16).slice(2) });
try { window.crypto = globalThis.crypto; } catch {}
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.ResizeObserver = window.ResizeObserver;
window.console = console;
const origError = console.error;
console.error = (...a) => { consoleErrors.push(a.map(String).join(" ")); origError.apply(console, a); };

const listeners = {};
const on = (name) => (cb) => { (listeners[name] ||= []).push(cb); return () => {}; };
const emit = (name, payload) => (listeners[name] || []).forEach((cb) => cb(payload));
const noop = async () => ({ ok: true });

const snap = { id: "s-main", cwd: "/home/dev", model: "MiniMax M3", effort: "medium", permissionMode: "plan", status: "responding", startedAt: "", debugMode: false, turnCount: 1, queuedTurnCount: 0, pendingApprovalCount: 1 };
const initialState = {
  ok: true,
  settings: { workspacePath: "/home/dev", claudeExecutablePath: "", selectedHarnessId: "claude-code", selectedProviderId: "openrouter", claudeModel: "MiniMax M3", claudeEffort: "medium", claudePermissionMode: "plan", claudeSafeMode: false, debugEnabled: false, routerBaseUrl: "", routerAuthToken: "", openRouterApiKey: "", automationApiPort: 47831 },
  auth: [], sessions: [{ id: "s-main", title: "main", workspace: "/home/dev", snapshot: snap }], modelRoutes: [], harnesses: [], router: { baseUrl: "" }, automationApi: { baseUrl: "", spec: "" }, logs: { logFilePath: "" },
  party: { parties: [{ id: "p1", name: "team-a", createdAt: "", updatedAt: "" }], currentPartyId: "p1", members: [{ partyId: "p1", name: "main", status: "running", runtime: "claude-code", role: "Primary", sessionId: "s-main", model: "MiniMax M3" }], messages: [] },
  resumableSessions: [],
};
let approveArgs = null;
window.agentParty = new Proxy({
  getInitialState: async () => initialState,
  approve: async (...args) => { approveArgs = args; return { ok: true }; },
  onSessionEvents: on("events"), onSnapshot: on("snapshot"), onSessions: on("sessions"), onPartyUpdate: on("partyUpdate"),
  onQaLayout: on("qaLayout"), onNavigate: on("nav"), onWorkspaceChoose: on("ws"), onNewSession: on("new"), onRefreshHistory: on("hist"),
  listParty: async () => initialState.party,
}, { get: (t, p) => p in t ? t[p] : noop });

window.localStorage.setItem("agentparty.layout.p1", JSON.stringify({ panels: [{ id: "pa", tabs: ["main"], active: "main", weight: 1 }], focusedPanelId: "pa" }));

const result = await build({ entryPoints: [path.join(projectRoot, "src/renderer/qa/appEntry.tsx")], bundle: true, format: "esm", platform: "browser", jsx: "automatic", loader: { ".css": "empty" }, define: { "process.env.NODE_ENV": '"development"' }, write: false });
const outDir = path.join(projectRoot, "node_modules/.qa"); mkdirSync(outDir, { recursive: true });
const bundlePath = path.join(outDir, "appEntry-askq.mjs"); writeFileSync(bundlePath, result.outputFiles[0].text);
const { mount } = await import(pathToFileURL(bundlePath).href);

mount(document.getElementById("root"));
await new Promise((r) => setTimeout(r, 150));

const questions = [{ question: "어떤 작업을 진행할까요?", header: "작업 선택", options: [
  { label: "코드 리뷰", description: "현재 변경점을 리뷰합니다." },
  { label: "버그 수정", description: "보고된 버그를 수정합니다." },
], multiSelect: false }];
const input = { questions };
const id = "toolu_01ASKQ";

// Exact adapter event sequence for an AskUserQuestion turn (start → stop →
// assistant snapshot → canUseTool), all sharing one tool-use id.
emit("events", { sessionId: "s-main", events: [
  { type: "status", status: "responding" },
  { type: "tool_call", id, name: "AskUserQuestion", input: {}, status: "started" },
  { type: "tool_call", id, name: "AskUserQuestion", input, status: "completed" },
  { type: "tool_call", id, name: "AskUserQuestion", input, status: "started" },
  { type: "approval_request", requestId: id, toolName: "AskUserQuestion", input, title: "AskUserQuestion" },
] });
await new Promise((r) => setTimeout(r, 120));

console.log("\nAskUserQuestion rendering assertions:");
const transcript = document.querySelector(".wb-transcript");
const blocks = transcript ? [...transcript.children] : [];
const cards = transcript ? transcript.querySelectorAll(".wb-question") : [];
const toolBoxes = transcript ? transcript.querySelectorAll(".wb-tool") : [];
const text = transcript?.textContent || "";

assert(cards.length === 1, `exactly one AskUserQuestion card rendered (got ${cards.length})`);
assert(toolBoxes.length === 0, `no duplicate/empty tool boxes for AskUserQuestion (got ${toolBoxes.length})`);
assert(blocks.length <= 3, `transcript is not cluttered with stacked blocks (got ${blocks.length})`);
assert(text.includes("어떤 작업을 진행할까요?"), "question text shown in full");
assert(text.includes("코드 리뷰") && text.includes("버그 수정"), "all option labels shown");
assert(transcript?.querySelectorAll(".wb-question-option").length === 2, "options are interactive buttons");

// Choose the first option and submit.
transcript.querySelector(".wb-question-option")?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await new Promise((r) => setTimeout(r, 50));
[...transcript.querySelectorAll(".wb-question .wb-btn-member")][0]?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await new Promise((r) => setTimeout(r, 80));

assert(Array.isArray(approveArgs) && approveArgs[2] === "allow", "answering approves the request");
const updatedInput = approveArgs?.[3];
assert(updatedInput?.answers?.["어떤 작업을 진행할까요?"] === "코드 리뷰", "approve carries SDK-correct answers shape");
assert((document.querySelector(".wb-question .wb-status-badge")?.textContent || "").includes("코드 리뷰"), "resolved card shows the chosen answer");

const realErrors = consoleErrors.filter((l) => !l.includes("not wrapped in act"));
assert(realErrors.length === 0, `no console errors / key collisions (${realErrors.length})${realErrors[0] ? ": " + realErrors[0].slice(0, 120) : ""}`);

console.log(failures.length ? `\nFAILED (${failures.length})` : "\nASKUSERQUESTION RENDER PASSED");
process.exit(failures.length ? 1 : 0);
