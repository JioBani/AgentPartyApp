/*
 * Full-process E2E for app language selection.
 *
 * Launches the real Electron app, changes locale through the public automation
 * route, and reads translated text back from the live DOM. This proves the
 * persisted setting, AppController broadcast, renderer catalog, and visible UI
 * are connected rather than testing those pieces in isolation.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { parseCsv } = require("./i18n-csv.cjs");
const copyRows = parseCsv(fs.readFileSync(path.join(root, "docs/user-facing-strings-excel.csv"), "utf8"));
const emptyWorkbenchCopy = copyRows.find((row) => row.id === "STR-2291");
const expectedEmptyWorkbenchCopy = emptyWorkbenchCopy?.suggested_text_ko || emptyWorkbenchCopy?.text;
const workspace = path.join(os.tmpdir(), "agentparty-locale-ws");
const userData = path.join(os.tmpdir(), "agentparty-locale-ud");
const port = Number(process.env.AGENTPARTY_LOCALE_PORT || "") || 48961;
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
  const payload = await response.json();
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

async function measuredText(selector) {
  const { payload } = await request("POST", "/api/measure", { selector, limit: 1 });
  if (!payload?.ok) throw new Error(`Could not measure ${selector}: ${payload?.error || "unknown error"}`);
  return String(payload.elements?.[0]?.text || payload.texts?.[0] || "").trim();
}

async function main() {
  for (const target of [workspace, userData]) {
    try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* absent */ }
  }
  fs.mkdirSync(workspace, { recursive: true });

  const child = spawn(process.env.ComSpec || "cmd.exe", ["/c", "npm", "run", "start"], {
    cwd: root,
    stdio: ["ignore", "ignore", "inherit"],
    windowsHide: true,
    env: {
      ...process.env,
      AGENTPARTY_QA: "1",
      AGENTPARTY_AUTOMATION_PORT: String(port),
      AGENTPARTY_USER_DATA: userData,
    },
  });

  try {
    await waitForApi();
    await request("POST", "/api/navigation", { view: "runtime", tab: "general" });
    await delay(500);

    const initial = await request("GET", "/api/settings/locale");
    assert(initial.payload?.locale === "ko", "a fresh install defaults to Korean");
    assert(await measuredText("[data-settings-card=language] .set-card-label") === "언어", "the language picker is visible in Korean");

    const changed = await request("POST", "/api/settings/locale", { locale: "en" });
    assert(changed.status === 200 && changed.payload?.locale === "en", "POST /api/settings/locale accepts English");
    await delay(500);
    assert(await measuredText(".titlebar-brand .brand-sub") === "Runtime", "the open window changes language immediately");
    assert(await measuredText(".set-tab.is-active") === "General", "runtime navigation uses the English catalog");

    const persisted = JSON.parse(fs.readFileSync(path.join(userData, "settings.json"), "utf8"));
    assert(persisted.locale === "en", "the locale is persisted in settings.json");

    const invalid = await request("POST", "/api/settings/locale", { locale: "xx" });
    assert(invalid.status >= 400 && invalid.payload?.error, "an unsupported locale returns a visible API error");
    assert((await request("GET", "/api/settings/locale")).payload?.locale === "en", "invalid input does not overwrite the current locale");

    await request("POST", "/api/settings/locale", { locale: "ko" });
    await delay(300);
    assert(await measuredText(".titlebar-brand .brand-sub") === "런타임", "switching back to Korean updates the same screen");
    await request("POST", "/api/navigation", { view: "workbench" });
    await delay(300);
    assert(await measuredText(".wb-workarea-empty p") === expectedEmptyWorkbenchCopy, "a CSV-backed workbench message renders from the Korean catalog");
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
    console.error(`locale E2E failed (${failures.length})`);
    process.exit(1);
  }
  console.log("locale E2E passed");
}

await main();
