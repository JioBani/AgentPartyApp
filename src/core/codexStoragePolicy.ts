import * as fs from "node:fs";
import * as path from "node:path";
import { agentPartyCodexSqliteHome } from "./codexSqliteHome";
import { assertCodexStorageUnlocked } from "./codexStorageLock";

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
    // Until the compatible baseline is deployed, native storage is explicit
    // opt-in even for a fresh profile. A status read must not change policy.
    return { version: 1, mode: "legacy" };
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
  assertCodexStorageUnlocked(userDataDir);
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
