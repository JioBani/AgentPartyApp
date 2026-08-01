/*
 * Message bodies (a sent user message, an inter-member channel message) show a
 * clipped PREVIEW by default and open the FULL text in a popup via "전체 보기".
 * Short messages render in full with no expand control. Mirrors the bash/tool
 * preview behavior so the transcript stays scannable.
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
const bp = path.join(outDir, "transcript-msg.mjs"); writeFileSync(bp, r.outputFiles[0].text);
const { Transcript } = await import(pathToFileURL(bp).href);
const React = await import("react");
const reactDom = await import("react-dom/client");

const longMessage = Array.from({ length: 40 }, (_, i) => `paragraph ${i} with some words`).join("\n");
const view = {
  name: "r", color: "#888", member: { name: "r", partyId: "p1", status: "idle", runtime: "claude-code", role: "" },
  status: "idle", unread: 0, pendingApproval: false, busy: false, model: "sonnet", effort: "medium", permissionMode: "default",
  transcript: [
    { id: "u1", kind: "user", text: longMessage, at: "10:00" },
    { id: "u2", kind: "user", text: "short hello", at: "10:01" },
    { id: "c1", kind: "channel", direction: "out", from: "", to: "peer", text: longMessage, at: "10:02" },
  ],
};
reactDom.createRoot(document.getElementById("root")).render(React.createElement(Transcript, { view, density: "wide", actions: {} }));
await new Promise((res) => setTimeout(res, 120));

console.log("\nMessage preview + expand:");
const userBubble = document.querySelector(".wb-user-bubble");
assert((userBubble?.textContent || "").includes("paragraph 0"), "long user message preview shows the start");
assert(!(userBubble?.textContent || "").includes("paragraph 39"), "long user message preview clips the tail");
assert((userBubble?.textContent || "").includes("…"), "clipped user message shows an ellipsis");

const expandButtons = [...document.querySelectorAll(".wb-expand-inline")];
assert(expandButtons.length === 2, "both long messages (user + channel) have a '전체 보기' control");

// The short message has no expand control and is shown in full.
const bubbles = [...document.querySelectorAll(".wb-user-bubble")];
assert((bubbles[1]?.textContent || "").includes("short hello") && !bubbles[1]?.querySelector(".wb-expand-inline"), "short message shows in full, no expand control");

console.log("\nFull-view popup:");
assert(!document.querySelector(".wb-tool-modal"), "no popup before clicking expand");
expandButtons[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await new Promise((res) => setTimeout(res, 40));
const modal = document.querySelector(".wb-tool-modal");
assert(Boolean(modal), "clicking '전체 보기' opens the popup");
assert((modal?.textContent || "").includes("paragraph 39"), "popup shows the FULL message (including the clipped tail)");
// [#16] INVERTED ON PURPOSE. This used to require the popup to close on a
// backdrop click — the defect, recorded as if it were the intent. The app's rule
// is that a modal closes by its own control, never by a stray click outside:
// selecting text in a long message routinely ends with the pointer outside.
document.querySelector(".wb-tool-modal-backdrop")?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await new Promise((res) => setTimeout(res, 40));
assert(Boolean(document.querySelector(".wb-tool-modal")), "popup survives a backdrop click (does NOT close on outside click)");
document.querySelector(".wb-tool-modal-head .wb-icon-btn")?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await new Promise((res) => setTimeout(res, 40));
assert(!document.querySelector(".wb-tool-modal"), "popup closes on its own 닫기 button");

console.log(failures.length ? `\nMESSAGE PREVIEW FAILED (${failures.length})` : "\nMESSAGE PREVIEW PASSED");
process.exit(failures.length ? 1 : 0);
