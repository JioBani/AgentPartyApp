/*
 * Copy an attached image to the clipboard ([P-3]9, jsdom). The thumbnail strip
 * had exactly one control — remove — so an image dropped or pasted into the
 * composer could not be reused anywhere else.
 *
 * Locks the renderer half of the contract:
 *  - each thumbnail carries a copy control alongside the remove control,
 *  - clicking it hands the SAME bytes to the bridge (mediaType + base64), and
 *    per-thumbnail, so copying the 2nd image copies the 2nd image,
 *  - it confirms visibly, and the confirmation is transient,
 *  - a FAILED copy is reported on screen — a copy that silently did nothing is
 *    the worst outcome, since the user pastes stale clipboard content and
 *    blames the app they pasted into.
 *
 * The bridge itself (`clipboard.writeImage` in the main process) is mocked here;
 * the real route is asserted end-to-end through POST /api/clipboard/image in
 * scripts/e2e-composer-input.mjs.
 */
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

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

// The preload bridge, mocked. `failNext` makes the next copy reject, so the
// error path is exercised rather than assumed.
const copies = [];
let failNext = false;
window.agentParty = {
  copyImageToClipboard: async (image) => {
    if (failNext) { failNext = false; throw new Error("클립보드를 사용할 수 없습니다"); }
    copies.push(image);
    return { ok: true, width: 1, height: 1, bytes: 70 };
  },
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
const bundlePath = path.join(outDir, "composer-copy-image.mjs"); writeFileSync(bundlePath, r.outputFiles[0].text);
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
const root = reactDom.createRoot(container);
root.render(React.createElement(Harness));
await tick(150);

// 1x1 PNG and a 1x1 GIF, so "which thumbnail did I copy" is decidable.
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const GIF_B64 = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
function imageFile(name, type, b64) {
  return new window.File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], name, { type });
}
function drop(form, files) {
  const ev = new window.Event("drop", { bubbles: true });
  Object.defineProperty(ev, "dataTransfer", { value: { files, items: files.map(() => ({ kind: "file" })) } });
  Object.defineProperty(ev, "preventDefault", { value: () => {} });
  form.dispatchEvent(ev);
}
const copyButtons = () => Array.from(document.querySelectorAll(".wb-attachment-copy"));
const hint = () => document.querySelector(".wb-attach-hint")?.textContent || "";

console.log("copy an attached image ([P-3]9)");

const form = document.querySelector("form.wb-composer");
drop(form, [imageFile("a.png", "image/png", PNG_B64), imageFile("b.gif", "image/gif", GIF_B64)]);
await tick(250);
assert(document.querySelectorAll(".wb-attachment img").length === 2, "이미지 2장이 첨부됐다");
assert(copyButtons().length === 2, "썸네일마다 복사 버튼이 있다 (기존에는 제거 버튼뿐)");
assert(document.querySelectorAll(".wb-attachment-x").length === 2, "…제거 버튼도 그대로 있다");

// Copy the SECOND thumbnail — a per-index control has to copy that index.
copyButtons()[1].click();
await tick(200);
assert(copies.length === 1, "복사 버튼이 브리지를 호출한다");
assert(copies[0]?.mediaType === "image/gif" && copies[0]?.dataBase64 === GIF_B64, `2번째 썸네일을 누르면 2번째 이미지가 복사된다 (${copies[0]?.mediaType})`);
assert(copyButtons()[1].getAttribute("title") === "복사됨", "복사 후 시각적으로 확인해준다");
await tick(1600);
assert(copyButtons()[1].getAttribute("title") === "클립보드로 복사", "확인 표시는 잠시 뒤 사라진다");

// The first thumbnail still copies the first image.
copyButtons()[0].click();
await tick(200);
assert(copies[1]?.mediaType === "image/png" && copies[1]?.dataBase64 === PNG_B64, "1번째 썸네일은 1번째 이미지를 복사한다");

// A failing copy must SAY so — never a silent no-op.
failNext = true;
copyButtons()[0].click();
await tick(250);
assert(/복사하지 못했습니다/.test(hint()) && /클립보드를 사용할 수 없습니다/.test(hint()), `복사 실패가 이유와 함께 화면에 뜬다: "${hint()}"`);

root.unmount();
console.log(failures.length ? `\nCOMPOSER COPY IMAGE FAILED (${failures.length})` : "\nCOMPOSER COPY IMAGE PASSED");
process.exit(failures.length ? 1 : 0);
