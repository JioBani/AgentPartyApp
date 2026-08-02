/*
 * Composer attachment strip no longer carries an image-copy control (R-18).
 *
 * [P-3]9 put copy on the not-yet-sent thumbnail — wrong target. R-18 moves
 * copy to the transcript. This script locks the REMOVAL so the mis-wired
 * button does not creep back while the transcript surface is covered by
 * scripts/qa-transcript-image.mjs.
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
def("FileReader", window.FileReader); def("File", window.File); def("Blob", window.Blob);
def("atob", (s) => Buffer.from(s, "base64").toString("binary"));
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }; globalThis.ResizeObserver = window.ResizeObserver;

window.agentParty = {
  copyImageToClipboard: async () => { throw new Error("composer must not call clipboard copy"); },
};

const outDir = path.join(projectRoot, "node_modules/.qa"); mkdirSync(outDir, { recursive: true });
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
const bundlePath = path.join(outDir, "composer-no-copy-image.mjs"); writeFileSync(bundlePath, r.outputFiles[0].text);
const { Composer, usePublishComposerPrefs } = await import(pathToFileURL(bundlePath).href);
const React = await import("react");
const reactDom = await import("react-dom/client");

const actions = {
  sendMessage() {}, prewarm() {}, approve() {}, answerQuestion() {}, interrupt() {}, restart() {}, compact() {},
  applyRuntime() {}, setEffort() {}, setThinking() {}, setPermissionMode() {}, setCodexPolicy() {},
  forceStop() {}, setCursorPolicy() {},
};
const view = {
  name: "main", color: "#888",
  member: { name: "main", runtime: "claude-code", role: "" },
  session: undefined, status: "idle", transcript: [], unread: 0,
  pendingApproval: false, busy: false, model: "Sonnet",
  effort: "medium", permissionMode: "default", vision: { image: true, maxImages: 20, maxBytesPerImage: 5242880 },
};

const tick = (ms = 80) => new Promise((res) => setTimeout(res, ms));

function Harness() {
  usePublishComposerPrefs({ sendKey: "ctrl-enter", interruptOnSend: false });
  return React.createElement(Composer, { view, density: "wide", actions });
}

const host = document.getElementById("root");
const container = document.createElement("div");
host.appendChild(container);
reactDom.createRoot(container).render(React.createElement(Harness));
await tick(150);

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
function imageFile(name, type, b64) {
  return new window.File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], name, { type });
}
function drop(form, files) {
  const ev = new window.Event("drop", { bubbles: true });
  Object.defineProperty(ev, "dataTransfer", { value: { files, items: files.map(() => ({ kind: "file" })) } });
  Object.defineProperty(ev, "preventDefault", { value: () => {} });
  form.dispatchEvent(ev);
}

console.log("composer attachment strip no longer copies (R-18)");

const form = document.querySelector("form.wb-composer");
drop(form, [imageFile("a.png", "image/png", PNG_B64)]);
await tick(250);
assert(document.querySelectorAll(".wb-attachment img").length === 1, "이미지가 첨부된다");
assert(document.querySelectorAll(".wb-attachment-x").length === 1, "제거 버튼은 남는다");
assert(document.querySelectorAll(".wb-attachment-copy").length === 0, "입력창 첨부에는 복사 버튼이 없다 (대화창으로 옮김)");

console.log(failures.length ? `\nCOMPOSER NO-COPY FAILED (${failures.length})` : "\nCOMPOSER NO-COPY PASSED");
process.exit(failures.length ? 1 : 0);
