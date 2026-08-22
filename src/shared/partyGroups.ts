/**
 * Party groups — the one shallow folder level that organises parties.
 *
 * A group is NOT a project, a permission boundary, or a workspace: it owns no
 * cwd, no settings, and no gate policy, and it never nests. It exists because a
 * flat list of thirty parties is unreadable, and nothing more. Keeping that
 * scope in the type (id + name + kind) is deliberate — every field added here
 * would be a field the list screen has to load before it can draw a folder.
 *
 * See `docs/기획/파티 그룹 및 멤버별 작업공간/README.md` §4, §9.
 */


/** The default group is created once and cannot be renamed or removed. */
export const DEFAULT_PARTY_GROUP_ID = "default";

export interface PartyGroup {
  id: string;
  name: string;
  /** `default` is the app-created home for parties that chose no group. */
  kind: "default" | "user";
  createdAt: string;
  updatedAt: string;
}

/**
 * What the party LIST knows about a party.
 *
 * Deliberately a summary and not a `PartyDefinition`: drawing the sidebar must
 * not read every party's `party.json`/`transcript.json`, or opening the app in a
 * workspace with a hundred parties pays for all of them to show ten. Members,
 * messages and layout are loaded when a party is actually selected.
 */
export interface PartySummary {
  id: string;
  groupId: string;
  name: string;
  /**
   * Absent while nothing has counted this party yet.
   *
   * The summary store always fills it; the sidebar can only count the party it
   * has loaded. `0` would be a claim — every party has at least `main` — so the
   * line omits the clause rather than printing a number nobody measured.
   */
  memberCount?: number;
  /** Members with a running turn right now (0 when the party is not loaded). */
  runningCount: number;
  /** How the party's members split across execution environments. */
  windowsCount: number;
  wslCount: number;
  updatedAt: string;
}

/**
 * One party as the app-global registry knows it: the summary plus where its
 * detail lives.
 *
 * `workspacePath` is what keeps this change cheap: members, messages, layout and
 * transcripts stay in that workspace's own `.agent_party_app/`, so grouping a
 * party costs no id, no session and no conversation (README §10.5). Selecting a
 * party from another workspace is a workspace switch, not a move.
 */
export interface RegisteredParty extends PartySummary {
  workspacePath: string;
}

/**
 * Groups in display order with their parties already attached.
 *
 * Built by `groupParties` rather than by each caller, so the "a party whose
 * group is missing falls back to the default group" rule (README §4.1) has one
 * implementation instead of one per screen.
 */
export interface PartyGroupView {
  group: PartyGroup;
  parties: PartySummary[];
}

/**
 * Buckets summaries into their groups, recovering orphans into the default one.
 *
 * A party whose `groupId` names a group that no longer exists is NOT dropped and
 * NOT given an invented folder: it lands in the default group, which is the only
 * outcome that keeps it reachable. Silently hiding it would be the "quiet
 * fallback" this project bans — it looks like a deleted party.
 */
export function groupParties(groups: PartyGroup[], parties: PartySummary[]): PartyGroupView[] {
  const byId = new Map<string, PartySummary[]>(groups.map((group) => [group.id, []]));
  const fallback = groups.find((group) => group.kind === "default")?.id ?? groups[0]?.id;
  for (const party of parties) {
    const bucket = byId.get(party.groupId) ?? (fallback ? byId.get(fallback) : undefined);
    bucket?.push(party);
  }
  return groups.map((group) => ({ group, parties: byId.get(group.id) ?? [] }));
}

/**
 * The one-line summary under a party name: `9 members`.
 *
 * How many members, and nothing else. It also carried the Windows/WSL split and
 * a recency, which made a three-clause line under every card in a list read top
 * to bottom for the one thing being compared — the party's name. Where each
 * member runs is stated in the member list, per group, at the moment it
 * matters; a card in the party picker is not that moment.
 */
export function partySummaryLine(party: PartySummary, _now: number): string {
  if (party.memberCount === undefined) {
    return "";
  }
  return `${party.memberCount} ${party.memberCount === 1 ? "member" : "members"}`;
}
