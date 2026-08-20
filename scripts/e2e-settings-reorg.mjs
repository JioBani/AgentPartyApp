/* Real-app E2E for Agent/Settings navigation, compatibility aliases, and layout captures. */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspace = path.join(os.tmpdir(), "agentparty-settings-reorg-ws");
const userData = path.join(os.tmpdir(), "agentparty-settings-reorg-ud");
const shots = path.join(root, ".tmp", "settings-reorg-e2e");
const port = Number(process.env.AGENTPARTY_SETTINGS_REORG_PORT || "") || 48973;
const base = `http://127.0.0.1:${port}`;
const failures = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (condition, message) => { console.log(`  ${condition ? "PASS" : "FAIL"} ${message}`); if (!condition) failures.push(message); };

async function request(method, url, body) {
  const response = await fetch(`${base}${url}`, { method, headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  let payload; try { payload = await response.json(); } catch { payload = {}; }
  return { status: response.status, payload };
}
async function waitForApi() {
  for (let i = 0; i < 120; i += 1) { try { if ((await request("GET", "/api/health")).payload?.ok) return; } catch {} await delay(500); }
  throw new Error("Automation API did not start");
}
function killTree(pid) { try { if (pid) execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch {} }
async function navigate(view, tab, harness) {
  const response = await request("POST", "/api/navigation", { view, ...(tab ? { tab } : {}), ...(harness ? { harness } : {}) });
  assert(response.status === 200 && response.payload?.view === view && (!tab || response.payload?.tab === tab), `${view}/${tab || "default"} opens and echoes normalized destination`);
  await delay(180);
}
async function capture(name, theme) {
  const target = path.join(shots, `${name}-${theme}.png`);
  const result = await request("POST", "/api/capture", { path: target, theme });
  assert(result.status === 200 && result.payload?.bytes > 1000 && fs.existsSync(target), `${name} ${theme} screenshot saved`);
}

fs.rmSync(workspace, { recursive: true, force: true }); fs.rmSync(userData, { recursive: true, force: true }); fs.rmSync(shots, { recursive: true, force: true });
fs.mkdirSync(workspace, { recursive: true }); fs.mkdirSync(shots, { recursive: true });
const child = spawn(process.env.ComSpec || "cmd.exe", ["/c", "npm", "run", "start"], { cwd: root, stdio: ["ignore", "ignore", "inherit"], windowsHide: true, env: { ...process.env, AGENTPARTY_QA: "1", AGENTPARTY_AUTOMATION_PORT: String(port), AGENTPARTY_USER_DATA: userData, AGENTPARTY_MOBILE_LINK: "1" } });

try {
  await waitForApi();
  const initialState = await request("GET", "/api/state");
  const appRoot = String(initialState.payload?.runtime?.appRoot || "");
  const mobileEnabled = initialState.payload?.settings?.mobile?.enabled === true;
  assert((appRoot + path.sep).toLowerCase().startsWith(root.toLowerCase() + path.sep), "E2E is driving the build from this feature worktree");
  const appPid = Number(execFileSync("powershell", ["-NoProfile", "-Command", `(Get-NetTCPConnection -State Listen -LocalPort ${port} | Select-Object -First 1 -ExpandProperty OwningProcess)`], { encoding: "utf8" }).trim());
  assert(Number.isInteger(appPid) && appPid > 0, "real Electron API listener PID is discoverable");
  const spec = await request("GET", "/api/spec");
  assert(spec.payload?.navigation?.tabs?.agent?.join(",") === "general,defaults,primer,gate,discord", "API spec declares the exact five Agent tabs");
  assert(spec.payload?.navigation?.tabs?.settings?.join(",") === "general,environment,workspace,mobile,versions,diagnostics,automation", "API spec declares every Settings tab");
  const dismissShot = path.join(shots, "dismiss-guide-offer.png");
  await request("POST", "/api/capture", { path: dismissShot, click: "[data-guide-offer] .ghost-btn" });
  fs.rmSync(dismissShot, { force: true });
  await request("POST", "/api/qa/window/bounds", { width: 1440, height: 900 });
  await navigate("agent", "general");
  const agentTabs = await request("POST", "/api/measure", { selector: ".set-tab", limit: 20 });
  const generalCards = await request("POST", "/api/measure", { selector: ".set-tab-panel:not([hidden]) [data-settings-card]", attributes: ["data-settings-card"], limit: 20 });
  assert(agentTabs.payload?.count === 5, "Agent exposes exactly five tabs");
  assert(generalCards.payload?.count === 4, "Agent General contains exactly the four contracted sections");
  assert(generalCards.payload?.elements?.map((entry) => entry.attributes?.["data-settings-card"]).join(",") === "composer,member-messages,auto-compact,idle-sleep", "Agent General cards follow the contracted order");
  for (const tab of ["general", "defaults", "primer", "gate", "discord"]) { await navigate("agent", tab, tab === "defaults" ? "codex" : undefined); await capture(`1440-agent-${tab}`, "light"); }
  await navigate("settings", "general");
  const settingsTabs = await request("POST", "/api/measure", { selector: ".set-tab", limit: 20 });
  assert(settingsTabs.payload?.count === (mobileEnabled ? 7 : 6), `Settings ${mobileEnabled ? "shows" : "hides"} Mobile Link according to its feature flag`);
  for (const tab of ["general", "environment", "workspace", ...(mobileEnabled ? ["mobile"] : []), "versions", "diagnostics", "automation"]) { await navigate("settings", tab); await capture(`1440-settings-${tab}`, "light"); }
  if (!mobileEnabled) {
    const unavailableMobile = await request("POST", "/api/navigation", { view: "settings", tab: "mobile" });
    assert(unavailableMobile.status >= 400 && /disabled/i.test(unavailableMobile.payload?.error || ""), "disabled Mobile Link navigation fails visibly instead of reporting a no-op");
  }

  const legacyHarness = await request("POST", "/api/navigation", { view: "runtime", tab: "harness", harness: "cursor" });
  assert(legacyHarness.payload?.view === "agent" && legacyHarness.payload?.tab === "defaults" && legacyHarness.payload?.harness === "cursor", "legacy runtime/harness normalizes to agent/defaults");
  const legacyEnvironment = await request("POST", "/api/navigation", { view: "runtime", tab: "environment" });
  assert(legacyEnvironment.payload?.view === "settings" && legacyEnvironment.payload?.tab === "environment", "legacy runtime/environment normalizes to settings/environment");
  const legacyAutomation = await request("POST", "/api/navigation", { view: "automation" });
  assert(legacyAutomation.payload?.view === "settings" && legacyAutomation.payload?.tab === "automation", "legacy automation normalizes to settings/automation");
  for (const body of [{ view: "bogus" }, { view: "agent", tab: "bogus" }, { view: "settings", tab: "bogus" }, { view: "agent", tab: "general", harness: "codex" }, { view: "agent", tab: "defaults", harness: "bogus" }]) {
    const invalid = await request("POST", "/api/navigation", body);
    assert(invalid.status >= 400 && Boolean(invalid.payload?.error), `invalid navigation ${JSON.stringify(body)} fails visibly`);
  }

  await navigate("agent", "defaults", "codex");
  await request("POST", "/api/capture", { path: path.join(shots, "default-harness-button.png"), click: ".set-default-harness:not(:disabled)" });
  await delay(250);
  const settings = await request("GET", "/api/state");
  assert(settings.payload?.settings?.selectedHarnessId === "codex", "default-harness button updates selectedHarnessId through the shared controller path");

  await request("POST", "/api/qa/window/bounds", { width: 1024, height: 768 });
  await navigate("agent", "general"); await capture("1024-agent-general", "dark");
  await navigate("agent", "defaults", "grok"); await capture("1024-agent-defaults", "dark");
  await navigate("settings", "general"); await capture("1024-settings-general", "dark");
  await navigate("settings", "automation"); await capture("1024-settings-automation", "dark");

  const tabs = await request("POST", "/api/measure", { selector: ".set-tab", styles: ["whiteSpace"], containedBy: ".set-tabs", limit: 20 });
  assert(tabs.status === 200 && tabs.payload?.elements?.every((entry) => entry.containedBy?.contained !== false), "narrow tab strip contains every visible tab without overlap/clipping");
  console.log(`EVIDENCE pid=${appPid} baseUrl=${base} appRoot=${appRoot}`);
  await request("POST", "/api/window/close", {});
} catch (error) { console.error(error); failures.push(String(error?.message || error)); }
finally { killTree(child.pid); await delay(300); fs.rmSync(workspace, { recursive: true, force: true }); fs.rmSync(userData, { recursive: true, force: true }); }

if (failures.length) { console.error(`settings reorg E2E failed (${failures.length})`); process.exit(1); }
console.log(`settings reorg E2E passed; screenshots: ${shots}`);
