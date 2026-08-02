/*
 * Non-image file drop ([P-3]10, jsdom). Dropping a non-image on the composer
 * used to do nothing at all: `onDrop` only reacted when at least one file was an
 * image, so a dropped .ts/.log/folder was swallowed with no attachment, no text
 * and no message.
 *
 * Locks the contract:
 *  - a non-image drop inserts its PATH into the draft (a member reads files
 *    itself, so a path is what it can act on),
 *  - a path containing spaces is quoted so two dropped paths stay separable,
 *  - an existing draft is appended to, not replaced,
 *  - images keep the old attach behaviour, and a MIXED drop does both,
 *  - a file whose path cannot be resolved is REPORTED, never silently skipped.
 *
 * The path itself comes from `window.agentParty.pathForFile` (webUtils in the
 * preload — Electron 32 removed `File.path`), which is MOCKED here.
 *
 * Known verification gap, stated rather than papered over: no tier can assert
 * the real bridge returns a real path. An OS drag-and-drop cannot be
 * synthesized over the automation API (`sendInputEvent` has no drag events), and
 * a File constructed inside the page has no path on disk, so `getPathForFile`
 * would legitimately return nothing for it. What IS covered end-to-end is that
 * the preload still loads with the `webUtils` import — a broken one takes
 * `window.agentParty` down with it, which scripts/e2e-composer-input.mjs would
 * fail on immediately.
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

const dom = new JSDOM('<!doctype html><html><body><div id=root></div></body></html>', { url: "http://localhost/", pretendToBeVisual: true });
const { window } = dom;
const def = (n, v) => { try { Object.defineProperty(globalThis, n, { value: v, configurable: true, writable: true }); } catch {} };
def("window", window); def("document", window.document); def("HTMLElement", window.HTMLElement);
def("getComputedStyle", window.getComputedStyle.bind(window));
def("requestAnimationFrame", (cb) => setTimeout(() => cb(Date.now()), 0)); def("cancelAnimationFrame", clearTimeout);
def("FileReader", window.FileReader); def("File", window.File); def("Blob", window.Blob);
def("atob", (s) => Buffer.from(s, "base64").toString("binary"));
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }; globalThis.ResizeObserver = window.ResizeObserver;

// The preload bridge, mocked: a file is resolvable iff we gave it a path.
const pathByName = new Map();
window.agentParty = { pathForFile: (file) => {
  const resolved = pathByName.get(file.name);
  if (!resolved) throw new Error("no path on disk");
  return resolved;
} };



const outDir = qaTempDir();
const r = await build({
  stdin: {
    contents: [
      'export { Composer } from "./src/renderer/workbench/Composer";',
      'export { usePublishComposerPrefs } from "./src/renderer/app/composerPrefs";',
    ].join("\n"),
    resolveDir: projectRoot,
    loader: "ts",
  },
  bundle: true, format: "esm", platform: "browser", jsx: "automatic", loader: { ".css": "empty" },
  define: { "process.env.NODE_ENV": '"development"' },
  external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"], write: false,
});
const bundlePath = path.join(outDir, "composer-drop-path.mjs"); writeFileSync(bundlePath, r.outputFiles[0].text);
const { Composer, usePublishComposerPrefs } = await import(pathToFileURL(bundlePath).href);
const React = await import("react");
const reactDom = await import("react-dom/client");

const sent = [];
const actions = {
  sendMessage: (name, text, attachments) => sent.push({ name, text, attachments }),
  prewarm() {}, approve() {}, answerQuestion() {}, interrupt() {}, restart() {}, compact() {},
  applyRuntime() {}, setEffort() {}, setThinking() {}, setPermissionMode() {}, setCodexPolicy() {},
  forceStop() {}, setCursorPolicy() {},
};
const mkView = (vision) => ({
  name: "main", color: "#888",
  member: { name: "main", runtime: "claude-code", role: "" },
  session: undefined, status: "idle", transcript: [], unread: 0,
  pendingApproval: false, busy: false, model: vision?.image === false ? "GLM-5.2" : "Sonnet",
  effort: "medium", permissionMode: "default", vision,
});

const tick = (ms = 60) => new Promise((res) => setTimeout(res, ms));

function Harness({ vision }) {
  usePublishComposerPrefs({ sendKey: "ctrl-enter", interruptOnSend: false });
  return React.createElement(Composer, { view: mkView(vision), density: "wide", actions });
}

let root;
async function mount(vision = { image: true, maxImages: 20, maxBytesPerImage: 5242880 }) {
  const host = document.getElementById("root");
  host.innerHTML = "";
  const container = document.createElement("div");
  host.appendChild(container);
  root = reactDom.createRoot(container);
  root.render(React.createElement(Harness, { vision }));
  await tick(120);
  return document.querySelector("form.wb-composer");
}

/** A non-image File whose resolvable path we register up front (or not). */
function file(name, type, resolvedPath) {
  if (resolvedPath) pathByName.set(name, resolvedPath);
  return new window.File([new Uint8Array([1, 2, 3])], name, { type });
}
function pngFile(name = "shot.png", resolvedPath) {
  if (resolvedPath) pathByName.set(name, resolvedPath);
  const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  return new window.File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], name, { type: "image/png" });
}
function drop(form, files) {
  const ev = new window.Event("drop", { bubbles: true });
  Object.defineProperty(ev, "dataTransfer", { value: { files, items: files.map(() => ({ kind: "file" })) } });
  Object.defineProperty(ev, "preventDefault", { value: () => {} });
  form.dispatchEvent(ev);
}
const draft = () => document.querySelector(".wb-composer-textarea")?.value ?? "";
const hint = () => document.querySelector(".wb-attach-hint")?.textContent || "";

console.log("non-image drop inserts a path ([P-3]10)");

// 1) A plain source file: its path lands in the draft, nothing is attached.
let form = await mount();
drop(form, [file("refresh.ts", "video/mp2t", "C:\\repo\\src\\auth\\refresh.ts")]);
await tick(150);
assert(draft() === "C:\\repo\\src\\auth\\refresh.ts", `비이미지 드롭이 경로를 입력창에 넣는다 (draft=${JSON.stringify(draft())})`);
assert(document.querySelectorAll(".wb-attachment img").length === 0, "…첨부는 만들지 않는다");
root.unmount();

// 2) A path with spaces is quoted, and an existing draft is appended to.
form = await mount();
const textarea = document.querySelector(".wb-composer-textarea");
const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
setter.call(textarea, "이 파일 봐줘");
textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
await tick();
drop(form, [file("notes.md", "text/markdown", "C:\\my docs\\notes.md")]);
await tick(150);
assert(draft() === '이 파일 봐줘 "C:\\my docs\\notes.md"', `공백이 있는 경로는 따옴표로 감싸고 기존 입력 뒤에 붙인다 (draft=${JSON.stringify(draft())})`);
root.unmount();

// 3) Mixed drop: the image attaches, the other file's path is inserted.
form = await mount();
drop(form, [pngFile("shot.png"), file("server.log", "text/plain", "C:\\logs\\server.log")]);
await tick(200);
assert(document.querySelectorAll(".wb-attachment img").length === 1, "이미지+파일 혼합 드롭: 이미지는 기존대로 첨부된다");
assert(draft() === "C:\\logs\\server.log", `…그리고 비이미지만 경로로 삽입된다 (draft=${JSON.stringify(draft())})`);
root.unmount();

// 4) An unresolvable file is REPORTED, not silently skipped.
form = await mount();
drop(form, [file("ghost.bin", "application/octet-stream")]);
await tick(150);
assert(draft() === "", "경로를 못 구하면 입력창은 그대로다");
assert(/ghost\.bin/.test(hint()) && /확인하지 못했/.test(hint()), `…대신 이유가 화면에 뜬다 (조용히 무시 금지): "${hint()}"`);
root.unmount();

// 5) A text-only model still takes a dropped PATH (only images are gated).
form = await mount({ image: false });
drop(form, [file("plan.md", "text/markdown", "C:\\repo\\plan.md")]);
await tick(150);
assert(draft() === "C:\\repo\\plan.md", `비전 미지원 모델에서도 경로 삽입은 동작한다 (draft=${JSON.stringify(draft())})`);
root.unmount();

console.log(failures.length ? `\nCOMPOSER DROP PATH FAILED (${failures.length})` : "\nCOMPOSER DROP PATH PASSED");
process.exit(failures.length ? 1 : 0);
