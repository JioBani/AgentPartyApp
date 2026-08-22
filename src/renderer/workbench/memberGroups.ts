/**
 * The member list's shape: execution ENVIRONMENT, then working directory.
 *
 * A party's members are routinely split across Windows and one or more WSL
 * distros, and across several checkouts inside each. That is the fact which
 * decides whether two members can even see the same file, so it is stated once
 * per group instead of once per row — or not at all.
 *
 * The environment is the thing a member actually runs in, and for WSL that is
 * the DISTRO, not the word "WSL": two distros share no filesystem and no
 * installed toolchain, so a common "WSL" parent grouped together things that
 * have nothing in common while costing a level of nesting in a 256px drawer.
 * Each distro is therefore a top-level environment, peer to Windows.
 *
 * When only ONE environment is in play and that environment names itself — a
 * party entirely on native Windows — the section header repeats a fact no row
 * disputes, so the tree is {@link MemberTree.flat} and the directory groups sit
 * at the root. A single WSL distro keeps its header: "Ubuntu-24.04" is the only
 * thing saying these members are not on the desktop's own filesystem.
 *
 * Pure and view-agnostic on purpose: it takes only the stored location string
 * off each member, so the sidebar, the design preview and the tests can all
 * group the same way without a store, a session or a harness. The parsing rules
 * (and the `wsl+<distro>:` wire format) stay in `shared/memberLocation`; this
 * module only decides ORDER and IDENTITY of the groups. Labels are the view's
 * business — this module says WHICH environment, never what to call it.
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
export type MemberEnvKind = ExecutionEnv | "unknown";

/**
 * Environments that identify themselves by the platform alone, in display
 * order. A party living entirely inside one of these hides the header (see
 * {@link MemberTree.flat}); adding a native Linux or macOS host later is one
 * entry here and one icon, with no change to the tree's shape.
 *
 * WSL is deliberately absent: its identity is the distro, which the platform
 * name cannot supply.
 */
const NATIVE_ENVS: readonly MemberEnvKind[] = ["windows"];

const ENV_ORDER: readonly MemberEnvKind[] = ["windows", "wsl", "unknown"];

export interface MemberCwdGroup<T extends GroupableMember = GroupableMember> {
  /** Stable across renders and across host/cwd edits; used for open/closed state. */
  id: string;
  /** Absent exactly when the environment is `unknown`. */
  location?: MemberExecutionLocation;
  /** Host-native path, or "" for the unknown bucket. */
  cwd: string;
  /** Present only for WSL, where a path alone does not identify a directory. */
  distro?: string;
  members: T[];
}

/**
 * One top-level execution environment: Windows, ONE WSL distro, or the bucket
 * for members whose location could not be read.
 */
export interface MemberEnvGroup<T extends GroupableMember = GroupableMember> {
  /**
   * Stable collapse key. Carries the distro, so folding Ubuntu never folds
   * Debian, and survives members being added, removed or restarted.
   */
  id: string;
  kind: MemberEnvKind;
  /** Present only for WSL, and only when the stored location named one. */
  distro?: string;
  /**
   * The environment could not be named: a WSL location with no distro, or a
   * member with no readable location at all. The view owes these a spelled-out
   * fallback rather than an empty heading.
   */
  unnamed: boolean;
  groups: MemberCwdGroup<T>[];
  /** Total members under this environment, so a collapsed section still counts. */
  count: number;
}

export interface MemberTree<T extends GroupableMember = GroupableMember> {
  envs: MemberEnvGroup<T>[];
  /**
   * The environment headers say nothing the list does not already imply — one
   * environment, and a native one that needs no distro to be identified. The
   * view drops the headers and renders `envs[0].groups` at the root.
   */
  flat: boolean;
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
 * Groups members by environment, then by directory.
 *
 * Member order inside a group is the caller's order (the sidebar's own sort),
 * so grouping never reshuffles a list the user has learned. Directories are
 * ordered by their displayed path, and environments by platform then distro
 * name, so the sections do not jump around when a member is added, removed or
 * restarted — the one thing a collapsible tree must not do while you are aiming
 * at a row.
 */
export function groupMembersByLocation<T extends GroupableMember>(views: readonly T[]): MemberTree<T> {
  const byEnv = new Map<string, MemberEnvGroup<T>>();
  for (const view of views) {
    const location = memberLocationOf(view);
    const kind: MemberEnvKind = location ? location.env : "unknown";
    // A WSL location with no distro names a filesystem we cannot identify. It
    // gets its own section rather than being folded into whichever distro
    // happens to sort first.
    const distro = kind === "wsl" ? location?.distro : undefined;
    const envId = envGroupId(kind, distro);
    let env = byEnv.get(envId);
    if (!env) {
      env = { id: envId, kind, distro, unnamed: kind === "unknown" || (kind === "wsl" && !distro), groups: [], count: 0 };
      byEnv.set(envId, env);
    }
    const id = cwdGroupId(location);
    const existing = env.groups.find((group) => group.id === id);
    if (existing) {
      existing.members.push(view);
    } else {
      env.groups.push({ id, location, cwd: location?.cwd ?? "", distro: location?.distro, members: [view] });
    }
    env.count += 1;
  }
  const envs = [...byEnv.values()].sort(compareEnvs);
  for (const env of envs) {
    env.groups.sort(compareGroups);
  }
  return { envs, flat: envs.length === 1 && NATIVE_ENVS.includes(envs[0].kind) };
}

/**
 * Identity of one environment section.
 *
 * The distro is folded in with WSL's own case-insensitive identity, so a party
 * whose members were created with `Ubuntu` and `ubuntu` is one section — and,
 * more to the point, one collapse key that does not flip between two ids.
 */
export function envGroupId(kind: MemberEnvKind, distro?: string): string {
  if (kind !== "wsl") {
    return `env:${kind}`;
  }
  // The missing distro needs a key of its own that no real distro can collide
  // with — including one actually named "unnamed" — so it sits outside the
  // `env:wsl:<name>` space entirely rather than inside it under a word.
  return distro ? `env:wsl:${distro.toLowerCase()}` : "env:wsl-unidentified";
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

/**
 * Windows first, then the distros by name, then whatever we could not identify.
 * Sorting distros by name rather than by first appearance means adding a member
 * never reorders the sections above the one it landed in.
 */
function compareEnvs(a: MemberEnvGroup, b: MemberEnvGroup): number {
  const kind = ENV_ORDER.indexOf(a.kind) - ENV_ORDER.indexOf(b.kind);
  if (kind !== 0) {
    return kind;
  }
  // A named distro outranks the unnamed bucket for the same reason `unknown`
  // sorts last: the least informative section never leads.
  const named = Number(Boolean(b.distro)) - Number(Boolean(a.distro));
  if (named !== 0) {
    return named;
  }
  return (a.distro || "").localeCompare(b.distro || "") || a.id.localeCompare(b.id);
}

function compareGroups(a: MemberCwdGroup, b: MemberCwdGroup): number {
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
