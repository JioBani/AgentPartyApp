/*
 * Command/skill palette regression. Two layers:
 *   1. paletteModel (pure): trigger detection is harness-aware (prefix + start
 *      of message only), filtering ranks by name match, and the inventory
 *      differs per harness (claude-code vs codex).
 *   2. Composer (DOM): typing "/" opens the palette; arrow/Enter selects; an
 *      action command (/compact) fires a local action, an insert command drops
 *      its trigger into the draft.
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
async function bundle(entry, name, external = []) {
  const r = await build({ entryPoints: [path.join(projectRoot, entry)], bundle: true, format: "esm", platform: "browser", jsx: "automatic", loader: { ".css": "empty" }, define: { "process.env.NODE_ENV": '"development"' }, external, write: false });
  const p = path.join(outDir, name); writeFileSync(p, r.outputFiles[0].text); return import(pathToFileURL(p).href);
}

// ---- Layer 1: pure model ----------------------------------------------------
const model = await bundle("src/renderer/workbench/paletteModel.ts", "palette-model.mjs", []);
const { detectTrigger, filterCommands, getHarnessPalette, groupByCategory, buildPalette } = model;

console.log("\nTrigger detection (harness-aware, start-of-message only):");
const cc = getHarnessPalette("claude-code");
assert(detectTrigger("/mod", cc.prefixes)?.query === "mod", "'/mod' yields query 'mod'");
assert(detectTrigger("/", cc.prefixes)?.query === "", "bare '/' opens the palette with an empty query");
assert(detectTrigger("/model now", cc.prefixes) === null, "a space (args started) closes the palette");
assert(detectTrigger("hello /model", cc.prefixes) === null, "prefix only counts at the start of the message");
assert(detectTrigger("send it", cc.prefixes) === null, "plain text never triggers");

console.log("\nFiltering + ranking:");
const m = filterCommands(cc.commands, "model");
assert(m.length > 0 && m[0].id === "model", "'model' ranks the /model command first");
const comp = filterCommands(cc.commands, "compact");
assert(comp.some((c) => c.id === "compact"), "'compact' matches /compact");
assert(filterCommands(cc.commands, "").length === cc.commands.length, "empty query returns the full inventory");
assert(filterCommands(cc.commands, "zzzznope").length === 0, "no match yields an empty list");

console.log("\nHarness abstraction:");
const codex = getHarnessPalette("codex");
assert(codex.harness === "codex", "codex runtime resolves to the codex palette");
assert(getHarnessPalette(undefined).harness === "claude-code", "unknown/absent runtime defaults to claude-code");
assert(codex.commands.some((c) => c.id === "approvals"), "codex inventory has its own commands (/approvals)");
assert(!cc.commands.some((c) => c.id === "approvals"), "claude-code inventory does NOT include codex-only commands");
assert(cc.commands.some((c) => c.id === "code-review"), "claude-code inventory has skills (/code-review)");
const groups = groupByCategory(cc.commands);
assert(groups[0].key === "command", "category grouping keeps Commands first");
assert(groups.some((g) => g.key === "agentparty"), "AgentParty commands form their own section");

console.log("\nLive discovery (buildPalette merges harness-reported commands):");
assert(buildPalette("claude-code").commands.length === cc.commands.length, "no discovery → static built-in inventory (fallback)");
const discovered = [
  { name: "model", description: "live model picker" },
  { name: "compact" },
  { name: "modular-workflow:install-skill", description: "Install a modular-workflow skill", argumentHint: "<skill>" },
  { name: "mcp__figma__get_design_context", description: "Figma design context" },
  { name: "my-custom", description: "a project command" },
];
const built = buildPalette("claude-code", discovered);
const byId = (id) => built.commands.find((c) => c.id === id);
assert(Boolean(byId("modular-workflow:install-skill")), "discovered plugin skill (modular-workflow) appears in the palette");
assert(byId("modular-workflow:install-skill").category === "plugin", "namespaced command is grouped under Plugins");
assert(byId("mcp__figma__get_design_context").category === "mcp", "mcp__ command is grouped under MCP prompts");
assert(byId("model").description === "live model picker", "live description overrides the static one");
assert(byId("compact").run.type === "action", "a discovered built-in keeps its static action wiring (/compact)");
assert(byId("modular-workflow:install-skill").args === "<skill>", "discovered argumentHint becomes the arg signature");
assert(built.commands.some((c) => c.source === "agentparty"), "AgentParty app commands are still appended to a live inventory");
assert(!built.commands.some((c) => c.id === "code-review"), "static-only skills are dropped when a live inventory exists");

// ---- Layer 2: Composer DOM --------------------------------------------------
const { Composer } = await bundle("src/renderer/workbench/Composer.tsx", "palette-composer.mjs", ["react", "react-dom", "react-dom/client", "react/jsx-runtime"]);
const React = await import("react");
const reactDom = await import("react-dom/client");

const calls = [];
const actions = {
  sendMessage: (...a) => calls.push(["send", ...a]),
  compact: (...a) => calls.push(["compact", ...a]),
  restart: (...a) => calls.push(["restart", ...a]),
  interrupt: (...a) => calls.push(["interrupt", ...a]),
  setPermissionMode: () => {},
};
const view = {
  name: "rev", color: "#888",
  member: { name: "rev", partyId: "p1", status: "idle", runtime: "claude-code", role: "" },
  status: "idle", unread: 0, pendingApproval: false, busy: false, model: "sonnet", effort: "medium", permissionMode: "default",
  transcript: [],
};
reactDom.createRoot(document.getElementById("root")).render(React.createElement(Composer, { view, density: "wide", actions }));
await new Promise((r) => setTimeout(r, 80));

const textarea = document.querySelector(".wb-composer-textarea");
function setDraft(val) {
  const desc = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value");
  desc.set.call(textarea, val);
  textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
}
const key = (k) => textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));

console.log("\nComposer palette (DOM):");
assert(Boolean(textarea), "composer renders a textarea");
assert(!document.querySelector(".wb-cmd-palette"), "palette is closed with an empty draft");

setDraft("/");
await new Promise((r) => setTimeout(r, 40));
assert(Boolean(document.querySelector(".wb-cmd-palette")), "typing '/' opens the palette");
assert(document.querySelectorAll(".wb-cmd-row").length === cc.commands.length, "all commands listed for bare '/'");

setDraft("/comp");
await new Promise((r) => setTimeout(r, 40));
const rows = [...document.querySelectorAll(".wb-cmd-row .wb-cmd-name")].map((n) => n.textContent);
assert(rows.includes("/compact"), "'/comp' filters down to /compact");

// Select /compact via keyboard — it is an action command, should fire compact().
key("Enter");
await new Promise((r) => setTimeout(r, 40));
assert(calls.some((c) => c[0] === "compact" && c[1] === "rev"), "Enter on /compact fires actions.compact(member)");
assert(!calls.some((c) => c[0] === "send"), "selecting a command does NOT send a chat message");
assert(!document.querySelector(".wb-cmd-palette"), "palette closes after selection");
assert((textarea.value || "") === "", "action command clears the draft");

// Insert command: selecting /model drops its trigger into the draft (no send).
setDraft("/model");
await new Promise((r) => setTimeout(r, 40));
key("Enter");
await new Promise((r) => setTimeout(r, 40));
assert(textarea.value === "/model ", "insert command writes '/model ' into the draft for arguments");
assert(!document.querySelector(".wb-cmd-palette"), "palette closes once the trigger ends (trailing space)");

// Escape dismisses without selecting.
setDraft("/de");
await new Promise((r) => setTimeout(r, 40));
assert(Boolean(document.querySelector(".wb-cmd-palette")), "'/de' reopens the palette");
key("Escape");
await new Promise((r) => setTimeout(r, 40));
assert(!document.querySelector(".wb-cmd-palette"), "Escape dismisses the palette");

// Renderer consumption: a member whose session snapshot carries the live
// inventory must drive the palette from it (regression — the snapshot has to
// reach the composer, not just /api/state).
console.log("\nComposer palette (live snapshot inventory):");
const liveView = {
  ...view,
  session: { id: "s1", title: "probe", workspace: "/w", snapshot: {
    id: "s1", cwd: "/w", model: "sonnet", effort: "low", status: "idle", startedAt: "", debugMode: false, turnCount: 0, queuedTurnCount: 0,
    slashCommands: [
      { name: "model", description: "live" },
      { name: "workflow-create", description: "Create a modular-workflow" },
      { name: "codex:rescue", description: "Hand a task to codex" },
    ],
  } },
};
const liveRoot = document.createElement("div"); document.body.appendChild(liveRoot);
reactDom.createRoot(liveRoot).render(React.createElement(Composer, { view: liveView, density: "wide", actions }));
await new Promise((r) => setTimeout(r, 80));
const liveTextarea = liveRoot.querySelector(".wb-composer-textarea");
const setLive = (val) => { const d = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value"); d.set.call(liveTextarea, val); liveTextarea.dispatchEvent(new window.Event("input", { bubbles: true })); };
setLive("/work");
await new Promise((r) => setTimeout(r, 50));
const liveNames = [...liveRoot.querySelectorAll(".wb-cmd-row .wb-cmd-name")].map((n) => n.textContent);
assert(liveNames.includes("/workflow-create"), "discovered skill (workflow-create) from the session snapshot appears");
setLive("/");
await new Promise((r) => setTimeout(r, 50));
const allLive = [...liveRoot.querySelectorAll(".wb-cmd-row .wb-cmd-name")].map((n) => n.textContent);
assert(!allLive.includes("/code-review"), "static-only commands are dropped once the live inventory drives the palette");
assert(allLive.includes("/codex:rescue"), "namespaced discovered command (codex:rescue) is present");

console.log(failures.length ? `\nCOMMAND PALETTE FAILED (${failures.length})` : "\nCOMMAND PALETTE PASSED");
process.exit(failures.length ? 1 : 0);
