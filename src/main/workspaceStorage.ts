import * as fs from "node:fs";
import * as path from "node:path";
import { log } from "./logger";

/**
 * The directory this app keeps INSIDE a user's workspace. Party state,
 * transcripts, the usage ledger and the instance discovery files all live here.
 */
export const STORAGE_DIR = ".agent_party_app";

/**
 * `.agent_party_app` sits inside the repository the user (and every member
 * agent) works in, so left unmarked it shows up as untracked noise — and one
 * `git add -A`, an ordinary thing for an agent to run, commits every member's
 * conversation into the user's project.
 *
 * Being tracked also breaks writes. Once git indexes these files, every
 * `git status` re-hashes them, and Windows refuses to rename onto a file
 * another process has open: measured at 35 of 120 saves failing with EPERM
 * while git polled, and 0 of 120 once ignored.
 *
 * `*` covers the directory's whole contents, including this file, so the rule
 * is self-contained and never touches the project's own `.gitignore`.
 */
const IGNORE_EVERYTHING = "# AgentParty's own storage — not part of your project.\n*\n";

/** Roots already marked, so the common path costs nothing after the first write. */
const marked = new Set<string>();

/**
 * Creates the storage root if needed and keeps it out of the user's version
 * control. Every writer that can be the FIRST to create the directory must come
 * through here — discovery beats the party repository to it on a fresh
 * workspace, and a root created by the loser of that race would go unmarked.
 */
export function ensureStorageDir(rootDir: string): string {
  fs.mkdirSync(rootDir, { recursive: true });
  if (marked.has(rootDir)) {
    return rootDir;
  }
  marked.add(rootDir);
  const file = path.join(rootDir, ".gitignore");
  try {
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, IGNORE_EVERYTHING);
    }
  } catch (error) {
    // Worth surfacing — it leaves the EPERM window open — but not worth losing
    // the write that prompted it.
    log("warn", "storage", "could not mark app storage as git-ignored", { rootDir, error: error instanceof Error ? error.message : String(error) });
  }
  return rootDir;
}
