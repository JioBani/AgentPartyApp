/*
 * Manual benchmark against a COPY of an existing workspace's AgentParty store.
 * Usage:
 *   node scripts/benchmark-party-switch-real-store.mjs <source-workspace> [installed-exe] [--open]
 * Omitting installed-exe launches this worktree's build. The source is read-only;
 * all app writes land in an isolated temporary copy. `--open` leaves the real
 * app and copy running for hands-on QA; ordinary benchmark runs delete the copy.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { firstBaseUrl } from "./lib/discovery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.resolve(process.argv[2] || "");
const keepOpen = process.argv.includes("--open");
const installedExeArg = process.argv.slice(3).find((value) => value !== "--open");
const installedExe = installedExeArg ? path.resolve(installedExeArg) : "";
if (!source || !fs.existsSync(path.join(source, ".agent_party_app", "parties.json"))) {
  throw new Error("Pass a workspace containing .agent_party_app as the first argument.");
}

const fixture = path.join(os.tmpdir(), `agentparty-real-switch-${process.pid}`);
const userData = path.join(os.tmpdir(), `agentparty-real-switch-user-${process.pid}`);
let child;
let base = "";

try {
  removeTempPath(fixture);
  removeTempPath(userData);
  fs.mkdirSync(fixture, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.cpSync(path.join(source, ".agent_party_app"), path.join(fixture, ".agent_party_app"), { recursive: true });
  prepareOfflineCopy();
  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ workspacePath: fixture }, null, 2));

  const env = {
    ...process.env,
    AGENTPARTY_QA: "1",
    AGENTPARTY_ALLOW_MULTI_INSTANCE: "1",
    AGENTPARTY_AUTOMATION_PORT: "",
    AGENTPARTY_USER_DATA: userData,
    AGENTPARTY_WINDOW_DISPLAY: "left",
  };
  const processOptions = { stdio: keepOpen ? "ignore" : ["ignore", "ignore", "pipe"], windowsHide: true, detached: keepOpen, env };
  child = installedExe
    ? spawn(installedExe, ["--workspace", fixture], processOptions)
    : spawn(process.env.ComSpec || "cmd.exe", ["/c", "npm", "run", "start", "--", "--workspace", fixture], { ...processOptions, cwd: root });
  child.stderr?.on("data", (chunk) => process.stderr.write(chunk));

  base = await discover();
  const health = await get("/api/health");
  const windows = (await get("/api/windows")).windows || [];
  const windowId = windows.find((item) => path.resolve(item.workspacePath || "") === fixture)?.id;
  if (!windowId) throw new Error(`No benchmark window for ${fixture}`);
  console.log(JSON.stringify({ build: installedExe || health.runtime?.appRoot, fixture, windowId }));

  if (keepOpen) {
    child.unref();
    console.log(JSON.stringify({ qaOpen: true, source, workspaceCopy: fixture, userData, launcherPid: child.pid }));
  } else {

  const catalog = JSON.parse(fs.readFileSync(path.join(fixture, ".agent_party_app", "parties.json"), "utf8"));
  const candidates = catalog.parties.map((party) => {
    const file = path.join(fixture, ".agent_party_app", "parties", party.id, "layout.json");
    let panels = 0;
    try { panels = JSON.parse(fs.readFileSync(file, "utf8")).layout?.panels?.length || 0; } catch { /* no layout */ }
    return { ...party, panels };
  }).filter((party) => party.panels > 0);
  const byName = new Map(candidates.map((party) => [party.name, party]));
  const preferred = ["team2", "teams2", "trans", "story", "teams2", "team2"]
    .map((name) => byName.get(name)).filter(Boolean);
  const sequence = preferred.length >= 4 ? preferred : [...candidates, ...candidates.slice().reverse()];
  const samples = [];
  for (const party of sequence) {
    const started = performance.now();
    await post(`/api/parties/${encodeURIComponent(party.id)}/select?window=${encodeURIComponent(windowId)}`, {});
    const commandMs = performance.now() - started;
    const milestones = await waitReady(party.id, party.name, party.panels, windowId, 20_000, started);
    samples.push({ party: party.name, panels: party.panels, commandMs: round(commandMs), ...milestones });
  }
  console.log(JSON.stringify({ samples }, null, 2));
  await post(`/api/window/close?window=${encodeURIComponent(windowId)}`, {}).catch(() => {});
  await waitForExit(child);
  }
} finally {
  if (!keepOpen) {
    if (child && child.exitCode === null) killProcessTree(child.pid);
    removeTempPath(fixture);
    removeTempPath(userData);
  }
}

function prepareOfflineCopy() {
  const store = path.join(fixture, ".agent_party_app");
  fs.rmSync(path.join(store, "instances"), { recursive: true, force: true });
  fs.mkdirSync(path.join(store, "instances"), { recursive: true });
  const partiesDir = path.join(store, "parties");
  for (const id of fs.readdirSync(partiesDir)) {
    const file = path.join(partiesDir, id, "party.json");
    if (!fs.existsSync(file)) continue;
    const party = JSON.parse(fs.readFileSync(file, "utf8"));
    party.members = (party.members || []).map((member) => {
      const next = { ...member, status: "sleeping", sleptAt: new Date(0).toISOString() };
      delete next.sessionId;
      delete next.sessionBootId;
      return next;
    });
    fs.writeFileSync(file, JSON.stringify(party));
  }
}

function removeTempPath(target) {
  const resolved = path.resolve(target);
  const tempRoot = path.resolve(os.tmpdir());
  if (resolved === tempRoot || !resolved.toLowerCase().startsWith((tempRoot + path.sep).toLowerCase())) {
    throw new Error(`Refusing to remove non-temporary benchmark path: ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

async function waitReady(partyId, partyName, panelCount, windowId, timeoutMs, started) {
  const deadline = performance.now() + timeoutMs;
  let shellMs;
  let firstPanelMs;
  while (performance.now() < deadline) {
    const query = `?window=${encodeURIComponent(windowId)}`;
    const active = await post(`/api/measure${query}`, { selector: ".wb-party-row.is-active .wb-party-name", limit: 1 }).catch(() => ({}));
    const root = await post(`/api/measure${query}`, {
      selector: ".wb-root", limit: 1, styles: [], attributes: ["data-layout-party"],
    }).catch(() => ({}));
    const contents = await post(`/api/measure${query}`, {
      selector: ".wb-transcript > .wb-block:last-child, .wb-transcript > .wb-transcript-empty",
      limit: 32,
      styles: [],
      attributes: [],
    }).catch(() => ({}));
    const layoutParty = root.elements?.[0]?.attributes?.["data-layout-party"];
    if (active.texts?.[0] === partyName && layoutParty === partyId && contents.count === panelCount) {
      shellMs ??= round(performance.now() - started);
      const readyCount = (contents.elements || []).filter((entry) => !entry.tag.includes("wb-transcript-loading")).length;
      if (readyCount > 0) firstPanelMs ??= round(performance.now() - started);
      if (readyCount === panelCount) {
        return { shellMs, firstPanelMs: firstPanelMs ?? shellMs, allPanelsMs: round(performance.now() - started) };
      }
    }
    await delay(15);
  }
  throw new Error(`Party '${partyName}' did not finish painting ${panelCount} panels.`);
}

async function discover() {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    const found = firstBaseUrl(fixture);
    if (found) {
      try { if ((await fetch(found + "/api/health")).ok) return found; } catch { /* starting */ }
    }
    await delay(250);
  }
  throw new Error("Could not discover benchmark app.");
}
async function get(route) { const response = await fetch(base + route); if (!response.ok) throw new Error(`${route}: ${response.status}`); return response.json(); }
async function post(route, body) { const response = await fetch(base + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) }); if (!response.ok) throw new Error(`${route}: ${response.status} ${await response.text()}`); return response.json(); }
function round(value) { return Math.round(value * 10) / 10; }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function killProcessTree(pid) { if (!pid) return; try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* exited */ } }
async function waitForExit(process) { if (process.exitCode !== null) return; await new Promise((resolve) => { process.once("exit", resolve); setTimeout(resolve, 5_000).unref(); }); }
