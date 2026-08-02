/*
 * Renderer regression for markdown rendering of model output. Mounts the real
 * Transcript with an assistant block containing GitHub-flavored markdown
 * (heading, bold, list, inline + fenced code/JSON, table, link) and asserts the
 * DOM renders proper elements — not raw markdown source. Also checks that a
 * fenced code block and inline code get the wrapping-friendly classes (the
 * debug/code horizontal-scroll fix is CSS-only; visual wrapping is covered by
 * the e2e capture).
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
const bundlePath = path.join(outDir, "transcript-md.mjs"); writeFileSync(bundlePath, r.outputFiles[0].text);
const { Transcript } = await import(pathToFileURL(bundlePath).href);
const React = await import("react");
const reactDom = await import("react-dom/client");

const md = [
  "## 리뷰 결과",
  "",
  "**중요**: 토큰 만료 처리에 이슈가 있습니다.",
  "",
  "- 첫째 항목",
  "- 둘째 항목 `inlineCode`",
  "",
  "```json",
  '{ "ok": true, "issues": 1 }',
  "```",
  "",
  "| 파일 | 라인 |",
  "| --- | --- |",
  "| auth.ts | 42 |",
  "",
  "[링크](https://example.com)",
].join("\n");

const view = {
  name: "reviewer", color: "#888", member: { name: "reviewer", partyId: "p1", status: "idle", runtime: "claude-code", role: "QA" },
  status: "idle", unread: 0, pendingApproval: false, busy: false, model: "sonnet", effort: "medium", permissionMode: "default",
  transcript: [
    { id: "a1", kind: "assistant", text: md, at: "10:00" },
    { id: "s1", kind: "status", text: "stderr: " + "x".repeat(400), at: "10:01" },
  ],
};
reactDom.createRoot(document.getElementById("root")).render(React.createElement(Transcript, { view, density: "wide", actions: {} }));
await new Promise((res) => setTimeout(res, 120));

console.log("\nMarkdown rendering:");
const body = document.querySelector(".wb-assistant-body");
const mdRoot = body?.querySelector(".wb-md");
assert(Boolean(mdRoot), "assistant body renders a markdown container");
assert(body?.querySelector("h2")?.textContent?.includes("리뷰 결과"), "## heading -> <h2>");
assert(body?.querySelector("strong")?.textContent === "중요", "**bold** -> <strong>");
const lis = body ? [...body.querySelectorAll("ul > li")] : [];
assert(lis.length === 2, "- list -> two <li>");
assert(Boolean(body?.querySelector("li .wb-md-code-inline")), "inline `code` -> chip class");
const pre = body?.querySelector("pre code");
assert(Boolean(pre) && /"ok": true/.test(pre?.textContent || ""), "fenced ```json -> <pre><code> with the JSON");
assert(/language-json/.test(pre?.className || ""), "code block carries its language class");
const table = body?.querySelector("table");
assert(Boolean(table), "GFM table -> <table>");
assert([...(table?.querySelectorAll("th") || [])].some((th) => th.textContent === "파일"), "table header rendered");
assert([...(table?.querySelectorAll("td") || [])].some((td) => td.textContent === "auth.ts"), "table cell rendered");
const link = body?.querySelector("a");
assert(link?.getAttribute("href") === "https://example.com" && link?.getAttribute("target") === "_blank" && link?.getAttribute("rel") === "noreferrer", "link opens externally (target=_blank, rel=noreferrer)");

console.log("\nLinks open in the OS browser (P-3.5):");
const opened = [];
window.agentParty = { openExternal: (url) => { opened.push(url); return Promise.resolve({ ok: true }); } };
globalThis.window.agentParty = window.agentParty;
const clickEvent = new window.MouseEvent("click", { bubbles: true, cancelable: true });
link?.dispatchEvent(clickEvent);
await new Promise((res) => setTimeout(res, 20));
assert(opened[0] === "https://example.com", "clicking a link hands the URL to shell.openExternal");
assert(clickEvent.defaultPrevented, "the in-app navigation is prevented (no Electron window navigation)");
const linkCopy = body?.querySelector(".wb-md-link .wb-copy-btn");
assert(Boolean(linkCopy), "a copy control sits next to the link");
const copied = [];
Object.defineProperty(window.navigator, "clipboard", { value: { writeText: (t) => { copied.push(t); return Promise.resolve(); } }, configurable: true });
def("navigator", window.navigator);
linkCopy?.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
await new Promise((res) => setTimeout(res, 20));
assert(copied[0] === "https://example.com", "the copy control writes the link target to the clipboard");

console.log("\nOne-click copy of code blocks and whole replies (P-3.3):");
const preCopy = body?.querySelector("pre .wb-copy-btn");
assert(Boolean(preCopy), "a fenced code block carries a copy control");
assert(body?.querySelectorAll(".wb-md > pre").length === 1, "the control lives INSIDE the <pre> (no wrapper element around the block)");
copied.length = 0;
preCopy?.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
await new Promise((res) => setTimeout(res, 20));
assert(copied[0] === '{ "ok": true, "issues": 1 }\n', "copying a code block yields exactly the block's code");
const replyCopy = document.querySelector(".wb-assistant-head .wb-copy-btn");
assert(Boolean(replyCopy), "the assistant reply carries a whole-reply copy control");
copied.length = 0;
replyCopy?.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
await new Promise((res) => setTimeout(res, 20));
assert(copied[0] === md, "copying a reply yields its markdown SOURCE (what you paste elsewhere)");

// A refused clipboard write must be shown, never swallowed as a fake success.
Object.defineProperty(window.navigator, "clipboard", { value: { writeText: () => Promise.reject(new Error("denied")) }, configurable: true });
replyCopy?.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
await new Promise((res) => setTimeout(res, 30));
assert(replyCopy?.getAttribute("data-copy-state") === "failed", "a refused clipboard write paints the failure state (no silent fake success)");

// No raw markdown source should leak into the rendered text.
const text = body?.textContent || "";
assert(!text.includes("##") && !text.includes("**") && !text.includes("```"), "raw markdown tokens (##, **, ```) are not shown literally");

console.log("\nDebug message wrapping (structure):");
const status = document.querySelector(".wb-status .wb-mono");
assert(Boolean(status) && (status.textContent || "").length > 300, "long debug/stderr line is rendered in a wb-mono span (CSS wraps it)");

console.log(failures.length ? `\nMARKDOWN RENDER FAILED (${failures.length})` : "\nMARKDOWN RENDER PASSED");
process.exit(failures.length ? 1 : 0);
