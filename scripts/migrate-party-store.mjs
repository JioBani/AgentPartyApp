/*
 * Standalone party-store migration — legacy single-blob → per-party split layout.
 *
 * WHY THIS EXISTS (and is separate from the app's own auto-migration):
 *   The multi-process refactor (Stage 1, cd4efd6) replaced one shared
 *   `.agent_party_app/state.json` blob — every party's members+messages in one
 *   file, which two processes clobbered wholesale — with a split layout:
 *     - parties.json                 : SHARED index { version:2, parties[], lastActivePartyId? }
 *     - parties/<id>/party.json      : PER-PARTY { version:2, members[], messages[] }
 *   The app migrates a legacy blob AUTOMATICALLY on its first read. This script
 *   does the SAME transform out-of-band so you can migrate a real workspace
 *   under your control and VERIFY it BEFORE ever launching the new build —
 *   rather than trusting the first launch to convert irreplaceable data. It is a
 *   faithful port of `PartyRepository.readLegacyBlob` + `migrateFromLegacy`
 *   (src/main/partyRepository.ts); keep the two in sync if that logic changes.
 *
 * SAFETY:
 *   - Never deletes or rewrites `state.json` — it is left as the backup, exactly
 *     as the app leaves it after auto-migration.
 *   - Never touches `parties/<id>/members/<name>/transcript.json` — transcripts
 *     already live per-member and keep resolving because the party id (the
 *     directory name) is preserved unchanged.
 *   - Refuses to overwrite an existing `parties.json` unless `--force`, so a
 *     workspace the app already migrated is not silently rewritten.
 *   - `--dry-run` prints the plan and writes nothing.
 *
 * USAGE:
 *   node scripts/migrate-party-store.mjs <workspace> [--dry-run] [--force]
 *
 *   <workspace> is the folder that CONTAINS `.agent_party_app` — the same path
 *   the app opens. For the WSL sellmate-dockerize workspace:
 *     from inside WSL : node scripts/migrate-party-store.mjs /home/spdlqj8876/sellmate-dockerize
 *     from Windows    : node scripts/migrate-party-store.mjs "\\\\wsl.localhost\\Ubuntu-20.04\\home\\spdlqj8876\\sellmate-dockerize"
 *   (both resolve to the same physical `.agent_party_app`; run it from either side.)
 */
import fs from "node:fs";
import path from "node:path";

const ROOT_DIR = ".agent_party_app";
const MESSAGE_CAP = 200; // mirror writeParty: messages.slice(-200)

function parseArgs(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const positional = argv.filter((a) => !a.startsWith("--"));
  return { workspace: positional[0], dryRun: flags.has("--dry-run"), force: flags.has("--force") };
}

/** Faithful port of sanitizeName in partyRepository.ts — MUST match so party dirs align. */
function sanitizeName(value) {
  return value.trim().replace(/[^a-zA-Z0-9._-]/g, "-");
}

function rootDir(workspace) {
  return path.join(workspace, ROOT_DIR);
}
function indexPath(workspace) {
  return path.join(rootDir(workspace), "parties.json");
}
function partyFilePath(workspace, partyId) {
  return path.join(rootDir(workspace), "parties", sanitizeName(partyId), "party.json");
}
function legacyBlobPath(workspace) {
  return path.join(rootDir(workspace), "state.json");
}

/** Port of writeJsonAtomic — per-pid temp + rename, trailing newline (byte-identical to the app). */
function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tempPath = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tempPath, file);
}

/**
 * Port of readLegacyBlob's NORMALIZATION: guarantee every party that owns members
 * is in parties[] and every member/message names a real party. Returns the
 * normalized { parties, lastActivePartyId, members, messages } or null if no blob.
 */
function normalizeLegacy(workspace) {
  const file = legacyBlobPath(workspace);
  if (!fs.existsSync(file)) {
    return null;
  }
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  const parties = Array.isArray(parsed.parties) ? parsed.parties : [];
  const rawMembers = Array.isArray(parsed.members) ? parsed.members : [];
  const rawMessages = Array.isArray(parsed.messages) ? parsed.messages : [];
  // Pre-party legacy data (members but no parties) → synthesize a default party.
  if (parties.length === 0 && rawMembers.length > 0) {
    const now = new Date().toISOString();
    parties.push({ id: "default", name: "Default Party", createdAt: now, updatedAt: now });
    console.warn("  ! legacy had members but no party — synthesizing 'Default Party'");
  }
  const known = new Set(parties.map((p) => p.id));
  const fallbackPartyId = (known.has(parsed.currentPartyId) ? parsed.currentPartyId : undefined) || parties[0]?.id;
  const place = (ownPartyId) => (ownPartyId && known.has(ownPartyId) ? ownPartyId : fallbackPartyId);
  return {
    parties,
    lastActivePartyId: place(parsed.currentPartyId),
    members: rawMembers.map((m) => ({ ...m, partyId: place(m.partyId) })),
    messages: rawMessages.map((m) => ({ ...m, partyId: place(m.partyId) })),
  };
}

/** Port of migrateFromLegacy: split the normalized blob into index + per-party files. */
function planSplit(state) {
  const detailByParty = new Map();
  for (const party of state.parties) {
    detailByParty.set(party.id, { members: [], messages: [] });
  }
  const detailFor = (partyId) => {
    const detail = detailByParty.get(partyId);
    if (!detail) {
      throw new Error(`invariant violated: record references unknown party '${partyId}'`);
    }
    return detail;
  };
  for (const member of state.members) {
    detailFor(member.partyId).members.push(member);
  }
  for (const message of state.messages) {
    detailFor(message.partyId).messages.push(message);
  }
  return detailByParty;
}

function main() {
  const { workspace, dryRun, force } = parseArgs(process.argv.slice(2));
  if (!workspace) {
    console.error("usage: node scripts/migrate-party-store.mjs <workspace> [--dry-run] [--force]");
    process.exit(2);
  }
  const root = rootDir(workspace);
  if (!fs.existsSync(root)) {
    console.error(`✗ no ${ROOT_DIR} under: ${workspace}`);
    process.exit(1);
  }

  const alreadyMigrated = fs.existsSync(indexPath(workspace));
  if (alreadyMigrated && !force) {
    console.error(`✗ parties.json already exists — workspace looks migrated. Re-run with --force to overwrite.`);
    console.error(`   ${indexPath(workspace)}`);
    process.exit(1);
  }

  const state = normalizeLegacy(workspace);
  if (!state) {
    console.error(`✗ no legacy state.json to migrate at: ${legacyBlobPath(workspace)}`);
    process.exit(1);
  }

  const detailByParty = planSplit(state);

  // ---- report ------------------------------------------------------------
  console.log(`workspace : ${workspace}`);
  console.log(`mode      : ${dryRun ? "DRY-RUN (no writes)" : force ? "WRITE (force overwrite)" : "WRITE"}`);
  console.log(`lastActive: ${state.lastActivePartyId ?? "(none)"}`);
  console.log(`parties   : ${state.parties.length}`);
  for (const party of state.parties) {
    const d = detailByParty.get(party.id);
    const capped = d.messages.length > MESSAGE_CAP ? ` (messages TRUNCATED ${d.messages.length}→${MESSAGE_CAP})` : "";
    const active = party.id === state.lastActivePartyId ? "  <- last active" : "";
    console.log(`  - ${party.name}  [${party.id}]  members=${d.members.length} messages=${d.messages.length}${capped}${active}`);
    // Flag transcripts that already exist so you can confirm they stay linked.
    const membersDir = path.join(rootDir(workspace), "parties", sanitizeName(party.id), "members");
    if (fs.existsSync(membersDir)) {
      const withTranscript = fs.readdirSync(membersDir).filter((m) =>
        fs.existsSync(path.join(membersDir, m, "transcript.json")));
      if (withTranscript.length) {
        console.log(`      transcripts kept for: ${withTranscript.join(", ")}`);
      }
    }
  }

  if (dryRun) {
    console.log("\nDRY-RUN: nothing written. state.json is untouched. Re-run without --dry-run to apply.");
    return;
  }

  // ---- write (state.json intentionally left as backup) -------------------
  writeJsonAtomic(indexPath(workspace), {
    version: 2,
    parties: state.parties,
    lastActivePartyId: state.lastActivePartyId,
  });
  for (const [partyId, detail] of detailByParty) {
    writeJsonAtomic(partyFilePath(workspace, partyId), {
      version: 2,
      members: detail.members,
      messages: detail.messages.slice(-MESSAGE_CAP),
    });
  }

  // ---- verify: recompose from the written files and check counts ---------
  const index = JSON.parse(fs.readFileSync(indexPath(workspace), "utf8"));
  let members = 0;
  let messages = 0;
  for (const party of index.parties) {
    const detail = JSON.parse(fs.readFileSync(partyFilePath(workspace, party.id), "utf8"));
    members += detail.members.length;
    messages += detail.messages.length;
  }
  const expectedMessages = [...detailByParty.values()].reduce((n, d) => n + Math.min(d.messages.length, MESSAGE_CAP), 0);
  const ok = members === state.members.length && messages === expectedMessages;
  console.log(`\n${ok ? "✓" : "✗"} verify: wrote ${index.parties.length} parties, ${members} members, ${messages} messages`);
  console.log(`  backup kept: ${legacyBlobPath(workspace)}`);
  if (!ok) {
    console.error(`  expected members=${state.members.length} messages=${expectedMessages}`);
    process.exit(1);
  }
}

main();
