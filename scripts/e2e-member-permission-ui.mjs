/*
 * Full-process e2e for the COMPOSER permission control — offline (mock members,
 * no model calls). Launches the REAL app and clicks the real permission widgets
 * in the renderer, then asserts the choice reached the member's party.json and
 * survived an app restart.
 *
 * The regression it locks: the composer's permission setters were session-scoped
 * (`if (sessionId) …`), so a permission changed while the member had NO live
 * session was dropped without a trace and the control snapped back to the stored
 * value — read by users as "the Codex permission resets itself". Both cases are
 * covered here: session down (the bug) and session live (must not regress).
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElectronE2eApp } from "./lib/electron-e2e.mjs";

// Derive the repo from this script so the test always drives the worktree it
// lives in — a hardcoded root silently tests a different checkout.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ws = path.join(os.tmpdir(), "ap-perm-ui-e2e-ws");
const userData = path.join(os.tmpdir(), "ap-perm-ui-e2e-ud");
const failures = [];
const assert = (c, m) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) failures.push(m); };
const partyRoot = path.join(ws, ".agent_party_app");
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** An OS-assigned free port: lanes run this concurrently, so never fix one. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const CODEX_PERM_TRIGGER = ".wb-codex-perm-trigger";
const CODEX_PRESET = (n) => `.wb-codex-perm-menu .wb-segmented .wb-segment:nth-child(${n})`; // 1 Read Only, 2 Auto, 3 Full Access
const CLAUDE_PERM_TRIGGER = 'button[title^="권한"]';
const CLAUDE_PERM_ITEM = (n) => `.wb-dd-menu .wb-dd-item:nth-child(${n})`; // 1 default … 3 plan

async function main() {
  const port = await freePort();
  const app = createElectronE2eApp({ root, workspace: ws, userData, port });
  const { get, post } = app;
  /**
   * Clicks a real DOM node in the running renderer and lets React settle.
   * `/api/capture` rejects a selector that matches nothing, so a stale selector
   * fails this test instead of quietly clicking nothing and still going green.
   */
  const click = async (selector) => {
    const result = await post("/api/capture", { click: selector });
    if (!result?.clicked) {
      throw new Error(`capture did not confirm the click on '${selector}'`);
    }
    await delay(250);
  };

  await app.prepare();
  try {
    await app.launch();
    // Assert WHICH workspace this app is serving before touching anything. The
    // routes that change a window's workspace also rewrite the stored default
    // even when the window lookup fails, so a driver that assumes instead of
    // checking is how an e2e once repointed a real installation.
    const served = (await get("/api/state")).workspacePath || (await get("/api/windows")).windows?.[0]?.workspacePath;
    assert(served === ws, `the app under test serves the isolated QA workspace (got ${served})`);

    await post("/api/qa/reset").catch(() => {});
    await post("/api/qa/seed", { party: "permui", members: [{ name: "claudey", role: "claude permission UI QA" }] });
    let party = await get("/api/party");
    const partyId = party.members.find((m) => m.name === "claudey").partyId;
    const detailFile = path.join(partyRoot, "parties", partyId, "party.json");
    const onDisk = (name) => readJson(detailFile).members.find((m) => m.name === name);
    const live = async (name) => (await get("/api/party")).members.find((m) => m.name === name);

    await post("/api/party/members", {
      partyId,
      name: "codey",
      requirement: "Codex permission UI QA",
      runtime: "codex",
      model: "gpt-5.4-mini",
      codexPolicy: { sandbox: "read-only", approval: "on-request", guardian: false },
    });
    await post("/api/qa/members", { name: "codey", model: "gpt-5.4-mini", autoReply: false });

    // --- Case 1: the bug — change the permission with NO live session --------
    await post("/api/party/members/codey/close", {});
    assert(!(await live("codey"))?.sessionId, "codex member has no live session (the reported condition)");

    await post("/api/qa/open", { panels: [["codey"]] });
    await delay(400);
    await click(CODEX_PERM_TRIGGER);
    await click(CODEX_PRESET(3)); // Full Access
    await delay(300);

    const expectedFull = { sandbox: "danger-full-access", approval: "never", guardian: false };
    assert(JSON.stringify((await live("codey"))?.codexPolicy) === JSON.stringify(expectedFull), "UI click with no live session updates the member state");
    assert(JSON.stringify(onDisk("codey")?.codexPolicy) === JSON.stringify(expectedFull), "UI click with no live session is persisted to party.json");

    // --- Case 2: must not regress — same control with a LIVE session ---------
    await post("/api/qa/members", { name: "codey", model: "gpt-5.4-mini", autoReply: false });
    const started = await live("codey");
    assert(Boolean(started?.sessionId), "codex member restarted with a live mock session");
    await post("/api/qa/open", { panels: [["codey"]] });
    await delay(400);
    await click(CODEX_PERM_TRIGGER);
    await click(CODEX_PRESET(1)); // Read Only
    await delay(300);

    const expectedRead = { sandbox: "read-only", approval: "on-request", guardian: false };
    assert(JSON.stringify(onDisk("codey")?.codexPolicy) === JSON.stringify(expectedRead), "UI click with a live session is still persisted");
    const codexSession = ((await get("/api/state")).sessions || []).find((s) => s.id === started.sessionId);
    assert(codexSession?.snapshot?.codexPolicy?.sandbox === "read-only", "UI click with a live session also reached the running adapter");

    // --- Case 3: the Claude single-mode dropdown, session down --------------
    await post("/api/party/members/claudey/close", {});
    await post("/api/qa/open", { panels: [["claudey"]] });
    await delay(400);
    await click(CLAUDE_PERM_TRIGGER);
    await click(CLAUDE_PERM_ITEM(3)); // plan
    await delay(300);
    assert(onDisk("claudey")?.permissionMode === "plan", "Claude permission mode picked with no live session is persisted");

    // The click driver itself must be trustworthy: a selector that matches
    // nothing has to fail, or every UI assertion above is worthless.
    let rejected = false;
    await post("/api/capture", { click: ".wb-no-such-element-anywhere" }).catch(() => { rejected = true; });
    assert(rejected, "a capture click that matches nothing is reported as a failure, not a silent no-op");

    // The same hazard in the scroll options: a capture of the WRONG position
    // looks as plausible as the right one, so these must not fail quietly either.
    rejected = false;
    await post("/api/capture", { scrollY: 400, scrollSelector: ".no-such-scroll-region" }).catch(() => { rejected = true; });
    assert(rejected, "a capture scrollY naming a missing element fails instead of scrolling something else");
    rejected = false;
    await post("/api/capture", { scrollX: 200 }).catch(() => { rejected = true; });
    assert(rejected, "a capture scrollX without scrollSelector fails instead of doing nothing");
    const scrolled = await post("/api/capture", { scrollY: 0 });
    assert(scrolled?.applied?.scrollY === 0, "a capture scroll reports the position it actually reached");

    await post("/api/capture", {});

    // --- Restart: the value the user picked must come back ------------------
    await app.close();
    await app.launch();
    assert(JSON.stringify((await live("codey"))?.codexPolicy) === JSON.stringify(expectedRead), "Codex policy chosen in the UI survives an app restart");
    assert((await live("claudey"))?.permissionMode === "plan", "Claude permission mode chosen in the UI survives an app restart");

    await app.close();
  } catch (error) {
    app.kill();
    throw error;
  }

  console.log("");
  if (failures.length) { console.log(`MEMBER PERMISSION UI E2E FAILED: ${failures.length}`); process.exit(1); }
  console.log("MEMBER PERMISSION UI E2E PASSED (composer permission clicks persist with and without a live session, in the real app)");
}

main().catch((e) => { console.error(e); process.exit(1); });
