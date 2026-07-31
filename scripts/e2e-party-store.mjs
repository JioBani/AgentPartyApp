/*
 * Full-process e2e for the party storage split (Stage 1) — offline (mock members,
 * no model). Launches the REAL app on an isolated userData + temp workspace and
 * proves, in the actual app path:
 *   1) new parties/members persist to the SPLIT layout (parties.json index +
 *      parties/<id>/party.json), never the old single state.json;
 *   2) `lastActivePartyId` is restored across an app RESTART (currentPartyId is
 *      per-process runtime, seeded from the persisted hint);
 *   3) a pre-existing legacy `state.json` migrates on first read with data intact.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElectronE2eApp } from "./lib/electron-e2e.mjs";

const root = "C:\\Project\\AgentPartyApp";
const ws = path.join(os.tmpdir(), "ap-party-store-e2e-ws");
const userData = path.join(os.tmpdir(), "ap-party-store-e2e-ud");
const port = Number(process.env.AGENTPARTY_PARTY_STORE_PORT || "") || 48942;
const failures = [];
const assert = (c, m) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) failures.push(m); };
const partyRoot = path.join(ws, ".agent_party_app");
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const app = createElectronE2eApp({ root, workspace: ws, userData, port });
const { get, post } = app;

async function main() {
  await app.prepare();

  // --- seed a LEGACY blob so the same run also proves migration -------------
  fs.mkdirSync(partyRoot, { recursive: true });
  fs.writeFileSync(path.join(partyRoot, "state.json"), JSON.stringify({
    version: 1,
    parties: [{ id: "legacy-1", name: "Legacy Party", createdAt: "t", updatedAt: "t" }],
    currentPartyId: "legacy-1",
    members: [{ name: "main", partyId: "legacy-1", status: "idle" }],
    messages: [],
  }));

  try {
    // 1) migration happened on first read
    await app.launch();
    let party = await get("/api/party");
    assert(party.parties.some((p) => p.id === "legacy-1"), "legacy party migrated + visible after launch");
    assert(fs.existsSync(path.join(partyRoot, "parties.json")), "split index parties.json written on migration");
    assert(fs.existsSync(path.join(partyRoot, "parties", "legacy-1", "party.json")), "legacy party's per-party file written");
    assert(readJson(path.join(partyRoot, "parties", "legacy-1", "party.json")).members.some((m) => m.name === "main"), "legacy member preserved in per-party file");

    // 2) new parties/members use the split layout, not state.json
    await post("/api/qa/reset").catch(() => {});
    await post("/api/qa/seed", { party: "alpha", members: [{ name: "aa", role: "r" }] });
    await post("/api/qa/seed", { party: "beta", members: [{ name: "bb", role: "r" }] });
    party = await get("/api/party");
    const alpha = party.parties.find((p) => p.name === "alpha");
    const beta = party.parties.find((p) => p.name === "beta");
    assert(Boolean(alpha && beta), "both new parties created");
    assert(fs.existsSync(path.join(partyRoot, "parties", alpha.id, "party.json")), "alpha detail file exists");
    assert(fs.existsSync(path.join(partyRoot, "parties", beta.id, "party.json")), "beta detail file exists");
    assert(readJson(path.join(partyRoot, "parties", alpha.id, "party.json")).members.some((m) => m.name === "aa"), "alpha's member is in ALPHA's file only");
    assert(!readJson(path.join(partyRoot, "parties", beta.id, "party.json")).members.some((m) => m.name === "aa"), "alpha's member is NOT in beta's file (isolated)");

    // 3) select alpha → lastActivePartyId persisted to the shared index
    await post(`/api/parties/${alpha.id}/select`);
    assert(readJson(path.join(partyRoot, "parties.json")).lastActivePartyId === alpha.id, "selecting alpha persisted lastActivePartyId to the index");

    // --- RESTART the app, same userData + workspace --------------------------
    await app.close();
    await app.launch();

    party = await get("/api/party");
    assert(party.parties.length >= 3, `all parties restored after restart (${party.parties.length})`);
    assert(party.currentPartyId === alpha.id, "currentPartyId restored to last-active (alpha) after restart");
    assert(party.members.some((m) => m.name === "aa"), "restart shows the active party's members (aa)");

    await app.close();
  } catch (error) {
    app.kill();
    throw error;
  }

  console.log("");
  if (failures.length) { console.log(`PARTY STORE E2E FAILED: ${failures.length}`); process.exit(1); }
  console.log("PARTY STORE E2E PASSED (split layout + last-active restore + legacy migration, in the real app)");
}

main().catch((e) => { console.error(e); process.exit(1); });
