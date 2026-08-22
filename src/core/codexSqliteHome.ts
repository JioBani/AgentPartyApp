import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

let startupTail: Promise<void> = Promise.resolve();

/**
 * Codex backfills a new state DB from the shared CODEX_HOME during initialize.
 * Starting several fresh app-servers at once can make those backfills observe
 * each other as still running and time out. Keep only the short initialize
 * phase serialized; turns and already-running members remain fully parallel.
 */
export async function withAgentPartyCodexStartup<T>(start: () => Promise<T>): Promise<T> {
  const previous = startupTail;
  let release!: () => void;
  startupTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await start();
  } finally {
    release();
  }
}

/**
 * Returns a stable, process-role-specific SQLite home for a Codex app-server.
 *
 * Codex keeps auth, config, skills, and rollout JSONL under CODEX_HOME, but its
 * state runtime can place the SQLite databases elsewhere via
 * CODEX_SQLITE_HOME. That separation matters because multiple long-lived
 * app-servers sharing logs_2.sqlite can make a newly spawned server fail during
 * startup with "failed to initialize sqlite state runtime".
 *
 * AgentParty deliberately runs one app-server per member, so each member (plus
 * discovery/usage helpers) gets its own stable database directory while still
 * sharing the user's normal Codex account and conversation files.
 */
export function agentPartyCodexSqliteHome(userDataDir: string, scope: string): string {
  const digest = crypto.createHash("sha256").update(scope).digest("hex").slice(0, 16);
  const label = scope
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "runtime";
  let selected = path.join(userDataDir, "codex-sqlite", `${label}-${digest}`);
  // A timed-out Codex backfill can leave its DB permanently marked `running`.
  // Recovery homes are retained (not deleted) and become the stable home on
  // later app launches. Walk only deterministic sibling names we created.
  for (let depth = 0; depth < 8; depth += 1) {
    const recovery = `${selected}-recovery`;
    if (!fs.existsSync(recovery)) {
      return selected;
    }
    selected = recovery;
  }
  return selected;
}

/** Returns a fresh, deterministic sibling while preserving the stalled DB. */
export function nextAgentPartyCodexSqliteHome(current: string): string {
  let candidate = `${current}-recovery`;
  for (let depth = 0; depth < 8 && fs.existsSync(candidate); depth += 1) {
    candidate = `${candidate}-recovery`;
  }
  return candidate;
}
