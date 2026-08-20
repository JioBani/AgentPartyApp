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
async function visibleGuideOffers() {
  // `body` guarantees a valid measurement even when the optional offer does
  // not exist; the attribute distinguishes it without turning absence into a
  // noisy API error.
  const candidates = await measure("[data-guide-offer], body", { limit: 10, attributes: ["data-guide-offer"] });
  return candidates.elements.filter((item) => item.attributes?.["data-guide-offer"] !== null && item.box.width > 0 && item.box.height > 0);
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

async function auditActiveTab(view, tab, harness, viewportRecord, state = "default") {
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
      measurements.push({
        view,
        tab,
        state,
        requested: viewportRecord.requested,
        actual: cards.viewport,
        id,
        minimum,
        closing,
        horizontalOverflow: entry.scrollable.horizontal,
        outsideCount: outside.length,
        controlsOverlap,
      });
      assert(minimum.left >= 18, `${id} minimum left inset is ${minimum.left}px`);
      assert(minimum.right >= 18, `${id} minimum right inset is ${minimum.right}px`);
      assert(closing >= 18, `${id} closing gutter is ${closing}px`);
    }
  }
}

async function capture(name, theme, scrollTo) {
  assert((await visibleGuideOffers()).length === 0, "guide offer is absent before capture");
  if (scrollTo !== undefined) await measure(".program-scroll", { scroll: { selector: ".program-scroll", to: scrollTo } });
  const target = path.join(shots, `${name}-${scrollTo === "bottom" ? "bottom" : "top"}-${theme}.png`);
  const response = await request("POST", "/api/capture", { path: target, theme });
  assert(response.status === 200 && response.payload?.bytes > 1000 && fs.existsSync(target), `${path.basename(target)} saved`);
}

async function captureStateSet(prefix) {
  for (const theme of ["light", "dark"]) {
    await capture(prefix, theme, 0);
    await capture(prefix, theme, "bottom");
  }
}

async function setActualViewport(requested) {
  const response = await request("POST", "/api/qa/window/bounds", requested);
  assert(response.status === 200, `requested window ${requested.width}x${requested.height}`);
  const surface = await measure("body");
  const actual = surface.viewport;
  assert(actual.width > 0 && actual.height > 0, `actual viewport is ${actual.width}x${actual.height}`);
  return { requested, actual, label: `${Math.round(actual.width)}x${Math.round(actual.height)}` };
}

async function dismissGuideOffer() {
  const visibleBefore = (await visibleGuideOffers()).length;
  let clicked = false;
  if (visibleBefore) {
    const response = await request("POST", "/api/capture", { click: "[data-guide-offer] .ghost-btn" });
    clicked = response.status === 200 && response.payload?.clicked === true;
    assert(clicked, "guide offer dismiss control was clicked");
    await delay(120);
  }
  const visibleAfter = (await visibleGuideOffers()).length;
  assert(clicked || visibleBefore === 0, "guide dismissal was clicked or no offer was shown");
  assert(visibleAfter === 0, "guide offer overlay is absent after dismissal");
}

async function installPopulatedWorkspaceFixture() {
  const recent = path.join(workspace, "a-deliberately-long-populated-workspace-path-for-layout-qa", "nested-project");
  fs.mkdirSync(recent, { recursive: true });
  const defaultResult = await request("POST", "/api/cwd/default", { env: "windows", cwd: workspace });
  assert(defaultResult.status === 200, "workspace default fixture saved through AppController API");
  const partyResult = await request("POST", "/api/parties", { name: "Layout populated workspace fixture", location: recent });
  assert(partyResult.status === 200, "workspace recent/member fixture created through AppController API");
  const prefs = await request("GET", "/api/cwd/preferences");
  const members = await request("GET", "/api/cwd/members");
  assert(prefs.payload?.preferences?.windowsDefault?.cwd === workspace, "workspace default is populated");
  assert((prefs.payload?.preferences?.windowsRecent || []).some((entry) => entry.location?.cwd === recent), "workspace recent list is populated");
  assert((members.payload?.members || []).some((entry) => entry.location?.cwd === recent), "workspace member locations are populated");
  return { default: workspace, recent, members: members.payload?.members?.length || 0 };
}

async function assertPopulatedWorkspaceRendered(viewport, fixture) {
  await navigate("settings", "workspace");
  const defaults = await measure('[data-layout-card="settings-workspace-defaults"] .set-cwd-path');
  const recent = await measure('[data-layout-card="settings-workspace-recent-windows"] .set-cwd-path');
  const members = await measure('[data-layout-card="settings-workspace-members"] .set-cwd-path, [data-layout-card="settings-workspace-members"] .set-cwd-meta');
  const defaultText = defaults.elements.map((item) => item.text).join(" | ");
  const recentText = recent.elements.map((item) => item.text).join(" | ");
  const memberText = members.elements.map((item) => item.text).join(" | ");
  assert(defaultText.includes(fixture.default), `${viewport.label} renderer shows populated workspace default`);
  assert(recentText.includes(fixture.recent), `${viewport.label} renderer shows populated long recent path`);
  assert(memberText.includes("main"), `${viewport.label} renderer shows populated member identity`);
  assert(memberText.includes("Layout populated workspace fixture"), `${viewport.label} renderer shows populated member party identity`);
  return { requested: viewport.requested, actual: defaults.viewport, defaultText, recentText, memberText };
}

async function installDiscordErrorFixture() {
  const saved = await request("POST", "/api/discord/settings", {
    desktopName: "LAYOUT-QA-DESKTOP-WITH-A-LONG-NAME",
    botToken: "layout.qa.invalid.discord.token",
    guildId: "123456789012345678",
    allowedUserIds: ["123456789012345678", "987654321098765432"],
  });
  assert(saved.status === 200 && saved.payload?.configured === true, "Discord configured fixture saved through AppController API");
  let status = saved.payload;
  for (let i = 0; i < 30 && status?.connection !== "error"; i += 1) {
    await delay(200);
    status = (await request("GET", "/api/discord")).payload;
  }
  assert(status?.configured === true, "Discord configured state is active");
  assert(status?.connection === "error" && Boolean(status?.error), "Discord invalid-token error state is visible");
  return { configured: status?.configured, connection: status?.connection, error: status?.error };
}

fs.rmSync(workspace, { recursive: true, force: true });
fs.rmSync(userData, { recursive: true, force: true });
fs.rmSync(shots, { recursive: true, force: true });
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(userData, { recursive: true });
fs.mkdirSync(shots, { recursive: true });
fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ workspacePath: workspace }, null, 2));
function spawnApp() {
  return spawn(process.execPath, [path.join(root, "scripts", "launch-electron.mjs"), "--workspace", workspace], {
    cwd: root,
    stdio: ["ignore", "ignore", "inherit"],
    windowsHide: true,
    env: { ...process.env, AGENTPARTY_QA: "1", AGENTPARTY_ALLOW_MULTI_INSTANCE: "1", AGENTPARTY_AUTOMATION_PORT: String(port), AGENTPARTY_USER_DATA: userData, AGENTPARTY_MOBILE_LINK: "1" },
  });
}
let child = spawnApp();

try {
  await waitForApi();
  await dismissGuideOffer();
  const workspaceFixture = await installPopulatedWorkspaceFixture();

  // CWD preferences and member locations are part of the renderer's initial
  // settings snapshot. Restart the same real app against the same isolated
  // stores so the visible UI, not only the backend response, owns the fixture.
  await request("POST", "/api/window/close", {});
  killTree(child.pid);
  await delay(350);
  child = spawnApp();
  await waitForApi();
  await dismissGuideOffer();

  const state = await request("GET", "/api/state");
  const appRoot = String(state.payload?.runtime?.appRoot || "");
  const mobileEnabled = state.payload?.settings?.mobile?.enabled === true;
  assert((appRoot + path.sep).toLowerCase().startsWith(root.toLowerCase() + path.sep), "real app is running this worktree build");
  const appPid = Number(execFileSync("powershell", ["-NoProfile", "-Command", `(Get-NetTCPConnection -State Listen -LocalPort ${port} | Select-Object -First 1 -ExpandProperty OwningProcess)`], { encoding: "utf8" }).trim());
  const discordFixture = await installDiscordErrorFixture();
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

  const viewportRequests = quickMode
    ? [{ width: 1440, height: 900 }]
    : [{ width: 1440, height: 900 }, { width: 760, height: 720 }];
  const viewports = [];
  const workspaceRendered = [];
  for (const requested of viewportRequests) {
    const viewport = await setActualViewport(requested);
    viewports.push(viewport);
    workspaceRendered.push(await assertPopulatedWorkspaceRendered(viewport, workspaceFixture));
    for (const target of tabs) {
      await auditActiveTab(target.view, target.tab, target.harness, viewport);
      if (!quickMode) for (const theme of ["light", "dark"]) {
        const prefix = `${viewport.label}-${target.view}-${target.tab}`;
        await capture(prefix, theme, 0);
        await capture(prefix, theme, "bottom");
      }
    }

    if (!quickMode) {
      for (const harness of ["claude-code", "codex", "cursor", "grok"]) {
        await auditActiveTab("agent", "defaults", harness, viewport, `harness-${harness}`);
        await capture(`${viewport.label}-agent-defaults-${harness}`, "light", 0);
        await capture(`${viewport.label}-agent-defaults-${harness}`, "light", "bottom");
      }

      // Required expanded/interactive states are audited at every actual viewport.
      await navigate("agent", "general");
      let interaction = await request("POST", "/api/capture", { click: '[data-settings-card="auto-compact"] .set-compact-toggle' });
      assert(interaction.payload?.clicked === true, "auto-compact expansion clicked");
      interaction = await request("POST", "/api/capture", { click: '[data-settings-card="idle-sleep"] .set-compact-toggle' });
      assert(interaction.payload?.clicked === true, "idle-sleep expansion clicked");
      await auditActiveTab("agent", "general", undefined, viewport, "expanded");
      await captureStateSet(`${viewport.label}-agent-general-expanded`);

      await navigate("settings", "general");
      interaction = await request("POST", "/api/capture", { click: '[data-layout-card="settings-fonts"] .set-font-trigger' });
      assert(interaction.payload?.clicked === true, "font picker opened");
      await auditActiveTab("settings", "general", undefined, viewport, "font-picker-open");
      await captureStateSet(`${viewport.label}-settings-general-font-picker`);

      await navigate("agent", "primer");
      interaction = await request("POST", "/api/capture", { click: ".set-primer-tab:nth-of-type(2)" });
      assert(interaction.payload?.clicked === true, "primer inner tab opened");
      await auditActiveTab("agent", "primer", undefined, viewport, "inner-tab");
      await captureStateSet(`${viewport.label}-agent-primer-inner-tab`);

      await navigate("settings", "environment");
      interaction = await request("POST", "/api/capture", { click: ".set-env-more > summary" });
      assert(interaction.payload?.clicked === true, "environment more actions expanded");
      await auditActiveTab("settings", "environment", undefined, viewport, "expanded");
      await captureStateSet(`${viewport.label}-settings-environment-expanded`);

      await navigate("settings", "versions");
      interaction = await request("POST", "/api/capture", { click: '[data-ver="history-toggle"]' });
      assert(interaction.payload?.clicked === true, "version history expanded");
      await auditActiveTab("settings", "versions", undefined, viewport, "history-expanded");
      await captureStateSet(`${viewport.label}-settings-versions-history`);
    }
  }
  const widthClamp = viewportRequests.map((requested, index) => ({ requested, actual: viewports[index]?.actual }));
  fs.writeFileSync(evidencePath, JSON.stringify({ appPid, baseUrl: base, appRoot, mobileEnabled, widthClamp, workspaceFixture, workspaceRendered, discordFixture, failures, measurements }, null, 2));
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
