import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { qaTempDir } from "./lib/qaTemp.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const assert = (condition, message) => {
  console.log(`  ${condition ? "✓" : "✗"} ${message}`);
  if (!condition) failures.push(message);
};

const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
const { window } = dom;
for (const [name, value] of Object.entries({
  window,
  document: window.document,
  HTMLElement: window.HTMLElement,
  Node: window.Node,
  FileReader: window.FileReader,
  File: window.File,
  Blob: window.Blob,
  KeyboardEvent: window.KeyboardEvent,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: (callback) => setTimeout(() => callback(Date.now()), 0),
  cancelAnimationFrame: clearTimeout,
})) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.ResizeObserver = window.ResizeObserver;

const built = await build({
  stdin: {
    contents: [
      'export { Composer } from "./src/renderer/workbench/Composer";',
      'export * from "./src/renderer/workbench/composerDraftStore";',
    ].join("\n"),
    resolveDir: rootDir,
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  jsx: "automatic",
  loader: { ".css": "empty" },
  define: { "process.env.NODE_ENV": '"development"' },
  external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"],
  write: false,
});
const bundlePath = path.join(qaTempDir(), "composer-draft-persistence.mjs");
writeFileSync(bundlePath, built.outputFiles[0].text);
const api = await import(pathToFileURL(bundlePath).href);
const React = await import("react");
const reactDom = await import("react-dom/client");

const container = document.getElementById("root");
const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
const commandUi = {
  openRuntime() {}, openPermissions() {}, openMcp() {}, openStatus() {},
  openUsage() {}, openAutoCompact() {},
};
let send = async () => {};
const actions = {
  sendMessage: (...args) => send(...args),
  prewarm() {}, approve() {}, answerQuestion() {}, interrupt() {}, restart() {}, compact() {},
  applyRuntime() {}, setEffort() {}, setThinking() {}, setPermissionMode() {}, setCodexPolicy() {},
  forceStop() {}, setCursorPolicy() {}, runQueueCommand: async () => undefined,
};

function view(partyId, name = "main", createdAt = "one") {
  return {
    name, color: "#888",
    member: { partyId, name, createdAt, runtime: "claude-code", role: "" },
    session: undefined, status: "idle", transcript: [], unread: 0,
    pendingApproval: false, busy: false, model: "Sonnet", effort: "medium",
    permissionMode: "default", vision: { image: true },
  };
}

async function mount(memberView) {
  const reactRoot = reactDom.createRoot(container);
  reactRoot.render(React.createElement(api.Composer, {
    view: memberView, density: "wide", actions, commandUi,
  }));
  await tick();
  const editor = container.querySelector("[contenteditable].wb-composer-editor");
  if (!editor) throw new Error("composer editor not found");
  return { reactRoot, editor };
}

async function unmount(reactRoot) {
  reactRoot.unmount();
  await tick();
}

function type(editor, text) {
  editor.textContent = text;
  editor.dispatchEvent(new window.Event("input", { bubbles: true }));
}

console.log("composer draft persistence");

let mounted = await mount(view("party-a"));
type(mounted.editor, "party A draft");
await tick();
await unmount(mounted.reactRoot);
mounted = await mount(view("party-a"));
assert(mounted.editor.getAttribute("data-draft") === "party A draft", "tab close and reopen restores the same target");
await unmount(mounted.reactRoot);

mounted = await mount(view("party-b"));
assert(mounted.editor.getAttribute("data-draft") === "", "same-named member in another party is isolated");
type(mounted.editor, "party B draft");
await tick();
await unmount(mounted.reactRoot);

mounted = await mount(view("party-a", "main", "two"));
assert(mounted.editor.getAttribute("data-draft") === "", "a deleted and recreated member starts with a fresh draft");
await unmount(mounted.reactRoot);

mounted = await mount(view("party-a"));
assert(mounted.editor.getAttribute("data-draft") === "party A draft", "switching parties and returning restores only that party's draft");

let rejectSend;
send = () => new Promise((_, reject) => { rejectSend = reject; });
mounted.editor.closest("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
await tick();
assert(mounted.editor.getAttribute("data-draft") === "party A draft", "draft remains visible until send succeeds");
rejectSend(new Error("rejected"));
await tick();
assert(mounted.editor.getAttribute("data-draft") === "party A draft", "failed send preserves the original draft");

send = async () => {};
mounted.editor.closest("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
await tick();
assert(mounted.editor.getAttribute("data-draft") === "", "successful send clears the current target");
await unmount(mounted.reactRoot);

mounted = await mount(view("party-b"));
assert(mounted.editor.getAttribute("data-draft") === "party B draft", "successful send does not clear another target");
await unmount(mounted.reactRoot);

const richTarget = view("party-rich", "writer", "one");
api.writeComposerDraft(api.composerDraftKey(richTarget.member), {
  text: 'review "C:\\draft file.txt"',
  attachments: [{ kind: "image", mediaType: "image/png", dataBase64: "iVBORw0KGgo=", name: "draft.png" }],
  references: [{ kind: "file", path: "C:\\draft file.txt", name: "draft file.txt", dir: "C:\\" }],
});
mounted = await mount(richTarget);
assert(Boolean(container.querySelector(".wb-attachment")), "image attachments restore with the text draft");
assert(Boolean(container.querySelector(".wb-ref-chip")), "file-reference chips restore with the text draft");
await unmount(mounted.reactRoot);

api.clearComposerDraftsForMember("party-b", "main");
assert(!api.readComposerDraft(api.composerDraftKey(view("party-b").member)), "actual member deletion discards its drafts");
api.writeComposerDraft(api.composerDraftKey(view("party-b").member), { text: "late cleanup", attachments: [], references: [] });
assert(!api.readComposerDraft(api.composerDraftKey(view("party-b").member)), "late unmount cleanup cannot revive a deleted member's draft");
api.writeComposerDraft(api.composerDraftKey(view("party-b", "main", "new").member), { text: "new member", attachments: [], references: [] });
assert(api.readComposerDraft(api.composerDraftKey(view("party-b", "main", "new").member))?.text === "new member", "a newly created member has an independent writable draft");
api.writeComposerDraft(api.composerDraftKey(view("party-c").member), { text: "c", attachments: [], references: [] });
api.clearComposerDraftsForParty("party-c");
assert(!api.readComposerDraft(api.composerDraftKey(view("party-c").member)), "actual party deletion discards its drafts");

console.log(failures.length ? `\n${failures.length} failure(s)` : "\nall passed");
process.exit(failures.length ? 1 : 0);
