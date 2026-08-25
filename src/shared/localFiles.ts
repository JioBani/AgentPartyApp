/**
 * What the app is willing to hand to the OS when a link points at a local file.
 *
 * Opening a file with its default application is the useful behaviour — a PDF
 * in the PDF viewer, an HTML page in the browser. But on Windows "open with the
 * default application" for a `.exe`, `.bat` or `.ps1` means RUN IT, and the link
 * that asked for it was written by a language model into a chat message. That is
 * not a decision this app may take on someone's behalf.
 *
 * So executables and scripts are never launched — they are REVEALED in the file
 * manager instead, which puts the choice back with the person. Everything else
 * goes to its default app.
 *
 * Pure data + a pure predicate, shared so main (which performs the open) and any
 * test can agree on the policy without duplicating the list.
 */

import { parseWorkspaceLocation, wslUncPath } from "./workspaceLocation";
import { isWindowsDrivePath } from "./windowsDrivePath";

export { isWindowsDrivePath } from "./windowsDrivePath";

/**
 * Extensions that are executed rather than viewed when "opened".
 *
 * Deliberately broad, and it includes shortcut/installer types (`.lnk`, `.msi`,
 * `.reg`) whose whole purpose is to run or change something. A file type missing
 * from this list is only ever *displayed* by its handler, which is the case this
 * feature is for.
 */
export const NEVER_LAUNCH_EXTENSIONS = [
  "exe", "com", "scr", "pif", "msi", "msp", "cpl", "jar", "app",
  "bat", "cmd", "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "hta",
  "sh", "bash", "zsh", "csh", "reg", "lnk", "url", "inf", "dll", "sys",
];

const NEVER_LAUNCH = new Set(NEVER_LAUNCH_EXTENSIONS);

/**
 * Restores the URL-shaped spelling of a Windows drive path before filesystem
 * resolution. Only Windows callers opt into this conversion: `/home/a` must
 * remain a normal POSIX absolute path in WSL/Linux, and UNC paths do not match
 * the drive-letter grammar.
 */
export function normalizeLocalFileTarget(value: string, platform: string): string {
  const input = String(value || "");
  if (platform !== "win32" || !/^[\\/][a-z]:[\\/]/i.test(input)) {
    return input;
  }
  return input.slice(1);
}

/**
 * Removes an editor-style source location from a filesystem target.
 *
 * Models commonly cite files as `path/to/file.ts:45` or
 * `path/to/file.ts:45:12`. The suffix identifies a line (and optionally a
 * column); it is not part of the filename that `fs.stat` or `shell.openPath`
 * can read. Callers must try the original path first and use this only as a
 * missing-file fallback, because `:` is legal in a POSIX filename.
 */
export function withoutLocalFileSourceLocation(value: string): string | undefined {
  const input = String(value || "");
  const match = /^(.*?):(\d+)(?::(\d+))?$/.exec(input);
  if (!match || !match[1] || Number(match[2]) < 1 || (match[3] !== undefined && Number(match[3]) < 1)) {
    return undefined;
  }
  return match[1];
}

/**
 * Where a link's target actually lives, as a path THIS host can open.
 *
 * The case this exists for: a member working in a WSL workspace writes
 * `/home/me/proj/설계.md`. That file is on the distro's ext4, but the desktop
 * runs on Windows, where `path.isAbsolute` reads a leading slash as the current
 * drive's root and turns it into `\home\me\proj\설계.md` — `C:\home\...`, which
 * can never exist. The window's workspace is what says otherwise: its host owns
 * the link, so the path is resolved in POSIX space and addressed through the
 * distro's UNC view.
 *
 * `workspace` is the serialized location of the window the link was clicked in
 * (`wsl+<distro>:/p` for WSL). Returns the path unchanged whenever no host
 * translation applies, so a local workspace behaves exactly as before.
 *
 * Pure: `platform` and `workspace` are arguments so this is testable off the
 * machine it describes. `file://` URLs are decoded by `decodeLocalFileTarget`
 * first — this only decides which host a plain path belongs to.
 *
 * `/mnt/<single-drive-letter>/...` is the distro's view of a Windows drive, not
 * a file on ext4. Translating it to `\\wsl$\<distro>\mnt\c\...` is the open/reveal
 * failure: that UNC is not a reachable Windows path. Convert to `C:\...` instead.
 */
export function localFileHostPath(value: string, workspace: string, platform: string): string {
  const input = String(value || "");
  // A link may name a distro outright (`wsl+Ubuntu:/home/a`, `\\wsl$\Ubuntu\home\a`);
  // that wins over the window, which is only the default host.
  const target = parseWorkspaceLocation(input);
  if (target.host.kind === "wsl") {
    return hostPathForWslPosix(target.host.distro, target.path, platform);
  }
  const home = parseWorkspaceLocation(String(workspace || ""));
  // Only the Windows desktop needs the translation. The same controller runs
  // headless INSIDE the distro, where `/home/...` is already native and a UNC
  // path would be meaningless.
  if (home.host.kind !== "wsl" || platform !== "win32" || isWindowsDrivePath(input)) {
    return input;
  }
  const posix = input.replace(/\\/g, "/");
  const absolute = posix.startsWith("/") ? posix : joinPosix(home.path || "/", posix);
  return hostPathForWslPosix(home.host.distro, absolute, platform);
}

/**
 * Decode a click/HTTP target into the spelling `localFileHostPath` understands.
 *
 * `file://` URLs are parsed here rather than by Node's `fileURLToPath`: on
 * Windows that API throws `ERR_INVALID_FILE_URL_PATH` for `file:///home/...`
 * and `file:///mnt/c/...` before the WSL host can be applied. `#` is a URL
 * fragment, not a filename; a literal `#` in a name is `%23`.
 */
export function decodeLocalFileTarget(raw: string): string {
  const input = String(raw || "");
  if (/^file:/i.test(input.trim())) {
    return parseLocalFileUrl(input);
  }
  try {
    return decodeURI(input);
  } catch {
    return input;
  }
}

/**
 * `file:` URL → a path or `wsl+<distro>:` URI. Throws the same readable error
 * the controller surfaces for a malformed URL.
 */
export function parseLocalFileUrl(raw: string): string {
  const input = String(raw || "").trim();
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error(`Not a readable file URL: '${raw}'.`);
  }
  if (parsed.protocol.toLowerCase() !== "file:") {
    throw new Error(`Not a readable file URL: '${raw}'.`);
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent(parsed.pathname || "");
  } catch {
    throw new Error(`Not a readable file URL: '${raw}'.`);
  }
  const host = (parsed.hostname || "").replace(/^\[|\]$/g, "");
  if (/^wsl(?:\.localhost|\$)$/i.test(host)) {
    const trimmed = pathname.replace(/^\/+/, "");
    const slash = trimmed.indexOf("/");
    const distro = slash === -1 ? trimmed : trimmed.slice(0, slash);
    const posix = slash === -1 ? "/" : trimmed.slice(slash);
    if (!distro) {
      throw new Error(`Not a readable file URL: '${raw}'.`);
    }
    return `wsl+${distro}:${posix || "/"}`;
  }
  if (host && host.toLowerCase() !== "localhost") {
    throw new Error(`Not a readable file URL: '${raw}'.`);
  }
  return pathname || "/";
}

/**
 * `/mnt/c/...` → `C:\...`. Grammar is exactly one drive letter:
 * `^/mnt/[A-Za-z](?:/|$)`. `/mnt/wsl` and `/mnt/abc` are distro paths, not drives.
 */
function windowsPathFromMnt(posix: string): string | null {
  const match = /^\/mnt\/([A-Za-z])(?:\/(.*))?$/.exec(posix);
  if (!match) {
    return null;
  }
  const rest = (match[2] || "").replace(/\//g, "\\");
  return rest ? `${match[1].toUpperCase()}:\\${rest}` : `${match[1].toUpperCase()}:\\`;
}

function hostPathForWslPosix(distro: string, posix: string, platform: string): string {
  if (platform !== "win32") {
    return posix;
  }
  return windowsPathFromMnt(posix) || wslUncPath(distro, posix);
}

/**
 * `<base>/<relative>` with `.`/`..` applied. Hand-rolled rather than
 * `path.posix.join` so this module stays free of platform-shaped surprises when
 * bundled for the renderer or a test.
 */
function joinPosix(base: string, relative: string): string {
  const parts: string[] = [];
  for (const segment of `${base}/${relative}`.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return `/${parts.join("/")}`;
}

/** The lowercase extension of a path, without the dot ("" when there is none). */
export function extensionOf(filePath: string): string {
  const name = filePath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * Whether this path may be handed to the OS's "open" verb.
 *
 * `false` does NOT mean "do nothing" — the caller reveals the file in the file
 * manager instead. Refusing silently would be indistinguishable from a broken
 * link, which is the bug this whole area keeps producing.
 */
export function isLaunchable(filePath: string): boolean {
  return !NEVER_LAUNCH.has(extensionOf(filePath));
}
