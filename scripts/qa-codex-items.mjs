/*
 * Codex transcript item coverage (Item 3). Three layers:
 *   1. codexItems (pure): diff stats, fileChange normalization, plan steps,
 *      tool source (mcp:<server>/plugin/namespace) — verified against the
 *      app-server ThreadItem field names.
 *   2. transcriptEvents (event pipeline): plan events upsert ONE evolving card;
 *      command output deltas APPEND (not replace); cwd/exit/duration merge;
 *      fileChange events become a diff block.
 *   3. Transcript (DOM): plan checklist with per-step status, fileChange +/-
 *      stats + diff, tool source badge + exit/duration meta, live output shown.
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
def("crypto", window.crypto && window.crypto.randomUUID ? window.crypto : { randomUUID: () => "id-" + Math.random().toString(16).slice(2) });
def("getComputedStyle", window.getComputedStyle.bind(window));
def("requestAnimationFrame", (cb) => setTimeout(() => cb(Date.now()), 0)); def("cancelAnimationFrame", clearTimeout);
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }; globalThis.ResizeObserver = window.ResizeObserver;



const outDir = qaTempDir();
async function bundle(entry, name, external = []) {
  const r = await build({ entryPoints: [path.join(projectRoot, entry)], bundle: true, format: "esm", platform: "browser", jsx: "automatic", loader: { ".css": "empty" }, define: { "process.env.NODE_ENV": '"development"' }, external, write: false });
  const p = path.join(outDir, name); writeFileSync(p, r.outputFiles[0].text); return import(pathToFileURL(p).href);
}

// ---- Layer 1: pure model ----------------------------------------------------
const I = await bundle("src/shared/codexItems.ts", "codex-items.mjs", []);
console.log("\ncodexItems pure model:");
assert(same(I.diffStats("--- a\n+++ b\n@@\n+one\n+two\n-old"), { added: 2, removed: 1 }), "diffStats counts +/- lines and ignores ---/+++ headers");
const edits = I.fileEditsFrom([{ path: "a.ts", kind: { type: "update" }, diff: "@@\n+x\n+y\n-z" }, { path: "b.ts", kind: { type: "add" }, diff: "+n" }]);
assert(edits.length === 2 && edits[0].added === 2 && edits[0].removed === 1, "fileEditsFrom computes per-file +/- stats");
assert(edits[1].kind === "add", "add kind labelled");
assert(I.patchKindLabel({ type: "update", move_path: "x" }) === "rename", "update with move_path → rename");
assert(same(I.planStepsFrom([{ step: "A", status: "completed" }, { step: "B", status: "inProgress" }]).map((s) => s.status), ["completed", "inProgress"]), "planStepsFrom preserves step status");
assert(I.toolSourceLabel({ type: "mcpToolCall", server: "brave" }) === "mcp:brave", "mcpToolCall → mcp:<server>");
assert(I.toolSourceLabel({ type: "mcpToolCall", server: "brave", pluginId: "p1" }) === "plugin:p1", "mcpToolCall with pluginId → plugin:<id>");
assert(I.toolSourceLabel({ type: "dynamicToolCall", namespace: "connectors" }) === "connectors", "dynamicToolCall → namespace");
assert(I.toolSourceLabel({ type: "commandExecution" }) === "shell", "commandExecution → shell");

// ---- Layer 2: event pipeline ------------------------------------------------
const T = await bundle("src/renderer/app/transcriptEvents.ts", "codex-items-events.mjs", []);
console.log("\ntranscriptEvents pipeline:");
let blocks = T.applyEvents({}, "s1", [
  { type: "plan", steps: [{ step: "A", status: "completed" }, { step: "B", status: "inProgress" }], explanation: "plan" },
  { type: "tool_call", id: "c1", name: "shell", status: "started", source: "shell", cwd: "/w", input: "npm test" },
  { type: "tool_call", id: "c1", name: "shell", status: "started", source: "shell", outputDelta: "line1\n" },
  { type: "tool_call", id: "c1", name: "shell", status: "started", source: "shell", outputDelta: "line2\n" },
  { type: "tool_call", id: "c1", name: "shell", status: "completed", exitCode: 0, durationMs: 1500 },
  { type: "file_change", changes: [{ path: "a.ts", kind: "update", added: 3, removed: 1, diff: "@@" }], status: "completed" },
  { type: "tool_call", id: "m1", name: "search", status: "completed", source: "mcp:brave" },
])["s1"];
const plan = blocks.find((b) => b.kind === "plan");
assert(plan && plan.steps.length === 2, "one plan block with structured steps");
const shell = blocks.find((b) => b.kind === "tool" && b.id === "c1");
assert(shell && shell.output === "line1\nline2\n", "command output deltas APPEND into one block");
assert(shell.exitCode === 0 && shell.durationMs === 1500 && shell.cwd === "/w", "cwd/exit/duration merged onto the shell block");
assert(blocks.filter((b) => b.kind === "tool" && b.id === "c1").length === 1, "the 5 shell events collapse to ONE tool block");
const fc = blocks.find((b) => b.kind === "fileChange");
assert(fc && fc.changes[0].added === 3, "fileChange event becomes a fileChange block with stats");
const mcp = blocks.find((b) => b.kind === "tool" && b.id === "m1");
assert(mcp && mcp.source === "mcp:brave", "mcp tool carries its source badge");

// a second plan update replaces steps (latest wins), keeps one card
blocks = T.applyEvents({ s1: blocks }, "s1", [{ type: "plan", steps: [{ step: "A", status: "completed" }, { step: "B", status: "completed" }], explanation: "plan" }])["s1"];
assert(blocks.filter((b) => b.kind === "plan").length === 1, "plan updates stay a single evolving card");
assert(blocks.find((b) => b.kind === "plan").steps.every((s) => s.status === "completed"), "latest plan steps win");

// ---- Layer 3: Transcript DOM ------------------------------------------------
const { Transcript } = await bundle("src/renderer/workbench/Transcript.tsx", "codex-items-transcript.mjs", ["react", "react-dom", "react-dom/client", "react/jsx-runtime"]);
const React = await import("react");
const reactDom = await import("react-dom/client");
const mount = (el) => { const host = document.createElement("div"); document.body.appendChild(host); reactDom.createRoot(host).render(el); return host; };
const settle = () => new Promise((r) => setTimeout(r, 60));

const view = {
  name: "codey", color: "#888", member: { name: "codey", runtime: "codex" }, status: "idle", unread: 0, pendingApproval: false, busy: false, model: "x", effort: "medium", permissionMode: "default",
  transcript: [
    { id: "plan", kind: "plan", steps: [{ step: "환경 점검", status: "completed" }, { step: "테스트 실행", status: "inProgress" }], explanation: "" },
    { id: "c1", kind: "tool", name: "shell", source: "shell", status: "completed", input: "npm test", output: "PASS\n", cwd: "/w", exitCode: 0, durationMs: 1500 },
    { id: "f1", kind: "fileChange", changes: [{ path: "src/a.ts", kind: "update", added: 3, removed: 1, diff: "@@\n+new\n-old" }], status: "completed" },
    { id: "m1", kind: "tool", name: "search", source: "mcp:brave", status: "completed", input: { query: "x" } },
  ],
};
console.log("\nTranscript DOM:");
const host = mount(React.createElement(Transcript, { view, density: "wide", actions: {} }));
await settle();
assert(Boolean(host.querySelector(".wb-plan")), "plan card renders");
assert(host.querySelector(".wb-plan-count")?.textContent === "1/2", "plan shows done/total count");
assert(host.querySelectorAll(".wb-plan-step").length === 2, "plan lists each step");
assert(Boolean(host.querySelector(".wb-plan-step.is-inProgress")), "in-progress step is marked");
assert(Boolean(host.querySelector(".wb-filechange")), "fileChange card renders");
assert(host.textContent.includes("src/a.ts") && host.textContent.includes("+3") && host.textContent.includes("-1"), "fileChange shows path and +/- stats");
const sources = [...host.querySelectorAll(".wb-tool-source")].map((s) => s.textContent);
assert(sources.includes("shell") && sources.includes("mcp:brave"), "tool source badges (shell, mcp:brave) render");
assert(host.textContent.includes("exit 0") && host.textContent.includes("1.5s"), "shell tool shows exit code and duration");
assert(host.textContent.includes("PASS"), "shell live output is shown");

console.log(failures.length ? `\nCODEX ITEMS FAILED (${failures.length})` : "\nCODEX ITEMS PASSED");
process.exit(failures.length ? 1 : 0);
