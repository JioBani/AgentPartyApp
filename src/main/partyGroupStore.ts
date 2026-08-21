/**
 * The app-global registry of party groups and the parties filed under them.
 *
 * Lives in `userData/party-groups.json`, NOT in a workspace, because that is the
 * whole point: opening the app from a different directory must show the same
 * groups and the same parties (README §4.3).
 *
 * What it does NOT hold is as important. A party's members, messages, layout and
 * transcripts stay exactly where they are — under that party's own workspace
 * `.agent_party_app/` — so this change costs no party id, session id or
 * transcript (README §10.5). The registry stores only what the LIST needs plus
 * the `workspacePath` that says where the detail is, which is what lets the
 * sidebar draw a hundred parties without opening one.
 *
 * Writes are atomic and last-writer-wins. Several windows share one file, and a
 * group rename is not worth a lock protocol; the loser of a race loses one
 * folder edit, not a party.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getUserDataDir } from "./userDataDir";
import { DEFAULT_PARTY_GROUP_ID, type PartyGroup, type RegisteredParty } from "../shared/partyGroups";
import { workspaceKey } from "../shared/workspaceLocation";
import { log } from "./logger";

export type { RegisteredParty };

export interface PartyGroupState {
  version: 1;
  groups: PartyGroup[];
  parties: RegisteredParty[];
  /**
   * Parties found in more than one workspace under the same id.
   *
   * Recorded rather than merged (README §10.7): two stores claiming one id is a
   * fact the user has to see, and picking a winner silently would hide whichever
   * copy holds the conversation they were looking for.
   */
  conflicts?: Array<{ partyId: string; workspacePaths: string[]; seenAt: string }>;
}

const FILE_NAME = "party-groups.json";

export class PartyGroupStore {
  private cache: PartyGroupState | undefined;
  private cacheMtimeMs = -1;

  /** The whole registry, with the default group guaranteed to exist. */
  read(): PartyGroupState {
    const file = this.filePath();
    let mtime = -1;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      mtime = -1;
    }
    if (this.cache && mtime === this.cacheMtimeMs) {
      return this.cache;
    }
    const state = withDefaultGroup(this.readFile(file));
    this.cache = state;
    this.cacheMtimeMs = mtime;
    return state;
  }

  write(state: PartyGroupState): PartyGroupState {
    const file = this.filePath();
    const next = withDefaultGroup(state);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(temp, JSON.stringify(next, null, 2), "utf8");
    fs.renameSync(temp, file);
    this.cache = next;
    try {
      this.cacheMtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      this.cacheMtimeMs = -1;
    }
    return next;
  }

  createGroup(name: string): { state: PartyGroupState; group: PartyGroup } {
    const trimmed = String(name || "").trim();
    if (!trimmed) {
      throw new Error("그룹 이름을 입력하세요.");
    }
    const state = this.read();
    if (state.groups.some((group) => group.name === trimmed)) {
      throw new Error(`'${trimmed}' 그룹이 이미 있습니다.`);
    }
    const now = new Date().toISOString();
    const group: PartyGroup = {
      id: `group-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      name: trimmed,
      kind: "user",
      createdAt: now,
      updatedAt: now,
    };
    log("info", "party", "party group created", { groupId: group.id, name: group.name });
    // PREPENDED, not appended: the new group appears at the top, next to the
    // button that made it, instead of below however many groups already
    // exist — where the user would have to go looking for it.
    return { state: this.write({ ...state, groups: [group, ...state.groups] }), group };
  }

  moveParty(partyId: string, groupId: string): PartyGroupState {
    const state = this.read();
    if (!state.groups.some((group) => group.id === groupId)) {
      throw new Error(`그룹 '${groupId}' 을 찾을 수 없습니다.`);
    }
    if (!state.parties.some((party) => party.id === partyId)) {
      throw new Error(`파티 '${partyId}' 이 목록에 없습니다.`);
    }
    log("info", "party", "party moved to group", { partyId, groupId });
    return this.write({
      ...state,
      parties: state.parties.map((party) => (party.id === partyId ? { ...party, groupId } : party)),
    });
  }

  /**
   * Renames a group.
   *
   * The default group is renamable like any other: its `kind` is what makes it
   * the fallback, not its label, and {@link withDefaultGroup} recreates it by
   * kind. Duplicate names are refused for the same reason as on create — two
   * folders with one name is a list the user cannot navigate.
   */
  renameGroup(groupId: string, name: string): PartyGroupState {
    const trimmed = String(name || "").trim();
    if (!trimmed) {
      throw new Error("그룹 이름을 입력하세요.");
    }
    const state = this.read();
    if (!state.groups.some((group) => group.id === groupId)) {
      throw new Error(`그룹 '${groupId}' 을 찾을 수 없습니다.`);
    }
    if (state.groups.some((group) => group.id !== groupId && group.name === trimmed)) {
      throw new Error(`'${trimmed}' 그룹이 이미 있습니다.`);
    }
    const now = new Date().toISOString();
    log("info", "party", "party group renamed", { groupId, name: trimmed });
    return this.write({
      ...state,
      groups: state.groups.map((group) => (group.id === groupId ? { ...group, name: trimmed, updatedAt: now } : group)),
    });
  }

  /**
   * Reorders the groups.
   *
   * The array order IS the display order, so this rewrites the array rather
   * than storing a rank on each group — one place to be wrong instead of N.
   *
   * `order` is applied to the ids it names; a group created in another window
   * while the user was dragging is NOT dropped, it keeps its place at the end.
   * Refusing the whole reorder because the list moved under us would lose the
   * drag for a reason the user cannot see.
   */
  reorderGroups(order: string[]): PartyGroupState {
    const state = this.read();
    const known = new Map(state.groups.map((group) => [group.id, group] as const));
    const ordered = order.map((id) => known.get(id)).filter((group): group is PartyGroup => Boolean(group));
    const seen = new Set(ordered.map((group) => group.id));
    const appended = state.groups.filter((group) => !seen.has(group.id));
    if (appended.length) {
      log("info", "party", "reorder did not mention every group; keeping the rest at the end", {
        missing: appended.map((group) => group.id),
      });
    }
    return this.write({ ...state, groups: [...ordered, ...appended] });
  }

  /**
   * Deletes a group and moves its parties to the default one.
   *
   * Deleting a FOLDER must never delete what is filed in it: the parties keep
   * their ids, their workspaces and their conversations, and land somewhere the
   * user can still reach them. The default group itself cannot be deleted —
   * something has to be the place things land.
   */
  removeGroup(groupId: string): { state: PartyGroupState; moved: number } {
    const state = this.read();
    const group = state.groups.find((entry) => entry.id === groupId);
    if (!group) {
      throw new Error(`그룹 '${groupId}' 을 찾을 수 없습니다.`);
    }
    if (group.kind === "default") {
      throw new Error("기본 그룹은 삭제할 수 없습니다. 파티가 돌아갈 곳이 필요합니다.");
    }
    const fallback = state.groups.find((entry) => entry.kind === "default")?.id ?? DEFAULT_PARTY_GROUP_ID;
    const moved = state.parties.filter((party) => party.groupId === groupId).length;
    log("info", "party", "party group removed", { groupId, name: group.name, moved });
    return {
      state: this.write({
        ...state,
        groups: state.groups.filter((entry) => entry.id !== groupId),
        parties: state.parties.map((party) => (party.groupId === groupId ? { ...party, groupId: fallback } : party)),
      }),
      moved,
    };
  }

  /**
   * Reconciles the complete party list for one workspace in ONE registry write.
   *
   * The desktop receives this snapshot from the workspace's own engine, which
   * is the only correct reader for a remote WSL path. Keeping the whole replace
   * here also prevents consumers from observing a half-registered workspace
   * while several parties are added one at a time. An incoming `groupId` seeds
   * only a new party; an existing party keeps its registry filing, so refreshing
   * stale workspace metadata can never undo an explicit {@link moveParty}.
   */
  reconcileWorkspace(workspacePath: string, summaries: RegisteredParty[]): { state: PartyGroupState; changed: boolean } {
    const state = this.read();
    const targetKey = workspaceKey(workspacePath);
    const incomingIds = new Set(summaries.map((party) => party.id));
    let parties = state.parties.filter((party) => workspaceKey(party.workspacePath) !== targetKey || incomingIds.has(party.id));
    let conflicts = state.conflicts;

    for (const summary of summaries) {
      const at = parties.findIndex((party) => party.id === summary.id);
      const existing = at >= 0 ? parties[at] : undefined;
      if (existing && workspaceKey(existing.workspacePath) !== targetKey) {
        const conflicted = recordConflict({ ...state, parties, conflicts }, summary.id, [existing.workspacePath, summary.workspacePath]);
        conflicts = conflicted.conflicts;
        continue;
      }
      const merged: RegisteredParty = existing
        ? { ...existing, ...summary, workspacePath, groupId: existing.groupId }
        : { ...summary, workspacePath, groupId: summary.groupId || DEFAULT_PARTY_GROUP_ID };
      if (at >= 0) {
        parties = parties.map((party, index) => (index === at ? merged : party));
      } else {
        parties = [...parties, merged];
      }
    }

    const next = withDefaultGroup({ ...state, parties, conflicts });
    if (JSON.stringify(next) === JSON.stringify(state)) {
      return { state, changed: false };
    }
    return { state: this.write(next), changed: true };
  }

  removeParty(partyId: string): PartyGroupState {
    const state = this.read();
    if (!state.parties.some((party) => party.id === partyId)) {
      return state;
    }
    return this.write({ ...state, parties: state.parties.filter((party) => party.id !== partyId) });
  }

  /** Every workspace the registry knows a party in — the migration's starting set. */
  knownWorkspaces(): string[] {
    return [...new Set(this.read().parties.map((party) => party.workspacePath))];
  }

  private filePath(): string {
    return path.join(getUserDataDir(), FILE_NAME);
  }

  private readFile(file: string): PartyGroupState {
    try {
      if (!fs.existsSync(file)) {
        return { version: 1, groups: [], parties: [] };
      }
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      return {
        version: 1,
        groups: Array.isArray(parsed?.groups) ? parsed.groups.filter(isGroup) : [],
        parties: Array.isArray(parsed?.parties) ? parsed.parties.filter(isParty) : [],
        conflicts: Array.isArray(parsed?.conflicts) ? parsed.conflicts : undefined,
      };
    } catch (error) {
      // A corrupt registry must not take the party list down with it: the
      // parties themselves are in their workspaces and will re-register.
      log("error", "party", "party group registry unreadable", { file, error: error instanceof Error ? error.message : String(error) });
      return { version: 1, groups: [], parties: [] };
    }
  }
}

/**
 * Guarantees the default group and rehomes orphans into it.
 *
 * Both halves of README §4.1 in one place: the group exists from first run, and
 * a party whose group is gone lands somewhere reachable instead of vanishing
 * from the list while its files sit on disk.
 */
function withDefaultGroup(state: PartyGroupState): PartyGroupState {
  const now = new Date().toISOString();
  const groups = state.groups.some((group) => group.kind === "default")
    ? state.groups
    : [{ id: DEFAULT_PARTY_GROUP_ID, name: "기본 그룹", kind: "default" as const, createdAt: now, updatedAt: now }, ...state.groups];
  const fallback = groups.find((group) => group.kind === "default")?.id ?? DEFAULT_PARTY_GROUP_ID;
  const known = new Set(groups.map((group) => group.id));
  const parties = state.parties.map((party) => (known.has(party.groupId) ? party : { ...party, groupId: fallback }));
  return { ...state, version: 1, groups, parties };
}

function recordConflict(state: PartyGroupState, partyId: string, workspacePaths: string[]): PartyGroupState {
  const seenAt = new Date().toISOString();
  const paths = [...new Set(workspacePaths)];
  log("warn", "party", "party id claimed by two workspaces", { partyId, workspacePaths: paths });
  const conflicts = (state.conflicts || []).filter((entry) => entry.partyId !== partyId);
  return { ...state, conflicts: [...conflicts, { partyId, workspacePaths: paths, seenAt }] };
}

function isGroup(value: any): value is PartyGroup {
  return Boolean(value && typeof value.id === "string" && typeof value.name === "string");
}

function isParty(value: any): value is RegisteredParty {
  return Boolean(value && typeof value.id === "string" && typeof value.name === "string" && typeof value.workspacePath === "string");
}
