/**
 * Bringing parties that predate groups into the app-global registry.
 *
 * The rules this implements (README §10) are mostly rules about what NOT to do:
 *
 *  - Nothing moves on disk. A party's members, messages, layout and transcripts
 *    stay in the workspace they were written to, and the party keeps its id,
 *    its members keep theirs, and every session id survives. The migration only
 *    reconciles registry rows saying where each party's detail lives; it never
 *    moves party data.
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

import { PartyGroupStore } from "./partyGroupStore";
import { parseMemberLocation } from "../shared/memberLocation";
import type { PartyDefinition, PartyMember } from "../shared/types";
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
export async function migratePartyGroups(
  workspaces: string[],
  deps: {
    store: PartyGroupStore;
    loadWorkspace: (workspacePath: string) => Promise<{ parties: PartyDefinition[]; members: PartyMember[]; backfilled: number }>;
  },
): Promise<MigrationReport> {
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
      // The owning engine performs both operations. A WSL workspace therefore
      // reads `/home/...` inside its distro instead of the desktop trying to
      // open `wsl+Distro:/home/...` as a Windows filesystem path.
      const state = await deps.loadWorkspace(workspacePath);
      // A closed/missing local volume can look like an empty repository. Keep
      // its durable summaries rather than interpreting temporary absence as
      // deletion. Real in-app deletion is reconciled by the live change path.
      if (!state.parties.length) {
        continue;
      }
      const before = new Set(deps.store.read().parties.map((party) => party.id));
      const summaries = state.parties.map((party) => {
        const own = state.members.filter((member) => member.partyId === party.id);
        const envs = own.map((member) => (member.location ? parseMemberLocation(member.location).env : undefined));
        return {
          id: party.id,
          // EMPTY on purpose. The registry uses this only as a new party's
          // default-group seed and preserves an existing party's filing.
          groupId: party.groupId || "",
          name: party.name,
          memberCount: own.length,
          runningCount: 0,
          windowsCount: envs.filter((env) => env === "windows").length,
          wslCount: envs.filter((env) => env === "wsl").length,
          updatedAt: party.updatedAt,
          workspacePath,
        };
      });
      const incomingIds = new Set(summaries.map((party) => party.id));
      const reconciled = deps.store.reconcileWorkspace(workspacePath, summaries);
      report.registered += reconciled.state.parties.filter((party) => !before.has(party.id) && incomingIds.has(party.id)).length;
      report.backfilled += state.backfilled;
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
