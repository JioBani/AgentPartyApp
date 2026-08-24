/*
 * Codex command/skill/plugin discovery in the palette (Item 4). Three layers:
 *   1. codexDiscovery (pure): skills/list + plugin/installed responses → palette
 *      commands tagged by source, with disabled reasons (disabled skill / admin-
 *      disabled plugin); not-installed plugins excluded. Verified against the
 *      app-server SkillSummary / PluginSummary shapes.
 *   2. paletteModel (pure): discovered commands with explicit source group under
 *      the right section (Skills/Plugins/Commands) and disabled → "disabled" badge.
 *   3. CommandPalette (DOM): source badges render, disabled rows dim, and the
 *      preview shows the disabled reason.
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

// ---- Layer 1: discovery normalization ---------------------------------------
const D = await bundle("src/shared/codexDiscovery.ts", "codex-discovery.mjs", []);
console.log("\ncodexDiscovery normalization:");
const skills = D.skillCommands({ data: [{ cwd: "/w", skills: [
  { name: "deep-dive", shortDescription: "심층 분석", enabled: true },
  { name: "legacy", description: "old skill", enabled: false },
  { name: D.CODEX_IN_APP_BROWSER_SKILL, path: "C:\\fake\\browser\\control-in-app-browser\\SKILL.md", enabled: true },
], errors: [] }] }, new Set([D.CODEX_IN_APP_BROWSER_SKILL]));
assert(skills.length === 2 && skills[0].source === "skill", "skills/list → skill commands");
assert(skills[0].name === "deep-dive" && !skills[0].disabledReason, "enabled skill has no disabled reason");
assert(skills[1].name === "legacy" && skills[1].disabledReason === "비활성화된 skill", "disabled skill carries a reason");
const hostOverrides = D.unsupportedHostSkillOverrides({ data: [{ skills: [
  { name: D.CODEX_IN_APP_BROWSER_SKILL, path: "C:\\fake\\browser\\control-in-app-browser\\SKILL.md" },
] }] });
assert(
  hostOverrides.length === 1
    && hostOverrides[0].enabled === false
    && hostOverrides[0].path === "C:\\fake\\browser\\control-in-app-browser\\SKILL.md",
  "unsupported host skill becomes a thread-local SKILL.md override",
);
assert(
  D.skillCommands(
    { data: [{ skills: [{ name: D.CODEX_IN_APP_BROWSER_SKILL, enabled: true }] }] },
    new Set([D.CODEX_IN_APP_BROWSER_SKILL]),
  ).length === 0,
  "unsupported host skill can be excluded from discovery",
);

const plugins = D.pluginCommands({ marketplaces: [{ plugins: [
  { summary: { id: "p1", name: "formatter", installed: true, enabled: true, availability: "AVAILABLE", keywords: ["fmt"] } },
  { summary: { id: "p2", name: "blocked", installed: true, enabled: true, availability: "DISABLED_BY_ADMIN" } },
  { summary: { id: "p3", name: "notinstalled", installed: false, enabled: true, availability: "AVAILABLE" } },
  { summary: { id: D.CODEX_IN_APP_BROWSER_PLUGIN, name: "browser", installed: true, enabled: true, availability: "AVAILABLE" } },
] }] }, new Set([D.CODEX_IN_APP_BROWSER_PLUGIN]));
assert(plugins.map((p) => p.name).join(",") === "formatter,blocked", "installed plugins only (not-installed and unsupported host plugin excluded)");
assert(plugins[0].source === "plugin" && !plugins[0].disabledReason, "available plugin has no disabled reason");
assert(plugins[1].disabledReason === "관리자가 비활성화함", "admin-disabled plugin carries a reason");

assert(
  D.pluginCommands(
    { marketplaces: [{ plugins: [{ summary: { id: D.CODEX_IN_APP_BROWSER_PLUGIN, name: "browser", installed: true } }] }] },
    new Set([D.CODEX_IN_APP_BROWSER_PLUGIN]),
  ).length === 0,
  "unsupported host plugin can be excluded from discovery",
);

// ---- Layer 2: palette grouping ----------------------------------------------
const P = await bundle("src/renderer/workbench/paletteModel.ts", "codex-palette-model.mjs", []);
console.log("\npaletteModel discovery:");
const discovered = [
  { name: "model", source: "built-in", description: "Switch model" },
  ...skills,
  ...plugins,
];
const palette = P.buildPalette("codex", discovered);
const groups = P.groupByCategory(palette.commands);
const byKey = Object.fromEntries(groups.map((g) => [g.key, g.items.map((i) => i.id)]));
assert((byKey.skill || []).includes("deep-dive") && (byKey.skill || []).includes("legacy"), "skills grouped under Skills");
assert((byKey.plugin || []).includes("formatter"), "plugins grouped under Plugins");
assert((byKey.command || []).includes("model"), "built-in stays under Commands");
const legacy = palette.commands.find((c) => c.id === "legacy");
assert(legacy.badges?.includes("disabled") && legacy.disabledReason === "비활성화된 skill", "disabled skill → disabled badge + reason");
const deepDive = palette.commands.find((c) => c.id === "deep-dive");
assert(deepDive.source === "skill" && deepDive.category === "skill", "explicit source drives category + badge");
assert(!deepDive.disabledReason && deepDive.run.type === "insert", "enabled discovered skill is allowed without a name allowlist");
const formatter = palette.commands.find((c) => c.id === "formatter");
assert(!formatter.disabledReason && formatter.run.type === "insert", "available discovered plugin is allowed without a name allowlist");

// ---- Layer 3: CommandPalette DOM --------------------------------------------
const { CommandPalette } = await bundle("src/renderer/workbench/CommandPalette.tsx", "codex-cmd-palette.mjs", ["react", "react-dom", "react-dom/client", "react/jsx-runtime"]);
const React = await import("react");
const reactDom = await import("react-dom/client");
const mount = (el) => { const host = document.createElement("div"); document.body.appendChild(host); reactDom.createRoot(host).render(el); return host; };
const settle = () => new Promise((r) => setTimeout(r, 60));

console.log("\nCommandPalette DOM:");
// Put the disabled 'legacy' skill as the active row so its preview shows.
const commands = palette.commands;
const legacyIndex = commands.findIndex((c) => c.id === "legacy");
const host = mount(React.createElement(CommandPalette, { commands, activeIndex: legacyIndex, onHover() {}, onSelect() {} }));
await settle();
const sources = [...host.querySelectorAll(".wb-cmd-source")].map((s) => s.textContent);
assert(sources.includes("skill") && sources.includes("plugin"), "source badges (skill, plugin) render in the list");
assert(Boolean(host.querySelector(".wb-cmd-row.is-disabled")), "disabled command row is dimmed");
assert(Boolean(host.querySelector(".wb-cmd-preview-disabled")), "preview shows the disabled reason");
assert(host.querySelector(".wb-cmd-preview-disabled")?.textContent === "비활성화된 skill", "the disabled reason text is correct");

console.log(failures.length ? `\nCODEX DISCOVERY FAILED (${failures.length})` : "\nCODEX DISCOVERY PASSED");
process.exit(failures.length ? 1 : 0);
