import * as fs from "node:fs";
import * as path from "node:path";

export function codexStorageLockPath(userDataDir: string): string {
  return path.join(userDataDir, "codex-storage.lock");
}

/** Windows byte-range locks are released by the OS, even after a crash.
 * The worker owns byte zero for its entire lifetime. File contents and PIDs
 * are diagnostic only; a stale, empty or malformed file never blocks startup.
 * Never unlink the marker: replacing its inode would bypass a live lock.
 */
export function assertCodexStorageUnlocked(userDataDir: string): void {
  if (process.platform !== "win32") return;
  const file = codexStorageLockPath(userDataDir);
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    fs.readSync(fd, Buffer.alloc(1), 0, 1, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    if (code === "EBUSY") {
      throw new Error("Codex storage maintenance is still running. Wait for the storage worker to finish before starting this session.");
    }
    throw new Error(`Cannot check Codex storage maintenance lock at ${file}: ${String(error)}. Check file permissions before retrying.`);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
