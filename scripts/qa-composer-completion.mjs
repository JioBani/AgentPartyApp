/*
 * Triggerless composer completion regression.
 *
 * Layer 1 locks the word detector. Layer 2 mounts the real Composer DOM and
 * proves the user-visible keyboard flow: a single letter finds a member, while
 * Tab on a provider immediately advances to that provider's models.
 */
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { qaTempDir } from "./lib/qaTemp.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
const define = (name, value) => Object.defineProperty(globalThis, name, {
  value,
  configurable: true,
  writable: true,
});
define("window", window);
define("document", window.document);
define("HTMLElement", window.HTMLElement);
define("Node", window.Node);
define("Text", window.Text);
define("Range", window.Range);
define("getComputedStyle", window.getComputedStyle.bind(window));
define("requestAnimationFrame", (callback) => setTimeout(() => callback(Date.now()), 0));
define("cancelAnimationFrame", clearTimeout);
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.ResizeObserver = window.ResizeObserver;
window.Range.prototype.getClientRects = () => [{ left: 120, top: 240, width: 0, height: 16 }];

const outDir = qaTempDir();
async function bundle(entry, name, external = []) {
  const result = await build({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    format: "esm",
    platform: "browser",
    jsx: "automatic",
    loader: { ".css": "empty" },
    define: { "process.env.NODE_ENV": '"development"' },
    external,
    write: false,
  });
  const output = path.join(outDir, name);
  writeFileSync(output, result.outputFiles[0].text);
  return import(pathToFileURL(output).href);
}

console.log("\nTriggerless detector:");
const model = await bundle("src/renderer/workbench/completionModel.ts", "completion-model.mjs");
const tags = await bundle("src/shared/messageTags.ts", "message-tags.mjs");
const claudeProviderTag = tags.createMessageTag({ kind: "provider", value: "anthropic", label: "Claude" });
const codexProviderTag = tags.createMessageTag({ kind: "provider", value: "openai", label: "Codex" });
const solModelTag = tags.createMessageTag({ kind: "model", value: "gpt-5.6-sol", label: "GPT-5.6 Sol" });
assert(model.detectCompletion("i", 1)?.kind === "all", "one letter opens combined completion");
assert(model.detectCompletion("ask i", 5)?.queries[0] === "i", "completion works mid-sentence at a word boundary");
assert(model.detectCompletion("gpt-5.6", 7)?.queries[0] === "gpt-5.6", "model punctuation remains searchable");
assert(model.detectCompletion("/c", 2) === null, "slash commands keep their reserved prefix");
assert(model.detectCompletion("@impl", 5) === null, "literal mentions keep their reserved prefix");
assert(model.detectCompletion(":a", 2)?.kind === "model", "legacy model trigger remains compatible");
assert(model.detectCompletion(":m", 2)?.kind === "member", "legacy member trigger remains compatible");

console.log("\nDurable message tags:");
assert(solModelTag === "⟦ap-tag:v1:model:gpt-5.6-sol:GPT-5.6%20Sol⟧", "tag uses the versioned AgentParty-only wire form");
assert(tags.parseMessageTag(solModelTag)?.label === "GPT-5.6 Sol", "canonical tag round-trips its display label");
assert(tags.parseMessageTag("⟦ap-tag:v1:model:gpt-5.6-sol:GPT-5.6 Sol⟧") === null, "uncanonical lookalike stays ordinary text");
assert(tags.parseMessageTag("⟦ap-tag:v2:model:gpt-5.6-sol:GPT-5.6%20Sol⟧") === null, "unknown tag versions stay ordinary text");
assert(tags.messageTagsToDisplayText(`use ${solModelTag} now`) === "use GPT-5.6 Sol now", "plain surfaces receive the readable label");
assert(tags.messageTagMatches(`⟦ap-tag:v1:broken ${solModelTag}`).at(-1)?.label === "GPT-5.6 Sol", "a malformed lookalike cannot swallow a later valid tag");

const app = await bundle(
  "scripts/fixtures/composerCompletionHarness.tsx",
  "completion-composer.mjs",
  ["react", "react-dom", "react-dom/client", "react/jsx-runtime"],
);
const React = await import("react");
const reactDom = await import("react-dom/client");

const members = [
  { name: "main", color: "#6c8cff", status: "idle" },
  { name: "impl", color: "#55bb88", status: "working" },
  { name: "review", color: "#aa77ee", status: "idle" },
];
const routes = [
  { harnessId: "claude-code", providerId: "anthropic", model: "claude-sonnet-4-5", label: "Sonnet 4.5", enabled: true },
  { harnessId: "codex", providerId: "openai", model: "gpt-5.6-sol", label: "GPT-5.6 Sol", enabled: true },
  { harnessId: "codex", providerId: "openai", model: "gpt-5.6-terra", label: "GPT-5.6 Terra", enabled: true },
  { harnessId: "cursor", providerId: "cursor", model: "composer-2", label: "Composer 2", enabled: true },
];
const calls = [];
const actions = {
  sendMessage: (...args) => calls.push(["send", ...args]),
  compact: () => {}, restart: () => {}, interrupt: () => {}, forceStop: () => {},
  setPermissionMode: () => {}, openEnvironmentSettings: () => {},
};
const commandUi = {
  openRuntime: () => {}, openPermissions: () => {}, openMcp: () => {},
  openStatus: () => {}, openUsage: () => {}, openAutoCompact: () => {},
};
const view = {
  name: "main",
  color: "#6c8cff",
  member: { name: "main", partyId: "p1", status: "idle", runtime: "claude-code", role: "" },
  status: "idle",
  unread: 0,
  pendingApproval: false,
  busy: false,
  model: "sonnet",
  effort: "medium",
  permissionMode: "default",
  transcript: [],
};

const composerRoot = reactDom.createRoot(document.getElementById("root"));
const renderComposer = (catalogMembers = members) => composerRoot.render(React.createElement(app.ComposerCompletionHarness, {
  members: catalogMembers, routes, view, actions, commandUi,
}));
renderComposer();
const tick = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));
await tick(100);

const editor = document.querySelector(".wb-composer-editor");
function typeWord(value) {
  editor.textContent = value;
  const range = document.createRange();
  const text = editor.firstChild;
  range.setStart(text, value.length);
  range.collapse(true);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  editor.dispatchEvent(new window.Event("input", { bubbles: true }));
}
function press(key, modifiers = {}) {
  return editor.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers }));
}
const visibleRows = () => [...document.querySelectorAll(".wb-mention-row .wb-mention-name")].map((node) => node.textContent);

console.log("\nComposer DOM flow:");
assert(Boolean(editor), "Composer renders its editable surface");
typeWord("zzlive");
await tick();
assert(!visibleRows().includes("@zzlive"), "a member absent from the live party is absent from completion");
renderComposer([...members, { name: "zzlive", color: "#ee9955", status: "idle" }]);
await tick();
assert(visibleRows().includes("@zzlive"), "a member added while the query is open appears without another input event");
typeWord("i");
await tick();
assert(visibleRows().includes("@impl"), "typing 'i' offers member impl without a prefix");
press("Tab");
await tick();
assert(editor.dataset.draft === "@impl ", "Tab commits the member as an @ mention chip");

typeWord("cl");
await tick();
assert(visibleRows().includes("Claude"), "typing 'cl' offers Claude without a prefix");
press("Tab");
await tick();
assert(editor.dataset.draft === `${claudeProviderTag} `, "Tab commits the wrapped Claude provider token");
assert(visibleRows().includes("Sonnet 4.5"), "provider commit immediately opens its model completion");

editor.textContent = "";
editor.dispatchEvent(new window.Event("input", { bubbles: true }));
await tick();
assert(!document.querySelector(".wb-mention-pop"), "deleting the provider chip closes its stale model completion");

typeWord("co");
await tick();
assert(visibleRows().includes("Codex"), "typing again can immediately choose a different provider");
press("Tab");
await tick();
assert(editor.dataset.draft === `${codexProviderTag} `, "Tab commits the wrapped replacement Codex provider");
assert(visibleRows().includes("GPT-5.6 Sol"), "Codex selection opens only its model completion");
press("Tab");
await tick();
assert(editor.dataset.draft === `${codexProviderTag} ${solModelTag} `, "next Tab commits the wrapped replacement provider's model");

const selectedModel = [...editor.querySelectorAll(".wb-token-chip")].at(-1);
selectedModel.nextSibling?.remove();
selectedModel.remove();
editor.dispatchEvent(new window.Event("input", { bubbles: true }));
await tick();
assert(editor.dataset.draft === `${codexProviderTag} `, "deleting only the model keeps its provider token");
const reopenedModelRows = visibleRows();
assert(reopenedModelRows.includes("GPT-5.6 Sol") && reopenedModelRows.includes("GPT-5.6 Terra"), `deleting a model reopens the provider's full model list (${reopenedModelRows.join(", ")})`);
assert(!calls.some((call) => call[0] === "send"), "completion itself never submits the message");

const transcriptRoot = document.createElement("div");
document.body.appendChild(transcriptRoot);
const malformed = "⟦ap-tag:v1:model:gpt-5.6-sol:GPT-5.6 Sol⟧";
reactDom.createRoot(transcriptRoot).render(React.createElement(app.MessageText, {
  text: `${codexProviderTag} ${solModelTag} ${malformed}`,
  members,
}));
await tick();
const staticTags = [...transcriptRoot.querySelectorAll(".wb-token-chip.is-static")];
assert(staticTags.map((node) => node.textContent).join("|") === "Codex|GPT-5.6 Sol", "transcript restores the exact provider/model labels as chips");
assert(staticTags[1]?.dataset.tokenValue === "gpt-5.6-sol", "restored chip retains the exact model value");
assert(transcriptRoot.textContent.includes(malformed), "a similar but invalid marker remains literal text");

typeWord("cl");
await tick();
press("Enter", { ctrlKey: true });
await tick();
assert(calls.some((call) => call[0] === "send" && call[2] === "cl"), "triggerless suggestions never steal Ctrl+Enter send");

console.log(failures.length ? `\nCOMPOSER COMPLETION FAILED (${failures.length})` : "\nCOMPOSER COMPLETION PASSED");
process.exit(failures.length ? 1 : 0);
