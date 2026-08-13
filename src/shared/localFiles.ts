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
