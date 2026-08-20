/**
 * The default and recent cwds offered when creating a party or a member.
 *
 * Stored in app settings, which is app-global — deliberately not per-workspace.
 * The party list stopped depending on the directory the app was launched from,
 * and the directories it suggests must not re-introduce that dependency.
 *
 * Every mutation here goes through `updateSettings`, so the on-disk write, the
 * lock and the broadcast are the ones the rest of the app already uses.
 */

import { getSettings, updateSettings } from "./settings";
import {
  EMPTY_CWD_PREFERENCES,
  RECENT_CWD_LIMIT,
  memberLocationKey,
  withRecentCwd,
  type CwdPreferences,
  type ExecutionEnv,
  type MemberExecutionLocation,
  type RecentCwd,
} from "../shared/memberLocation";
import { checkCwd } from "./cwdService";
import { log } from "./logger";

export function getCwdPreferences(): CwdPreferences {
  return normalize(getSettings().cwdPreferences);
}

/**
 * Re-checks every remembered cwd and returns the list with fresh verdicts.
 *
 * Separate from {@link getCwdPreferences} because it can spawn `wsl.exe` once
 * per distro: a screen that merely draws the list must not pay for that, and a
 * screen that shows "왜 못 쓰는지" has to.
 */
export async function getCheckedCwdPreferences(): Promise<CwdPreferences> {
  const prefs = getCwdPreferences();
  const recheck = async (entries: RecentCwd[]): Promise<RecentCwd[]> =>
    Promise.all(entries.map(async (entry) => {
      const { problem } = await checkCwd(entry.location);
      // `problem` is REPLACED, not merged: a distro that came back must clear
      // its old failure, or the row keeps accusing a directory that now works.
      return problem ? { ...entry, problem } : { location: entry.location, usedAt: entry.usedAt };
    }));
  return {
    ...prefs,
    windowsRecent: await recheck(prefs.windowsRecent),
    wslRecent: await recheck(prefs.wslRecent),
  };
}

/**
 * Sets an environment's default cwd.
 *
 * Refuses a location that is not usable RIGHT NOW, with the reason. A default
 * exists to be filled into the member wizard without further thought, so
 * storing one that cannot be run in would just move the failure to the next
 * member somebody creates.
 */
export async function setDefaultCwd(location: MemberExecutionLocation): Promise<CwdPreferences> {
  const { problem } = await checkCwd(location);
  if (problem) {
    throw new Error(`${problem.message}: ${location.distro ? `${location.distro} · ` : ""}${location.cwd}`);
  }
  const prefs = getCwdPreferences();
  const next = location.env === "wsl"
    ? { ...prefs, wslDefault: location }
    : { ...prefs, windowsDefault: location };
  return persist(next);
}

export function clearDefaultCwd(env: ExecutionEnv): CwdPreferences {
  const prefs = getCwdPreferences();
  return persist(env === "wsl" ? { ...prefs, wslDefault: undefined } : { ...prefs, windowsDefault: undefined });
}

/**
 * Records a cwd a member was just created in.
 *
 * Called only AFTER the creation succeeded (README §6): a path that failed
 * validation must not come back in the list looking like a previous success.
 */
export function rememberCwd(location: MemberExecutionLocation, usedAt = new Date().toISOString()): CwdPreferences {
  return persist(withRecentCwd(getCwdPreferences(), location, usedAt));
}

export function removeRecentCwd(location: MemberExecutionLocation): CwdPreferences {
  const prefs = getCwdPreferences();
  const key = memberLocationKey(location);
  const field = location.env === "wsl" ? "wslRecent" : "windowsRecent";
  return persist({ ...prefs, [field]: prefs[field].filter((entry) => memberLocationKey(entry.location) !== key) });
}

/** Promotes a remembered cwd to its environment's default (same checks apply). */
export function promoteRecentCwd(location: MemberExecutionLocation): Promise<CwdPreferences> {
  return setDefaultCwd(location);
}

function persist(next: CwdPreferences): CwdPreferences {
  const saved = normalize(next);
  updateSettings({ cwdPreferences: saved });
  log("info", "cwd", "preferences saved", {
    windowsDefault: saved.windowsDefault?.cwd,
    wslDefault: saved.wslDefault ? `${saved.wslDefault.distro}:${saved.wslDefault.cwd}` : undefined,
    recent: saved.windowsRecent.length + saved.wslRecent.length,
  });
  return saved;
}

/**
 * Repairs a stored value into the shape the screens expect.
 *
 * A hand-edited or older settings file can carry anything; entries that are not
 * a usable pair are DROPPED here rather than reaching the picker as a row with
 * no path. The cap is re-applied because the file is not the only writer.
 */
export function normalize(value: CwdPreferences | undefined): CwdPreferences {
  if (!value || typeof value !== "object") {
    return { ...EMPTY_CWD_PREFERENCES, windowsRecent: [], wslRecent: [] };
  }
  return {
    windowsDefault: normalizeLocation(value.windowsDefault, "windows"),
    wslDefault: normalizeLocation(value.wslDefault, "wsl"),
    windowsRecent: normalizeRecent(value.windowsRecent, "windows"),
    wslRecent: normalizeRecent(value.wslRecent, "wsl"),
  };
}

function normalizeLocation(value: MemberExecutionLocation | undefined, env: ExecutionEnv): MemberExecutionLocation | undefined {
  const cwd = String(value?.cwd || "").trim();
  if (!cwd) {
    return undefined;
  }
  if (env === "wsl") {
    const distro = String(value?.distro || "").trim();
    return distro ? { env, cwd, distro } : undefined;
  }
  return { env, cwd };
}

function normalizeRecent(value: RecentCwd[] | undefined, env: ExecutionEnv): RecentCwd[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const kept: RecentCwd[] = [];
  for (const entry of value) {
    const location = normalizeLocation(entry?.location, env);
    if (!location || seen.has(memberLocationKey(location))) {
      continue;
    }
    seen.add(memberLocationKey(location));
    kept.push({ location, usedAt: String(entry?.usedAt || ""), ...(entry?.problem ? { problem: entry.problem } : {}) });
    if (kept.length >= RECENT_CWD_LIMIT) {
      break;
    }
  }
  return kept;
}
