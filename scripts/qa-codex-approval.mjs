/*
 * Codex approval card variants (Item 2). Two layers:
 *   1. codexApproval (pure): decision option sets per request kind, decision →
 *      protocol value (accept/acceptForSession/execpolicy amendment/decline), and
 *      the request → card-metadata / response translation verified against the
 *      real app-server types (CommandExecutionApprovalDecision, ReviewDecision…).
 *   2. Transcript (DOM): a Codex command approval shows the exact command and the
 *      once/session/prefix-rule/decline buttons ("always" only when a rule is
 *      offered); a file-change approval omits "always"; request-user-input drives
 *      the question card; each choice reaches actions.approve via codexDecision.
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
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
const { window } = dom;
const def = (n, v) => { try { Object.defineProperty(globalThis, n, { value: v, configurable: true, writable: true }); } catch {} };
def("window", window); def("document", window.document); def("HTMLElement", window.HTMLElement);
def("getComputedStyle", window.getComputedStyle.bind(window));
def("requestAnimationFrame", (cb) => setTimeout(() => cb(Date.now()), 0)); def("cancelAnimationFrame", clearTimeout);
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }; globalThis.ResizeObserver = window.ResizeObserver;



const outDir = qaTempDir();
async function bundle(entry, name, external = []) {
  const r = await build({ entryPoints: [path.join(projectRoot, entry)], bundle: true, format: "esm", platform: "browser", jsx: "automatic", loader: { ".css": "empty" }, define: { "process.env.NODE_ENV": '"development"' }, external, write: false });
  const p = path.join(outDir, name); writeFileSync(p, r.outputFiles[0].text); return import(pathToFileURL(p).href);
}

// ---- Layer 1: pure model ----------------------------------------------------
const A = await bundle("src/shared/codexApproval.ts", "codex-approval.mjs", []);
console.log("\ncodexApproval decision options:");
assert(same(A.codexApprovalOptions({ kind: "command", canAlways: true }), ["decline", "once", "session", "always"]), "command WITH a rule offers once/session/always/decline");
assert(same(A.codexApprovalOptions({ kind: "command", canAlways: false }), ["decline", "once", "session"]), "command WITHOUT a rule has no 'always'");
assert(same(A.codexApprovalOptions({ kind: "fileChange" }), ["decline", "once", "session"]), "fileChange has no 'always' (no prefix rule for patches)");
assert(same(A.codexApprovalOptions({ kind: "userInput" }), ["decline", "once"]), "userInput falls back to once/decline");

console.log("\ncodexApproval decision resolution:");
assert(A.codexDecisionOf("allow", { codexDecision: "session" }) === "session", "explicit codexDecision overrides behavior");
assert(A.codexDecisionOf("allow", undefined) === "once", "allow with no override → once");
assert(A.codexDecisionOf("deny", undefined) === "decline", "deny with no override → decline");

console.log("\ncodexApproval → protocol mapping:");
assert(A.commandExecutionDecision("once") === "accept", "command once → accept");
assert(A.commandExecutionDecision("session") === "acceptForSession", "command session → acceptForSession");
assert(same(A.commandExecutionDecision("always", ["npm", "test"]), { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["npm", "test"] } }), "command always+rule → acceptWithExecpolicyAmendment");
assert(A.commandExecutionDecision("always") === "acceptForSession", "command always with NO rule degrades to acceptForSession");
assert(A.commandExecutionDecision("decline") === "decline", "command decline → decline");
assert(A.fileChangeDecision("always") === "acceptForSession", "fileChange always degrades to acceptForSession");
assert(A.reviewDecision("session") === "approved_for_session", "legacy session → approved_for_session");
assert(same(A.reviewDecision("always", ["git", "push"]), { approved_execpolicy_amendment: { proposed_execpolicy_amendment: ["git", "push"] } }), "legacy always+rule → approved_execpolicy_amendment");

console.log("\ncodexApproval request → meta:");
const cmdMeta = A.approvalMeta("item/commandExecution/requestApproval", { command: "rm -rf build", cwd: "/w", proposedExecpolicyAmendment: ["rm"] });
assert(cmdMeta.kind === "command" && cmdMeta.command === "rm -rf build" && cmdMeta.canAlways === true, "command meta carries command + canAlways from the amendment");
assert(A.approvalMeta("item/fileChange/requestApproval", {}).kind === "fileChange", "fileChange method classified");
assert(A.approvalMeta("item/tool/requestUserInput", {}).kind === "userInput", "requestUserInput method classified");
assert(A.approvalMeta("item/permissions/requestApproval", {}).kind === "permissions", "permissions method classified");
assert(A.approvalMeta("mcpServer/elicitation/request", {}).kind === "elicitation", "elicitation method classified");

console.log("\ncodexApproval request → response:");
assert(same(A.approvalResult("item/commandExecution/requestApproval", "session", {}, undefined), { decision: "acceptForSession" }), "command response uses CommandExecutionApprovalDecision");
assert(same(A.approvalResult("execCommandApproval", "once", {}, undefined), { decision: "approved" }), "legacy execCommandApproval uses ReviewDecision");
const perm = A.approvalResult("item/permissions/requestApproval", "session", { permissions: { network: { hosts: ["x"] }, fileSystem: null } }, undefined);
assert(perm.scope === "session" && perm.permissions.network && Object.prototype.hasOwnProperty.call(perm.permissions, "network"), "permissions accept echoes the granted profile at session scope");
assert(same(A.approvalResult("item/permissions/requestApproval", "decline", { permissions: { network: {} } }, undefined), { permissions: {}, scope: "turn" }), "permissions decline grants nothing");
assert(same(A.approvalResult("mcpServer/elicitation/request", "decline", {}, undefined), { action: "decline", content: null, _meta: null }), "elicitation decline → action decline");
const ui = A.approvalResult("item/tool/requestUserInput", "once", { questions: [{ id: "q1", question: "이름?" }] }, { answers: { "이름?": "Alice, Bob" } });
assert(same(ui, { answers: { q1: { answers: ["Alice", "Bob"] } } }), "userInput maps card answers back to id-keyed protocol answers");

// ---- Layer 2: Transcript DOM ------------------------------------------------
const { Transcript } = await bundle("src/renderer/workbench/Transcript.tsx", "codex-approval-transcript.mjs", ["react", "react-dom", "react-dom/client", "react/jsx-runtime"]);
const React = await import("react");
const reactDom = await import("react-dom/client");
const mount = (el) => { const host = document.createElement("div"); document.body.appendChild(host); reactDom.createRoot(host).render(el); return host; };
const click = (el) => el?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const settle = () => new Promise((r) => setTimeout(r, 60));

let captured = null;
const actions = { approve: (name, requestId, behavior, updatedInput) => { captured = { name, requestId, behavior, updatedInput }; }, answerQuestion() {} };
const mkView = (block) => ({ name: "codey", color: "#888", member: { name: "codey", runtime: "codex" }, status: "approval", transcript: [block], unread: 0, pendingApproval: true, busy: false, model: "x", effort: "medium", permissionMode: "default" });

console.log("\nTranscript codex command approval:");
const cmdBlock = { id: "a1", kind: "approval", requestId: "r1", toolName: "item/commandExecution/requestApproval", title: "명령 실행 승인", codex: { kind: "command", command: "npm test", cwd: "/w", canAlways: true, alwaysHint: "npm test" } };
const cmdHost = mount(React.createElement(Transcript, { view: mkView(cmdBlock), density: "wide", actions }));
await settle();
assert(Boolean(cmdHost.querySelector(".wb-codex-approval")), "codex approval card renders");
assert(cmdHost.textContent.includes("npm test"), "the exact command is shown");
const cmdBtns = [...cmdHost.querySelectorAll(".wb-codex-approval-actions .wb-btn")].map((b) => b.textContent);
assert(cmdBtns.includes("항상 허용 (규칙)"), "'always' button shown because a rule was offered");
assert(cmdBtns.includes("이 세션 동안") && cmdBtns.includes("이번만 허용") && cmdBtns.includes("거부"), "once/session/decline buttons shown");
click([...cmdHost.querySelectorAll(".wb-codex-approval-actions .wb-btn")].find((b) => b.textContent === "이 세션 동안"));
assert(captured?.behavior === "allow" && captured?.updatedInput?.codexDecision === "session", "clicking 'this session' sends codexDecision=session");
click([...cmdHost.querySelectorAll(".wb-codex-approval-actions .wb-btn")].find((b) => b.textContent === "거부"));
assert(captured?.behavior === "deny" && captured?.updatedInput?.codexDecision === "decline", "clicking decline sends deny + codexDecision=decline");

console.log("\nTranscript codex file-change approval:");
const fcBlock = { id: "a2", kind: "approval", requestId: "r2", toolName: "item/fileChange/requestApproval", title: "파일 변경 승인", codex: { kind: "fileChange", diff: "--- a/x\n+++ b/x\n@@\n-old\n+new" } };
const fcHost = mount(React.createElement(Transcript, { view: mkView(fcBlock), density: "wide", actions }));
await settle();
assert(Boolean(fcHost.querySelector(".wb-approval-diff")), "file-change approval shows a diff block");
const fcBtns = [...fcHost.querySelectorAll(".wb-codex-approval-actions .wb-btn")].map((b) => b.textContent);
assert(!fcBtns.includes("항상 허용 (규칙)"), "file-change approval has NO 'always' (no prefix rule for patches)");

console.log("\nTranscript codex request-user-input:");
const uiBlock = { id: "a3", kind: "approval", requestId: "r3", toolName: "item/tool/requestUserInput", title: "Codex가 입력을 요청함", codex: { kind: "userInput" }, input: { questions: [{ id: "q1", header: "환경", question: "어느 환경에 배포할까요?", multiSelect: false, options: [{ label: "staging" }, { label: "prod" }] }] } };
const uiHost = mount(React.createElement(Transcript, { view: mkView(uiBlock), density: "wide", actions }));
await settle();
assert(uiHost.textContent.includes("어느 환경에 배포할까요?"), "request-user-input renders as the interactive question card");
assert([...uiHost.querySelectorAll(".wb-question-option")].some((b) => b.textContent.includes("staging")), "its options are selectable");

console.log(failures.length ? `\nCODEX APPROVAL FAILED (${failures.length})` : "\nCODEX APPROVAL PASSED");
process.exit(failures.length ? 1 : 0);
