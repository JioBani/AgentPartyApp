/*
 * Full-process E2E for appearance (System / Light / Dark).
 *
 * Launches the real Electron app, drives the public automation routes, and
 * reads `data-theme` from the live DOM. Persistence is proven by restarting
 * the same userData directory. A second window proves the live broadcast.
 *
 * OS colour-scheme: Windows cannot be flipped from this process. QA therefore
 * drives `POST /api/qa/appearance/os`, which is the nativeTheme signal the app
 * already listens to — not a fake renderer-only path.
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

async function main() {
  for (const target of [workspace, userData]) {
    try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* absent */ }
  }
  fs.mkdirSync(workspace, { recursive: true });

  let child = launch();
  try {
    await waitForApi();

    const spec = await request("GET", "/api/spec");
    const endpoints = spec.payload?.endpoints || [];
    assert(endpoints.includes("GET /api/appearance/theme"), "GET /api/appearance/theme is in the spec");
    assert(endpoints.includes("POST /api/appearance/theme"), "POST /api/appearance/theme is in the spec");
    assert(endpoints.includes("POST /api/qa/appearance/os"), "POST /api/qa/appearance/os is in the spec");

    const initial = await request("GET", "/api/appearance/theme");
    assert(initial.payload?.preference === "light", "a fresh install defaults to light");
    assert(initial.payload?.applied === "light", "default applied theme is light");
    assert(initial.payload?.stored === false, "a missing settings.json theme is not an explicit choice");
    assert(initial.payload?.background === "#e7e8eb", "fresh window chrome matches light bg-0");
    assert((initial.payload?.options || []).join(",") === "system,light,dark", "options are system/light/dark");

    const windows = (await request("GET", "/api/windows")).payload?.windows || [];
    const win1 = windows[0]?.id;
    const opened = await request("POST", "/api/windows", { workspacePath: workspace });
    const win2 = opened.payload?.id;
    assert(Boolean(win1 && win2 && win1 !== win2), "a second window opened in this process");

    const dark = await request("POST", "/api/appearance/theme", { theme: "dark" });
    assert(dark.status === 200 && dark.payload?.preference === "dark" && dark.payload?.applied === "dark", "POST /api/appearance/theme accepts dark");
    assert(dark.payload?.background === "#0a0b0e", "dark chrome matches bg-0");
    await delay(500);
    const painted1 = await htmlTheme(win1);
    const painted2 = await htmlTheme(win2);
    assert(painted1.applied === "dark" && painted1.preference === "dark", "window 1 paints dark");
    assert(painted2.applied === "dark" && painted2.preference === "dark", "window 2 received the live broadcast");
    const persisted = JSON.parse(fs.readFileSync(path.join(userData, "settings.json"), "utf8"));
    assert(persisted.theme === "dark", "the preference is persisted in settings.json");

    const invalid = await request("POST", "/api/appearance/theme", { theme: "auto" });
    assert(invalid.status >= 400 && invalid.payload?.error, "an unknown theme returns a visible API error");
    assert(String(invalid.payload.error).includes("지원하지 않는 테마입니다"), "the error names the rejected value");
    assert((await request("GET", "/api/appearance/theme")).payload?.preference === "dark", "invalid input does not overwrite the current theme");

    const missing = await request("POST", "/api/appearance/theme", {});
    assert(missing.status >= 400 && missing.payload?.error, "a missing theme field is an error, not a silent default");

    const viaSettings = await request("POST", "/api/settings", { theme: "nope" });
    assert(viaSettings.status >= 400 && viaSettings.payload?.error, "POST /api/settings rejects an unknown theme the same way");

    const system = await request("POST", "/api/appearance/theme", { theme: "system" });
    assert(system.status === 200 && system.payload?.preference === "system", "POST /api/appearance/theme accepts system");
    await delay(400);
    const paintedSystem = await htmlTheme(win1);
    assert(paintedSystem.preference === "system", "system preference is visible on html");
    assert(paintedSystem.applied === "light" || paintedSystem.applied === "dark", "system paints an applied light or dark theme");

    const osDark = await request("POST", "/api/qa/appearance/os", { dark: true });
    assert(osDark.status === 200 && osDark.payload?.preference === "system" && osDark.payload?.applied === "dark", "QA OS-dark follows System live");
    await delay(400);
    const liveDark1 = await htmlTheme(win1);
    const liveDark2 = await htmlTheme(win2);
    assert(liveDark1.applied === "dark", "window 1 follows the nativeTheme signal");
    assert(liveDark2.applied === "dark", "window 2 follows the nativeTheme signal");
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
    const afterClick = await request("GET", "/api/appearance/theme");
    assert(afterClick.payload?.preference === "light", "title-bar cycles system → light");

    await request("POST", "/api/appearance/theme", { theme: "dark" });
    await delay(300);
    await request("POST", "/api/window/close", {});
  } catch (error) {
    console.error(error);
    failures.push(String(error?.message || error));
  } finally {
    killTree(child.pid);
    await delay(500);
  }

  child = launch();
  try {
    await waitForApi();
    const restarted = await request("GET", "/api/appearance/theme");
    assert(restarted.payload?.preference === "dark", "the preference survives an app restart");
    assert(restarted.payload?.applied === "dark", "restart applied theme is dark, not a light flash");
    assert(restarted.payload?.stored === true, "settings.json still has an explicit theme after restart");
    assert(restarted.payload?.background === "#0a0b0e", "restarted window chrome is dark bg-0");
    const painted = await htmlTheme();
    assert(painted.preference === "dark", "the restarted window paints the stored preference");
    assert(painted.applied === "dark", "restart first paint is dark");
    assert(painted.paint === "sync", "data-theme-paint=sync proves the pre-React path ran");
    await request("POST", "/api/window/close", {});
  } catch (error) {
    console.error(error);
    failures.push(String(error?.message || error));
  } finally {
    killTree(child.pid);
    await delay(300);
    for (const target of [workspace, userData]) {
      try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* absent */ }
    }
  }

  if (failures.length) {
    console.error(`theme E2E failed (${failures.length})`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log("theme E2E passed");
}

await main();
