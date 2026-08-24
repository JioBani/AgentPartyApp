/*
 * Settings mount fires a quiet update check so the titlebar pill and the
 * 버전 tab are not stuck on the startup / 6-hour result. Locks:
 *   1) opening the settings screen calls checkForUpdate({ quiet: true })
 *   2) switching to the 버전 tab asks again (list refresh rides that check)
 * Does not boot Electron — the renderer is mounted in jsdom against a mock bridge.
 */
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { qaTempDir } from "./lib/qaTemp.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };

const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
const { window } = dom;
const def = (n, v) => { try { Object.defineProperty(globalThis, n, { value: v, configurable: true, writable: true }); } catch {} };
def("window", window);
def("document", window.document);
def("HTMLElement", window.HTMLElement);
def("Node", window.Node);
def("navigator", window.navigator);
def("getComputedStyle", window.getComputedStyle.bind(window));
def("requestAnimationFrame", (cb) => setTimeout(() => cb(Date.now()), 0));
def("cancelAnimationFrame", clearTimeout);
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.ResizeObserver = window.ResizeObserver;
window.HTMLElement.prototype.scrollIntoView = () => {};
if (!window.navigator.clipboard) {
  Object.defineProperty(window.navigator, "clipboard", { value: { writeText: async () => {} }, configurable: true });
}

const checks = [];
window.agentParty = {
  checkForUpdate: async (options) => {
    checks.push(options || {});
    return { ok: true, update: { state: "up-to-date", channel: "stable", currentVersion: "0.3.0", latestVersion: "0.3.0", checkedAt: new Date().toISOString() } };
  },
  getUpdateStatus: async () => ({ ok: true, update: { state: "idle", channel: "stable", currentVersion: "0.3.0" } }),
  listUpdateVersions: async () => ({ ok: true, releases: [] }),
  onUpdateStatus: () => () => {},
  getEnvironment: async () => ({ checks: [] }),
  getDiagnostics: async () => ({ build: {}, host: {}, logFile: "" }),
  openExternal: async () => {},
};
globalThis.window = window;

const outDir = qaTempDir();
async function load(entry, name) {
  const result = await build({
    entryPoints: [path.join(projectRoot, entry)],
    bundle: true,
    format: "esm",
    platform: "browser",
    jsx: "automatic",
    loader: { ".css": "empty" },
    define: { "process.env.NODE_ENV": '"development"' },
    external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "electron"],
    plugins: [{
      name: "node-builtins",
      setup(buildApi) {
        buildApi.onResolve({ filter: /^node:/ }, (args) => ({ path: args.path, namespace: "node-stub" }));
        buildApi.onLoad({ filter: /.*/, namespace: "node-stub" }, () => ({
          contents: "const join = (...parts) => parts.filter(Boolean).join('/'); export default { join, win32: { join: (...p) => p.filter(Boolean).join('\\\\') } }; export { join }; export const dirname = () => ''; export const resolve = (...parts) => parts.filter(Boolean).join('/'); export const basename = (p) => String(p).split(/[\\\\/]/).pop(); export const sep = '/'; export const posix = { join }; export const win32 = { join: (...p) => p.filter(Boolean).join('\\\\') };",
          loader: "js",
        }));
      },
    }],
    write: false,
  });
  const file = path.join(outDir, name);
  writeFileSync(file, result.outputFiles[0].text);
  return import(pathToFileURL(file).href);
}

const { SettingsView } = await load("src/renderer/app/secondaryViews.tsx", "settings-view.mjs");
const { I18nProvider } = await load("src/renderer/i18n/I18nProvider.tsx", "i18n.mjs");
const React = await import("react");
const reactDom = await import("react-dom/client");

const settings = {
  locale: "ko",
  theme: "system",
  fonts: { sans: "Maplestory", mono: "Geist Mono" },
  debugEnabled: false,
  mobile: { enabled: false },
};

const noop = () => {};
const host = window.document.createElement("div");
window.document.body.appendChild(host);
const root = reactDom.createRoot(host);
root.render(React.createElement(I18nProvider, { locale: "ko" }, React.createElement(SettingsView, {
  automationApi: { baseUrl: "http://127.0.0.1:1", spec: "/api/spec" },
  logs: { logFilePath: "" },
  router: "http://127.0.0.1:1",
  settings,
  onToggleDebug: noop,
  onSaveTheme: noop,
  onSaveFonts: noop,
  onSaveLocale: noop,
  onSaveExecutablePaths: noop,
  cwdPrefs: { windowsRecent: [], wslRecent: [] },
  cwdDefaultUsage: {},
  memberLocations: [],
  now: Date.now(),
  onPickDefaultCwd: noop,
  onClearDefaultCwd: noop,
  onPromoteRecentCwd: noop,
  onRemoveRecentCwd: noop,
  onRecheckRecentCwd: noop,
  onCloneMember: noop,
})));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
await flush();
await flush();

assert(checks.length >= 1, "opening settings asks the update feed");
assert(checks[0]?.quiet === true, "settings-enter check is quiet (does not flash checking)");
const afterMount = checks.length;

const versionsTab = [...host.querySelectorAll("[role=tab]")].find((el) => /버전/.test(el.textContent || ""));
assert(!!versionsTab, "versions tab is on the settings strip");
versionsTab.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await flush();
await flush();
assert(checks.length > afterMount, "opening the versions tab re-asks so the list is current");
assert(checks.slice(afterMount).every((call) => call.quiet === true), "versions-tab re-check is also quiet");

if (failures.length) {
  throw new Error(`SETTINGS UPDATE CHECK QA FAILED: ${failures.join("; ")}`);
}
console.log("SETTINGS UPDATE CHECK QA PASSED");
