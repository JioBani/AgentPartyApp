/**
 * The member list's two-level shape: execution host, then working directory.
 *
 * A party's members are routinely split across Windows and a WSL distro, and
 * across several checkouts inside each. A flat list said none of that — the one
 * fact that decides whether two members can even see the same file was either
 * missing or repeated on every row. Grouping states it once per group instead.
 *
 * Pure and view-agnostic on purpose: it takes only the stored location string
 * off each member, so the sidebar, the design preview and the tests can all
 * group the same way without a store, a session or a harness. The parsing rules
 * (and the `wsl+<distro>:` wire format) stay in `shared/memberLocation`; this
 * module only decides ORDER and IDENTITY of the groups.
 */

import type { ExecutionEnv, MemberExecutionLocation } from "../../shared/memberLocation";
import { memberLocationKey, parseMemberLocation } from "../../shared/memberLocation";

/** The minimum a row must carry to be grouped. `MemberView` satisfies it. */
export interface GroupableMember {
  name: string;
  member: { location?: string };
}

/**
 * `unknown` is a real bucket, not an error: a member created before locations
 * existed (and not yet backfilled) still has to appear somewhere, and dropping
 * it from the list would be the one failure mode nobody could diagnose from the
 * UI. It sorts last so it never leads with the least informative section.
 */
export type MemberHostKind = ExecutionEnv | "unknown";

const HOST_ORDER: readonly MemberHostKind[] = ["windows", "wsl", "unknown"];

export interface MemberCwdGroup<T extends GroupableMember = GroupableMember> {
  /** Stable across renders and across host/cwd edits; used for open/closed state. */
  id: string;
  /** Absent exactly when the host is `unknown`. */
  location?: MemberExecutionLocation;
  /** Host-native path, or "" for the unknown bucket. */
  cwd: string;
  /** Present only for WSL, where a path alone does not identify a directory. */
  distro?: string;
  members: T[];
}

export interface MemberHostGroup<T extends GroupableMember = GroupableMember> {
  id: string;
  host: MemberHostKind;
  groups: MemberCwdGroup<T>[];
  /** Total members under this host, so a collapsed section still counts. */
  count: number;
}

/** The stored location, or undefined when absent or unparseable. */
export function memberLocationOf(view: GroupableMember): MemberExecutionLocation | undefined {
  const stored = view.member.location;
  if (!stored) {
    return undefined;
  }
  try {
    return parseMemberLocation(stored);
  } catch {
    // A location we cannot read is not a location. Falling back to "windows"
    // would file the member under a host it may not run on, which is worse than
    // admitting we do not know.
    return undefined;
  }
}

/**
 * Groups members by host, then by directory.
 *
 * Member order inside a group is the caller's order (the sidebar's own sort),
 * so grouping never reshuffles a list the user has learned. Directories are
 * ordered by their displayed path so the sections do not jump around when a
 * member is added, removed or restarted — the one thing a collapsible tree must
 * not do while you are aiming at a row.
 */
export function groupMembersByLocation<T extends GroupableMember>(views: readonly T[]): MemberHostGroup<T>[] {
  const byHost = new Map<MemberHostKind, Map<string, MemberCwdGroup<T>>>();
  for (const view of views) {
    const location = memberLocationOf(view);
    const host: MemberHostKind = location ? location.env : "unknown";
    const id = cwdGroupId(location);
    let groups = byHost.get(host);
    if (!groups) {
      groups = new Map();
      byHost.set(host, groups);
    }
    const existing = groups.get(id);
    if (existing) {
      existing.members.push(view);
    } else {
      groups.set(id, { id, location, cwd: location?.cwd ?? "", distro: location?.distro, members: [view] });
    }
  }
  const result: MemberHostGroup<T>[] = [];
  for (const host of HOST_ORDER) {
    const groups = byHost.get(host);
    if (!groups || groups.size === 0) {
      continue;
    }
    const ordered = [...groups.values()].sort(compareGroups);
    result.push({
      id: "host:" + host,
      host,
      groups: ordered,
      count: ordered.reduce((total, group) => total + group.members.length, 0),
    });
  }
  return result;
}

/**
 * Identity of one directory group.
 *
 * Built on `memberLocationKey`, which already knows that `C:\Proj` and `c:\proj`
 * are one Windows directory while `/srv/A` and `/srv/a` are two inside a distro.
 * Without that, one checkout could occupy two groups purely because two members
 * were created with different capitalisation.
 */
export function cwdGroupId(location: MemberExecutionLocation | undefined): string {
  return location ? `${location.env}:${memberLocationKey(location)}` : "unknown";
}

function compareGroups(a: MemberCwdGroup, b: MemberCwdGroup): number {
  const distro = (a.distro || "").localeCompare(b.distro || "");
  if (distro !== 0) {
    return distro;
  }
  return a.cwd.localeCompare(b.cwd) || a.id.localeCompare(b.id);
}

/**
 * Splits a path into an ancestor prefix and the directory NAME.
 *
 * Two things had to be true at once: the name must survive a narrow drawer (it
 * is what tells two checkouts apart), and the prefix must stay readable when it
 * cannot be shown in full. Letting CSS ellipsize the raw prefix satisfied the
 * first and wrecked the second: `C:\Users\Dev\AppData\...` shrank to `C` and ran
 * straight into the name, which reads as a different path rather than a
 * shortened one.
 *
 * So the prefix is shortened HERE, to its root plus one ellipsis, and CSS
 * truncation is only the backstop. The full path is always on the tooltip.
 */
export function splitPathTail(cwd: string): { head: string; tail: string } {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  if (!trimmed) {
    return { head: "", tail: cwd };
  }
  const cut = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  if (cut < 0) {
    return { head: "", tail: trimmed };
  }
  // The separator stays with the head: the tail is the directory NAME, and a
  // leading slash on it reads as a root path that is not what this is.
  const head = trimmed.slice(0, cut + 1);
  const tail = trimmed.slice(cut + 1) || trimmed;
  return { head: shortenHead(head), tail };
}

/**
 * `C:\Users\Dev\AppData\Roaming\x\` becomes `C:\…\`; `/home/dev/services/`
 * becomes `/…/`. One segment deep or less is kept whole — shortening
 * `C:\Project\` would hide a real name to save two characters.
 */
function shortenHead(head: string): string {
  const separator = head.includes("\\") ? "\\" : "/";
  const segments = head.split(/[\\/]/).filter((segment) => segment.length > 0);
  // The drive is not an ancestor anyone is reading past; `/` is not either.
  const root = head.startsWith("/") ? "" : segments[0] || "";
  const ancestors = segments.length - (root ? 1 : 0);
  if (ancestors < 1) {
    return head;
  }
  // Every shortened prefix comes out the same handful of characters wide. That
  // is the point: a prefix whose LENGTH varies is a prefix CSS truncates by a
  // different amount on every row, and a row that renders `C` followed by a
  // directory name reads as a path that does not exist.
  return `${root}${separator}\u2026${separator}`;
}
