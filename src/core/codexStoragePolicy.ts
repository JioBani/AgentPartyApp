import * as fs from "node:fs";
import * as path from "node:path";
import { agentPartyCodexSqliteHome } from "./codexSqliteHome";
import { assertCodexStorageUnlocked } from "./codexStorageLock";

export type CodexStorageMode = "legacy" | "native";
/** An operator's explicit choice: a verified native transition or a legacy rollback. */
export interface CodexStorageRecord {
  version: 1;
  mode: CodexStorageMode;
  verifiedAt?: string;
  backupPath?: string;
  reportPath?: string;
}

/**
 * The instant this profile stopped creating isolated SQLite stores. Written once,
 * at the first desktop start without an explicit record. Afterwards a new Codex
 * thread uses the user's own Codex storage; only a conversation that already
 * lived in a member's isolated store keeps that store. Deleting the file moves the
 * cutover later and would hand newer native threads back to isolated stores.
 */
export interface CodexNativeCutover {
  version: 1;
  newThreadsNativeSince: string;
}

export function codexStorageRecordPath(userDataDir: string): string {
  return path.join(userDataDir, "codex-storage.json");
}

export function codexNativeCutoverPath(userDataDir: string): string {
  return path.join(userDataDir, "codex-native-cutover.json");
}

function readExplicitRecord(userDataDir: string): CodexStorageRecord | undefined {
  const file = codexStorageRecordPath(userDataDir);
  if (!fs.existsSync(file)) return undefined;
  const record = JSON.parse(fs.readFileSync(file, "utf8")) as CodexStorageRecord;
  if (record.version !== 1 || (record.mode !== "legacy" && record.mode !== "native")) {
    throw new Error(`Unsupported Codex storage configuration: ${file}`);
  }
  return record;
}

/** Without an explicit record the transition service treats the profile as legacy. */
export function readCodexStorageRecord(userDataDir: string): CodexStorageRecord {
  // A status read must not change policy, so a missing record is never written here.
  return readExplicitRecord(userDataDir) ?? { version: 1, mode: "legacy" };
}

export function readCodexNativeCutover(userDataDir: string): CodexNativeCutover | undefined {
  const file = codexNativeCutoverPath(userDataDir);
  if (!fs.existsSync(file)) return undefined;
  const cutover = JSON.parse(fs.readFileSync(file, "utf8")) as CodexNativeCutover;
  if (cutover.version !== 1 || Number.isNaN(Date.parse(cutover.newThreadsNativeSince))) {
    throw new Error(`Unsupported Codex storage cutover: ${file}`);
  }
  return cutover;
}

/** The cutover that applies right now, or undefined when an explicit record decides. */
export function activeCodexNativeCutover(userDataDir: string): CodexNativeCutover | undefined {
  return readExplicitRecord(userDataDir) ? undefined : readCodexNativeCutover(userDataDir);
}

/**
 * Records the cutover the first time this app starts on a Windows profile.
 * Call before any Codex process starts, so every thread created by this version
 * is newer than the cutover. Returns the cutover only when it was just written.
 */
export function ensureCodexNativeCutover(userDataDir: string): CodexNativeCutover | undefined {
  if (process.platform !== "win32") return undefined;
  if (readExplicitRecord(userDataDir) || readCodexNativeCutover(userDataDir)) return undefined;
  const cutover: CodexNativeCutover = { version: 1, newThreadsNativeSince: new Date().toISOString() };
  writeJsonAtomically(codexNativeCutoverPath(userDataDir), cutover);
  return cutover;
}

/**
 * The SQLite home for one Codex process. `undefined` means no override: CODEX_HOME,
 * CODEX_SQLITE_HOME and Codex config decide, exactly as for the user's own CLI.
 * `threadId` is the conversation being resumed; omit it for a new thread.
 */
export function codexSqliteHomeForScope(userDataDir: string, scope: string, threadId?: string): string | undefined {
  const desktop = scope.startsWith("desktop:") || scope.startsWith("environment:");
  // An orphaned migration worker may outlive an app crash. The new app must
  // not start writers just because its in-memory maintenance flag is fresh.
  assertCodexStorageUnlocked(userDataDir);
  // WSL/SSH and non-Windows hosts keep isolated stores until verified separately.
  if (process.platform !== "win32" || !desktop) return agentPartyCodexSqliteHome(userDataDir, scope);
  const record = readExplicitRecord(userDataDir);
  if (record) return record.mode === "native" ? undefined : agentPartyCodexSqliteHome(userDataDir, scope);
  const cutover = readCodexNativeCutover(userDataDir);
  if (!cutover) return agentPartyCodexSqliteHome(userDataDir, scope);
  const isolated = agentPartyCodexSqliteHome(userDataDir, scope);
  // Only a conversation this store may already index keeps using it. Never
  // create an isolated store after the cutover.
  return threadId && threadPredates(threadId, cutover) && fs.existsSync(isolated) ? isolated : undefined;
}

/** Codex thread IDs are UUIDv7: their first 48 bits are the creation time in ms. */
export function codexThreadCreatedAt(threadId: string): number | undefined {
  const match = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-/i.exec(threadId);
  return match ? parseInt(match[1] + match[2], 16) : undefined;
}

function threadPredates(threadId: string, cutover: CodexNativeCutover): boolean {
  const createdAt = codexThreadCreatedAt(threadId);
  // Every thread this version creates is UUIDv7, so any other ID is older.
  return createdAt === undefined || createdAt < Date.parse(cutover.newThreadsNativeSince);
}

/**
 * AgentParty sets CODEX_SQLITE_HOME only on its own Codex children. When the app
 * is launched from inside one of them (a member ran an installer or relaunched
 * the app), that value leaks into the whole app and would redirect native
 * storage, and a storage transition, into one member's isolated store. It never
 * expresses the user's own configuration. Returns the discarded value to report.
 */
export function discardInheritedIsolatedSqliteHome(userDataDir: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env.CODEX_SQLITE_HOME;
  if (!value) return undefined;
  const relative = path.relative(path.resolve(userDataDir, "codex-sqlite"), path.resolve(value));
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  delete env.CODEX_SQLITE_HOME;
  return value;
}

export function writeCodexStorageRecord(userDataDir: string, record: CodexStorageRecord): void {
  writeJsonAtomically(codexStorageRecordPath(userDataDir), record);
}

function writeJsonAtomically(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(`${file}.tmp`, file);
}
