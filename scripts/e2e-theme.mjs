/*
 * Full-process E2E for appearance (System / Light / Dark).
 *
 * First paint is owned by main (settings + nativeTheme), passed into the
 * renderer before load. localStorage is only a true-legacy dark path.
 *
 * OS colour-scheme: Windows cannot be flipped from this process. QA therefore
 * drives `POST /api/qa/appearance/os`, which is the nativeTheme signal the app
 * already listens to.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspace = path.join(os.tmpdir(), "agentparty-theme-ws");
const userData = path.join(os.tmpdir(), "agentparty-theme-ud");
const port = Number(process.env.AGENTPARTY_THEME_PORT || "") || 48971;
const base = `http://127.0.0.1:${port}`;
const failures = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (condition, message) => {
  console.log(`  ${condition ? "PASS" : "FAIL"} ${message}`);
  if (!condition) failures.push(message);
};

async function request(method, url, body) {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload = null;
  try { payload = await response.json(); } catch { payload = { error: await response.text() }; }
  return { status: response.status, payload };
}

async function waitForApi() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      if ((await request("GET", "/api/health")).payload?.ok) return;
    } catch { /* app is still starting */ }
    await delay(500);
  }
  throw new Error("Automation API did not start");
}

function killTree(pid) {
  if (!pid) return;
  try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* already closed */ }
}

function launch() {
  return spawn(process.env.ComSpec || "cmd.exe", ["/c", "npm", "run", "start"], {
    cwd: root,
    stdio: ["ignore", "ignore", "inherit"],
    windowsHide: true,
    env: {
      ...process.env,
      AGENTPARTY_QA: "1",
      AGENTPARTY_ALLOW_MULTI_INSTANCE: "1",
      AGENTPARTY_AUTOMATION_PORT: String(port),
      AGENTPARTY_USER_DATA: userData,
    },
  });
}

async function htmlTheme(windowId) {
  const suffix = windowId ? `?window=${encodeURIComponent(windowId)}` : "";
  const { payload } = await request("POST", `/api/measure${suffix}`, {
    selector: "html",
    attributes: ["data-theme", "data-theme-preference", "data-theme-paint"],
    limit: 1,
  });
  if (!payload?.ok && !payload?.elements) {
    throw new Error(`Could not measure html theme: ${payload?.error || "unknown error"}`);
  }
  const attributes = payload.elements?.[0]?.attributes || {};
  return {
    applied: payload.theme || attributes["data-theme"] || "",
    preference: attributes["data-theme-preference"] || "",
    paint: attributes["data-theme-paint"] || "",
  };
}

async function run(label, fn) {
  let child;
  try {
    child = launch();
    await waitForApi();
    await fn();
  } catch (error) {
    console.error(label, error);
    failures.push(`${label}: ${error?.message || error}`);
  } finally {
    killTree(child?.pid);
    await delay(500);
  }
}

async function main() {
  for (const target of [workspace, userData]) {
    try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* absent */ }
  }
  fs.mkdirSync(workspace, { recursive: true });

  await run("plant-legacy", async () => {
    const initial = await request("GET", "/api/appearance/theme");
    assert(initial.payload?.preference === "light", "a fresh install defaults to light");
    assert(initial.payload?.stored === false, "a missing settings.json theme is not an explicit choice");
    const stored = await request("POST", "/api/qa/appearance/storage", { theme: "dark", themePreference: null });
    assert(stored.status === 200 && stored.payload?.theme === "dark", "legacy localStorage dark can be planted");
    await delay(400);
  });

  {
    const settingsPath = path.join(userData, "settings.json");
    if (fs.existsSync(settingsPath)) {
      const file = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      delete file.theme;
      fs.writeFileSync(settingsPath, JSON.stringify(file, null, 2));
    }
  }

  await run("legacy-and-product", async () => {
    const spec = await request("GET", "/api/spec");
    const endpoints = spec.payload?.endpoints || [];
    assert(endpoints.includes("GET /api/appearance/theme"), "GET /api/appearance/theme is in the spec");
    assert(endpoints.includes("POST /api/appearance/theme"), "POST /api/appearance/theme is in the spec");
    assert(endpoints.includes("POST /api/qa/appearance/os"), "POST /api/qa/appearance/os is in the spec");

    let legacyPaint;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      legacyPaint = await htmlTheme();
      if (legacyPaint.applied === "dark" && legacyPaint.preference === "dark") break;
      await delay(250);
    }
    assert(legacyPaint?.applied === "dark" && legacyPaint?.preference === "dark", "legacy dark paints when settings.json has no theme");
    const migrated = await request("GET", "/api/appearance/theme");
    assert(migrated.payload?.preference === "dark" && migrated.payload?.stored === true, "legacy dark migrates into settings.json");
    assert(migrated.payload?.applied === "dark" && migrated.payload?.background === "#0a0b0e", "migrated Dark keeps dark chrome, not default Light");
    const settled = await htmlTheme();
    assert(settled.applied === "dark" && settled.preference === "dark", "renderer still shows Dark after initial state loads");

    const windows = (await request("GET", "/api/windows")).payload?.windows || [];
    const win1 = windows[0]?.id;
    const opened = await request("POST", "/api/windows", { workspacePath: workspace });
    const win2 = opened.payload?.id;
    assert(Boolean(win1 && win2 && win1 !== win2), "a second window opened in this process");

    const dark = await request("POST", "/api/appearance/theme", { theme: "dark" });
    assert(dark.status === 200 && dark.payload?.preference === "dark" && dark.payload?.applied === "dark", "POST /api/appearance/theme accepts dark");
    assert(dark.payload?.background === "#0a0b0e", "dark chrome matches bg-0");
    await delay(500);
    assert((await htmlTheme(win1)).applied === "dark", "window 1 paints dark");
    assert((await htmlTheme(win2)).applied === "dark", "window 2 received the live broadcast");

    const invalid = await request("POST", "/api/appearance/theme", { theme: "auto" });
    assert(invalid.status === 400, "an unknown theme is HTTP 400, not 500");
    assert(invalid.payload?.code === "invalid_theme", "unknown theme serializes code invalid_theme");
    assert(String(invalid.payload.error).includes("지원하지 않는 테마입니다"), "the error names the rejected value");
    assert((await request("GET", "/api/appearance/theme")).payload?.preference === "dark", "invalid input does not overwrite the current theme");

    const missing = await request("POST", "/api/appearance/theme", {});
    assert(missing.status === 400 && missing.payload?.code === "invalid_theme", "a missing theme field is 400 invalid_theme");

    const viaSettings = await request("POST", "/api/settings", { theme: "nope" });
    assert(viaSettings.status === 400 && viaSettings.payload?.code === "invalid_theme", "POST /api/settings rejects an unknown theme as 400 invalid_theme");

    const system = await request("POST", "/api/appearance/theme", { theme: "system" });
    assert(system.status === 200 && system.payload?.preference === "system", "POST /api/appearance/theme accepts system");
    await delay(400);
    const paintedSystem = await htmlTheme(win1);
    assert(paintedSystem.preference === "system", "system preference is visible on html");
    assert(paintedSystem.applied === "light" || paintedSystem.applied === "dark", "system paints an applied light or dark theme");

    const osDark = await request("POST", "/api/qa/appearance/os", { dark: true });
    assert(osDark.status === 200 && osDark.payload?.preference === "system" && osDark.payload?.applied === "dark", "QA OS-dark follows System live");
    await delay(400);
    assert((await htmlTheme(win1)).applied === "dark", "window 1 follows the nativeTheme signal");
    assert((await htmlTheme(win2)).applied === "dark", "window 2 follows the nativeTheme signal");
    const osLight = await request("POST", "/api/qa/appearance/os", { dark: false });
    assert(osLight.payload?.applied === "light", "QA OS-light follows System live");
    await delay(400);
    assert((await htmlTheme(win1)).applied === "light", "window 1 returns to light with the OS signal");

    const locked = await request("POST", "/api/appearance/theme", { theme: "light" });
    assert(locked.payload?.preference === "light", "lock light");
    const ignored = await request("POST", "/api/qa/appearance/os", { dark: true });
    assert(ignored.payload?.preference === "light" && ignored.payload?.applied === "light", "locked Light ignores the OS signal");

    await request("POST", "/api/navigation", { view: "automation" });
    await delay(500);
    const { payload: card } = await request("POST", "/api/measure", { selector: "[data-settings-card=appearance]", limit: 1 });
    assert(Boolean(card?.elements?.[0]), "Settings shows an explicit appearance selector");
    const { payload: active } = await request("POST", "/api/measure", { selector: "[data-theme-option=light].is-active", limit: 1 });
    assert(Boolean(active?.elements?.[0]), "the Settings selector marks Light as selected");

    await request("POST", "/api/appearance/theme", { theme: "system" });
    await delay(300);
    const click = await request("POST", "/api/capture", { path: path.join(os.tmpdir(), "agentparty-theme-click.png"), click: "[data-theme-toggle]" });
    assert(click.status === 200 && click.payload?.ok !== false, "the title-bar shortcut is clickable");
    await delay(400);
    assert((await request("GET", "/api/appearance/theme")).payload?.preference === "light", "title-bar cycles system → light");

    await request("POST", "/api/appearance/theme", { theme: "dark" });
    await delay(300);
    const planted = await request("POST", "/api/qa/appearance/storage", { theme: "light", themePreference: "light" });
    assert(planted.status === 200 && planted.payload?.themePreference === "light", "stale light cache planted against stored dark");
  });

  await run("settings-beat-stale-cache", async () => {
    const restarted = await request("GET", "/api/appearance/theme");
    assert(restarted.payload?.preference === "dark", "settings.json dark survives restart");
    assert(restarted.payload?.applied === "dark", "authoritative boot is dark, not the stale light cache");
    assert(restarted.payload?.stored === true, "settings.json still has an explicit theme after restart");
    assert(restarted.payload?.background === "#0a0b0e", "restarted window chrome is dark bg-0");
    const painted = await htmlTheme();
    assert(painted.preference === "dark" && painted.applied === "dark", "first paint follows settings, not localStorage");
    assert(painted.paint === "sync", "data-theme-paint=sync proves the pre-React path ran");
  });

  for (const target of [workspace, userData]) {
    try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* absent */ }
  }

  if (failures.length) {
    console.error(`theme E2E failed (${failures.length})`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log("theme E2E passed");
}

await main();
