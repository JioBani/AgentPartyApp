import * as fs from "node:fs";
import * as path from "node:path";
import { log } from "./logger";
import { ensureStorageDir, STORAGE_DIR } from "./workspaceStorage";
import type { TurnUsageRecord } from "../shared/tokenUsage";

/**
 * Append-only per-workspace usage ledger — the durable per-turn accounting the
 * Token Usage dashboard reads. One JSON record per completed turn, appended on
 * `turn_complete`; range-scanned and aggregated at query time.
 *
 * Layout: `<workspace>/.agent_party_app/usage/turns.jsonl` (JSON Lines).
 * Append-only means we never rewrite history — a member's spend record survives
 * even after the party is deleted (the dashboard's "보관" requirement).
 *
 * Per AGENTS.md: write failures are SURFACED via the log (never silently
 * swallowed) but never throw into the turn path — a ledger hiccup must not break
 * a live turn.
 */
export class UsageLedger {
  private static readonly ROOT_DIR = STORAGE_DIR;
  private static readonly LEDGER_DIR = "usage";
  private static readonly LEDGER_FILE = "turns.jsonl";

  private filePath(workspacePath: string): string {
    return path.join(workspacePath, UsageLedger.ROOT_DIR, UsageLedger.LEDGER_DIR, UsageLedger.LEDGER_FILE);
  }

  /** Appends one turn record. Never throws; logs on failure. */
  append(workspacePath: string, record: TurnUsageRecord): void {
    try {
      const file = this.filePath(workspacePath);
      ensureStorageDir(path.join(workspacePath, UsageLedger.ROOT_DIR));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
    } catch (err) {
      log("warn", "usage", "failed to append turn usage record", {
        workspacePath,
        error: String((err as Error)?.message || err),
      });
    }
  }

  /**
   * Reads records whose end-time falls in [fromMs, toMs). Tolerant of a partial
   * trailing line (a crash mid-append) — malformed lines are skipped and logged,
   * never fatal.
   */
  read(workspacePath: string, fromMs: number, toMs: number): TurnUsageRecord[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath(workspacePath), "utf8");
    } catch {
      return []; // no ledger yet — "아직 없음", not an error
    }
    const out: TurnUsageRecord[] = [];
    let skipped = 0;
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const record = JSON.parse(trimmed) as TurnUsageRecord;
        const at = Date.parse(record.at);
        if (Number.isFinite(at) && at >= fromMs && at < toMs) {
          out.push(record);
        }
      } catch {
        skipped += 1;
      }
    }
    if (skipped > 0) {
      log("warn", "usage", "skipped malformed usage ledger lines", { workspacePath, skipped });
    }
    return out;
  }

  /** Total record count across all time — 0 ⇒ instrumentation has no samples yet. */
  count(workspacePath: string): number {
    try {
      return fs
        .readFileSync(this.filePath(workspacePath), "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0).length;
    } catch {
      return 0;
    }
  }
}
