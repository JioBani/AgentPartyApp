/*
 * Composer send key (jsdom). Locks two user-visible contracts:
 *
 *  [P-3]8 — the global `composer.sendKey` preference decides what Enter does.
 *    "ctrl-enter" (default) → Enter is a newline, Ctrl/Cmd+Enter sends.
 *    "enter"                → Enter sends, Shift+Enter is a newline.
 *
 *  [#15] — the SAME thing happens at every panel width. Narrow renders a
 *    single-line <input> inside the composer <form>, where the browser's default
 *    action for Enter is "submit the form". So whenever Enter must NOT send, the
 *    narrow input has to consume the key — otherwise merely narrowing the panel
 *    starts sending on Enter.
 *
 * jsdom does not implement a form's implicit submission, so the narrow case is
 * asserted through `defaultPrevented` — the exact thing that suppresses it —
 * plus "no message was sent". Real key input at a real window width is covered
 * by the full-process scripts/e2e-composer-send-key.mjs.
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
def("KeyboardEvent", window.KeyboardEvent);
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }; globalThis.ResizeObserver = window.ResizeObserver;



const outDir = qaTempDir();
// One bundle exporting BOTH the input and the publisher, so the test drives the
// same module instance of the preference channel that the Composer subscribes to.
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
const bundlePath = path.join(outDir, "composer-send-key.mjs"); writeFileSync(bundlePath, r.outputFiles[0].text);
const { Composer, usePublishComposerPrefs } = await import(pathToFileURL(bundlePath).href);
const React = await import("react");
const reactDom = await import("react-dom/client");

const view = {
  name: "main", color: "#888",
  member: { name: "main", runtime: "claude-code", role: "" },
  session: undefined, status: "idle", transcript: [], unread: 0,
  pendingApproval: false, busy: false, model: "Sonnet",
  effort: "medium", permissionMode: "default", vision: { image: true },
};

let sent = [];
const actions = {
  sendMessage: (name, text, attachments) => sent.push({ name, text, attachments }),
  prewarm() {}, approve() {}, answerQuestion() {}, interrupt() {}, restart() {}, compact() {},
  applyRuntime() {}, setEffort() {}, setThinking() {}, setPermissionMode() {}, setCodexPolicy() {},
  forceStop() {}, setCursorPolicy() {},
};

const tick = (ms = 40) => new Promise((res) => setTimeout(res, ms));

/** Renders the composer with `sendKey` published through the preference channel. */
function Harness({ sendKey, density }) {
  usePublishComposerPrefs({ sendKey });
  return React.createElement(Composer, { view, density, actions });
}

async function mount({ sendKey, density }) {
  sent = [];
  const container = document.getElementById("root");
  const root = reactDom.createRoot(container);
  root.render(React.createElement(Harness, { sendKey, density }));
  await tick();
  const field = container.querySelector(density === "narrow" ? "input.wb-composer-input" : "textarea.wb-composer-textarea");
  if (!field) throw new Error(`composer field not found for density=${density}`);
  // Type a draft so a send is possible at all.
  const setter = Object.getOwnPropertyDescriptor(
    density === "narrow" ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype,
    "value",
  ).set;
  setter.call(field, "hello");
  field.dispatchEvent(new window.Event("input", { bubbles: true }));
  await tick();
  return { root, field };
}

/** Dispatches Enter with the given modifiers; returns whether the key was consumed. */
function pressEnter(field, modifiers = {}) {
  const event = new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...modifiers });
  field.dispatchEvent(event);
  return event.defaultPrevented;
}

const cases = [
  // sendKey, density, modifiers, expectSent, expectConsumed, label
  ["ctrl-enter", "wide", {}, false, false, "기본값: Enter 는 전송하지 않는다 (줄바꿈)"],
  ["ctrl-enter", "wide", { ctrlKey: true }, true, true, "기본값: Ctrl+Enter 는 전송한다"],
  ["ctrl-enter", "wide", { metaKey: true }, true, true, "기본값: Cmd+Enter 도 전송한다"],
  ["ctrl-enter", "narrow", { ctrlKey: true }, true, true, "기본값: 좁은 폭에서도 Ctrl+Enter 는 전송한다"],
  ["ctrl-enter", "narrow", {}, false, true, "[#15] 기본값: 좁은 폭의 Enter 도 전송하지 않는다 (폼 기본 submit 차단)"],
  ["enter", "wide", {}, true, true, "enter 설정: Enter 는 전송한다"],
  ["enter", "wide", { shiftKey: true }, false, false, "enter 설정: Shift+Enter 는 전송하지 않는다 (줄바꿈)"],
  ["enter", "narrow", {}, true, true, "enter 설정: 좁은 폭에서도 Enter 는 전송한다"],
  ["enter", "narrow", { shiftKey: true }, false, true, "[#15] enter 설정: 좁은 폭의 Shift+Enter 도 전송하지 않는다"],
];

console.log("composer send key ([P-3]8 / [#15])");
for (const [sendKey, density, modifiers, expectSent, expectConsumed, label] of cases) {
  const { root, field } = await mount({ sendKey, density });
  const consumed = pressEnter(field, modifiers);
  await tick();
  assert(sent.length === (expectSent ? 1 : 0) && consumed === expectConsumed, label);
  root.unmount();
  await tick(10);
}

console.log(failures.length ? `\n${failures.length} failure(s)` : "\nall passed");
process.exit(failures.length ? 1 : 0);
