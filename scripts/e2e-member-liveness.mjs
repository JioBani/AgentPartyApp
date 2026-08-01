/*
 * [#13] Does the app tell the truth about whether a member is alive?
 * [#19] Does a member keep its conversation across a close/restart?
 *
 * Full-process, offline (mock members, no model calls).
 *
 * #13: liveness used to mean "an entry exists in the in-memory session map".
 * That entry outlives the harness process, so a member whose harness had ended
 * still reported as running and the UI offered it as ready to chat.
 *
 * #19: the harness thread id — the only way back into a conversation — was
 * recorded solely by the renderer's debounced transcript save. A member driven
 * with NO WINDOW OPEN (how agent-run party members normally work) never had it
 * recorded, so its next start began an empty conversation.
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElectronE2eApp } from "./lib/electron-e2e.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ws = path.join(os.tmpdir(), "ap-liveness-e2e-ws");
const userData = path.join(os.tmpdir(), "ap-liveness-e2e-ud");
const failures = [];
const assert = (c, m) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) failures.push(m); };
const partyRoot = path.join(ws, ".agent_party_app");
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

async function main() {
  const port = await freePort();
  const app = createElectronE2eApp({ root, workspace: ws, userData, port });
  const { get, post } = app;

  await app.prepare();
  try {
    await app.launch();
    // Step 0: prove we are driving THIS worktree's build. `appRoot` is read off
    // the running module, so unlike the workspace (which this driver supplied)
    // it cannot be satisfied by an app started from another checkout.
    const appRoot = (await get("/api/state")).runtime?.appRoot;
    // Compare on a path BOUNDARY. "C:\...\AgentPartyApp" is a string prefix of
    // "C:\...\AgentPartyApp-w1", so a bare startsWith would accept a sibling
    // worktree's build — the exact false green this assertion exists to catch.
    const withinRoot = typeof appRoot === "string"
      && (appRoot + path.sep).toLowerCase().startsWith(root.toLowerCase() + path.sep);
    assert(withinRoot, `the running build is this worktree's (root ${root}, app reports ${appRoot})`);
    const served = (await get("/api/state")).workspacePath || (await get("/api/windows")).windows?.[0]?.workspacePath;
    assert(served === ws, `the app under test serves the isolated QA workspace (got ${served})`);

    await post("/api/qa/reset").catch(() => {});
    await post("/api/qa/seed", { party: "liveness", members: [{ name: "worker", role: "liveness QA" }] });
    let party = await get("/api/party");
    const member = party.members.find((m) => m.name === "worker");
    const partyId = member.partyId;
    const detailFile = path.join(partyRoot, "parties", partyId, "party.json");
    const onDisk = () => readJson(detailFile).members.find((m) => m.name === "worker");
    const live = async () => (await get("/api/party")).members.find((m) => m.name === "worker");
    const turnStatus = async () => (await post("/api/party/members/worker/status", {})).members?.[0]
      ?? (await post("/api/party/members/worker/status", {}));

    assert(Boolean(member?.sessionId), "the member starts with a live session");
    assert((await live())?.status === "running", "a member with a live harness reports running");

    // --- #19: the conversation must be recoverable the instant a turn commits -
    // The thread id used to be written only by the renderer's debounced (1.2s)
    // transcript save. Waiting for that debounce here would test the debounce,
    // not the fix, so this closes the member as soon as the TURN itself is done.
    // A member run with no window open never gets that save at all — the same
    // hole, permanently — but an e2e always has a renderer, so racing the
    // debounce is how that hole is made observable.
    await post("/api/party/messages", { to: "worker", from: "user", content: "hello" });
    const turnCommitted = async () => {
      const view = ((await get("/api/state")).sessions || []).find((s) => s.id === member.sessionId);
      return Number(view?.snapshot?.turnCount || 0) > 0 && String(view?.snapshot?.status) !== "responding";
    };
    for (let i = 0; i < 60 && !(await turnCommitted()); i += 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert(await turnCommitted(), "the turn committed a conversation");
    const thread = onDisk()?.harnessSessionId;
    assert(Boolean(thread), "the harness thread is recorded as soon as the turn commits, not on a later save");

    // --- #13: the harness dies -----------------------------------------------
    await post("/api/qa/members/worker/kill-harness", {});
    let killed = false;
    for (let i = 0; i < 20; i += 1) {
      if ((await live())?.status === "missing_session") { killed = true; break; }
      await new Promise((r) => setTimeout(r, 250));
    }
    assert(killed, "a member whose harness ended stops reporting as running");
    const status = await turnStatus();
    assert(status?.running === false, "the member status an agent reads also stops claiming it is running");
    // Death must not arrive as a BUSY value. A dead member rendered as "working"
    // would put a spinner on it — dressing a wrong state up as a plausible one,
    // which is the failure mode this whole cycle is about.
    assert(status?.turnActive === false, "a dead member is not reported as mid-turn");
    assert(!["requesting", "responding", "interrupting"].includes(String(status?.status)), `a dead member's status is not a busy one (got ${status?.status})`);

    // --- #19: the conversation survives a close + restart --------------------
    await post("/api/party/members/worker/close", {});
    assert(onDisk()?.harnessSessionId === thread, "closing the member keeps the thread it was on");

    await app.close();
    await app.launch();
    assert((await live())?.harnessSessionId === thread, "the thread survives an app restart, so the next turn resumes it");

    await app.close();
  } catch (error) {
    app.kill();
    throw error;
  }

  console.log("");
  if (failures.length) { console.log(`MEMBER LIVENESS E2E FAILED: ${failures.length}`); process.exit(1); }
  console.log("MEMBER LIVENESS E2E PASSED (#13 liveness is reported honestly, #19 the conversation survives)");
}

main().catch((e) => { console.error(e); process.exit(1); });
