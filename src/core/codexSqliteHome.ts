import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** Brief backoff while Codex releases or finishes backfilling its state DB. */
export const CODEX_SQLITE_STARTUP_RETRY_DELAYS_MS = [250, 750, 2_000, 5_000] as const;

export function isSqliteStateRuntimeStartupError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /failed to initialize (?:sqlite )?state runtime/iu.test(message)
    || /failed to initialize state runtime at/iu.test(message);
}

export function isStalledSqliteBackfillError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timed out waiting for state db backfill/iu.test(message);
}

/**
 * Codex backfills a new state DB from the shared CODEX_HOME during initialize.
 * Starting several fresh app-servers at once can make those backfills observe
 * each other as still running and time out. Keep only the short initialize
 * phase serialized; turns and already-running members remain fully parallel.
 */
export { withAgentPartyCodexStartup } from "./codexStartup";

/**
 * Compatibility path for existing isolated storage and unconverted hosts.
 * New Windows profiles use Codex's own storage policy. Existing recovery
 * directories remain discoverable so an upgrade never strands their state.
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
