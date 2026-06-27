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

/**
 * Parses a serialized location. Anything that is not a `wsl+<distro>:` URI is
 * treated as a local path, verbatim — so existing settings/state that store a
 * raw Windows path keep working unchanged.
 */
export function parseWorkspaceLocation(value: string): WorkspaceLocation {
  const match = WSL_URI.exec(value.trim());
  if (match) {
    const distro = match[1].trim();
    const posixPath = match[2] || "/";
    return { host: { kind: "wsl", distro }, path: posixPath };
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
