/* Real Electron E2E for the seven Settings color-theme presets. */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspace = path.join(os.tmpdir(), "agentparty-theme-ws");
const userData = path.join(os.tmpdir(), "agentparty-theme-ud");
const settingsPath = path.join(userData, "settings.json");
const port = Number(process.env.AGENTPARTY_THEME_PORT || "") || 48971;
const base = `http://127.0.0.1:${port}`;
const presets = [
  { id: "agentparty-light", label: "AgentParty Light", bg0: "#e7e8eb", panel: "#ffffff", text: "#171a1f", accent: "#3f6fe6", selection: "#cbd8f8", status: "#3f6fe6", original: { "--bg-1": "#f3f4f6", "--bg-3": "#eef0f3", "--bg-4": "#e6e9ed", "--bg-input": "#ffffff", "--border-subtle": "#e2e5ea", "--border": "#d3d7df", "--border-strong": "#c0c5ce", "--text-1": "#454b56", "--text-2": "#6c7480", "--text-3": "#9aa1ac", "--live": "#b9791d", "--success": "#2f8f5e", "--danger": "#cf4b45", "--warning": "#b07816" } },
  { id: "agentparty-dark", label: "AgentParty Dark", bg0: "#0a0b0e", panel: "#14171d", text: "#e7e9ee", accent: "#5b8cff", selection: "#263b70", status: "#5b8cff", original: { "--bg-1": "#0e1014", "--bg-3": "#1b1f27", "--bg-4": "#222731", "--bg-input": "#0c0e12", "--border-subtle": "#1c2028", "--border": "#262b35", "--border-strong": "#333a46", "--text-1": "#aeb4c0", "--text-2": "#79808d", "--text-3": "#535965", "--live": "#e0a14e", "--success": "#54b585", "--danger": "#e0635d", "--warning": "#d9a441" } },
  { id: "github-light", label: "GitHub Light", bg0: "#f6f8fa", panel: "#ffffff", text: "#1f2328", accent: "#0969da", selection: "#b6d7ff", status: "#0969da" },
  { id: "github-dark", label: "GitHub Dark", bg0: "#0d1117", panel: "#161b22", text: "#f0f6fc", accent: "#58a6ff", selection: "#264f78", status: "#1f6feb" },
  { id: "dracula", label: "Dracula", bg0: "#282a36", panel: "#30323f", text: "#f8f8f2", accent: "#bd93f9", selection: "#44475a", status: "#6272a4" },
  { id: "nord", label: "Nord", bg0: "#2e3440", panel: "#3b4252", text: "#eceff4", accent: "#88c0d0", selection: "#4c566a", status: "#5e81ac" },
  { id: "solarized-dark", label: "Solarized Dark", bg0: "#002b36", panel: "#073642", text: "#fdf6e3", accent: "#2aa198", selection: "#075b6b", status: "#268bd2" },
];
const failures = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (condition, message) => { console.log(`  ${condition ? "PASS" : "FAIL"} ${message}`); if (!condition) failures.push(message); };

async function request(method, url, body) {
  const response = await fetch(`${base}${url}`, { method, headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  let payload = null;
  try { payload = await response.json(); } catch { payload = { error: await response.text() }; }
  return { status: response.status, payload };
}

async function waitForApi() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try { if ((await request("GET", "/api/health")).payload?.ok) return; } catch { /* starting */ }
    await delay(500);
  }
  throw new Error("Automation API did not start");
}

function killTree(pid) { if (pid) try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* closed */ } }
function launch() {
  return spawn(process.env.ComSpec || "cmd.exe", ["/c", "npm", "run", "start"], {
    cwd: root, stdio: ["ignore", "ignore", "inherit"], windowsHide: true,
    env: { ...process.env, AGENTPARTY_QA: "1", AGENTPARTY_ALLOW_MULTI_INSTANCE: "1", AGENTPARTY_AUTOMATION_PORT: String(port), AGENTPARTY_USER_DATA: userData },
  });
}

async function run(label, fn) {
  let child;
  try { child = launch(); await waitForApi(); await fn(); }
  catch (error) { console.error(label, error); failures.push(`${label}: ${error?.message || error}`); }
  finally { killTree(child?.pid); await delay(500); }
}

async function htmlTheme(windowId) {
  const query = windowId ? `?window=${encodeURIComponent(windowId)}` : "";
  const { payload } = await request("POST", `/api/measure${query}`, { selector: "html", attributes: ["data-theme", "data-theme-preference", "data-theme-paint"], styles: ["--bg-0", "--bg-1", "--bg-2", "--bg-3", "--bg-4", "--bg-input", "--border-subtle", "--border", "--border-strong", "--text-0", "--text-1", "--text-2", "--text-3", "--accent", "--selection", "--status", "--live", "--success", "--danger", "--warning", "--focus-ring-width"], limit: 1 });
  const element = payload?.elements?.[0];
  if (!element) throw new Error(payload?.error || "html was not measurable");
  return { theme: element.attributes["data-theme"], preference: element.attributes["data-theme-preference"], paint: element.attributes["data-theme-paint"], styles: element.styles };
}

async function choosePreset(index, windowId) {
  const query = `?window=${encodeURIComponent(windowId)}`;
  await request("POST", `/api/qa/input${query}`, { selector: "[data-theme-select]", select: presets[index].id });
  await delay(350);
}

async function plantCache(themePreference, theme) {
  const result = await request("POST", "/api/qa/appearance/storage", { themePreference, theme });
  assert(result.status === 200 && result.payload?.themePreference === themePreference && result.payload?.theme === theme, `renderer cache planted as ${themePreference}/${theme}`);
}

async function verifyCacheMigration(expected, label) {
  const painted = await htmlTheme();
  assert(painted.theme === expected && painted.preference === expected && painted.paint === "sync", `${label} drives synchronous first paint`);
  await delay(500);
  const state = await request("GET", "/api/appearance/theme");
  assert(state.payload?.preference === expected && state.payload?.stored === true, `${label} migrates through AppController into settings`);
  const saved = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert(saved.theme === expected, `${label} is permanently saved`);
  const cache = await request("POST", "/api/qa/appearance/storage", {});
  assert(cache.payload?.themePreference === expected && cache.payload?.theme === expected, `${label} normalizes both renderer cache keys`);
}

function cssHex(value) { return String(value || "").trim().toLowerCase(); }

async function main() {
  for (const target of [workspace, userData]) try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* absent */ }
  fs.mkdirSync(workspace, { recursive: true });

  await run("seven-presets", async () => {
    const initial = await request("GET", "/api/appearance/theme");
    assert(initial.payload?.preference === "agentparty-light", "fresh install defaults to AgentParty Light");
    assert(JSON.stringify(initial.payload?.options) === JSON.stringify(presets.map(({ id }) => id)), "API exposes exactly seven presets");
    const spec = (await request("GET", "/api/spec")).payload?.endpoints || [];
    assert(spec.includes("GET /api/appearance/theme") && spec.includes("POST /api/appearance/theme"), "appearance routes are published in /api/spec");
    assert(!spec.includes("POST /api/qa/appearance/os"), "removed nativeTheme QA route is absent");

    const windows = (await request("GET", "/api/windows")).payload?.windows || [];
    const win1 = windows[0]?.id;
    const win2 = (await request("POST", "/api/windows", { workspacePath: workspace })).payload?.id;
    assert(Boolean(win1 && win2 && win1 !== win2), "second real BrowserWindow opened");

    const navigation = await request("POST", `/api/navigation?window=${encodeURIComponent(win1)}`, { view: "settings", tab: "general" });
    assert(navigation.status === 200, "navigation opens Settings > General");
    await delay(500);
    const options = (await request("POST", `/api/measure?window=${encodeURIComponent(win1)}`, { selector: "[data-theme-select] option", attributes: ["value"], styles: [], limit: 10 })).payload?.elements || [];
    assert(options.length === 7, "Settings has one dropdown with exactly seven options");
    assert(options.map((entry) => entry.attributes.value).join(",") === presets.map(({ id }) => id).join(","), "dropdown option ids are exact");
    assert(options.map((entry) => entry.text).join(",") === presets.map(({ label }) => label).join(","), "dropdown labels are exact");
    const trigger = (await request("POST", `/api/measure?window=${encodeURIComponent(win1)}`, { selector: "[data-theme-menu-trigger]", attributes: ["aria-haspopup", "aria-expanded"], styles: [], limit: 1 })).payload?.elements?.[0];
    assert(trigger?.attributes?.["aria-haspopup"] === "menu", "titlebar exposes an ARIA theme menu trigger");
    await request("POST", `/api/capture?window=${encodeURIComponent(win1)}`, { path: path.join(os.tmpdir(), "agentparty-theme-menu.png"), click: "[data-theme-menu-trigger]" });
    await delay(150);
    const menuOptions = (await request("POST", `/api/measure?window=${encodeURIComponent(win1)}`, { selector: "[data-theme-menu-option]", attributes: ["data-theme-menu-option", "aria-checked"], styles: [], limit: 10 })).payload?.elements || [];
    assert(menuOptions.length === 7, "titlebar menu contains the same seven presets");
    await request("POST", `/api/capture?window=${encodeURIComponent(win1)}`, { path: path.join(os.tmpdir(), "agentparty-theme-menu-agentparty-dark.png"), click: "[data-theme-menu-option=agentparty-dark]" });
    await delay(350);
    assert((await request("GET", "/api/appearance/theme")).payload?.preference === "agentparty-dark", "titlebar menu selects AgentParty Dark through AppController");
    await request("POST", `/api/navigation?window=${encodeURIComponent(win1)}`, { view: "settings", tab: "general" });
    await delay(150);
    const syncedSelect = await request("POST", `/api/qa/input?window=${encodeURIComponent(win1)}`, { selector: "[data-theme-select]" });
    assert(syncedSelect.payload?.value === "agentparty-dark", "Settings dropdown reflects the titlebar AgentParty Dark selection");
    await request("POST", `/api/capture?window=${encodeURIComponent(win1)}`, { path: path.join(os.tmpdir(), "agentparty-theme-menu-escape.png"), click: "[data-theme-menu-trigger]" });
    await request("POST", `/api/qa/input?window=${encodeURIComponent(win1)}`, { selector: "[data-theme-menu-option=agentparty-dark]", key: "Escape" });
    await delay(100);
    const closedMenu = await request("POST", `/api/measure?window=${encodeURIComponent(win1)}`, { selector: "[data-theme-menu]", styles: [], limit: 1 });
    assert(Boolean(closedMenu.payload?.error), "Escape closes the titlebar theme menu");

    for (let index = 0; index < presets.length; index += 1) {
      const preset = presets[index];
      await request("POST", `/api/navigation?window=${encodeURIComponent(win1)}`, { view: "settings", tab: "general" });
      await delay(150);
      await choosePreset(index, win1);
      const state = await request("GET", "/api/appearance/theme");
      assert(state.payload?.preference === preset.id && state.payload?.applied === preset.id, `${preset.label} selected through the real dropdown`);
      assert(state.payload?.background === preset.bg0, `${preset.label} BrowserWindow background matches bg-0`);
      for (const [name, windowId] of [["window 1", win1], ["window 2", win2]]) {
        const painted = await htmlTheme(windowId);
        assert(painted.theme === preset.id && painted.preference === preset.id, `${preset.label} broadcasts to ${name}`);
        assert(cssHex(painted.styles["--bg-0"]) === preset.bg0 && cssHex(painted.styles["--bg-2"]) === preset.panel, `${preset.label} ${name} background/panel tokens compute correctly`);
        assert(cssHex(painted.styles["--text-0"]) === preset.text && cssHex(painted.styles["--accent"]) === preset.accent, `${preset.label} ${name} text/accent tokens compute correctly`);
        assert(cssHex(painted.styles["--selection"]) === preset.selection && cssHex(painted.styles["--status"]) === preset.status, `${preset.label} ${name} selection/status tokens compute correctly`);
        if (preset.original) {
          assert(Object.entries(preset.original).every(([token, value]) => cssHex(painted.styles[token]) === value), `${preset.label} ${name} preserves original 23dc88b computed tokens`);
          assert(painted.styles["--focus-ring-width"] === "1px", `${preset.label} ${name} preserves original 1px focus ring`);
        }
      }
    }

    const invalid = await request("POST", "/api/appearance/theme", { theme: "dark" });
    assert(invalid.status === 400 && invalid.payload?.code === "invalid_theme", "removed legacy id is strict invalid_theme 400");
    assert(String(invalid.payload?.error).includes("dark"), "invalid diagnostic names the rejected value");
    const missing = await request("POST", "/api/appearance/theme", {});
    assert(missing.status === 400 && missing.payload?.code === "invalid_theme", "missing theme is strict invalid_theme 400");
    const viaSettings = await request("POST", "/api/settings", { theme: "auto" });
    assert(viaSettings.status === 400 && viaSettings.payload?.code === "invalid_theme", "settings route shares strict validation");
    assert((await request("GET", "/api/appearance/theme")).payload?.preference === "solarized-dark", "invalid input does not overwrite selection");

    const saved = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    assert(saved.theme === "solarized-dark", "dropdown selection persists to settings.json");
    const planted = await request("POST", "/api/qa/appearance/storage", { theme: "light", themePreference: "github-light" });
    assert(planted.payload?.themePreference === "github-light", "stale cache planted against stored Solarized Dark");
  });

  await run("restart-first-paint", async () => {
    const state = await request("GET", "/api/appearance/theme");
    assert(state.payload?.preference === "solarized-dark" && state.payload?.stored === true, "saved preset survives restart");
    const painted = await htmlTheme();
    assert(painted.theme === "solarized-dark" && painted.preference === "solarized-dark", "synchronous first paint beats stale cache");
    assert(painted.paint === "sync", "data-theme-paint=sync proves pre-React paint");
    assert(cssHex(painted.styles["--bg-0"]) === "#002b36", "restarted first-paint token is Solarized Dark");
    await plantCache("system", "dark");
  });

  for (const scenario of [
    { id: "agentparty-dark", label: "legacy system + dark cache", nextPreference: "light", nextTheme: "light" },
    { id: "agentparty-light", label: "legacy light cache", nextPreference: "nord", nextTheme: "dark" },
    { id: "nord", label: "valid Nord preference + stale dark cache", nextPreference: "dracula", nextTheme: "light" },
    { id: "dracula", label: "valid Dracula preference + stale light cache", nextPreference: "solarized-dark", nextTheme: "dark" },
    { id: "solarized-dark", label: "valid Solarized Dark preference + stale dark cache" },
  ]) {
    try { fs.rmSync(settingsPath, { force: true }); } catch { /* absent */ }
    await run(`cache-${scenario.id}`, async () => {
      await verifyCacheMigration(scenario.id, scenario.label);
      if (scenario.nextPreference) await plantCache(scenario.nextPreference, scenario.nextTheme);
    });
  }

  for (const target of [workspace, userData]) try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* absent */ }
  if (failures.length) {
    console.error(`theme E2E failed (${failures.length})`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log("theme E2E passed");
}

await main();
