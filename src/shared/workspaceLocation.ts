import * as path from "node:path";
import { parseWorkspaceLocation, serializeWorkspaceLocation, type WorkspaceLocation } from "./workspaceUri";

/**
 * Where a workspace physically lives. A workspace is still a cwd directory, but
 * that directory may belong to a different host than the Electron UI (e.g. a WSL
 * distro). See the WSL remote-engine design.
 *
 * The type and its parser live in `workspaceUri.ts`, which has no Node import so
 * the renderer can read the same strings. They are re-exported here because this
 * module is what the main process already imports — moving the file must not
 * become a rename across twenty call sites.
 */
export type { WorkspaceHost, WorkspaceLocation } from "./workspaceUri";
export { parseWorkspaceLocation, serializeWorkspaceLocation, isWslLocation } from "./workspaceUri";


/**
 * Stable identity used for caching/dedup (engine contexts, window grouping).
 * Replaces every ad-hoc `path.resolve(workspacePath)`.
 *
 * "local" means "native to the host running this code": on Windows that is
 * `path.win32.resolve` (byte-identical to the previous logic), and inside a WSL
 * distro engine it is `path.posix.resolve` — so a Linux workspace path is not
 * mangled into backslashes. We therefore use the platform-default `path.resolve`
 * for local. WSL locations addressed from another host use the distro-qualified
 * posix form and never touch `path.resolve`.
 *
 * Stays HERE rather than in `workspaceUri.ts` because it needs `node:path`, and
 * that import is exactly what the renderer must not pull in.
 */
export function workspaceLocationKey(loc: WorkspaceLocation): string {
  if (loc.host.kind === "wsl") {
    // WSL resolves distro names case-insensitively (`Ubuntu` and `ubuntu` start
    // the same distro), while its POSIX paths remain case-sensitive. Folding
    // only the authority keeps one engine/window/session owner for that host
    // without merging `/srv/A` and `/srv/a`.
    return `wsl+${loc.host.distro.toLowerCase()}:${path.posix.normalize(loc.path || "/")}`;
  }
  const resolved = path.resolve(loc.path || ".");
  // Windows paths are case-insensitive. Keeping the caller's spelling as the
  // cache key let `C:\Project` and `c:\project` spawn two engines for one store.
  // A native engine running inside WSL must retain POSIX case sensitivity.
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Convenience: identity key straight from a serialized string. */
export function workspaceKey(value: string): string {
  return workspaceLocationKey(parseWorkspaceLocation(value));
}

/**
 * The Windows UNC view of a path inside a distro: `\\wsl$\<distro>\home\me\a.md`.
 *
 * This is how Windows — Explorer, `node:fs`, `shell.openPath` — reaches a file
 * that lives on the distro's ext4. Windows 11 also serves `\\wsl.localhost\`,
 * but `\\wsl$\` works on every version that has WSL2 and is the spelling the
 * rest of the app already uses (discovery), so there is ONE spelling here
 * instead of two that could resolve differently.
 */
export function wslUncPath(distro: string, posixPath: string): string {
  const rel = String(posixPath || "").replace(/^\/+/, "").replace(/\//g, "\\");
  return path.win32.join(`\\\\wsl$\\${distro}`, rel);
}

export function workspaceLocationsEqual(a: WorkspaceLocation, b: WorkspaceLocation): boolean {
  return workspaceLocationKey(a) === workspaceLocationKey(b);
}

/**
 * Resolves the `--workspace <path>` / `--workspace=<path>` argument out of a
 * process argv into a serialized workspace location. Pure + electron-free so it
 * can be unit-tested; the Electron entry wraps it to log the warning.
 *
 * The tricky case (a real, reproduced bug): Electron's
 * `app.commandLine.appendSwitch(...)` INJECTS Chromium switches between
 * `--workspace` and its value and moves the positional path to the END of argv.
 * So for `AgentParty.exe --workspace "C:\proj"` the app actually sees
 * `["--workspace", "--allow-file-access-from-files", "--disable-features=…", "C:\proj"]`.
 * Taking `argv[index+1]` then grabbed a *flag* as the path, which was resolved
 * against the process cwd into a fabricated workspace. So:
 *  - the space-separated value is only trusted when the next token isn't a flag;
 *    otherwise the path is recovered from the last positional (non-flag) arg.
 *  - a *non-absolute* local value is rejected (it would be cwd-resolved into a
 *    bogus path), surfacing a warning instead — the no-silent-fallback rule.
 *  - `--workspace=<path>` (inline) is immune to the reorder and always preferred.
 *
 * Returns `location` when usable, and/or a `warning` string the caller surfaces.
 */
export function workspaceArgFromArgv(argv: string[]): { location?: string; warning?: string } {
  const inline = argv.find((arg) => arg.startsWith("--workspace="));
  const index = argv.indexOf("--workspace");
  let value = "";
  if (inline) {
    value = inline.slice("--workspace=".length);
  } else if (index >= 0) {
    const next = argv[index + 1];
    // A flag (or nothing) after `--workspace` means Electron reordered argv:
    // recover the path from the last positional argument instead of the flag.
    value = next && !next.startsWith("--") ? next : lastPositional(argv, index);
  }
  value = value.trim();
  if (!value) {
    return index >= 0 && !inline ? { warning: "--workspace present but no path could be resolved from argv (dropped/reordered by launcher) — using default workspace" } : {};
  }
  const location = parseWorkspaceLocation(value);
  if (location.host.kind === "wsl" && (!location.host.distro || !path.posix.isAbsolute(location.path))) {
    return { warning: `ignoring invalid WSL --workspace value (absolute path required): ${value}` };
  }
  if (location.host.kind === "local" && !path.win32.isAbsolute(location.path) && !path.posix.isAbsolute(location.path)) {
    return { warning: `ignoring non-absolute --workspace value: ${value}` };
  }
  return { location: serializeWorkspaceLocation(location) };
}

/**
 * The last positional (non-flag, non-`.`) argv entry — where Electron parks the
 * reordered `--workspace` path. Skips argv[0] (the executable) and the
 * `--workspace` token itself so neither is ever mistaken for the path.
 */
function lastPositional(argv: string[], workspaceIndex: number): string {
  for (let i = argv.length - 1; i >= 1; i--) {
    if (i === workspaceIndex) {
      continue;
    }
    const arg = argv[i];
    if (arg && !arg.startsWith("--") && arg !== ".") {
      return arg;
    }
  }
  return "";
}
