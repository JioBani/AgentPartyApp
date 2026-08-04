import * as crypto from "node:crypto";
import * as path from "node:path";

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
  return path.join(userDataDir, "codex-sqlite", `${label}-${digest}`);
}
