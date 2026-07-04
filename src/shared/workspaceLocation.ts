import * as path from "node:path";

/**
 * Where a workspace physically lives. A workspace is still a cwd directory, but
 * that directory may belong to a different host than the Electron UI (e.g. a WSL
 * distro). See docs/WSL_REMOTE.md. Until the remote engine lands, every location
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

export function workspaceLocationsEqual(a: WorkspaceLocation, b: WorkspaceLocation): boolean {
  return workspaceLocationKey(a) === workspaceLocationKey(b);
}

/**
 * Resolves the `--workspace <path>` / `--workspace=<path>` argument out of a
 * process argv into a serialized workspace location. Pure + electron-free so it
 * can be unit-tested; the Electron entry wraps it to log the warning.
 *
 * Guards two ways a launcher can hand us garbage (both once opened a bogus
 * workspace, violating the no-silent-fallback rule):
 *  - a *dropped* path, so `--workspace` is immediately followed by another flag
 *    (e.g. the Chromium switch `--allow-file-access-from-files`): the flag is NOT
 *    consumed as the path.
 *  - a *non-absolute* local value: it would be `path.resolve`d against the
 *    process cwd downstream, fabricating `<cwd>\<token>` instead of erroring.
 *
 * Returns `location` when usable, and/or a `warning` string the caller surfaces.
 */
export function workspaceArgFromArgv(argv: string[]): { location?: string; warning?: string } {
  const inline = argv.find((arg) => arg.startsWith("--workspace="));
  const index = argv.indexOf("--workspace");
  const nextToken = index >= 0 ? argv[index + 1] : undefined;
  const value = (inline ? inline.slice("--workspace=".length) : nextToken && !nextToken.startsWith("--") ? nextToken : "").trim();
  if (!value) {
    return index >= 0 && !inline ? { warning: `--workspace present but its path was missing/dropped (next token: ${nextToken ?? "none"})` } : {};
  }
  const location = parseWorkspaceLocation(value);
  if (location.host.kind === "local" && !path.win32.isAbsolute(location.path) && !path.posix.isAbsolute(location.path)) {
    return { warning: `ignoring non-absolute --workspace value: ${value}` };
  }
  return { location: serializeWorkspaceLocation(location) };
}
