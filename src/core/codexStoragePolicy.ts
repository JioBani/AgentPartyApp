import * as fs from "node:fs";
import * as path from "node:path";
import { agentPartyCodexSqliteHome } from "./codexSqliteHome";

export type CodexStorageMode = "legacy" | "native";
export interface CodexStorageRecord {
  version: 1;
  mode: CodexStorageMode;
  verifiedAt?: string;
  backupPath?: string;
  reportPath?: string;
}

export function codexStorageRecordPath(userDataDir: string): string {
  return path.join(userDataDir, "codex-storage.json");
}

export function readCodexStorageRecord(userDataDir: string): CodexStorageRecord {
  const file = codexStorageRecordPath(userDataDir);
  if (!fs.existsSync(file)) {
    // An upgrade must not silently move existing members. Fresh profiles use
    // Codex's own configuration immediately, without creating isolated DBs.
    const record: CodexStorageRecord = { version: 1, mode: fs.existsSync(path.join(userDataDir, "codex-sqlite")) ? "legacy" : "native" };
    // Pin the initial decision: a later remote/legacy helper may create this
    // directory, which must not switch an already-native desktop back again.
    writeCodexStorageRecord(userDataDir, record);
    return record;
  }
  const record = JSON.parse(fs.readFileSync(file, "utf8")) as CodexStorageRecord;
  if (record.version !== 1 || (record.mode !== "legacy" && record.mode !== "native")) {
    throw new Error(`Unsupported Codex storage configuration: ${file}`);
  }
  return record;
}

/** Native means no override: CODEX_HOME, CODEX_SQLITE_HOME and Codex config win. */
export function codexSqliteHomeForScope(userDataDir: string, scope: string): string | undefined {
  const desktop = scope.startsWith("desktop:") || scope.startsWith("environment:");
  // An orphaned migration worker may outlive an app crash. The new app must
  // not start writers just because its in-memory maintenance flag is fresh.
  const lock = path.join(userDataDir, "codex-storage.lock");
  if (process.platform === "win32" && fs.existsSync(lock)) {
    const owner = JSON.parse(fs.readFileSync(lock, "utf8")) as { pid?: number; workerPid?: number };
    for (const pid of [owner.pid, owner.workerPid]) {
      if (!pid) continue;
      try { process.kill(pid, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") continue;
        throw error;
      }
      throw new Error(`Codex storage maintenance is still running (PID ${pid}). Wait for it to finish before starting this session.`);
    }
  }
  const record = process.platform === "win32" ? readCodexStorageRecord(userDataDir) : undefined;
  if (desktop && record?.mode === "native") return undefined;
  return agentPartyCodexSqliteHome(userDataDir, scope);
}

export function writeCodexStorageRecord(userDataDir: string, record: CodexStorageRecord): void {
  const file = codexStorageRecordPath(userDataDir);
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(record, null, 2), "utf8");
  fs.renameSync(`${file}.tmp`, file);
}
