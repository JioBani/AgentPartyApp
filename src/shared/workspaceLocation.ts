import * as path from "node:path";

/**
 * Where a workspace physically lives. A workspace is still a cwd directory, but
 * that directory may belong to a different host than the Electron UI (e.g. a WSL
 * distro). See the WSL remote-engine design. Until the remote engine lands, every location
 * is `{ kind: "local" }` and behavior is identical to a bare path string.
 */
export type WorkspaceHost =
  | { kind: "local" }
  | { kind: "wsl"; distro: string };

export interface WorkspaceLocation {
  host: WorkspaceHost;
  /** Host-native absolute path: win32 for local, posix for wsl. */
  path: string;
}

/** `wsl+<distro>:<posix-abs-path>` — mirrors VS Code's `wsl+<distro>` authority. */
const WSL_URI = /^wsl\+([^:]+):(.*)$/;
/** Windows UNC view of a distro: `\\wsl$\<distro>\...` or `\\wsl.localhost\<distro>\...`. */
const WSL_UNC = /^\\\\wsl(?:\$|\.localhost)\\([^\\]+)\\?(.*)$/;

/**
 * Parses a serialized location into a host + native path:
 * - `wsl+<distro>:/path` → that WSL location.
 * - a `\\wsl$\<distro>\...` / `\\wsl.localhost\...` UNC path → the same WSL
 *   location (so the Windows folder picker can choose a WSL folder).
 * - anything else → a local path, verbatim (existing Windows paths unchanged).
 */
export function parseWorkspaceLocation(value: string): WorkspaceLocation {
  const trimmed = value.trim();

  const uri = WSL_URI.exec(trimmed);
  if (uri) {
    return { host: { kind: "wsl", distro: uri[1].trim() }, path: uri[2] || "/" };
  }

  const unc = WSL_UNC.exec(trimmed);
  if (unc) {
    const posixPath = `/${unc[2].replace(/\\/g, "/")}`.replace(/\/+$/, "") || "/";
    return { host: { kind: "wsl", distro: unc[1].trim() }, path: posixPath };
  }

  return { host: { kind: "local" }, path: value };
}

/**
 * Serializes a location back to a string. Local locations serialize to their raw
 * path (backward compatible); WSL locations to the `wsl+<distro>:` URI.
 */
export function serializeWorkspaceLocation(loc: WorkspaceLocation): string {
  if (loc.host.kind === "wsl") {
    return `wsl+${loc.host.distro}:${loc.path}`;
  }
  return loc.path;
}

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
 */
export function workspaceLocationKey(loc: WorkspaceLocation): string {
  if (loc.host.kind === "wsl") {
    return `wsl+${loc.host.distro}:${path.posix.normalize(loc.path || "/")}`;
  }
  return path.resolve(loc.path || ".");
}

/** Convenience: identity key straight from a serialized string. */
export function workspaceKey(value: string): string {
  return workspaceLocationKey(parseWorkspaceLocation(value));
}

export function isWslLocation(loc: WorkspaceLocation): boolean {
  return loc.host.kind === "wsl";
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
