import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { codexExecutable, codexExtraArgs, resolveCodexExecutable } from "../core/codexExec";
import { readCodexStorageRecord, writeCodexStorageRecord, type CodexStorageMode } from "../core/codexStoragePolicy";
import { withCodexStorageMaintenance } from "../core/codexStartup";
import { assertCodexStorageUnlocked, codexStorageLockPath } from "../core/codexStorageLock";
import { getSettings } from "./settings";
import { getUserDataDir } from "./userDataDir";
import { log } from "./logger";
import type { SessionManager } from "./sessionManager";

interface StorageJob {
  state: "running" | "complete" | "failed";
  target: CodexStorageMode;
  startedAt: string;
  phase: string;
  verified?: number;
  total?: number;
  backupPath?: string;
  reportPath?: string;
  error?: string;
  warning?: string;
  excludedMissing?: number;
  missingRollouts?: Record<string, string[]>;
  workerPid?: number;
}

/** Transitional Windows administration, deliberately outside normal session startup. */
export class CodexStorageService {
  private job?: StorageJob;

  constructor(private readonly sessions: SessionManager) {
    const file = this.jobPath();
    if (fs.existsSync(file)) {
      this.job = JSON.parse(fs.readFileSync(file, "utf8")) as StorageJob;
      if (this.job.state === "running") {
        const committed = readCodexStorageRecord(getUserDataDir());
        if (committed.mode === this.job.target && committed.backupPath && committed.backupPath === this.job.backupPath && committed.reportPath) {
          this.job = { ...this.job, state: "complete", phase: "complete", reportPath: committed.reportPath };
        } else {
          this.job = { ...this.job, state: "failed", error: "The previous app exited during storage verification. Wait for any surviving storage worker to finish, close external Codex sessions, then rerun verification. Partial progress does not imply a mode switch." };
        }
      }
    }
  }

  private jobPath(): string { return path.join(getUserDataDir(), "codex-storage-job.json"); }

  private saveJob(): void {
    const file = this.jobPath();
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(this.job, null, 2), "utf8");
    fs.renameSync(`${file}.tmp`, file);
  }

  private lockPath(): string { return codexStorageLockPath(getUserDataDir()); }

  status() {
    return { supported: process.platform === "win32", ...readCodexStorageRecord(getUserDataDir()), job: this.job };
  }

  start(input: { mode?: unknown; externalCodexStopped?: unknown; acceptGoalReset?: unknown; excludeMissingThreadIds?: unknown }) {
    if (process.platform !== "win32") throw new Error("Storage transition is currently supported on Windows only. Remote hosts keep their existing mode.");
    if (input.mode !== "native" && input.mode !== "legacy") throw new Error("mode must be native or legacy.");
    if (input.externalCodexStopped !== true) throw new Error("Close external Codex CLI/IDE sessions, then acknowledge externalCodexStopped=true.");
    if (input.acceptGoalReset !== true) throw new Error("This transition preserves conversations but does not merge goal IDs or accumulated goal usage. Acknowledge acceptGoalReset=true.");
    if (input.excludeMissingThreadIds !== undefined && (!Array.isArray(input.excludeMissingThreadIds) || input.excludeMissingThreadIds.some((id) => typeof id !== "string" || !id))) {
      throw new Error("excludeMissingThreadIds must be an explicit array of thread IDs.");
    }
    if (this.job?.state === "running") throw new Error("Codex storage maintenance is already running.");
    const resume = this.sessions.pauseCodexForStorage();
    try { assertCodexStorageUnlocked(getUserDataDir()); }
    catch (error) { resume(); throw error; }
    const job: StorageJob = { state: "running", target: input.mode, startedAt: new Date().toISOString(), phase: "preflight" };
    this.job = job;
    try { this.saveJob(); }
    catch (error) { resume(); throw error; }
    void withCodexStorageMaintenance(() => this.run(job, input.excludeMissingThreadIds as string[] | undefined)).then(() => {
      job.state = "complete";
      job.phase = "complete";
      log("info", "codex-storage", "storage transition verified", { mode: job.target, backupPath: job.backupPath, verified: job.verified });
      this.saveJob();
    }, (error) => {
      job.state = "failed";
      job.error = error instanceof Error ? error.message : String(error);
      log("error", "codex-storage", "storage transition failed; mode unchanged", { error: job.error, backupPath: job.backupPath });
      this.saveJob();
    }).finally(() => {
      resume();
    }).catch((error) => log("error", "codex-storage", "storage operation cleanup failed", { error: String(error) }));
    return this.status();
  }

  private async run(job: StorageJob, excludeMissingThreadIds?: string[]): Promise<void> {
    const userData = getUserDataDir();
    const command = resolveCodexExecutable(codexExecutable(getSettings().codexExecutablePath));
    const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    const candidates = [
      resources && path.join(resources, "bin", "codex-storage-transition.py"),
      path.resolve(__dirname, "../../scripts/codex-storage-transition.py"),
    ].filter((p): p is string => Boolean(p));
    const script = candidates.find((p) => fs.existsSync(p));
    if (!script) throw new Error("Codex storage transition worker is missing from this installation.");
    const request = {
      mode: job.target, userData, excludeMissingThreadIds,
      home: process.env.AGENTPARTY_NATIVE_CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
      sqliteEnvironment: process.env.CODEX_SQLITE_HOME,
      command: command.command, args: [...command.argsPrefix, ...codexExtraArgs()],
    };
    // Python is needed only for this one-time operation: its standard SQLite
    // backup API snapshots WAL consistently without shipping a native binding.
    const result = await new Promise<{ backupPath: string; reportPath: string; verified: number }>((resolve, reject) => {
      const child = spawn("python", [script, "--lock", this.lockPath()], { windowsHide: true, stdio: "pipe" });
      job.workerPid = child.pid;
      let requestSent = false;
      const lockTimer = setTimeout(() => {
        failure = "Storage worker did not acquire its operating-system lock within 20 seconds.";
        child.kill(); // No request was sent: the worker cannot have opened a DB.
      }, 20_000);
      let final: { backupPath: string; reportPath: string; verified: number } | undefined;
      let failure = "";
      const lines = readline.createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        try {
          const message = JSON.parse(line);
          if (message.locked === true && !requestSent) {
            clearTimeout(lockTimer);
            this.saveJob();
            requestSent = true;
            child.stdin.end(JSON.stringify(request));
            return;
          }
          const previousPhase = job.phase;
          if (message.error) failure = String(message.error);
          if (typeof message.excludedMissing === "number") job.excludedMissing = message.excludedMissing;
          if (message.missingRollouts) job.missingRollouts = message.missingRollouts;
          if (message.warning) {
            job.warning = String(message.warning);
            log("warn", "codex-storage", "storage verification is waiting", { warning: job.warning });
          }
          if (message.phase) job.phase = String(message.phase);
          if (typeof message.verified === "number") job.verified = message.verified;
          if (typeof message.total === "number") job.total = message.total;
          if (message.backupPath) job.backupPath = String(message.backupPath);
          if (message.complete === true) final = message;
          if (job.phase !== previousPhase || message.backupPath || (job.verified && job.verified % 100 === 0)) this.saveJob();
        } catch (error) {
          failure = `Cannot record storage verification progress: ${String(error)}`;
          if (!requestSent) child.stdin.end();
        }
      });
      child.stderr.on("data", (chunk) => { failure = `${failure}${String(chunk)}`.slice(-2000); });
      child.once("error", (error) => reject(new Error(`Python 3.11+ is required for this one-time storage operation: ${error.message}`)));
      child.stdin.on("error", reject);
      child.once("close", (code) => {
        clearTimeout(lockTimer);
        lines.close();
        if (code === 0 && final && !failure) resolve(final);
        else reject(new Error(failure || `Storage worker exited with code ${code}; storage mode was not changed.`));
      });
    });
    job.backupPath = result.backupPath;
    job.reportPath = result.reportPath;
    job.verified = result.verified;
    writeCodexStorageRecord(userData, { version: 1, mode: job.target, verifiedAt: new Date().toISOString(), backupPath: result.backupPath, reportPath: result.reportPath });
  }
}
