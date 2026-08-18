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
 * Whether a string is a Windows drive-absolute path, including the slash that
 * markdown/URL handling can place before the drive (`/C:/work/file.html`).
 * Kept separate from Node's platform-dependent `path.isAbsolute`: on Windows
 * that API accepts `/C:/...` as the quite different `\C:\...` rooted path.
 */
export function isWindowsDrivePath(value: string): boolean {
  return /^[\\/]?[a-z]:[\\/]/i.test(String(value || ""));
}

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
 * machine it describes. The caller still handles `file://` URLs and percent
 * decoding — this only decides which host a plain path belongs to.
 */
export function localFileHostPath(value: string, workspace: string, platform: string): string {
  const input = String(value || "");
  // A link may name a distro outright (`wsl+Ubuntu:/home/a`, `\\wsl$\Ubuntu\home\a`);
  // that wins over the window, which is only the default host.
  const target = parseWorkspaceLocation(input);
  if (target.host.kind === "wsl") {
    return platform === "win32" ? wslUncPath(target.host.distro, target.path) : target.path;
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
  return wslUncPath(home.host.distro, absolute);
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
