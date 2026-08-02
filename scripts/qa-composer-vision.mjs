/*
 * Composer image-attachment gating (jsdom). Locks the user-visible contract:
 *  - A vision model: dropping an image adds a thumbnail and submit forwards the
 *    attachment to actions.sendMessage(name, text, [image]).
 *  - A text-only model: the same drop is REFUSED with a visible reason (no silent
 *    drop) and no attachment is sent.
 *  - The composer placeholder advertises image attach only when supported.
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
def("FileReader", window.FileReader); def("File", window.File); def("Blob", window.Blob);
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }; globalThis.ResizeObserver = window.ResizeObserver;



const outDir = qaTempDir();
const r = await build({ entryPoints: [path.join(projectRoot, "src/renderer/workbench/Composer.tsx")], bundle: true, format: "esm", platform: "browser", jsx: "automatic", loader: { ".css": "empty" }, define: { "process.env.NODE_ENV": '"development"' }, external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"], write: false });
const bundlePath = path.join(outDir, "composer-vision.mjs"); writeFileSync(bundlePath, r.outputFiles[0].text);
const { Composer } = await import(pathToFileURL(bundlePath).href);
const React = await import("react");
const reactDom = await import("react-dom/client");

function mkView(vision) {
  return {
    name: "main", color: "#888",
    member: { name: "main", runtime: "claude-code", role: "" },
    session: undefined, status: "idle", transcript: [], unread: 0,
    pendingApproval: false, busy: false, model: vision?.image === false ? "GLM-5.2" : "Sonnet",
    effort: "medium", permissionMode: "default", vision,
  };
}

const sent = [];
const actions = {
  sendMessage: (name, text, attachments) => sent.push({ name, text, attachments }),
  prewarm() {}, approve() {}, answerQuestion() {}, interrupt() {}, restart() {}, compact() {},
  applyRuntime() {}, setEffort() {}, setThinking() {}, setPermissionMode() {}, setCodexPolicy() {},
};

const tick = (ms = 40) => new Promise((res) => setTimeout(res, ms));
function render(view) {
  const root = reactDom.createRoot(document.getElementById("root"));
  root.render(React.createElement(Composer, { view, density: "wide", actions }));
  return root;
}
function pngFile() {
  // 1x1 PNG bytes.
  const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new window.File([bytes], "shot.png", { type: "image/png" });
}
function dropImage(form, file) {
  const ev = new window.Event("drop", { bubbles: true });
  Object.defineProperty(ev, "dataTransfer", { value: { files: file ? [file] : [], items: file ? [{ kind: "file" }] : [] } });
  Object.defineProperty(ev, "preventDefault", { value: () => {} });
  form.dispatchEvent(ev);
}

// --- Vision model: drop adds a thumbnail; submit forwards the attachment -------
console.log("\nvision model (Sonnet):");
def("atob", (s) => Buffer.from(s, "base64").toString("binary"));
let root = render(mkView({ image: true, maxImages: 20, maxBytesPerImage: 5242880 }));
await tick();
let form = document.querySelector("form.wb-composer");
assert(/붙여넣기|끌어놓기/.test(document.querySelector(".wb-composer-textarea")?.getAttribute("placeholder") || ""), "placeholder advertises image attach on a vision model");
dropImage(form, pngFile());
await tick(120);
assert(document.querySelectorAll(".wb-attachment img").length === 1, "dropping an image adds one thumbnail");
// Type text and submit.
const textarea = document.querySelector(".wb-composer-textarea");
const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
setter.call(textarea, "look at this");
textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
await tick();
form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
await tick();
assert(sent.length === 1 && sent[0].attachments?.length === 1, "submit forwards the image attachment to sendMessage");
assert(sent[0].attachments[0].mediaType === "image/png" && sent[0].attachments[0].dataBase64.length > 0, "the forwarded attachment carries mediaType + base64 data");
assert(document.querySelectorAll(".wb-attachment img").length === 0, "attachments clear after send");
root.unmount();

// --- Text-only model: drop is refused with a reason, nothing sent -------------
console.log("\ntext-only model (GLM-5.2):");
sent.length = 0;
root = render(mkView({ image: false }));
await tick();
form = document.querySelector("form.wb-composer");
assert(Boolean(document.querySelector(".wb-attach-hint")), "a text-only model shows a persistent 'not supported' hint");
dropImage(form, pngFile());
await tick(120);
assert(document.querySelectorAll(".wb-attachment img").length === 0, "dropping an image on a text-only model adds NO thumbnail");
assert(/지원하지 않습니다|비전/.test(document.querySelector(".wb-attach-hint.is-error, .wb-attach-hint")?.textContent || ""), "the refusal reason is visible (no silent drop)");
root.unmount();

console.log(failures.length ? `\nCOMPOSER VISION FAILED (${failures.length})` : "\nCOMPOSER VISION PASSED");
process.exit(failures.length ? 1 : 0);
