/**
 * Bringing parties that predate groups into the app-global registry.
 *
 * The rules this implements (README §10) are mostly rules about what NOT to do:
 *
 *  - Nothing moves on disk. A party's members, messages, layout and transcripts
 *    stay in the workspace they were written to, and the party keeps its id,
 *    its members keep theirs, and every session id survives. The migration only
 *    ADDS: a registry row saying "this party is in the default group, and its
 *    detail lives in that workspace".
 *  - A member with no `location` is backfilled with the workspace its party was
 *    stored in — the directory it has been running in all along, not a guess.
 *  - The same party id found in two workspaces is recorded as a conflict, never
 *    merged: picking a winner would hide whichever copy holds the conversation
 *    the user was looking for.
 *  - Re-running changes nothing. That is what makes it safe to run on every
 *    boot, which is the only way a workspace opened for the first time next
 *    week also gets registered.
 *
 * A partial failure is reported, not smoothed over: a workspace that could not
 * be read is named in the result rather than leaving a silently short list.
 */

import { PartyRepository } from "./partyRepository";
import { PartyGroupStore } from "./partyGroupStore";
import { parseMemberLocation } from "../shared/memberLocation";
import type { PartyMember } from "../shared/types";
import { log } from "./logger";

export interface MigrationReport {
  ok: boolean;
  /** Workspaces examined this run. */
  workspaces: string[];
  /** Parties newly added to the registry (already-registered ones are not counted). */
  registered: number;
  /** Members that had no location and were given their workspace's. */
  backfilled: number;
  /** Parties whose id was claimed by a second workspace. */
  conflicts: Array<{ partyId: string; workspacePaths: string[] }>;
  /** Workspaces that could not be read, with why. */
  failures: Array<{ workspacePath: string; error: string }>;
}

/**
 * Registers every party found in `workspaces`, backfilling member locations.
 *
 * `workspaces` is the caller's list of places to look — the open windows plus
 * whatever the registry already knows. The migration deliberately does not go
 * hunting the filesystem for `.agent_party_app` directories: a scan would pick
 * up copies, backups and other checkouts, and quietly present them as the
 * user's parties.
 */
export function migratePartyGroups(
  workspaces: string[],
  deps: { repository: PartyRepository; store: PartyGroupStore },
): MigrationReport {
  const report: MigrationReport = {
    ok: true,
    workspaces: [...new Set(workspaces.filter(Boolean))],
    registered: 0,
    backfilled: 0,
    conflicts: [],
    failures: [],
  };

  for (const workspacePath of report.workspaces) {
    try {
      const state = deps.repository.read(workspacePath);
      if (!state.parties.length) {
        continue;
      }
      const before = new Set(deps.store.read().parties.map((party) => party.id));
      const backfilled = backfillLocations(state.members, workspacePath);
      if (backfilled.length) {
        // One write per party, because that is the file that owns its members.
        for (const partyId of new Set(backfilled.map((member) => member.partyId || ""))) {
          deps.repository.writeParty(
            workspacePath,
            partyId,
            state.members.filter((member) => member.partyId === partyId),
            state.messages.filter((message) => message.partyId === partyId),
          );
        }
        report.backfilled += backfilled.length;
      }

      for (const party of state.parties) {
        const own = state.members.filter((member) => member.partyId === party.id);
        const envs = own.map((member) => (member.location ? parseMemberLocation(member.location).env : undefined));
        deps.store.upsertParty({
          id: party.id,
          // EMPTY on purpose. `upsertParty` files a party it has never seen into
          // the default group and leaves an already-registered one where it is;
          // naming the default here instead would drag every party the user
          // moved back into 기본 그룹 on the next boot — which it did.
          groupId: party.groupId || "",
          name: party.name,
          memberCount: own.length,
          runningCount: 0,
          windowsCount: envs.filter((env) => env === "windows").length,
          wslCount: envs.filter((env) => env === "wsl").length,
          updatedAt: party.updatedAt,
          workspacePath,
        });
        if (!before.has(party.id)) {
          report.registered += 1;
        }
      }
    } catch (error) {
      report.ok = false;
      report.failures.push({ workspacePath, error: error instanceof Error ? error.message : String(error) });
      log("error", "party", "party group migration failed for a workspace", { workspacePath, error: String(error) });
    }
  }

  report.conflicts = (deps.store.read().conflicts || []).map((entry) => ({ partyId: entry.partyId, workspacePaths: entry.workspacePaths }));
  log(report.ok ? "info" : "warn", "party", "party group migration finished", {
    workspaces: report.workspaces.length,
    registered: report.registered,
    backfilled: report.backfilled,
    conflicts: report.conflicts.length,
    failures: report.failures.length,
  });
  return report;
}

/**
 * Gives every member with no location the workspace its party was stored in.
 *
 * Mutates in place and returns what it touched, so the caller writes only the
 * parties that actually changed. A member that already has one is never
 * rewritten — the stored value is the user's choice, and this function has no
 * better information than they did.
 */
function backfillLocations(members: PartyMember[], workspacePath: string): PartyMember[] {
  const touched: PartyMember[] = [];
  for (const member of members) {
    if (!member.location) {
      member.location = workspacePath;
      member.updatedAt = new Date().toISOString();
      touched.push(member);
    }
  }
  return touched;
}
