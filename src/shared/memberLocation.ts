/**
 * Where a member RUNS — its stable cwd inside AgentParty.
 *
 * A member's cwd is immutable during ordinary app operation on purpose: changing
 * it also changes filesystem, permissions and tooling context. Current native
 * CLIs can resume a harness thread from another cwd, so a disappeared directory
 * is handled as an explicit external-CLI recovery path. AgentParty does not
 * infer that external cwd or silently rewrite this stored location.
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

/**
 * Public host selector used by automation and member-facing tools.
 *
 * This deliberately is not inferred from `cwd`: `/work` does not identify a
 * WSL distro, and a future Linux or macOS desktop must be able to add its own
 * local host without changing the `member-create` request shape. Keep supported
 * host kinds and their metadata here so UI, HTTP and MCP never grow separate
 * platform lists.
 */
export const MEMBER_EXECUTION_HOSTS = ["windows", "wsl"] as const;
export type MemberExecutionHost = (typeof MEMBER_EXECUTION_HOSTS)[number];

export interface MemberExecutionLocationRequest {
  host: MemberExecutionHost;
  /** Absolute path in the selected host's native syntax. */
  cwd: string;
  /** Required for WSL; absent for a native host. */
  distro?: string;
}

export interface SupportedMemberExecutionHost {
  host: MemberExecutionHost;
  label: string;
  distroRequired: boolean;
  pathStyle: "win32" | "posix";
}

export const SUPPORTED_MEMBER_EXECUTION_HOSTS: readonly SupportedMemberExecutionHost[] = [
  { host: "windows", label: "Windows", distroRequired: false, pathStyle: "win32" },
  { host: "wsl", label: "WSL", distroRequired: true, pathStyle: "posix" },
];

/** The most recent cwds we keep per environment (README §6). */
export const RECENT_CWD_LIMIT = 5;

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

/** A location an agent may suggest when creating another member. */
export interface MemberExecutionLocationSuggestion extends MemberExecutionLocationRequest {
  /** Existing stored wire representation accepted by the UI/HTTP APIs. */
  location: string;
  source: "default" | "recent";
  usedAt?: string;
  problem?: CwdProblem;
}

export interface MemberExecutionLocationCatalog {
  supportedHosts: readonly SupportedMemberExecutionHost[];
  locations: MemberExecutionLocationSuggestion[];
}

/**
 * App-global cwd preferences: one default per environment, five recents each.
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

/**
 * What the cwd picker should start on.
 *
 * Most recent first, then this environment's default, then the app's own
 * workspace folder. An empty field made every new member a folder hunt, and the
 * path somebody used a minute ago is the best guess anyone has.
 *
 * A remembered path that FAILED its last check is skipped rather than offered:
 * pre-selecting a directory we already know is gone just moves the failure to
 * the create button.
 */
export function suggestedCwd(
  prefs: CwdPreferences,
  env: ExecutionEnv,
  appWorkspaceRoot?: string,
): MemberExecutionLocation | undefined {
  const { fallback, recent } = preferencesFor(prefs, env);
  const usableRecent = recent.find((entry) => !entry.problem);
  if (usableRecent) {
    return usableRecent.location;
  }
  if (fallback) {
    return fallback;
  }
  // Only Windows gets the app folder: there is no app-managed directory inside
  // a distro, and inventing one would be a guess about somebody else's machine.
  return env === "windows" && appWorkspaceRoot ? { env: "windows", cwd: appWorkspaceRoot } : undefined;
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

/** Turns the public, explicit host request into the app's internal location. */
export function memberLocationFromRequest(value: unknown): MemberExecutionLocation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("location must be an object with host and cwd.");
  }
  const input = value as Record<string, unknown>;
  const host = typeof input.host === "string" ? input.host.trim().toLowerCase() : "";
  if (!(MEMBER_EXECUTION_HOSTS as readonly string[]).includes(host)) {
    throw new Error(`location.host must be one of: ${MEMBER_EXECUTION_HOSTS.join(", ")}.`);
  }
  if (typeof input.cwd !== "string" || !input.cwd.trim()) {
    throw new Error("location.cwd must be a non-empty string.");
  }
  const cwd = input.cwd.trim();
  if (host === "wsl") {
    if (typeof input.distro !== "string" || !input.distro.trim()) {
      throw new Error("location.distro is required when location.host is 'wsl'.");
    }
    return { env: "wsl", cwd, distro: input.distro.trim() };
  }
  if (input.distro !== undefined && input.distro !== null && String(input.distro).trim()) {
    throw new Error("location.distro is only valid when location.host is 'wsl'.");
  }
  return { env: "windows", cwd };
}

/** Public automation shape for one internal execution location. */
export function memberLocationRequestOf(location: MemberExecutionLocation): MemberExecutionLocationRequest {
  return location.env === "wsl"
    ? { host: "wsl", cwd: location.cwd, distro: location.distro }
    : { host: "windows", cwd: location.cwd };
}

/**
 * Flattens the current preference store into a host-neutral suggestion list.
 * Adding Linux/macOS later only requires teaching the preference adapter about
 * their rows; the MCP response and `member-create.location` contract stay the
 * same.
 */
export function memberExecutionLocationCatalog(prefs: CwdPreferences): MemberExecutionLocationCatalog {
  const rows: MemberExecutionLocationSuggestion[] = [];
  const seen = new Set<string>();
  const append = (location: MemberExecutionLocation, source: "default" | "recent", usedAt?: string, problem?: CwdProblem) => {
    const key = memberLocationKey(location);
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({ ...memberLocationRequestOf(location), location: serializeMemberLocation(location), source, usedAt, problem });
  };
  // Most recent suggestions lead, matching the member wizard. Defaults fill a
  // host only when that exact location was not already a recent success.
  for (const entry of prefs.windowsRecent) append(entry.location, "recent", entry.usedAt, entry.problem);
  for (const entry of prefs.wslRecent) append(entry.location, "recent", entry.usedAt, entry.problem);
  if (prefs.windowsDefault) append(prefs.windowsDefault, "default");
  if (prefs.wslDefault) append(prefs.wslDefault, "default");
  return { supportedHosts: SUPPORTED_MEMBER_EXECUTION_HOSTS, locations: rows };
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
    // Distro names follow WSL's case-insensitive identity; the path inside the
    // distro does not. Without this, one cwd occupied two recent-list slots
    // merely because one caller wrote `Ubuntu` and another wrote `ubuntu`.
    return `wsl+${(loc.distro ?? "").toLowerCase()}:${trimTrailing(loc.cwd, "/") || "/"}`;
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
