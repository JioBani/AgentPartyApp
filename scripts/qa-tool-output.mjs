/*
 * Regression for tool-call (e.g. bash) output rendering. The summary `arg` is
 * intentionally ellipsis-clipped, so a long command must still be fully visible
 * in the EXPANDED body, and tool_result content arrays must render as plain
 * text (not escaped JSON) — full content, never truncated.
 */
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

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

const outDir = path.join(projectRoot, "node_modules/.qa"); mkdirSync(outDir, { recursive: true });
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
    // String result.
    { id: "t1", kind: "tool", name: "Bash", status: "completed", input: { command: longCommand }, result: longOutput, at: "10:00" },
    // Anthropic content-array result.
    { id: "t2", kind: "tool", name: "Bash", status: "completed", input: { command: "echo hi" }, result: [{ type: "text", text: longOutput }], at: "10:01" },
  ],
};
reactDom.createRoot(document.getElementById("root")).render(React.createElement(Transcript, { view, density: "wide", actions: {} }));
await new Promise((res) => setTimeout(res, 120));

console.log("\nTool output rendering:");
const details = [...document.querySelectorAll(".wb-tool")];
assert(details.length === 2, "two tool blocks rendered");

const cmd = document.querySelector(".wb-tool-cmd");
assert(Boolean(cmd), "expanded tool body shows a full-command line");
assert((cmd?.textContent || "").includes(longCommand), "the FULL bash command is present in the body (not ellipsis-clipped)");
assert((cmd?.textContent || "").startsWith("$ "), "command is shown with a $ prefix");

const results = [...document.querySelectorAll(".wb-tool-result")];
assert(results.length === 2, "both tool results rendered");
results.forEach((p, i) => {
  const txt = p.textContent || "";
  assert(txt.includes("line 0:") && txt.includes("line 149:"), `result #${i}: full output present (first + last line), not truncated`);
});
// The content-array result must be plain text, not JSON.
const arrResult = results[1]?.textContent || "";
assert(!arrResult.trim().startsWith("[") && !arrResult.includes('"type"'), "content-array result renders as plain text, not escaped JSON");

console.log("\nCommand scroll + full-view modal:");
const wrap = document.querySelector(".wb-tool-cmd-wrap");
assert(Boolean(wrap), "command body is wrapped for scroll + expand control");
const expandBtn = wrap?.querySelector(".wb-tool-expand");
assert(Boolean(expandBtn), "'전체 보기' expand button is present");
assert(!document.querySelector(".wb-tool-modal"), "no modal before clicking expand");
expandBtn?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await new Promise((res) => setTimeout(res, 40));
const modal = document.querySelector(".wb-tool-modal");
assert(Boolean(modal), "clicking expand opens the full-view modal");
const modalText = modal?.textContent || "";
assert(modalText.includes(longCommand), "modal shows the FULL command");
assert(modalText.includes("line 0:") && modalText.includes("line 149:"), "modal shows the full result too");
// Close via backdrop click.
document.querySelector(".wb-tool-modal-backdrop")?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await new Promise((res) => setTimeout(res, 40));
assert(!document.querySelector(".wb-tool-modal"), "modal closes on backdrop click");

console.log(failures.length ? `\nTOOL OUTPUT FAILED (${failures.length})` : "\nTOOL OUTPUT PASSED");
process.exit(failures.length ? 1 : 0);
