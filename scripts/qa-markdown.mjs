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
import { writeFileSync, readFileSync } from "node:fs";
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
  "",
  "[Windows URL 경로](/C:/Project/AgentPartyApp/docs/발표/demo.html)",
  "",
  "[Windows 드라이브 경로](C:/Project/AgentPartyApp/docs/발표/demo.html)",
  "",
  "[Windows encoded backslash path](<C:\\Project\\AgentPartyApp\\docs\\demo.html>)",
  "",
  "[Windows bracket folder](<C:\\Project\\novel\\[4060182] title\\file.pdf>)",
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
const link = body?.querySelector('a[href="https://example.com"]');
assert(link?.getAttribute("href") === "https://example.com" && link?.getAttribute("target") === "_blank" && link?.getAttribute("rel") === "noreferrer", "link opens externally (target=_blank, rel=noreferrer)");

console.log("\nLinks open in the OS browser (P-3.5):");
const opened = [];
const openedPaths = [];
const revealed = [];
window.agentParty = {
  openExternal: (url) => { opened.push(url); return Promise.resolve({ ok: true }); },
  openPath: (file) => { openedPaths.push(file); return Promise.resolve({ ok: true, action: "opened", path: file }); },
  revealPath: (file) => { revealed.push(file); return Promise.resolve({ ok: true }); },
};
globalThis.window.agentParty = window.agentParty;
const clickEvent = new window.MouseEvent("click", { bubbles: true, cancelable: true });
link?.dispatchEvent(clickEvent);
await new Promise((res) => setTimeout(res, 20));
assert(opened[0] === "https://example.com", "clicking a link hands the URL to shell.openExternal");
assert(clickEvent.defaultPrevented, "the in-app navigation is prevented (no Electron window navigation)");
const windowsUrlLink = body?.querySelector('a[href="/C:/Project/AgentPartyApp/docs/%EB%B0%9C%ED%91%9C/demo.html"], a[href="/C:/Project/AgentPartyApp/docs/발표/demo.html"]');
const windowsDriveLink = [...(body?.querySelectorAll("a") || [])].find((anchor) => anchor.textContent === "Windows 드라이브 경로");
const encodedBackslashLink = [...(body?.querySelectorAll("a") || [])].find((anchor) => anchor.textContent === "Windows encoded backslash path");
const bracketFolderLink = [...(body?.querySelectorAll("a") || [])].find((anchor) => anchor.textContent === "Windows bracket folder");
windowsUrlLink?.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
windowsDriveLink?.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
encodedBackslashLink?.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
bracketFolderLink?.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
await new Promise((res) => setTimeout(res, 20));
assert(openedPaths.some((value) => /^\/C:\/Project/.test(value)), "URL-shaped /C:/ markdown link is handed to the local-file controller");
assert(openedPaths.some((value) => /^C:\/Project/i.test(value)), `bare C:/ markdown link is not mistaken for a foreign URI scheme (href=${windowsDriveLink?.getAttribute("href")}, opened=${openedPaths.join(" | ")})`);
assert(openedPaths.some((value) => /^C:%5CProject/i.test(value)), `encoded-backslash drive link is handed to the local-file controller (href=${encodedBackslashLink?.getAttribute("href")}, opened=${openedPaths.join(" | ")})`);
assert(openedPaths.some((value) => /^C:\/Project\/novel\/%5B4060182%5D%20title\/file\.pdf$/i.test(value)), `a separator before a bracketed folder survives markdown parsing (href=${bracketFolderLink?.getAttribute("href")}, opened=${openedPaths.join(" | ")})`);
const driveReveal = windowsDriveLink?.closest(".wb-md-link")?.querySelector(".wb-md-link-reveal");
assert(Boolean(driveReveal), "a local-file link carries a reveal control");
assert(Boolean(encodedBackslashLink?.closest(".wb-md-link")?.querySelector(".wb-md-link-reveal")), "an encoded-backslash drive link carries a reveal control");
assert(Boolean(bracketFolderLink?.closest(".wb-md-link")?.querySelector(".wb-md-link-reveal")), "a bracketed-folder drive link carries a reveal control");
driveReveal?.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
await new Promise((res) => setTimeout(res, 20));
assert(revealed.some((value) => /^C:\/Project/i.test(value)), "the reveal control hands the file path to revealPath");
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

console.log("\nMixed Korean/URL/English channel body:");
const MIXED = [
  "v0.2.7 배포 완료. 공개 릴리스",
  "https://github.com/JioBani/AgentParty-releases/releases/tag/v0.2.7, source annotated tag v0.2.7→4ab7bf0.",
  "설치본/포터블/blockmap/latest.yml 언급은 완료. 익명 다운로드 4개 모두 HTTP 200, latest.yml 0.2.7 및 한글 릴리스 노트 정상 확인.",
].join("\n");
const MIXED_HREF = "https://github.com/JioBani/AgentParty-releases/releases/tag/v0.2.7";
const mixedHost = document.createElement("div");
document.body.appendChild(mixedHost);
reactDom.createRoot(mixedHost).render(React.createElement(Transcript, {
  view: {
    ...view,
    transcript: [{ id: "ch-mixed", kind: "channel", direction: "in", from: "alice", to: "bob", text: MIXED, at: "10:02" }],
  },
  density: "wide",
  actions: {},
}));
await new Promise((res) => setTimeout(res, 80));
const bubble = mixedHost.querySelector(".wb-channel-bubble");
const bubbleText = bubble?.textContent || "";
assert(Boolean(bubble), "channel card renders a bubble");
assert(bubbleText.includes("v0.2.7 배포 완료"), "Korean prefix is visible");
assert(bubbleText.includes(MIXED_HREF), "full autolinked URL text is visible (no truncation)");
assert(bubbleText.includes(", source annotated tag v0.2.7"), "comma and English after the URL are visible");
assert(bubbleText.includes("한글 릴리스 노트 정상 확인"), "trailing Korean sentence is visible");
const mixedLink = bubble?.querySelector(`a[href="${MIXED_HREF}"]`);
const mixedWrap = mixedLink?.closest(".wb-md-link");
assert(Boolean(mixedLink), "bare URL autolinks to the exact href (comma stays outside the anchor)");
assert(Boolean(mixedWrap), "autolink sits in the .wb-md-link wrapper");
assert(Boolean(mixedWrap?.querySelector(".wb-copy-btn")), "copy control remains next to the autolink");
opened.length = 0;
mixedLink?.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
await new Promise((res) => setTimeout(res, 20));
assert(opened[0] === MIXED_HREF, "clicking the autolink hands the exact href to openExternal");
Object.defineProperty(window.navigator, "clipboard", { value: { writeText: (t) => { copied.push(t); return Promise.resolve(); } }, configurable: true });
copied.length = 0;
mixedWrap?.querySelector(".wb-copy-btn")?.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
await new Promise((res) => setTimeout(res, 20));
assert(copied[0] === MIXED_HREF, "copy control writes the exact href, not the surrounding sentence");

console.log("\nWSL / POSIX / file: local-file hrefs survive sanitisation:");
const wslMd = [
  "[mnt](/mnt/c/Users/Public/a.txt)",
  "",
  "[home](/home/me/a.md)",
  "",
  "[file-home](file:///home/me/a.md)",
  "",
  "[file-wsl](file://wsl.localhost/Ubuntu-22.04/home/me/a.md)",
  "",
  "[web](https://example.com/wsl-href)",
  "",
  "[mail](mailto:someone@example.com)",
].join("\n");
const wslHost = document.createElement("div");
document.body.appendChild(wslHost);
reactDom.createRoot(wslHost).render(React.createElement(Transcript, {
  view: {
    ...view,
    transcript: [{ id: "a-wsl", kind: "assistant", text: wslMd, at: "10:03" }],
  },
  density: "wide",
  actions: {},
}));
await new Promise((res) => setTimeout(res, 80));
const wslBody = wslHost.querySelector(".wb-assistant-body");
const hrefOf = (label) => [...(wslBody?.querySelectorAll("a") || [])].find((a) => a.textContent === label)?.getAttribute("href") || "";
assert(hrefOf("mnt") === "/mnt/c/Users/Public/a.txt", "POSIX /mnt href is not stripped");
assert(hrefOf("home") === "/home/me/a.md", "POSIX /home href is not stripped");
assert(hrefOf("file-home") === "file:///home/me/a.md", "file:///home href is not stripped");
assert(hrefOf("file-wsl") === "file://wsl.localhost/Ubuntu-22.04/home/me/a.md", "file://wsl.localhost href is not stripped");
assert(hrefOf("web") === "https://example.com/wsl-href", "http href is unchanged");
assert(hrefOf("mail") === "mailto:someone@example.com", "mailto href is unchanged");
openedPaths.length = 0;
revealed.length = 0;
opened.length = 0;
const clickLabel = (label) => {
  const anchor = [...(wslBody?.querySelectorAll("a") || [])].find((a) => a.textContent === label);
  anchor?.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  return anchor;
};
clickLabel("mnt");
clickLabel("home");
clickLabel("file-home");
clickLabel("file-wsl");
const webAnchor = clickLabel("web");
clickLabel("mail");
await new Promise((res) => setTimeout(res, 20));
assert(openedPaths.filter((p) => p === "/mnt/c/Users/Public/a.txt").length === 1, "/mnt click hands the href to openPath once");
assert(openedPaths.filter((p) => p === "/home/me/a.md").length === 1, "/home click hands the href to openPath once");
assert(openedPaths.filter((p) => p === "file:///home/me/a.md").length === 1, "file:///home click hands the href to openPath once");
assert(openedPaths.filter((p) => p === "file://wsl.localhost/Ubuntu-22.04/home/me/a.md").length === 1, "file://wsl.localhost click hands the href to openPath once");
assert(openedPaths.length === 4, `only the four local-file links call openPath (${openedPaths.join(" | ")})`);
assert(opened.includes("https://example.com/wsl-href"), "http still goes to openExternal");
assert(!opened.some((u) => /^file:/i.test(u)), "file: is not handed to openExternal");
const homeReveal = [...(wslBody?.querySelectorAll("a") || [])].find((a) => a.textContent === "home")?.closest(".wb-md-link")?.querySelector(".wb-md-link-reveal");
assert(Boolean(homeReveal), "/home link carries a reveal control");
assert(!webAnchor?.closest(".wb-md-link")?.querySelector(".wb-md-link-reveal"), "http link has no reveal control");
homeReveal?.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
const fileHomeReveal = [...(wslBody?.querySelectorAll("a") || [])].find((a) => a.textContent === "file-home")?.closest(".wb-md-link")?.querySelector(".wb-md-link-reveal");
assert(Boolean(fileHomeReveal), "file:///home link carries a reveal control");
fileHomeReveal?.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
await new Promise((res) => setTimeout(res, 20));
assert(revealed.filter((p) => p === "/home/me/a.md").length === 1, "reveal control hands /home to revealPath once");
assert(revealed.filter((p) => p === "file:///home/me/a.md").length === 1, "reveal control hands file:///home to revealPath once");

console.log("\nCSS: long-link wrapper is not nowrap:");
const css = readFileSync(path.join(projectRoot, "src/renderer/styles.css"), "utf8");
assert(!/\.wb-md-link\s*\{[^}]*white-space\s*:\s*nowrap/.test(css), ".wb-md-link does not set white-space:nowrap");

console.log(failures.length ? `\nMARKDOWN RENDER FAILED (${failures.length})` : "\nMARKDOWN RENDER PASSED");
process.exit(failures.length ? 1 : 0);
