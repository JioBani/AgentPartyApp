/**
 * Windows drive-absolute path grammar used by markdown link classification.
 *
 * Kept out of `localFiles` / `workspaceLocation` because those modules import
 * `node:path` for WSL host identity. The renderer only needs this predicate
 * (a `C:` href is a file, not a URI scheme) and must stay browser-safe.
 *
 * Includes the slash markdown/URL handling can place before the drive
 * (`/C:/work/file.html`). Separate from Node's `path.isAbsolute`: on Windows
 * that API accepts `/C:/...` as the quite different `\C:\...` rooted path.
 */
export function isWindowsDrivePath(value: string): boolean {
  return /^[\\/]?[a-z]:[\\/]/i.test(String(value || ""));
}
