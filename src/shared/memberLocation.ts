/**
 * Where a member RUNS — the one cwd it is pinned to for life.
 *
 * A member's cwd is immutable after creation on purpose. Claude Code, Codex and
 * Cursor all key session discovery, settings, permissions and conversation
 * resume off the cwd, so moving a member would silently detach it from its own
 * history. The UI therefore shows the location read-only, and "I need another
 * directory" is answered by creating another member.
 *
 * The wire format is the existing `WorkspaceLocation` string (`C:\proj`, or
 * `wsl+Ubuntu-24.04:/home/dev/svc`), not a second encoding: a member's cwd and a
 * workspace path are the same kind of thing, and two spellings would drift.
 *
 * See `docs/기획/파티 그룹 및 멤버별 작업공간/README.md` §5, §6, §12.
 */

import { parseWorkspaceLocation, serializeWorkspaceLocation, type WorkspaceLocation } from "./workspaceUri";

/** The two environments a member can run in. Windows-first: this is a Windows app. */
export type ExecutionEnv = "windows" | "wsl";

/** The most recent cwds we keep per environment (README §6). */
export const RECENT_CWD_LIMIT = 10;

/**
 * A member's fixed execution location, in the shape screens want to read.
 *
 * `distro` is present exactly when `env === "wsl"`; the pair is what the WSL
 * side needs (a POSIX path alone does not say which distro's filesystem it is).
 */
export interface MemberExecutionLocation {
  env: ExecutionEnv;
  /** Host-native absolute path: win32 for windows, posix for wsl. */
  cwd: string;
  distro?: string;
}

/**
 * Why a remembered cwd cannot be used right now.
 *
 * Carried as a REASON rather than a boolean because "폴더 없음" and "배포판을
 * 시작할 수 없음" call for different repairs, and collapsing them into
 * "unavailable" is how a user ends up re-picking a folder that was never the
 * problem. Never used to substitute a different cwd — only to display.
 */
export interface CwdProblem {
  kind: "missing" | "denied" | "distro-missing" | "distro-unavailable" | "not-absolute";
  message: string;
}

/**
 * The one wording per failure kind.
 *
 * Centralised so the picker and the settings screen cannot describe the same
 * broken path differently — two spellings of one fact is how a user concludes
 * there are two problems.
 */
export const CWD_PROBLEM_MESSAGE: Record<CwdProblem["kind"], string> = {
  "missing": "폴더 없음",
  "denied": "접근 권한 없음",
  "distro-missing": "배포판이 설치되어 있지 않음",
  "distro-unavailable": "배포판을 시작할 수 없음",
  "not-absolute": "절대 경로가 아님",
};

export function cwdProblem(kind: CwdProblem["kind"]): CwdProblem {
  return { kind, message: CWD_PROBLEM_MESSAGE[kind] };
}

/** One entry of the per-environment recent list. */
export interface RecentCwd {
  location: MemberExecutionLocation;
  /** ISO timestamp of the member creation that put it here. */
  usedAt: string;
  /** Set only when the last check failed; the entry is shown, not dropped. */
  problem?: CwdProblem;
}

/**
 * An existing member's fixed location, as the settings screen lists it.
 *
 * Lives here rather than in the settings component because the fixtures and the
 * automation API answer with it too, and a shared shape must not be defined by
 * one of its readers.
 */
export interface MemberLocationRow {
  member: string;
  partyName: string;
  location: MemberExecutionLocation;
}

/**
 * App-global cwd preferences: one default per environment, ten recents each.
 *
 * Global rather than per-workspace because the party list is global now — the
 * directory the app happened to be launched from must not change which cwds are
 * offered.
 */
export interface CwdPreferences {
  windowsDefault?: MemberExecutionLocation;
  wslDefault?: MemberExecutionLocation;
  windowsRecent: RecentCwd[];
  wslRecent: RecentCwd[];
}

export const EMPTY_CWD_PREFERENCES: CwdPreferences = {
  windowsRecent: [],
  wslRecent: [],
};

/** Reads the half of the preferences that belongs to one environment. */
export function preferencesFor(prefs: CwdPreferences, env: ExecutionEnv): { fallback?: MemberExecutionLocation; recent: RecentCwd[] } {
  return env === "wsl"
    ? { fallback: prefs.wslDefault, recent: prefs.wslRecent }
    : { fallback: prefs.windowsDefault, recent: prefs.windowsRecent };
}

/** `MemberExecutionLocation` → the stored `WorkspaceLocation` string. */
export function serializeMemberLocation(loc: MemberExecutionLocation): string {
  return serializeWorkspaceLocation(toWorkspaceLocation(loc));
}

export function toWorkspaceLocation(loc: MemberExecutionLocation): WorkspaceLocation {
  return loc.env === "wsl" && loc.distro
    ? { host: { kind: "wsl", distro: loc.distro }, path: loc.cwd }
    : { host: { kind: "local" }, path: loc.cwd };
}

/**
 * The stored `WorkspaceLocation` string → the shape screens read.
 *
 * A `\\wsl$\…` UNC path parses to a WSL location (the Windows folder picker can
 * land there), so this is also what turns a folder the user browsed to into the
 * distro + POSIX pair the WSL side needs.
 */
export function parseMemberLocation(value: string): MemberExecutionLocation {
  const loc = parseWorkspaceLocation(value);
  return loc.host.kind === "wsl"
    ? { env: "wsl", cwd: loc.path, distro: loc.host.distro }
    : { env: "windows", cwd: loc.path };
}

/**
 * Identity for dedup and selection highlighting.
 *
 * Case-insensitive on Windows (`C:\Proj` and `c:\proj` are one directory) and
 * case-sensitive inside a distro (`/srv/A` and `/srv/a` are two), because that
 * is what the two filesystems actually do. Trailing separators are dropped so a
 * path picked with and without one does not occupy two of the ten slots.
 */
export function memberLocationKey(loc: MemberExecutionLocation): string {
  if (loc.env === "wsl") {
    return `wsl+${loc.distro ?? ""}:${trimTrailing(loc.cwd, "/") || "/"}`;
  }
  return trimTrailing(loc.cwd.replace(/\//g, "\\"), "\\").toLowerCase();
}

export function memberLocationsEqual(a: MemberExecutionLocation, b: MemberExecutionLocation): boolean {
  return memberLocationKey(a) === memberLocationKey(b);
}

/**
 * Puts a just-used location at the top of its environment's recent list.
 *
 * Only creations that SUCCEEDED reach here (README §6): a path that failed
 * validation must not be offered again as if it worked. Re-using a location
 * moves it up instead of adding a duplicate, and the list is capped at
 * {@link RECENT_CWD_LIMIT}.
 */
export function withRecentCwd(prefs: CwdPreferences, loc: MemberExecutionLocation, usedAt: string): CwdPreferences {
  const key = memberLocationKey(loc);
  const field = loc.env === "wsl" ? "wslRecent" : "windowsRecent";
  const kept = prefs[field].filter((entry) => memberLocationKey(entry.location) !== key);
  return { ...prefs, [field]: [{ location: loc, usedAt }, ...kept].slice(0, RECENT_CWD_LIMIT) };
}

/**
 * Whether a location is well-formed enough to even attempt.
 *
 * Shape only — this cannot say the folder exists. Reachability is checked in the
 * environment the member will actually run in (README §12): that Windows can see
 * `\\wsl$\…` says nothing about whether the distro will start.
 */
export function checkLocationShape(loc: MemberExecutionLocation): CwdProblem | undefined {
  const cwd = loc.cwd.trim();
  if (loc.env === "wsl") {
    if (!loc.distro) {
      return { kind: "distro-missing", message: "WSL 배포판을 선택하세요" };
    }
    return cwd.startsWith("/") ? undefined : { kind: "not-absolute", message: "WSL 경로는 / 로 시작하는 절대 경로여야 합니다" };
  }
  return /^[a-zA-Z]:[\\/]/.test(cwd) || cwd.startsWith("\\\\")
    ? undefined
    : { kind: "not-absolute", message: "Windows 경로는 절대 경로여야 합니다" };
}

function trimTrailing(value: string, sep: string): string {
  let end = value.length;
  while (end > 1 && value[end - 1] === sep) {
    end -= 1;
  }
  return value.slice(0, end);
}
