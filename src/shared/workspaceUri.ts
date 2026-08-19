/**
 * The serialized form of a workspace location, with no Node dependency.
 *
 * Split out of `workspaceLocation.ts` (which needs `node:path` for identity
 * keys and UNC joins) so the RENDERER can parse and print the same strings the
 * main process stores. The member cwd picker shows `wsl+Ubuntu-24.04:/srv` as a
 * distro badge plus a POSIX path; without this it would have to re-implement
 * that split, and the two spellings would drift the first time one side gained
 * a case the other did not.
 *
 * `workspaceLocation.ts` re-exports these, so there is exactly one parser.
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

export function isWslLocation(loc: WorkspaceLocation): boolean {
  return loc.host.kind === "wsl";
}
