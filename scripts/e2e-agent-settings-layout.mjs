/* Real-app geometry QA for every Agent and Settings tab. */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baselineMode = process.env.AGENTPARTY_LAYOUT_BASELINE === "1";
const quickMode = process.env.AGENTPARTY_LAYOUT_QUICK === "1";
const workspace = path.join(os.tmpdir(), "agentparty-layout-ws");
const userData = path.join(os.tmpdir(), "agentparty-layout-ud");
const shots = path.join(root, ".tmp", "agent-settings-layout-e2e", baselineMode ? "before" : "after");
const evidencePath = path.join(shots, "measurements.json");
const port = Number(process.env.AGENTPARTY_LAYOUT_PORT || 0) || 48976;
const base = `http://127.0.0.1:${port}`;
const failures = [];
const measurements = [];
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
  let payload;
  try { payload = await response.json(); } catch { payload = {}; }
  return { status: response.status, payload };
}
async function waitForApi() {
  for (let i = 0; i < 120; i += 1) {
    try { if ((await request("GET", "/api/health")).payload?.ok) return; } catch {}
    await delay(500);
  }
  throw new Error("Automation API did not start");
}
function killTree(pid) {
  try { if (pid) execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
}
async function navigate(view, tab, harness) {
  const response = await request("POST", "/api/navigation", { view, tab, ...(harness ? { harness } : {}) });
  assert(response.status === 200 && response.payload?.view === view && response.payload?.tab === tab, `${view}/${tab} opened`);
  await delay(tab === "environment" || tab === "versions" || tab === "diagnostics" ? 900 : 220);
}
async function measure(selector, extra = {}) {
  const response = await request("POST", "/api/measure", { selector, limit: 400, ...extra });
  if (response.status !== 200) throw new Error(`measure ${selector}: ${response.payload?.error || response.status}`);
  return response.payload;
}
const inset = (card, child) => ({
  left: Math.round((child.left - card.left) * 100) / 100,
  right: Math.round((card.right - child.right) * 100) / 100,
  bottom: Math.round((card.bottom - child.bottom) * 100) / 100,
});
function overlap(a, b) {
  return Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1
    && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
}

const contentSelectors = {
  "agent-general-composer": "> .set-card-body > *",
  "agent-general-member-messages": "> .set-card-body > *",
  "agent-general-auto-compact": "> .set-compact",
  "agent-general-idle-sleep": "> .set-compact",
  "agent-primer": "> .set-primer > *",
  "agent-gate": "> .set-gate-defaults > *",
  "settings-language": "> .set-card-body > *",
  "settings-fonts": "> .set-card-body > .set-inline-note, > .set-card-body > .set-font-field > .set-field-label, > .set-card-body > .set-font-field > .set-font-trigger, > .set-card-body > .set-font-field > .set-font-preview, > .set-card-body > .set-font-field > .set-font-note",
  "settings-workspace-defaults": "> .set-card-body > *",
  "settings-workspace-recent-windows": "> .set-card-body > *",
  "settings-workspace-recent-wsl": "> .set-card-body > *",
  "settings-workspace-members": "> .set-card-body > *",
  "settings-diagnostics-system": "> .set-card-body > *",
  "settings-versions-channel": "> .set-update-channel-options > *, > .set-update-channel-note > *",
  "settings-versions-installed": "> .set-ver-current > *, > .set-diag-actions > *",
  "settings-versions-latest": "> .set-ver-latest > *, > .set-ver-empty",
  "settings-automation-router": "> .set-automation-content > *",
  "settings-automation-api": "> .set-automation-content > *",
  // The disclosure button deliberately owns the full card row; its children
  // remain on the 20px content line and are what geometry QA measures.
  "settings-versions-history": "> .set-ver-toggle > *, > .set-ver-list > *",
};

async function auditActiveTab(view, tab, harness) {
  await navigate(view, tab, harness);
  const cards = await measure('.set-tab-panel:not([hidden]) [data-layout-card]', { attributes: ["data-layout-card"] });
  assert(cards.count > 0, `${view}/${tab} exposes measurable cards`);
  for (const entry of cards.elements.filter((item) => item.box.width > 0 && item.box.height > 0)) {
    const id = entry.attributes["data-layout-card"];
    const cardSelector = `[data-layout-card="${id}"]`;
    assert(!entry.scrollable.horizontal, `${id} has no horizontal overflow`);
    // Font search is an intentional overlay, and release-note bodies are
    // intentional scrollports. Audit their bounding surface, not offscreen
    // children which are clipped by that declared surface.
    const descendantSelector = id === "settings-fonts"
      ? `${cardSelector} *:not(.set-font-pop):not(.set-font-pop *)`
      : id.startsWith("settings-versions-")
        ? `${cardSelector} *:not(.set-ver-notes *)`
        : `${cardSelector} *`;
    const descendants = await measure(descendantSelector, { containedBy: cardSelector });
    const visibleDescendants = descendants.elements.filter((item) => item.box.width > 0 && item.box.height > 0);
    const outside = visibleDescendants.filter((item) => !item.containedBy?.fully);
    if (outside.length) console.log(`    OUTSIDE ${id}: ${JSON.stringify(outside.map((item) => ({ tag: item.tag, box: item.box, containment: item.containedBy })))}`);
    assert(outside.length === 0, `${id} descendants stay inside the card`);
    const controls = visibleDescendants.filter((item) => /^(button|input|select|textarea)/.test(item.tag));
    let controlsOverlap = false;
    for (let i = 0; i < controls.length; i += 1) for (let j = i + 1; j < controls.length; j += 1) {
      if (overlap(controls[i].box, controls[j].box)) controlsOverlap = true;
    }
    assert(!controlsOverlap, `${id} controls do not overlap`);

    const suffix = contentSelectors[id] || "> :not(.set-card-label):not(.set-card-body)";
    let content;
    try { content = await measure(suffix.split(",").map((part) => `${cardSelector} ${part.trim()}`).join(", ")); } catch {
      content = null;
    }
    if (content?.elements?.length) {
      const boxes = content.elements.map((item) => item.box).filter((box) => box.width > 0 && box.height > 0);
      if (!boxes.length) continue;
      const metrics = boxes.map((box) => inset(entry.box, box));
      const minimum = {
        left: Math.min(...metrics.map((value) => value.left)),
        right: Math.min(...metrics.map((value) => value.right)),
        bottom: Math.min(...metrics.map((value) => value.bottom)),
      };
      const closing = inset(entry.box, boxes.reduce((last, box) => box.bottom > last.bottom ? box : last)).bottom;
      measurements.push({ view, tab, id, viewport: cards.viewport, minimum, closing });
      assert(minimum.left >= 18, `${id} minimum left inset is ${minimum.left}px`);
      assert(minimum.right >= 18, `${id} minimum right inset is ${minimum.right}px`);
      assert(closing >= 18, `${id} closing gutter is ${closing}px`);
    }
  }
}

async function capture(name, theme, scrollTo) {
  if (scrollTo !== undefined) await measure(".program-scroll", { scroll: { selector: ".program-scroll", to: scrollTo } });
  const target = path.join(shots, `${name}-${scrollTo === "bottom" ? "bottom" : "top"}-${theme}.png`);
  const response = await request("POST", "/api/capture", { path: target, theme });
  assert(response.status === 200 && response.payload?.bytes > 1000 && fs.existsSync(target), `${path.basename(target)} saved`);
}

fs.rmSync(workspace, { recursive: true, force: true });
fs.rmSync(userData, { recursive: true, force: true });
fs.rmSync(shots, { recursive: true, force: true });
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(shots, { recursive: true });
const child = spawn(process.env.ComSpec || "cmd.exe", ["/c", "npm", "run", "start"], {
  cwd: root,
  stdio: ["ignore", "ignore", "inherit"],
  windowsHide: true,
  env: { ...process.env, AGENTPARTY_QA: "1", AGENTPARTY_AUTOMATION_PORT: String(port), AGENTPARTY_USER_DATA: userData, AGENTPARTY_MOBILE_LINK: "1" },
});

try {
  await waitForApi();
  const state = await request("GET", "/api/state");
  const appRoot = String(state.payload?.runtime?.appRoot || "");
  const mobileEnabled = state.payload?.settings?.mobile?.enabled === true;
  assert((appRoot + path.sep).toLowerCase().startsWith(root.toLowerCase() + path.sep), "real app is running this worktree build");
  const appPid = Number(execFileSync("powershell", ["-NoProfile", "-Command", `(Get-NetTCPConnection -State Listen -LocalPort ${port} | Select-Object -First 1 -ExpandProperty OwningProcess)`], { encoding: "utf8" }).trim());
  const dismissShot = path.join(shots, "dismiss-guide-offer.png");
  await request("POST", "/api/capture", { path: dismissShot, click: "[data-guide-offer] .ghost-btn" });
  fs.rmSync(dismissShot, { force: true });
  await request("POST", "/api/qa/environment", {});
  await request("POST", "/api/qa/update", {
    state: "available",
    channel: "stable",
    currentVersion: "0.2.7",
    latestVersion: "0.3.0-beta.12",
    releases: [
      { version: "0.3.0-beta.12", name: "A deliberately long release title that must wrap without crossing the card gutter", notes: "## Long notes\n" + "A long diagnostic-style release note with a/path/that/keeps/going/without/a/convenient/break repeated for overflow QA. ".repeat(12), publishedAt: "2026-08-20T00:00:00.000Z", url: "https://example.com/releases/0.3.0-beta.12", prerelease: true },
      { version: "0.2.7", name: "v0.2.7", notes: "Current release", publishedAt: "2026-08-01T00:00:00.000Z", url: "https://example.com/releases/0.2.7", prerelease: false, current: true },
      { version: "0.2.6", name: "Earlier release", notes: "Historical notes ".repeat(30), publishedAt: "2026-07-01T00:00:00.000Z", url: "https://example.com/releases/0.2.6", prerelease: false },
    ],
  });
  const tabs = [
    ...["general", "defaults", "primer", "gate", "discord"].map((tab) => ({ view: "agent", tab, harness: tab === "defaults" ? "codex" : undefined })),
    ...["general", "environment", "workspace", ...(mobileEnabled ? ["mobile"] : []), "versions", "diagnostics", "automation"].map((tab) => ({ view: "settings", tab })),
  ];

  await request("POST", "/api/qa/window/bounds", { width: 1440, height: 900 });
  for (const target of tabs) await auditActiveTab(target.view, target.tab, target.harness);
  if (!quickMode) {
  for (const harness of ["claude-code", "codex", "cursor", "grok"]) {
    await auditActiveTab("agent", "defaults", harness);
    await capture(`1440x900-agent-defaults-${harness}`, "light", 0);
    await capture(`1440x900-agent-defaults-${harness}`, "light", "bottom");
  }

  // Required expanded/interactive states are measured in the same real app.
  await navigate("agent", "general");
  await request("POST", "/api/capture", { path: path.join(shots, "interaction-auto-compact.png"), click: '[data-settings-card="auto-compact"] .set-compact-toggle' });
  await request("POST", "/api/capture", { path: path.join(shots, "interaction-idle-sleep.png"), click: '[data-settings-card="idle-sleep"] .set-compact-toggle' });
  await auditActiveTab("agent", "general");
  await navigate("settings", "general");
  await request("POST", "/api/capture", { path: path.join(shots, "interaction-font-picker.png"), click: '[data-layout-card="settings-fonts"] .set-font-trigger' });
  await auditActiveTab("settings", "general");
  await navigate("agent", "primer");
  await request("POST", "/api/capture", { path: path.join(shots, "interaction-primer-inner-tab.png"), click: ".set-primer-tab:nth-of-type(2)" });
  await auditActiveTab("agent", "primer");
  await navigate("settings", "environment");
  await request("POST", "/api/capture", { path: path.join(shots, "interaction-environment-more.png"), click: ".set-env-more > summary" });
  await auditActiveTab("settings", "environment");
  await navigate("settings", "versions");
  await request("POST", "/api/capture", { path: path.join(shots, "interaction-version-history.png"), click: '[data-ver="history-toggle"]' });
  await auditActiveTab("settings", "versions");

  const viewports = [
    { width: 1440, height: 900, themes: ["light", "dark"] },
    { width: 1024, height: 768, themes: ["light", "dark"] },
    { width: 760, height: 720, themes: ["light", "dark"] },
  ];
  for (const viewport of viewports) {
    await request("POST", "/api/qa/window/bounds", viewport);
    for (const target of tabs) {
      await navigate(target.view, target.tab, target.harness);
      for (const theme of viewport.themes) {
        const prefix = `${viewport.width}x${viewport.height}-${target.view}-${target.tab}`;
        await capture(prefix, theme, 0);
        await capture(prefix, theme, "bottom");
      }
    }
  }
  }
  fs.writeFileSync(evidencePath, JSON.stringify({ appPid, baseUrl: base, appRoot, mobileEnabled, failures, measurements }, null, 2));
  console.log(`EVIDENCE pid=${appPid} baseUrl=${base} appRoot=${appRoot}`);
  console.log(`EVIDENCE measurements=${evidencePath} screenshots=${shots}`);
  await request("POST", "/api/window/close", {});
} catch (error) {
  failures.push(String(error?.message || error));
  console.error(error);
} finally {
  killTree(child.pid);
  await delay(300);
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(userData, { recursive: true, force: true });
}

if (failures.length && !baselineMode) {
  console.error(`agent/settings layout E2E failed (${failures.length})`);
  process.exit(1);
}
console.log(`${baselineMode ? "baseline captured" : "agent/settings layout E2E passed"}; failures=${failures.length}`);
