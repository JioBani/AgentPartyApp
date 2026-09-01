/*
 * Regression for tool-call (e.g. bash) output rendering. Long commands/output
 * show a clipped PREVIEW inline (kept scannable), with a "전체 보기" control that
 * opens a popup holding the FULL command + result; short content shows no expand
 * control. tool_result content arrays must render as plain text (not escaped JSON).
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
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }; globalThis.ResizeObserver = window.ResizeObserver;



const outDir = qaTempDir();
const r = await build({ entryPoints: [path.join(projectRoot, "src/renderer/workbench/Transcript.tsx")], bundle: true, format: "esm", platform: "browser", jsx: "automatic", loader: { ".css": "empty" }, define: { "process.env.NODE_ENV": '"development"' }, external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"], write: false });
const bp = path.join(outDir, "transcript-tool.mjs"); writeFileSync(bp, r.outputFiles[0].text);
const { Transcript } = await import(pathToFileURL(bp).href);
const React = await import("react");
const reactDom = await import("react-dom/client");

const longCommand = "for f in $(find . -name '*.log'); do echo \"=== $f ===\"; cat \"$f\"; done # " + "x".repeat(300);
const longOutput = Array.from({ length: 150 }, (_, i) => `line ${i}: ${"y".repeat(30)}`).join("\n");

const view = {
  name: "r", color: "#888", member: { name: "r", partyId: "p1", status: "idle", runtime: "claude-code", role: "" },
  status: "idle", unread: 0, pendingApproval: false, busy: false, model: "sonnet", effort: "medium", permissionMode: "default",
  transcript: [
    // String result (long → previewed inline, full in popup).
    { id: "t1", kind: "tool", name: "Bash", status: "completed", input: { command: longCommand }, result: longOutput, at: "10:00" },
    // Anthropic content-array result (long).
    { id: "t2", kind: "tool", name: "Bash", status: "completed", input: { command: "echo hi" }, result: [{ type: "text", text: longOutput }], at: "10:01" },
    // Short result → no expand control, full content inline.
    { id: "t3", kind: "tool", name: "Bash", status: "completed", input: { command: "echo hi" }, result: "hello world", at: "10:02" },
    { id: "t4", kind: "tool", name: "shell", status: "failed", input: { command: "exit 1" }, result: "failed", at: "10:03" },
  ],
};
reactDom.createRoot(document.getElementById("root")).render(React.createElement(Transcript, { view, density: "wide", actions: {} }));
await new Promise((res) => setTimeout(res, 120));

console.log("\nTool output rendering (preview inline):");
const details = [...document.querySelectorAll(".wb-tool")];
assert(details.length === 4, "four tool blocks rendered");
const failedSummary = details[3]?.querySelector("summary");
assert(Boolean(failedSummary?.querySelector(".wb-tool-check.is-failed svg")), "failed tool keeps its red X mark");
assert(!failedSummary?.querySelector(".wb-tool-outcome"), "failed tool does not repeat the word 실패 beside the X");

const cmd = document.querySelector(".wb-tool-cmd");
assert(Boolean(cmd), "tool body shows a command line");
assert((cmd?.textContent || "").startsWith("$ "), "command is shown with a $ prefix");
assert((cmd?.textContent || "").includes("for f in"), "command preview keeps the start of the command");
assert(!(cmd?.textContent || "").includes("x".repeat(300)), "the long command tail is NOT dumped inline (previewed)");

const results = [...document.querySelectorAll(".wb-tool-result")];
assert(results.length === 4, "all tool results rendered");
// The two long results are previewed: first line present, last line NOT (clipped).
assert((results[0].textContent || "").includes("line 0:"), "long result preview shows the first line");
assert(!(results[0].textContent || "").includes("line 149:"), "long result preview clips the tail (not dumped inline)");
assert((results[0].textContent || "").trim().endsWith("…"), "clipped preview ends with an ellipsis");
// The content-array result must be plain text, not JSON (even in preview).
const arrResult = results[1]?.textContent || "";
assert(!arrResult.trim().startsWith("[") && !arrResult.includes('"type"'), "content-array result renders as plain text, not escaped JSON");
// Short result renders in full, no clipping.
assert((results[2].textContent || "") === "hello world", "short result is shown in full (no preview clip)");

console.log("\nExpand control + full-view popup:");
const blocks = [...document.querySelectorAll(".wb-tool")];
assert(!blocks[2].querySelector(".wb-tool-expand"), "short tool has NO '전체 보기' control");
const expandBtn = blocks[0].querySelector("summary .wb-tool-expand");
assert(Boolean(expandBtn), "long tool has a '전체 보기' control in its summary");
assert(!document.querySelector(".wb-tool-modal"), "no modal before clicking expand");
expandBtn?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await new Promise((res) => setTimeout(res, 40));
const modal = document.querySelector(".wb-tool-modal");
assert(Boolean(modal), "clicking expand opens the full-view popup");
assert(modal?.parentElement?.parentElement === document.body, "tool popup is mounted at the application window root");
const modalText = modal?.textContent || "";
assert(modalText.includes(longCommand), "popup shows the FULL command (untruncated)");
assert(modalText.includes("line 0:") && modalText.includes("line 149:"), "popup shows the full result (first + last line)");
// [#16] INVERTED ON PURPOSE. This used to require the popup to close on a
// backdrop click — the defect, recorded as if it were the intent. The app's rule
// is that a modal closes by its own control, never by a stray click outside:
// selecting text in a long command or result routinely ends with the pointer
// outside the popup, which used to close it and lose the selection.
document.querySelector(".wb-tool-modal-backdrop")?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await new Promise((res) => setTimeout(res, 40));
assert(Boolean(document.querySelector(".wb-tool-modal")), "popup survives a backdrop click (does NOT close on outside click)");
document.querySelector(".wb-tool-modal-head .wb-icon-btn")?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await new Promise((res) => setTimeout(res, 40));
assert(!document.querySelector(".wb-tool-modal"), "popup closes on its own 닫기 button");

console.log(failures.length ? `\nTOOL OUTPUT FAILED (${failures.length})` : "\nTOOL OUTPUT PASSED");
process.exit(failures.length ? 1 : 0);
