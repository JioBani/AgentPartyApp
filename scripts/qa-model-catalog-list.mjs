/*
 * Model catalog LIST regression (jsdom) — R-5 provider collapse, R-6 favourites
 * pinned on top, R-7 model search. Locks the confirmed design in
 * `docs/디자인 핸드오프/design_handoff_mentions_catalog` (B) and
 * `design_handoff_model_search`.
 *
 * Two layers:
 *   1. the pure assembly (`modelCatalogGroups.ts` + `shared/favoriteModels.ts`),
 *      where the ORDER of filter → favourites → grouping is the whole game;
 *   2. the rendered modal, where the traps live — a star must not select a row,
 *      Escape must not close the modal out from under a search, and filtering
 *      must never change which model is selected.
 *
 * NOT covered, deliberately: the confirmed checklist asks that a search for
 * `frontier` match by capability tier. The catalog carries no tier field for any
 * of its models (only free-text descriptions mention the word), so that axis has
 * no data behind it and was dropped rather than faked. See the commit message.
 */
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { projectRoot, qaTempFile } from "./lib/qaTemp.mjs";
const failures = [];
const assert = (c, m) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) failures.push(m); };

const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
const { window } = dom;
const def = (n, v) => { try { Object.defineProperty(globalThis, n, { value: v, configurable: true, writable: true }); } catch {} };
def("window", window); def("document", window.document); def("HTMLElement", window.HTMLElement);
def("getComputedStyle", window.getComputedStyle.bind(window));
def("requestAnimationFrame", (cb) => setTimeout(() => cb(Date.now()), 0)); def("cancelAnimationFrame", clearTimeout);
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }; globalThis.ResizeObserver = window.ResizeObserver;

async function load(entry, name, names) {
  const r = await build({ entryPoints: [path.join(projectRoot, entry)], bundle: true, format: "esm", platform: "browser", jsx: "automatic", loader: { ".css": "empty" }, define: { "process.env.NODE_ENV": '"development"' }, external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"], write: false });
  const file = qaTempFile(name); writeFileSync(file, r.outputFiles[0].text);
  const mod = await import(pathToFileURL(file).href);
  return names.reduce((acc, k) => (acc[k] = mod[k], acc), {});
}

const { buildCatalogView, catalogCountLabel, initialProvOpen } = await load(
  "src/renderer/workbench/modelCatalogGroups.ts", "cat-groups.mjs",
  ["buildCatalogView", "catalogCountLabel", "initialProvOpen"],
);
const { normalizeFavoriteModels, toggleFavoriteModel, resolveFavoriteModels } = await load(
  "src/shared/favoriteModels.ts", "fav-models.mjs",
  ["normalizeFavoriteModels", "toggleFavoriteModel", "resolveFavoriteModels"],
);
/*
 * The modal and the favourites channel MUST come out of one bundle. Building
 * them as separate entry points gives each its own copy of the channel's module
 * state, so the publisher here would write to an instance the modal never reads
 * — the component would render with no favourites while the test looked correct.
 */
async function loadBundle(contents, name, names) {
  const r = await build({ stdin: { contents, resolveDir: projectRoot, sourcefile: name, loader: "ts" }, bundle: true, format: "esm", platform: "browser", jsx: "automatic", loader: { ".css": "empty" }, define: { "process.env.NODE_ENV": '"development"' }, external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"], write: false });
  const file = qaTempFile(name); writeFileSync(file, r.outputFiles[0].text);
  const mod = await import(pathToFileURL(file).href);
  return names.reduce((acc, k) => (acc[k] = mod[k], acc), {});
}
const { ModelCatalogModal, usePublishFavoriteModels, __resetFavoriteModelPrefs } = await loadBundle(
  `export { ModelCatalogModal } from "./src/renderer/workbench/ModelCatalogModal";
   export { usePublishFavoriteModels, __resetFavoriteModelPrefs } from "./src/renderer/app/favoriteModelPrefs";`,
  "cat-modal.mjs",
  ["ModelCatalogModal", "usePublishFavoriteModels", "__resetFavoriteModelPrefs"],
);
const React = await import("react");
const reactDom = await import("react-dom/client");

// --- fixtures -------------------------------------------------------------
// Mirrors the confirmed screenshots: 6 models, 2 of them starred.
const route = (model, label, providerId, perf) => ({
  harnessId: "claude-code", providerId, model, label, meta: { perf, costTier: perf, context: "200K" },
});
const ROUTES = [
  route("claude-sonnet-4.5", "claude-sonnet-4.5", "anthropic", 4),
  route("claude-opus-4.1", "claude-opus-4.1", "anthropic", 5),
  route("claude-haiku-4", "claude-haiku-4", "anthropic", 3),
  route("gpt-5", "gpt-5", "openai", 5),
  route("o4-mini", "o4-mini", "openai", 2),
  route("deepseek-v3.2", "deepseek-v3.2", "openrouter", 3),
];
const meta = (r) => ({ id: r.model, name: r.label, provider: r.providerId, perf: r.meta.perf, cost: r.meta.perf, context: "200K" });
const ENTRIES = ROUTES.map((r) => ({ route: r, meta: meta(r) }));
const keyOf = (model) => `claude-code::${ROUTES.find((r) => r.model === model).providerId}::${model}`;
const FAVS = ["claude-sonnet-4.5", "gpt-5"];

const groupIds = (v) => v.groups.map((g) => g.id);
const groupNamed = (v, id) => v.groups.find((g) => g.id === id);
const modelsIn = (g) => (g ? g.entries.map((e) => e.route.model) : []);

// --- 1. assembly order ----------------------------------------------------
console.log("\nAssembly order (filter → favourites → provider groups):");
{
  const base = buildCatalogView({ entries: ENTRIES, query: "", favorites: FAVS, provOpen: {}, selectedKey: keyOf("claude-sonnet-4.5") });
  assert(groupIds(base)[0] === "favorites", "favourites section is first");
  assert(modelsIn(groupNamed(base, "favorites")).join() === "claude-sonnet-4.5,gpt-5", "favourites keep CATALOG order, not the order they were starred");
  // Shown in BOTH places on purpose: pinning is a shortcut, not a new home, so
  // a provider group stays a complete inventory of what that provider offers.
  assert(modelsIn(groupNamed(base, "anthropic")).includes("claude-sonnet-4.5"), "a starred model ALSO stays in its provider group");
  assert(groupNamed(base, "anthropic").entries.length === 3, "the provider count is the provider's whole list, starred or not");
  assert(groupNamed(base, "openai").entries.length === 2, "openai still lists gpt-5 alongside o4-mini");
  assert(base.favoriteCount === 2 && base.total === 6, "header counts: 6 total, 2 favourites");
  assert(catalogCountLabel(base) === "6 available · ★ 2", "browsing label matches the confirmed design");

  // The decisive one: grouping BEFORE filtering would leave a starred match
  // inside a collapsed provider group, hiding it.
  const searched = buildCatalogView({ entries: ENTRIES, query: "gpt", favorites: FAVS, provOpen: {}, selectedKey: keyOf("claude-sonnet-4.5") });
  assert(groupIds(searched).join() === "favorites,openai", "a starred match is pinned AND left in its provider group; groups with no match are dropped");
  assert(modelsIn(groupNamed(searched, "favorites")).join() === "gpt-5", "the favourites section shows only the models that MATCH");
  assert(catalogCountLabel(searched) === "1 / 6 일치", "searching label switches to n / m 일치");

  const none = buildCatalogView({ entries: ENTRIES, query: "llama", favorites: FAVS, provOpen: {}, selectedKey: "" });
  assert(none.groups.length === 0 && none.matched === 0, "no match renders no group at all (empty state's job)");
}

// --- 2. search axes -------------------------------------------------------
console.log("\nSearch axes (name + provider; no tier field exists):");
{
  const byProviderLabel = buildCatalogView({ entries: ENTRIES, query: "openrouter", favorites: [], provOpen: {}, selectedKey: "" });
  assert(byProviderLabel.matched === 1, "a provider name matches its models even when no model name contains it");
  const byId = buildCatalogView({ entries: ENTRIES, query: "OPENAI", favorites: [], provOpen: {}, selectedKey: "" });
  assert(byId.matched === 2, "the provider's catalog id matches too, case-insensitively");
  const partial = buildCatalogView({ entries: ENTRIES, query: "hai", favorites: [], provOpen: {}, selectedKey: "" });
  assert(partial.matched === 1, "substring match, not fuzzy");
  const spaces = buildCatalogView({ entries: ENTRIES, query: "   ", favorites: FAVS, provOpen: {}, selectedKey: "" });
  assert(spaces.searching === false && spaces.matched === 6, "a whitespace-only query is NOT a search");
}

// --- 3. collapse state ----------------------------------------------------
console.log("\nProvider collapse (R-5):");
{
  const collapsed = buildCatalogView({ entries: ENTRIES, query: "", favorites: [], provOpen: {}, selectedKey: "" });
  assert(collapsed.groups.every((g) => g.kind === "favorites" || !g.open), "provider groups start COLLAPSED");
  assert(groupNamed(collapsed, "anthropic").preview === "sonnet-4.5 · opus-4.1 · haiku-4", "collapsed header previews model names with the claude- prefix stripped");

  const many = buildCatalogView({ entries: ENTRIES, query: "", favorites: [], provOpen: {}, selectedKey: keyOf("claude-haiku-4") });
  assert(groupNamed(many, "anthropic").hasSelected === true, "a collapsed group holding the current model is flagged (사용 중 badge)");

  // Search force-expands for display but must not WRITE the user's flags.
  const userFlags = { anthropic: false, openai: true };
  const searching = buildCatalogView({ entries: ENTRIES, query: "claude", favorites: [], provOpen: userFlags, selectedKey: "" });
  assert(groupNamed(searching, "anthropic").open === true, "every group renders expanded while searching");
  assert(userFlags.anthropic === false && userFlags.openai === true, "the user's collapse flags are READ, never mutated");
  const restored = buildCatalogView({ entries: ENTRIES, query: "", favorites: [], provOpen: userFlags, selectedKey: "" });
  assert(groupNamed(restored, "anthropic").open === false && groupNamed(restored, "openai").open === true, "clearing the search restores exactly the shape the user left");
}

// --- 4. opening the catalog ----------------------------------------------
console.log("\nInitial expansion on open:");
{
  const onNormal = initialProvOpen(ENTRIES, keyOf("claude-opus-4.1"), FAVS);
  assert(onNormal.anthropic === true && Object.keys(onNormal).length === 1, "the current model's provider group is expanded");
  const onFav = initialProvOpen(ENTRIES, keyOf("gpt-5"), FAVS);
  assert(Object.keys(onFav).length === 0, "nothing expands when the current model is starred (already pinned on top)");
}

// --- 5. favourite storage policy -----------------------------------------
console.log("\nFavourite storage (never auto-pruned):");
{
  assert(normalizeFavoriteModels(["a", "a", "", 7, " b "]).join() === "a,b", "normalize dedupes, trims and drops non-strings");
  assert(normalizeFavoriteModels("nope").length === 0, "a non-array stored value degrades to empty");
  assert(toggleFavoriteModel(["a", "b"], "a").join() === "b", "toggle removes a starred id");
  assert(toggleFavoriteModel(["a"], "b").join() === "a,b", "toggle appends a new id");

  const { resolved, unresolved } = resolveFavoriteModels(["gpt-5", "retired-model"], ROUTES.map((r) => r.model));
  assert(resolved.join() === "gpt-5", "only ids the catalog can resolve are renderable");
  assert(unresolved.join() === "retired-model", "an unresolvable id is REPORTED, not silently dropped");

  // The ghost guard: an id with no model must never reach the rendered list.
  const ghosted = buildCatalogView({ entries: ENTRIES, query: "", favorites: ["gpt-5", "retired-model"], provOpen: {}, selectedKey: "" });
  assert(ghosted.favoriteCount === 1, "the header counts SHOWN favourites, not stored ones");
  assert(modelsIn(groupNamed(ghosted, "favorites")).join() === "gpt-5", "an unresolvable favourite draws no ghost row");
}

// --- 6. rendered modal ----------------------------------------------------
console.log("\nRendered catalog:");
/* One modal at a time: the previous case's copy is portaled into the same body,
   so leaving it mounted would make the queries below hit the WRONG modal (and
   leave a second Escape listener attached). */
let mounted = null;
function render(node) {
  if (mounted) {
    mounted.root.unmount();
    mounted.host.remove();
  }
  const host = window.document.createElement("div");
  window.document.body.appendChild(host);
  const root = reactDom.createRoot(host);
  root.render(node);
  mounted = { root, host };
  return host;
}
// Favourites arrive through a publish/subscribe effect, so the first paint is
// pre-publish; settle a few macrotasks before asserting on the list.
const flush = async () => { for (let i = 0; i < 4; i += 1) { await new Promise((r) => setTimeout(r, 0)); } };
const click = (el) => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
/** React tracks an input's value, so assigning `.value` is ignored — go through
 *  the native setter the way a real keystroke does. */
const type = (input, value) => {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
};
const q = (sel) => window.document.querySelector(sel);
const qa = (sel) => [...window.document.querySelectorAll(sel)];
const rowNames = () => qa(".wb-model-row .wb-model-name .wb-mono").map((n) => n.textContent);

function Harness({ favorites, onToggle, onClose = () => {} }) {
  const [list, setList] = React.useState(favorites);
  usePublishFavoriteModels(list, (id) => { onToggle(id); setList((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id])); });
  return React.createElement(ModelCatalogModal, {
    title: "Runtime", routes: ROUTES, value: { model: "claude-sonnet-4.5" },
    config: {}, onApply: () => {}, onClose,
  });
}

{
  __resetFavoriteModelPrefs();
  const toggled = [];
  render(React.createElement(Harness, { favorites: FAVS, onToggle: (id) => toggled.push(id) }));
  await flush();

  assert(q(".wb-model-search-input") !== null, "the search field renders");
  assert(q(".wb-model-search-row") && !q(".wb-model-scroll .wb-model-search-row"), "the search row sits OUTSIDE the scrolling list");
  assert(q(".wb-model-list-head .wb-mono").textContent === "6 available · ★ 2", "header shows the browsing count");
  assert(rowNames().join() === "claude-sonnet-4.5,gpt-5", "only the favourites' rows are visible — provider groups start collapsed");
  assert(q(".wb-model-search-clear") === null, "the clear button is hidden while the query is empty");

  // Star must not select.
  const before = q(".wb-model-row.is-selected .wb-model-name .wb-mono").textContent;
  const gptStar = qa(".wb-model-row")[1].querySelector(".wb-model-star");
  click(gptStar); await flush();
  assert(toggled.join() === "gpt-5", "clicking the star toggles that model's favourite");
  assert(q(".wb-model-row.is-selected .wb-model-name .wb-mono").textContent === before, "the star click did NOT change the selection");

  // Expanding a provider group.
  const anthropicHeader = qa(".wb-model-provider-btn").find((b) => b.textContent.includes("Claude"));
  assert(anthropicHeader.getAttribute("aria-expanded") === "false", "provider header reports collapsed");
  click(anthropicHeader); await flush();
  assert(rowNames().includes("claude-opus-4.1"), "clicking the header expands the group");
}

{
  __resetFavoriteModelPrefs();
  let closed = 0;
  render(React.createElement(Harness, { favorites: FAVS, onToggle: () => {}, onClose: () => { closed += 1; } }));
  await flush();
  const input = q(".wb-model-search-input");

  type(input, "Llama");
  await flush();
  assert(q(".wb-model-empty") !== null, "no match draws the empty state");
  assert(q(".wb-model-empty p").textContent.includes('"Llama"'), "the empty state echoes the query in the user's ORIGINAL casing");
  assert(q(".wb-model-list-head .wb-mono").textContent === "0 / 6 일치", "header switches to the match count");
  assert(q(".wb-model-search-clear") !== null, "the clear button appears once there is a query");

  // Escape must not close the modal out from under a search.
  window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await flush();
  assert(closed === 0, "Escape with a query does NOT close the modal");
  assert(q(".wb-model-search-input").value === "", "Escape cleared the query instead");
  window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await flush();
  assert(closed === 1, "a second Escape, with the query empty, closes as before");
}

{
  // Filtering is display-only: the selected model must survive being filtered out.
  __resetFavoriteModelPrefs();
  render(React.createElement(Harness, { favorites: [], onToggle: () => {} }));
  await flush();
  const input = q(".wb-model-search-input");
  type(input, "o4-mini");
  await flush();
  assert(rowNames().join() === "o4-mini", "the list filtered down to the single match");
  assert(q(".wb-model-detail .wb-detail-head .wb-mono").textContent === "claude-sonnet-4.5", "the filtered-out model stays SELECTED and its detail panel is unchanged");
}

console.log(failures.length ? `\n${failures.length} failure(s)` : "\nall good");
process.exit(failures.length ? 1 : 0);
