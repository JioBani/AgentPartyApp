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
    return { state: this.write({ ...state, groups: [...state.groups, group] }), group };
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
   * Adds or refreshes one party's summary.
   *
   * `groupId` is only applied when given, so a routine counts refresh cannot
   * move a party the user filed somewhere back into the default group.
   */
  upsertParty(summary: RegisteredParty): PartyGroupState {
    const state = this.read();
    const existing = state.parties.find((party) => party.id === summary.id);
    if (existing && existing.workspacePath !== summary.workspacePath) {
      return this.write(recordConflict(state, summary.id, [existing.workspacePath, summary.workspacePath]));
    }
    const merged: RegisteredParty = existing
      ? { ...existing, ...summary, groupId: summary.groupId || existing.groupId }
      : { ...summary, groupId: summary.groupId || DEFAULT_PARTY_GROUP_ID };
    return this.write({
      ...state,
      parties: existing
        ? state.parties.map((party) => (party.id === summary.id ? merged : party))
        : [...state.parties, merged],
    });
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
