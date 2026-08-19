/*
 * Full-process regression for party-switch latency at realistic store scale.
 *
 * The fixture mirrors the shape that exposed the lag in a real workspace:
 * eight parties, 12 open tabs / six panels per party, tool-heavy multi-megabyte
 * transcripts. It launches the real Electron app on isolated userData, selects
 * parties through the public automation route (the same AppController method
 * as the sidebar), and measures layout, first-panel, and all-panel paint.
 *
 * Offline: sleeping members never start a harness, so there is no model call.
 * Run after `npm run build`.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { firstBaseUrl } from "./lib/discovery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ws = path.join(os.tmpdir(), `agentparty-party-switch-perf-${process.pid}`);
const userData = path.join(os.tmpdir(), `agentparty-party-switch-perf-user-${process.pid}`);
const shot = path.join(os.tmpdir(), `agentparty-party-switch-perf-${process.pid}.png`);

const PARTY_COUNT = 8;
const MEMBERS_PER_PARTY = 12;
const VISIBLE_PANELS = 6;
const BLOCKS_PER_TRANSCRIPT = 400;
const BLOCK_TEXT_BYTES = 1_400;
const MAX_INTERACTIVE_MS = Number(process.env.AGENTPARTY_PARTY_SWITCH_MAX_MS || 500);
const MAX_ALL_PANELS_MS = Number(process.env.AGENTPARTY_PARTY_SWITCH_ALL_MAX_MS || 5_000);

let base = "";
const failures = [];
const assert = (condition, message) => {
  console.log(`  ${condition ? "ok" : "FAIL"}: ${message}`);
  if (!condition) failures.push(message);
};

async function main() {
  removePath(ws);
  removePath(userData);
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  seedStore();
  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ workspacePath: ws }, null, 2));

  const child = spawn(process.env.ComSpec || "cmd.exe", ["/c", "npm", "run", "start"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      AGENTPARTY_QA: "1",
      AGENTPARTY_ALLOW_MULTI_INSTANCE: "1",
      AGENTPARTY_AUTOMATION_PORT: "",
      AGENTPARTY_USER_DATA: userData,
      AGENTPARTY_WINDOW_DISPLAY: "left",
    },
  });
  let appStderr = "";
  child.stderr.on("data", (chunk) => {
    appStderr += String(chunk);
    process.stderr.write(chunk);
  });

  try {
    base = await discover();
    const health = await get("/api/health");
    assert(health.ok, `real app is healthy at ${base}`);
    assertRunningBuildIsThisWorktree(health.runtime?.appRoot || "");

    const windows = (await get("/api/windows")).windows || [];
    const windowId = windows[0]?.id;
    assert(windows[0]?.workspacePath === ws, `window serves isolated fixture (${windows[0]?.workspacePath || "missing"})`);
    assert(Boolean(windowId), "test window is addressable through the automation API");

    await waitForPartyReady("perf-party-0", windowId, 15_000, performance.now());

    const samples = [];
    for (let index = 1; index < PARTY_COUNT; index += 1) {
      const partyId = `perf-party-${index}`;
      const started = performance.now();
      await post(`/api/parties/${partyId}/select?window=${encodeURIComponent(windowId)}`, {});
      const commandMs = performance.now() - started;
      const milestones = await waitForPartyReady(partyId, windowId, MAX_ALL_PANELS_MS * 2, started);
      samples.push({ partyId, commandMs: round(commandMs), ...milestones });
    }

    // A warm return is a different failure mode: every transcript is cached,
    // so without staged DOM reveal React remounts all visible cards at once.
    const warmPartyId = "perf-party-1";
    const warmStarted = performance.now();
    await post(`/api/parties/${warmPartyId}/select?window=${encodeURIComponent(windowId)}`, {});
    samples.push({
      partyId: `${warmPartyId}-warm`,
      commandMs: round(performance.now() - warmStarted),
      ...await waitForPartyReady(warmPartyId, windowId, MAX_ALL_PANELS_MS * 2, warmStarted),
    });

    // Background tabs are intentionally not restored during the party switch.
    // Selecting one must still feel immediate and converge on the same history.
    const query = `?window=${encodeURIComponent(windowId)}`;
    const storedLayout = (await get(`/api/party/layout${query}`)).layout;
    storedLayout.panels[0].active = "member-6";
    const backgroundStarted = performance.now();
    await post(`/api/party/layout${query}`, { layout: storedLayout });
    const backgroundTabMs = await waitForMemberReady("panel-1-0", "member-6", warmPartyId, windowId, 5_000, backgroundStarted);

    const worstInteractive = Math.max(...samples.map((sample) => sample.firstPanelMs));
    const worstAll = Math.max(...samples.map((sample) => sample.allPanelsMs));
    const medianInteractive = samples.map((sample) => sample.firstPanelMs).sort((a, b) => a - b)[Math.floor(samples.length / 2)];
    const transcriptBytes = PARTY_COUNT * MEMBERS_PER_PARTY * BLOCKS_PER_TRANSCRIPT * BLOCK_TEXT_BYTES;
    console.log(`  scale: ${PARTY_COUNT} parties, ${PARTY_COUNT * MEMBERS_PER_PARTY} transcripts, ~${Math.round(transcriptBytes / 1024 / 1024)} MiB text`);
    console.log(`  samples: ${JSON.stringify(samples)}`);
    assert(worstInteractive <= MAX_INTERACTIVE_MS, `worst first usable panel ${worstInteractive}ms <= ${MAX_INTERACTIVE_MS}ms (median ${medianInteractive}ms)`);
    assert(worstAll <= MAX_ALL_PANELS_MS, `all six panels finish sequentially within ${MAX_ALL_PANELS_MS}ms (worst ${worstAll}ms)`);
    assert(backgroundTabMs <= MAX_INTERACTIVE_MS, `a previously unloaded background tab becomes usable in ${backgroundTabMs}ms <= ${MAX_INTERACTIVE_MS}ms`);
    assert(!appStderr.includes("party:transcript:get failed"), "rapid party switches never restore a previous party member through the new party scope");

    await waitForCount(".wb-transcript > .wb-block", VISIBLE_PANELS * 150, windowId, 5_000);
    const rendered = await post(`/api/measure${query}`, { selector: ".wb-transcript > .wb-block", limit: 1 });
    const older = await post(`/api/measure${query}`, { selector: ".wb-transcript-older", limit: VISIBLE_PANELS });
    assert(rendered.count === VISIBLE_PANELS * 150, `all six panels retain the established 150-block tail (${rendered.count})`);
    assert(older.count === VISIBLE_PANELS, `all ${VISIBLE_PANELS} panels retain the older-history control`);

    const openedTool = await post(`/api/capture${query}`, { path: shot, click: ".wb-tool:not([open]) > summary" });
    const toolBody = await post(`/api/measure${query}`, { selector: ".wb-tool[open] .wb-tool-result", limit: 1 });
    assert(openedTool.applied?.clicked && toolBody.count > 0, "a deferred collapsed tool body renders normally on first open");

    const capture = await post(`/api/capture${query}`, { path: shot, click: ".wb-transcript-older" });
    const expanded = await post(`/api/measure${query}`, { selector: ".wb-transcript > .wb-block", limit: 1 });
    assert(capture.applied?.clicked, "older-history control is clickable in the real workbench");
    assert(expanded.count === VISIBLE_PANELS * 150 + 150, `one panel reveals a 150-block older page without expanding the others (${expanded.count})`);
    assert(capture.ok && capture.bytes > 0, `captured switched workbench (${capture.bytes || 0} bytes)`);

    await post(`/api/window/close?window=${encodeURIComponent(windowId)}`, {}).catch(() => {});
    await waitForExit(child);
  } catch (error) {
    killProcessTree(child.pid);
    throw error;
  } finally {
    removePath(ws);
    removePath(userData);
  }

  console.log(failures.length ? `\nPARTY SWITCH PERF E2E FAILED (${failures.length})` : "\nPARTY SWITCH PERF E2E PASSED");
  process.exit(failures.length ? 1 : 0);
}

function seedStore() {
  const storage = path.join(ws, ".agent_party_app");
  const parties = Array.from({ length: PARTY_COUNT }, (_, index) => ({
    id: `perf-party-${index}`,
    name: `Perf Party ${index}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }));
  fs.mkdirSync(storage, { recursive: true });
  fs.writeFileSync(path.join(storage, ".gitignore"), "*\n");
  fs.writeFileSync(path.join(storage, "parties.json"), JSON.stringify({ version: 2, parties, lastActivePartyId: parties[0].id }, null, 2));

  const filler = "x".repeat(BLOCK_TEXT_BYTES);
  for (const [partyIndex, party] of parties.entries()) {
    const partyDir = path.join(storage, "parties", party.id);
    const members = Array.from({ length: MEMBERS_PER_PARTY }, (_, memberIndex) => ({
      partyId: party.id,
      name: memberIndex === 0 ? "main" : `member-${memberIndex}`,
      role: "Performance fixture member",
      runtime: "codex",
      model: "gpt-5.4-mini",
      status: "sleeping",
      createdAt: `2026-01-01T00:00:${String(memberIndex).padStart(2, "0")}.000Z`,
      updatedAt: "2026-01-01T00:00:00.000Z",
      sleptAt: "2026-01-01T00:00:00.000Z",
    }));
    fs.mkdirSync(partyDir, { recursive: true });
    fs.writeFileSync(path.join(partyDir, "party.json"), JSON.stringify({ version: 2, members, messages: [] }, null, 2));
    fs.writeFileSync(path.join(partyDir, "layout.json"), JSON.stringify({
      version: 1,
      layout: {
        panels: members.slice(0, VISIBLE_PANELS).map((member, memberIndex) => ({
          id: `panel-${partyIndex}-${memberIndex}`,
          tabs: [member.name, members[memberIndex + VISIBLE_PANELS].name],
          active: member.name,
          weight: 1,
        })),
        focusedPanelId: `panel-${partyIndex}-0`,
      },
    }, null, 2));

    for (const member of members) {
      const memberDir = path.join(partyDir, "members", member.name);
      fs.mkdirSync(memberDir, { recursive: true });
      const blocks = Array.from({ length: BLOCKS_PER_TRANSCRIPT }, (_, blockIndex) => {
        const common = { id: `${party.id}-${member.name}-${blockIndex}`, at: "12:00" };
        if (blockIndex % 2 === 0) {
          return {
            ...common,
            kind: "tool",
            name: "shell",
            status: "completed",
            input: { command: `echo ${party.id} ${member.name}` },
            result: filler,
          };
        }
        return {
          ...common,
          kind: "assistant",
          text: blockIndex === BLOCKS_PER_TRANSCRIPT - 1 ? `READY ${party.id} ${member.name}` : filler,
        };
      });
      fs.writeFileSync(path.join(memberDir, "transcript.json"), JSON.stringify({ version: 1, blocks }));
    }
  }
}

async function waitForPartyReady(partyId, windowId, timeoutMs, started) {
  const deadline = performance.now() + timeoutMs;
  let shellMs;
  let firstPanelMs;
  while (performance.now() < deadline) {
    try {
      const query = `?window=${encodeURIComponent(windowId)}`;
      const active = await post(`/api/measure${query}`, { selector: ".wb-party-row.is-active .wb-party-name", limit: 1 });
      const rootState = await post(`/api/measure${query}`, {
        selector: ".wb-root",
        limit: 1,
        styles: [],
        attributes: ["data-layout-party"],
      });
      const contents = await post(`/api/measure${query}`, {
        selector: ".wb-transcript > .wb-assistant:last-child, .wb-transcript > .wb-transcript-empty",
        limit: VISIBLE_PANELS,
        styles: [],
        attributes: [],
      });
      const correctParty = active.texts?.[0] === `Perf Party ${Number(partyId.split("-").at(-1))}`
        && rootState.elements?.[0]?.attributes?.["data-layout-party"] === partyId;
      if (correctParty && contents.count === VISIBLE_PANELS) {
        shellMs ??= round(performance.now() - started);
        const readyCount = (contents.elements || []).filter((entry) => (
          entry.tag.includes("wb-assistant") && entry.text.includes(`READY ${partyId}`)
        )).length;
        if (readyCount > 0) firstPanelMs ??= round(performance.now() - started);
        if (readyCount === VISIBLE_PANELS) {
          return {
            shellMs,
            firstPanelMs: firstPanelMs ?? shellMs,
            allPanelsMs: round(performance.now() - started),
          };
        }
      }
    } catch {
      // Party update/layout/transcript restore is still in flight.
    }
    await delay(15);
  }
  throw new Error(`Party '${partyId}' did not paint ${VISIBLE_PANELS} transcripts within ${timeoutMs}ms.`);
}

async function waitForCount(selector, expected, windowId, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  const query = `?window=${encodeURIComponent(windowId)}`;
  while (performance.now() < deadline) {
    const result = await post(`/api/measure${query}`, { selector, limit: 1 }).catch(() => ({}));
    if (result.count === expected) return;
    await delay(15);
  }
  throw new Error(`Selector '${selector}' did not reach ${expected} elements within ${timeoutMs}ms.`);
}

async function waitForMemberReady(panelId, member, partyId, windowId, timeoutMs, started) {
  const deadline = performance.now() + timeoutMs;
  const query = `?window=${encodeURIComponent(windowId)}`;
  while (performance.now() < deadline) {
    const heading = await post(`/api/measure${query}`, {
      selector: `[data-panel-id="${panelId}"] .wb-toolbar-id strong`, limit: 1,
    }).catch(() => ({}));
    const tail = await post(`/api/measure${query}`, {
      selector: `[data-panel-id="${panelId}"] .wb-transcript > .wb-assistant:last-child, [data-panel-id="${panelId}"] .wb-transcript > .wb-transcript-empty`,
      limit: 1,
      styles: [],
      attributes: [],
    }).catch(() => ({}));
    if (heading.texts?.[0] === member && tail.texts?.[0]?.includes(`READY ${partyId} ${member}`)) {
      return round(performance.now() - started);
    }
    await delay(15);
  }
  throw new Error(`Background tab '${member}' did not become usable within ${timeoutMs}ms.`);
}

function assertRunningBuildIsThisWorktree(appRoot) {
  const within = (path.resolve(appRoot) + path.sep).toLowerCase().startsWith(root.toLowerCase() + path.sep);
  assert(within, `running app comes from this worktree (${appRoot || "missing appRoot"})`);
}

async function discover() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const found = firstBaseUrl(ws);
    if (found) {
      try {
        const response = await fetch(found + "/api/health");
        if (response.ok && (await response.json()).ok) return found;
      } catch {
        // App is still starting.
      }
    }
    await delay(250);
  }
  throw new Error("Could not discover the isolated AgentParty process.");
}

async function get(route) {
  const response = await fetch(base + route);
  if (!response.ok) throw new Error(`${route} ${response.status}: ${await response.text()}`);
  return response.json();
}

async function post(route, body) {
  const response = await fetch(base + route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (!response.ok) throw new Error(`${route} ${response.status}: ${await response.text()}`);
  return response.json();
}

function removePath(target) {
  const resolved = path.resolve(target);
  const tempRoot = path.resolve(os.tmpdir());
  if (resolved === tempRoot || !resolved.toLowerCase().startsWith((tempRoot + path.sep).toLowerCase())) {
    throw new Error(`Refusing to remove non-temporary QA path: ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

function killProcessTree(pid) {
  if (!pid) return;
  try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* already exited */ }
}

async function waitForExit(child) {
  if (child.exitCode !== null) return;
  await new Promise((resolve) => {
    child.once("exit", resolve);
    setTimeout(() => { killProcessTree(child.pid); resolve(); }, 5_000).unref();
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function round(value) {
  return Math.round(value * 10) / 10;
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
