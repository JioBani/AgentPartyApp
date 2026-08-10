import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Where a harness keeps its OWN copy of a member's conversation.
 *
 * The app's transcript is a display copy with a retention window; the harness
 * writes the full conversation somewhere else and never trims it (measured:
 * 601 MB across 833 files for Claude Code, with 85-day-old sessions still
 * present despite a documented 30-day cleanup). So when the app's window has
 * dropped older history, the harness file is where the rest actually is, and
 * pointing at it costs no new bookkeeping — the session id is already stored.
 *
 * ⚠️ Claude Code keys its directory on the ABSOLUTE cwd. Moving the project
 * folder therefore orphans the history: the new path maps to a different (and
 * empty) directory. This is why the result carries `exists` rather than a bare
 * path — a stale pointer must not be presented as if it were the archive.
 */

export type HarnessOriginal = {
  harness: string;
  /** Absolute path to the file or directory holding the harness's own copy. */
  path: string;
  /** False when nothing is there — typically the project folder was moved. */
  exists: boolean;
  bytes?: number;
};

/**
 * Claude Code's directory name for a working directory.
 *
 * Every character outside `[a-zA-Z0-9]` becomes `-`, so a Korean or spaced path
 * turns into one dash per character. Verified against all 74 project directories
 * on a real machine by re-deriving each from the `cwd` recorded inside it.
 */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/** The harness's own record for a member, or undefined if we cannot name one. */
export function resolveHarnessOriginal(harness: string | undefined, sessionId: string | undefined, cwd: string | undefined): HarnessOriginal | undefined {
  if (!sessionId || !harness) {
    return undefined;
  }
  const home = os.homedir();
  // Members carry either spelling of the Claude harness.
  if (harness === "claude-code" || harness === "claude") {
    if (!cwd) {
      return undefined;
    }
    return describe(harness, path.join(home, ".claude", "projects", claudeProjectDirName(cwd), `${sessionId}.jsonl`));
  }
  if (harness === "codex") {
    // Rollouts are filed by date, but the name ends with the session id, so the
    // id alone locates the file without reading Codex's own index.
    const found = findBySuffix(path.join(home, ".codex", "sessions"), `-${sessionId}.jsonl`, 4);
    return found ? describe(harness, found) : undefined;
  }
  if (harness === "cursor") {
    // chats/<project hash>/<session id>/ — the project hash is not derivable, so
    // the session directory is located by name one level down.
    const found = findDirNamed(path.join(home, ".cursor", "chats"), sessionId);
    return found ? describe(harness, found) : undefined;
  }
  return undefined;
}

function describe(harness: string, target: string): HarnessOriginal {
  try {
    const stat = fs.statSync(target);
    return { harness, path: target, exists: true, bytes: stat.isDirectory() ? directorySize(target) : stat.size };
  } catch {
    return { harness, path: target, exists: false };
  }
}

function directorySize(dir: string): number {
  let total = 0;
  for (const entry of readDirSafe(dir)) {
    const full = path.join(dir, entry.name);
    try {
      total += entry.isDirectory() ? directorySize(full) : fs.statSync(full).size;
    } catch {
      // A file vanishing mid-walk is not worth failing the whole lookup over.
    }
  }
  return total;
}

/** Depth-limited search for a file whose name ends with `suffix`. */
function findBySuffix(root: string, suffix: string, depth: number): string | undefined {
  for (const entry of readDirSafe(root)) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (depth > 0) {
        const found = findBySuffix(full, suffix, depth - 1);
        if (found) {
          return found;
        }
      }
    } else if (entry.name.endsWith(suffix)) {
      return full;
    }
  }
  return undefined;
}

/** Finds `<root>/<any>/<name>` — Cursor's per-project hash sits in between. */
function findDirNamed(root: string, name: string): string | undefined {
  for (const entry of readDirSafe(root)) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = path.join(root, entry.name, name);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function readDirSafe(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // A harness that was never installed has no directory. Not an error: the
    // caller renders "no original" rather than a failure.
    return [];
  }
}
