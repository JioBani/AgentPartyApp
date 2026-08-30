/*
 * Full-process e2e for the per-turn Token Usage LEDGER (phase 1: instrumentation).
 * Launches the real app (QA, mock harness — no model calls), seeds a mock party,
 * drives several real turns through the party workbench message API, then asserts
 * the automation API `GET /api/token-usage` returns a real, attributed aggregate:
 *   - recordCount > 0 (turns were logged),
 *   - a token split (input/output) actually reached the ledger,
 *   - the derived list-price estCost is computed,
 *   - rollups attribute spend to the party, its members, and the trigger.
 *
 * This proves the ledger plumbing end to end (adapter turn_complete → sessionManager
 * → UsageLedger → engine aggregate → HTTP) on the SAME AppController method the UI
 * will use. Empty-range honesty ("아직 없음") is also asserted.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { firstBaseUrl } from "./lib/discovery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ws = path.join(os.tmpdir(), "agentparty-token-usage-e2e-workspace");
const userData = path.join(os.tmpdir(), "agentparty-token-usage-e2e-user-data");
let base = "";

const MEMBERS = [
  { name: "backend", model: "sonnet", role: "API/auth", autoReply: true },
  { name: "frontend", model: "sonnet", role: "login UI", autoReply: true },
  { name: "reviewer", model: "haiku", role: "review", autoReply: true },
];

async function main() {
  await removePath(ws);
  await removePath(userData);
  fs.mkdirSync(ws, { recursive: true });

  const child = spawn(process.execPath, [path.join(root, "scripts", "launch-electron.mjs"), "--workspace", ws], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      AGENTPARTY_QA: "1",
      AGENTPARTY_ALLOW_MULTI_INSTANCE: "1",
      AGENTPARTY_USER_DATA: userData,
      AGENTPARTY_WINDOW_DISPLAY: "left",
    },
    windowsHide: true,
  });
  child.stdout.on("data", (c) => process.stdout.write(c));
  child.stderr.on("data", (c) => process.stderr.write(c));

  try {
    await waitForApi();
    assert((await getJson("/api/health")).ok, "health ok");

    // Empty ledger → honest empty aggregate BEFORE any turn.
    const empty = await getJson("/api/token-usage?range=5h&bucket=5");
    assert(empty.recordCount === 0, `empty ledger reports recordCount 0 (got ${empty.recordCount})`);
    assert(Array.isArray(empty.buckets) && empty.buckets.length === 0, "empty ledger has no buckets");

    // Seed a mock party and drive real turns.
    await post("/api/qa/reset").catch(() => {});
    const seeded = await post("/api/qa/seed", { party: "Token Usage e2e", members: MEMBERS });
    assert(seeded.created?.length === MEMBERS.length, `seeded ${MEMBERS.length} mock members`);

    const state = await getJson("/api/state");
    const partyId = state.party?.currentPartyId || state.party?.parties?.[0]?.id;
    assert(partyId, `party id resolved (${partyId})`);

    // Drive turns: several to backend, a couple to frontend, one to reviewer.
    const sends = [
      ["backend", "trace the 500 in verifyRefresh and propose a fix"],
      ["backend", "now write the 401 conversion"],
      ["backend", "add a regression test"],
      ["frontend", "wire the login form to the new 401 contract"],
      ["frontend", "handle the re-auth hint"],
      ["reviewer", "review the auth diff"],
    ];
    for (let index = 0; index < sends.length; index += 1) {
      const [name, text] = sends[index];
      await post(`/api/party/members/${name}/message`, { text });
      // Wait for this turn to commit before sending the next one. This test is
      // about ledger accounting, not the separate rapid-queue handoff path.
      await waitForRecords(index + 1);
    }

    // Wait for the ledger to reflect every driven turn (mock auto-reply is ~700ms).
    const agg = await waitForRecords(sends.length);
    assert(agg.recordCount >= sends.length, `ledger logged ${agg.recordCount} turns (≥ ${sends.length})`);

    // A real token split reached the ledger, and est cost was derived.
    assert(agg.totals.input > 0 && agg.totals.output > 0, `token split logged (in=${agg.totals.input}, out=${agg.totals.output})`);
    assert(agg.totals.estCostUsd > 0, `list-price estCost derived (≈$${agg.totals.estCostUsd.toFixed(4)})`);
    assert(agg.totals.effectiveCostUsd > 0 && agg.totals.estimatedCostTurns > 0,
      `dashboard cost uses list-price fallback when no bill is reported (≈$${agg.totals.effectiveCostUsd.toFixed(4)})`);

    // Rollups attribute spend correctly.
    const party = agg.parties.find((p) => p.key === partyId);
    assert(party, `party rollup present for ${partyId}`);
    const memberNames = agg.members.map((m) => m.label);
    for (const m of ["backend", "frontend", "reviewer"]) {
      assert(memberNames.includes(m), `member rollup includes ${m}`);
    }
    const backend = agg.members.find((m) => m.label === "backend");
    assert(backend.turns >= 3, `backend logged ≥3 turns (${backend.turns})`);
    // Trigger is best-effort and honest: a user send tags its turn `user`; extra
    // turn_completes from rapidly-queued sends (no fresh send origin) record
    // `unknown` — never a fabricated label. Assert both: ≥1 user turn per member
    // was tagged, and NOTHING was mis-tagged as an overhead trigger.
    const userTrigger = agg.triggers.find((t) => t.key === "user");
    assert(userTrigger && userTrigger.turns >= 3, `user sends tagged trigger=user (${userTrigger?.turns} ≥ 3)`);
    const overhead = agg.triggers.filter((t) => ["party-message", "gate-review", "compact", "subagent", "init"].includes(t.key));
    assert(overhead.length === 0, `no user send mis-tagged as an overhead trigger (${overhead.map((t) => t.key).join(",") || "none"})`);

    // Party-scoped query buckets by member.
    const scoped = await getJson(`/api/token-usage?range=5h&bucket=5&party=${encodeURIComponent(partyId)}`);
    assert(scoped.recordCount === agg.recordCount, "party-scoped query returns the same record count");
    assert(scoped.buckets.some((b) => Object.keys(b.bySeries).some((k) => ["backend", "frontend", "reviewer"].includes(k))), "party-scoped buckets are keyed by member");

    console.log(`\n  aggregate: ${agg.recordCount} turns, ≈$${agg.totals.estCostUsd.toFixed(4)}, ${agg.buckets.length} bucket(s)`);
    console.log(`  top members: ${agg.members.slice(0, 3).map((m) => `${m.label}(${m.turns}t/≈$${m.estCostUsd.toFixed(3)})`).join(", ")}`);

    await post("/api/window/close", {});
    await waitForExit(child);
    console.log("TOKEN USAGE LEDGER E2E PASSED (real per-turn records, attributed + queryable)");
  } catch (error) {
    killProcessTree(child.pid);
    throw error;
  }
}

async function waitForRecords(min) {
  const started = Date.now();
  let last;
  while (Date.now() - started < 30000) {
    last = await getJson("/api/token-usage?range=5h&bucket=5");
    if (last.recordCount >= min) return last;
    await delay(1000);
  }
  throw new Error(`ledger never reached ${min} records (last=${last?.recordCount}).`);
}

async function waitForApi() {
  const started = Date.now();
  while (Date.now() - started < 60000) {
    base = firstBaseUrl(ws);
    if (base) {
      try { if ((await getJson("/api/health")).ok) return; } catch {}
    }
    await delay(500);
  }
  throw new Error("Automation API did not start (no live instance file under the e2e workspace).");
}

async function getJson(u) {
  const r = await fetch(base + u);
  if (!r.ok) throw new Error(`${u} returned ${r.status}`);
  return r.json();
}

async function post(u, b) {
  const r = await fetch(base + u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) });
  if (!r.ok) throw new Error(`${u} returned ${r.status}: ${await r.text()}`);
  return r.json();
}

async function removePath(target) {
  for (let i = 0; i < 10; i += 1) {
    try { fs.rmSync(target, { recursive: true, force: true }); return; } catch (e) { if (e?.code !== "EBUSY" || i === 9) return; await delay(300); }
  }
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("App did not exit after close API.")), 10000);
    child.once("exit", () => { clearTimeout(t); resolve(); });
  });
}

function killProcessTree(pid) {
  if (!pid) return;
  try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch { try { process.kill(pid); } catch {} }
}

function assert(v, m) { if (!v) throw new Error(`Assertion failed: ${m}`); console.log(`  ok: ${m}`); }
function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

main().catch((e) => { console.error(e); process.exit(1); });
