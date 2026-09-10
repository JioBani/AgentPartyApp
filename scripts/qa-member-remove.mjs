/*
 * Regression for the Workbench sidebar delete controls (right-click context
 * menu):
 *  - Member rows → '삭제하기' calls onRemoveMember, 'main' included: it is the
 *    member a party is born with, not a protected role.
 *  - Party rows → a two-step confirm: the first click arms ('파티 삭제…'), the
 *    second calls onRemoveParty. Deleting a party cascades to its members, so
 *    the confirm guards against an accidental single click.
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
const r = await build({ entryPoints: [path.join(projectRoot, "src/renderer/workbench/PartySidebar.tsx")], bundle: true, format: "esm", platform: "browser", jsx: "automatic", loader: { ".css": "empty" }, define: { "process.env.NODE_ENV": '"development"' }, external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"], write: false });
const bundlePath = path.join(outDir, "sidebar-remove.mjs"); writeFileSync(bundlePath, r.outputFiles[0].text);
const { PartySidebar } = await import(pathToFileURL(bundlePath).href);
const React = await import("react");
const reactDom = await import("react-dom/client");

const mkView = (name) => ({ name, color: "#888", member: { name, partyId: "p1", status: "idle", runtime: "claude-code", role: "" }, status: "idle", unread: 0, pendingApproval: false, busy: false, model: "sonnet", effort: "medium", permissionMode: "default", transcript: [] });
let removed = [];
let removedParties = [];
const props = {
  groups: [{ id: "default", name: "Default", kind: "default", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }],
  partySummaries: [{ id: "p1", groupId: "default", name: "P", memberCount: 2, runningCount: 0, windowsCount: 2, wslCount: 0, updatedAt: "2026-01-01T00:00:00.000Z" }],
  cwdPrefs: { windowsRecent: [], wslRecent: [] }, appWorkspaceRoot: "C:\\Project", now: Date.parse("2026-01-01T00:00:00.000Z"),
  activePartyId: "p1", views: [mkView("main"), mkView("alice")], openMembers: new Set(),
  drawers: { party: { open: true, width: 236 }, member: { open: true, width: 210 } },
  routes: [], defaultProfile: { harness: "claude-code", model: "sonnet", effort: "medium", permissionMode: "default" }, harnessDefaults: {},
  onSelectParty: () => {}, onCreateParty: () => {}, onCreateGroup: () => {}, onMovePartyToGroup: () => {},
  onRenameGroup: () => {}, onRemoveGroup: () => {}, onReorderGroups: () => {}, onBrowseCwd: async () => null,
  onCreateMember: () => {}, onOpenMember: () => {}, onRestartMember: () => {}, onSetMemberKeepAwake: () => {}, onSleepMember: () => {}, onWakeMember: () => {},
  onRemoveMember: (name) => removed.push(name), onRemoveParty: (id) => removedParties.push(id),
  onOpenPartyGate: () => {}, onOpenPartyInNewWindow: () => {}, onToggleDrawer: () => {},
  favoriteParties: [], onToggleFavoriteParty: () => {},
  groupFolds: { party: [], member: [] }, onToggleGroupFold: () => {},
};
reactDom.createRoot(document.getElementById("root")).render(React.createElement(PartySidebar, props));
await new Promise((r) => setTimeout(r, 80));

const click = (el) => el?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const rightClick = (el) => el?.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, clientX: 50, clientY: 50 }));
const rows = [...document.querySelectorAll(".wb-member-row")];
const rowFor = (name) => rows.find((row) => row.querySelector(".wb-member-name")?.textContent === name);
const tick = () => new Promise((r) => setTimeout(r, 30));

console.log("\nMember-remove (right-click context menu) assertions:");
assert(rows.length === 2, "both members rendered");

// Right-click 'main' → an ORDINARY member menu, 삭제하기 included: 'main' is the
// member a party is born with, not a protected role, so the menu offers exactly
// what it offers for any other member. 항상 실행 상태 유지 applies to it too, so the
// menu now opens; only the delete item stays absent.
rightClick(rowFor("main")); await tick();
const mainCtx = document.querySelector(".wb-ctx-menu");
assert(Boolean(mainCtx), "right-click on 'main' opens a context menu");
const mainItems = mainCtx ? [...mainCtx.querySelectorAll(".wb-ctx-item")] : [];
assert(mainItems.some((b) => /삭제하기/.test(b.textContent || "")), "'main' context menu offers 삭제하기 like any other member");
assert(mainItems.some((b) => /항상 실행 상태 유지/.test(b.textContent || "")), "'main' context menu offers 항상 실행 상태 유지");

// Right-click 'alice' → a context menu with a delete item appears; no removal yet.
rightClick(rowFor("alice")); await tick();
const ctx = document.querySelector(".wb-ctx-menu");
assert(Boolean(ctx), "right-click on 'alice' opens a context menu");
const del = ctx && [...ctx.querySelectorAll(".wb-ctx-item")].find((b) => /삭제하기/.test(b.textContent || ""));
assert(Boolean(del), "context menu shows a '삭제하기' item");
assert(removed.length === 0, "opening the menu does not remove anything yet");

// Click '삭제하기' → onRemoveMember('alice'), menu closes.
click(del); await tick();
assert(removed.length === 1 && removed[0] === "alice", "clicking '삭제하기' calls onRemoveMember('alice')");
assert(!document.querySelector(".wb-ctx-menu"), "menu closes after deleting");

console.log("\nParty-remove (right-click, two-step confirm) assertions:");
const partyRow = document.querySelector(".wb-party-row");
assert(Boolean(partyRow), "a party row is rendered");

// Right-click the party → menu shows a first-step '파티 삭제…' (not yet armed).
rightClick(partyRow); await tick();
const pctx = document.querySelector(".wb-ctx-menu");
const step1 = pctx && [...pctx.querySelectorAll(".wb-ctx-item")].find((b) => /파티 삭제…/.test(b.textContent || ""));
assert(Boolean(step1), "right-click on a party opens a '파티 삭제…' first step");
assert(removedParties.length === 0, "the first step does not delete the party");

// First click arms the confirm; still no deletion.
click(step1); await tick();
const confirm = [...document.querySelectorAll(".wb-ctx-menu .wb-ctx-item")]
  .find((button) => /다시 선택하여 확인/.test(button.textContent || ""));
assert(confirm && /다시 선택하여 확인/.test(confirm.textContent || ""), "first click arms the explicit delete confirmation");
assert(removedParties.length === 0, "arming the confirm still does not delete the party");

// Second click deletes; menu closes.
click(confirm); await tick();
assert(removedParties.length === 1 && removedParties[0] === "p1", "the confirming click calls onRemoveParty('p1')");
assert(!document.querySelector(".wb-ctx-menu"), "menu closes after deleting the party");

console.log(failures.length ? `\nMEMBER/PARTY REMOVE FAILED (${failures.length})` : "\nMEMBER/PARTY REMOVE PASSED");
process.exit(failures.length ? 1 : 0);
