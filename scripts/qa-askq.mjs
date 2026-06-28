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

const questions = [
  { question: "어떤 작업을 진행할까요?", header: "작업 선택", multiSelect: false, options: [
    { label: "코드 리뷰", description: "현재 변경점을 리뷰합니다." },
    { label: "버그 수정", description: "보고된 버그를 수정합니다." },
  ] },
  { question: "어떤 우선순위로 진행할까요?", header: "우선순위", multiSelect: false, options: [
    { label: "빠르게", description: "최소 변경." },
    { label: "꼼꼼하게", description: "철저히." },
  ] },
];
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
const text = () => transcript?.textContent || "";
const options = () => [...transcript.querySelectorAll(".wb-question-option")];

assert(cards.length === 1, `exactly one AskUserQuestion card rendered (got ${cards.length})`);
assert(toolBoxes.length === 0, `no duplicate/empty tool boxes for AskUserQuestion (got ${toolBoxes.length})`);
assert(blocks.length <= 3, `transcript is not cluttered with stacked blocks (got ${blocks.length})`);

// Stepper: only the first question is shown, with a progress indicator.
assert(text().includes("어떤 작업을 진행할까요?"), "first question shown");
assert(!text().includes("어떤 우선순위로 진행할까요?"), "second question NOT shown until advanced (stepped, not all-at-once)");
assert((transcript.querySelector(".wb-question-progress")?.textContent || "").replace(/\s/g, "") === "1/2", "progress shows 1/2");
assert(options().filter((b) => !b.classList.contains("wb-question-other")).length === 2, "current question shows its 2 structured options");
assert(options().some((b) => b.classList.contains("wb-question-other")), "an Other (free-text) option is always appended");

// Choosing a single-select option auto-advances to the next question.
options()[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await new Promise((r) => setTimeout(r, 50));
assert((transcript.querySelector(".wb-question-progress")?.textContent || "").replace(/\s/g, "") === "2/2", "advanced to 2/2 after selecting");
assert(text().includes("어떤 우선순위로 진행할까요?"), "second question shown after advancing");

// Answer the last question; submit becomes available.
options()[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await new Promise((r) => setTimeout(r, 50));
[...transcript.querySelectorAll(".wb-question .wb-btn-member")][0]?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await new Promise((r) => setTimeout(r, 80));

assert(Array.isArray(approveArgs) && approveArgs[2] === "allow", "answering approves the request");
const updatedInput = approveArgs?.[3];
assert(updatedInput?.answers?.["어떤 작업을 진행할까요?"] === "코드 리뷰", "answer for question 1 carried in SDK-correct shape");
assert(updatedInput?.answers?.["어떤 우선순위로 진행할까요?"] === "빠르게", "answer for question 2 carried");
assert((document.querySelector(".wb-question .wb-status-badge")?.textContent || "").includes("답변함"), "resolved card shows answered state");

// --- Other (free-text) path: a fresh pending question with an Other option ---
approveArgs = null;
const id2 = "toolu_OTHER";
const input2 = { questions: [{ question: "기타 질문?", header: "기타", options: [{ label: "A" }, { label: "B" }], multiSelect: false }] };
emit("events", { sessionId: "s-main", events: [
  { type: "tool_call", id: id2, name: "AskUserQuestion", input: input2, status: "started" },
  { type: "approval_request", requestId: id2, toolName: "AskUserQuestion", input: input2, title: "AskUserQuestion" },
] });
await new Promise((r) => setTimeout(r, 120));
const cards2 = document.querySelectorAll(".wb-question");
const otherCard = cards2[cards2.length - 1];
const otherBtn = otherCard.querySelector(".wb-question-other");
assert(Boolean(otherBtn), "an 'Other (free-text)' option is always offered");
otherBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await new Promise((r) => setTimeout(r, 40));
const otherInput = otherCard.querySelector(".wb-question-other-input");
assert(Boolean(otherInput), "choosing Other reveals a free-text input");
const submit2 = [...otherCard.querySelectorAll(".wb-btn-member")][0];
assert(submit2.disabled, "submit stays disabled until free text is typed");
// React tracks the value via a hidden setter; use the native setter so onChange fires.
const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
valueSetter.call(otherInput, "직접 적은 답");
otherInput.dispatchEvent(new window.Event("input", { bubbles: true }));
await new Promise((r) => setTimeout(r, 40));
[...otherCard.querySelectorAll(".wb-btn-member")][0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await new Promise((r) => setTimeout(r, 60));
assert(approveArgs?.[3]?.answers?.["기타 질문?"] === "직접 적은 답", "Other free text is sent as the answer");

const realErrors = consoleErrors.filter((l) => !l.includes("not wrapped in act"));
assert(realErrors.length === 0, `no console errors / key collisions (${realErrors.length})${realErrors[0] ? ": " + realErrors[0].slice(0, 120) : ""}`);

console.log(failures.length ? `\nFAILED (${failures.length})` : "\nASKUSERQUESTION RENDER PASSED");
process.exit(failures.length ? 1 : 0);
