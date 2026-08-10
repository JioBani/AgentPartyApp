/**
 * The message an IPC rejection actually carries.
 *
 * Electron prefixes every one with `Error invoking remote method '<channel>': `
 * (often followed by a second `Error: `). A user reading
 * "party:createParty" learns nothing, and the prefix pushes the real sentence
 * off the first line of a toast. Shared so every surface unwraps it the same
 * way — the settings 진단 card and the Workbench notices both use this.
 */
export function ipcErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, "");
}
