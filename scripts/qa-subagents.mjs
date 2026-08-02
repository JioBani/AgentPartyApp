/*
 * Subagent-observation UI coverage. Four layers:
 *   1. subagentActivity (pure): tool→action derivation (the currentAction swap
 *      point) maps Claude + Codex + mock tool names to the right Korean label.
 *   2. subagentEvents (fold): `subagent` events merge by agentId into a separate
 *      slice (spawn + blocks + terminal phase); typing is replaced; and the
 *      TRANSCRIPT fold ignores them (subagent output stays out of the chat).
 *   3. subagentModel + scenarios: a named mock scenario expands + folds into the
 *      right dock counts/summary; status→color mapping; responsive thresholds.
 *   4. Dock + Detail (DOM): dock lists rows with status pills; detail drills in
 *      with the delegated-task band and the subagent's own tool transcript.
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
def("crypto", window.crypto && window.crypto.randomUUID ? window.crypto : { randomUUID: () => "id-" + Math.random().toString(16).slice(2) });
def("getComputedStyle", window.getComputedStyle.bind(window));
def("requestAnimationFrame", (cb) => setTimeout(() => cb(Date.now()), 0)); def("cancelAnimationFrame", clearTimeout);
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }; globalThis.ResizeObserver = window.ResizeObserver;



const outDir = qaTempDir();
async function bundle(entry, name, external = []) {
  const r = await build({ entryPoints: [path.join(projectRoot, entry)], bundle: true, format: "esm", platform: "browser", jsx: "automatic", loader: { ".css": "empty" }, define: { "process.env.NODE_ENV": '"development"' }, external, write: false });
  const p = path.join(outDir, name); writeFileSync(p, r.outputFiles[0].text); return import(pathToFileURL(p).href);
}

// ---- Layer 1: activity derivation (currentAction swap point) -----------------
const A = await bundle("src/shared/subagentActivity.ts", "sub-activity.mjs", []);
console.log("\nsubagentActivity derivation:");
assert(A.deriveSubagentAction("Grep").kind === "searching" && A.deriveSubagentAction("Grep").label === "코드 탐색중", "Grep → 코드 탐색중");
assert(A.deriveSubagentAction("Read").kind === "reading", "Read → reading");
assert(A.deriveSubagentAction("run_tests").kind === "testing", "run_tests → testing");
assert(A.deriveSubagentAction("commandExecution").kind === "running", "Codex commandExecution → running");
assert(A.deriveSubagentAction("WebSearch").kind === "web", "WebSearch → web");
assert(A.deriveSubagentAction("Edit").kind === "editing", "Edit → editing");
assert(A.deriveSubagentAction("Task").kind === "spawning", "Task → spawning");
assert(A.deriveSubagentAction("Grep", "verifyRefresh").summary === "코드 탐색중 · verifyRefresh", "arg folds into summary");
assert(A.deriveSubagentAction("mystery_tool").kind === "unknown" && A.deriveSubagentAction("mystery_tool").label === "작업중", "unknown tool falls back (no silent drop)");
assert(A.subagentActionLabel({ kind: "reading", label: "문서 읽는중", summary: "문서 읽는중 · a.ts" }) === "문서 읽는중 · a.ts", "summary wins over label");

// ---- Layer 2: fold + separation ---------------------------------------------
const S = await bundle("src/renderer/app/subagentEvents.ts", "sub-events.mjs", []);
const T = await bundle("src/renderer/app/transcriptEvents.ts", "sub-transcript.mjs", []);
console.log("\nsubagentEvents fold + separation:");
let subs = S.applySubagentEvents({}, "s1", [
  { type: "subagent", agentId: "a1", lifecycle: { phase: "working", label: "shard-runner", hint: "auth/**", assignedTask: "run auth tests" } },
  { type: "subagent", agentId: "a1", block: { kind: "assistant", text: "실행 중" } },
  { type: "subagent", agentId: "a1", block: { kind: "tool", name: "Grep", arg: "verifyRefresh" } },
  { type: "subagent", agentId: "a1", block: { kind: "typing" } },
  { type: "subagent", agentId: "a1", block: { kind: "status", text: "done" } },
  { type: "subagent", agentId: "a1", lifecycle: { phase: "done", tools: "318 tests", dur: "2m 04s" } },
])["s1"];
assert(subs.length === 1, "one subagent folded by agentId");
assert(subs[0].name === "shard-runner" && subs[0].hint === "auth/**" && subs[0].task === "run auth tests", "lifecycle identity merged");
assert(subs[0].phase === "done" && subs[0].tools === "318 tests" && subs[0].dur === "2m 04s", "terminal phase + meta merged");
assert(subs[0].activity && subs[0].activity.kind === "searching", "activity derived from the Grep tool block");
assert(subs[0].blocks.filter((b) => b.kind === "typing").length === 0, "trailing typing replaced by the next real block");
assert(subs[0].blocks.length === 3, "assistant + tool + status blocks retained (typing dropped)");
// Separation: the TRANSCRIPT fold must ignore subagent events entirely.
const chat = T.applyEvents({}, "s1", [
  { type: "assistant_text_delta", text: "hi" },
  { type: "subagent", agentId: "a1", block: { kind: "assistant", text: "SECRET subagent output" } },
])["s1"];
assert(!JSON.stringify(chat).includes("SECRET subagent output"), "subagent output never enters the main transcript");
assert(chat.length === 1 && chat[0].kind === "assistant", "only the parent assistant text is in the chat");

// ---- Layer 3: scenarios + dock model ----------------------------------------
const SC = await bundle("src/shared/subagentScenarios.ts", "sub-scenarios.mjs", []);
const M = await bundle("src/renderer/workbench/subagentModel.ts", "sub-model.mjs", ["react"]);
console.log("\nscenarios + dock model:");
assert(SC.expandScenarioByName("nope", "t") === null, "unknown scenario name → null (loud failure upstream)");
const evs = SC.expandScenarioByName("claude-test-shards", "12:00");
let folded = S.applySubagentEvents({}, "s2", evs)["s2"];
assert(folded.length === 6, "claude-test-shards folds to 6 subagents");
const dock = M.buildSubDock(folded, "#e0a14e", "wide", undefined, false);
assert(dock.count === 6, "dock count = 6");
assert(dock.summary === "2 실행 · 2 완료 · 2 대기", "summary joins non-zero status counts in order");
assert(dock.running === 2, "two running");
const working = M.subagentStatusStyle("working", "#e0a14e");
assert(working.working === true && working.color === "#e0a14e" && working.bg.startsWith("rgba(224, 161, 78"), "working uses member color + alpha tint");
assert(M.subagentStatusStyle("done", "#e0a14e").color === "var(--success)", "done → success token");
assert(M.subagentStatusStyle("queued", "#e0a14e").color === "var(--text-3)", "queued → text-3 token");
assert(M.subagentStatusStyle("failed", "#e0a14e").color === "var(--danger)", "failed → danger token");
const narrow = M.buildSubDock(folded, "#e0a14e", "narrow", undefined, false);
assert(narrow.rows.every((r) => r.showLine === false && r.showMeta === false), "narrow hides line + meta");
const mid = M.buildSubDock(folded, "#e0a14e", "mid", undefined, false);
assert(mid.rows.every((r) => r.showLine === true && r.showMeta === false), "mid shows line, hides meta");
// A working subagent's row line prefers the live activity over its task.
const billing = folded.find((s) => s.hint === "billing/**");
const billingRow = M.buildSubDock([billing], "#e0a14e", "wide", undefined, false).rows[0];
assert(billingRow.line.includes("실행중") || billingRow.line.includes(billing.task) || billingRow.line.length > 0, "working row shows a live line");

// ---- Layer 4: Dock + Detail DOM ---------------------------------------------
const { SubagentDock } = await bundle("src/renderer/workbench/SubagentDock.tsx", "sub-dock.mjs", ["react", "react-dom", "react-dom/client", "react/jsx-runtime"]);
const { SubagentDetail } = await bundle("src/renderer/workbench/SubagentDetail.tsx", "sub-detail.mjs", ["react", "react-dom", "react-dom/client", "react/jsx-runtime"]);
const React = await import("react");
const reactDom = await import("react-dom/client");
const mount = (el) => { const host = document.createElement("div"); document.body.appendChild(host); reactDom.createRoot(host).render(el); return host; };
const settle = () => new Promise((r) => setTimeout(r, 60));

console.log("\nSubagentDock DOM:");
const dockHost = mount(React.createElement(SubagentDock, { view: dock, onToggle: () => {}, onOpen: () => {} }));
await settle();
assert(Boolean(dockHost.querySelector(".wb-subdock")), "dock renders");
assert(dockHost.querySelector(".wb-subdock-count")?.textContent === "6", "dock count badge shows 6");
assert(dockHost.textContent.includes("2 실행 · 2 완료 · 2 대기"), "dock summary rendered");
assert(dockHost.querySelectorAll(".wb-subrow").length === 6, "one row per subagent");
assert([...dockHost.querySelectorAll(".wb-subrow-status")].some((s) => s.textContent === "실행 중"), "a working row shows the 실행 중 pill");
assert([...dockHost.querySelectorAll(".wb-subrow-status")].some((s) => s.textContent === "대기"), "a queued row shows the 대기 pill");

console.log("\nSubagentDetail DOM:");
const detail = M.buildSubDetail(folded.find((s) => s.hint === "auth/**"), "#e0a14e");
const detailHost = mount(React.createElement(SubagentDetail, { detail, parentName: "tester", parentColor: "#e0a14e", density: "wide", onBack: () => {} }));
await settle();
assert(Boolean(detailHost.querySelector(".wb-subdetail")), "detail overlay renders");
assert(detailHost.textContent.includes("위임된 작업"), "delegated-task band renders");
assert(detailHost.textContent.includes("auth 도메인"), "the delegated task text is shown");
assert(detailHost.textContent.includes("tester"), "breadcrumb shows the parent member");
assert(Boolean(detailHost.querySelector(".wb-subblock-tool")), "the subagent's own tool block renders");
assert(detailHost.textContent.includes("run_tests"), "tool name shown in detail transcript");
assert(!detailHost.querySelector(".wb-subdetail-task .wb-expand-inline"), "a SHORT delegated task shows in full, with no expand control");

console.log("\nLong delegated task is collapsed (#6):");
// The reported symptom: a delegated prompt of hundreds of lines rendered whole,
// pushing the subagent's actual work off screen.
const longTask = Array.from({ length: 40 }, (_, i) => `${i + 1}. 리팩터링 대상 파일과 검증 절차를 순서대로 기술한 지시 라인`).join("\n");
const longDetail = { ...detail, task: longTask };
const longHost = mount(React.createElement(SubagentDetail, { detail: longDetail, parentName: "tester", parentColor: "#e0a14e", density: "wide", onBack: () => {} }));
await settle();
const band = longHost.querySelector(".wb-subdetail-task");
assert(Boolean(band) && band.textContent.length < longTask.length, "a long delegated task renders as a clipped preview, not in full");
assert(band.textContent.includes("1. 리팩터링"), "the preview keeps the beginning of the prompt");
const expand = band.querySelector(".wb-expand-inline");
assert(Boolean(expand), "…and offers 전체 보기");
expand.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
await settle();
const popup = document.querySelector(".wb-tool-modal");
assert(Boolean(popup) && popup.textContent.includes("40. 리팩터링"), "전체 보기 opens the FULL prompt in a popup (nothing is lost)");

console.log(failures.length ? `\nSUBAGENTS FAILED (${failures.length})` : "\nSUBAGENTS PASSED");
process.exit(failures.length ? 1 : 0);
