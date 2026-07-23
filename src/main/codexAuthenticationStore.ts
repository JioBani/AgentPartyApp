import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { CodexAuthenticationUpdate } from "../shared/codexAuthentication";
import { log } from "./logger";

interface ManagedState {
  generation: string;
  managedAuthDigest?: string;
}

/**
 * Owns the native Codex credential file for the engine host on which it runs.
 *
 * Desktop engines write the Windows user's ~/.codex/auth.json; WSL engine
 * servers run this same code natively and therefore write the distro user's
 * ~/.codex/auth.json. The original file is backed up before first management.
 */
export class CodexAuthenticationStore {
  private readonly authFile: string;
  private readonly stateFile: string;
  private readonly backupDir: string;

  constructor(
    private readonly storageDir: string,
    codexHome = path.join(os.homedir(), ".codex"),
  ) {
    this.authFile = path.join(codexHome, "auth.json");
    this.stateFile = path.join(storageDir, "codex-auth-state.json");
    this.backupDir = path.join(storageDir, "codex-auth-backups");
  }

  async apply(update: CodexAuthenticationUpdate): Promise<boolean> {
    const previous = await this.readState();
    await fsp.mkdir(path.dirname(this.authFile), { recursive: true });
    const current = await this.readCurrent();
    const currentDigest = current ? digest(current) : undefined;
    const serialized = update.credential
      ? `${JSON.stringify({
        OPENAI_API_KEY: null,
        auth_mode: update.credential.authMode,
        last_refresh: update.credential.lastRefresh,
        tokens: {
          access_token: update.credential.tokens.accessToken,
          refresh_token: update.credential.tokens.refreshToken,
          id_token: update.credential.tokens.idToken,
          account_id: update.credential.tokens.accountId,
        },
      }, null, 2)}\n`
      : undefined;
    const expectedDigest = serialized ? digest(serialized) : undefined;

    // A generation marker alone is not proof that native Codex still has that
    // account: Codex, the user, or another tool may replace/delete auth.json.
    // Only skip when both the marker and the actual managed file agree.
    if (previous?.generation === update.generation) {
      if (serialized && currentDigest === expectedDigest) {
        return false;
      }
      if (!serialized) {
        // A disconnected generation owns no credential. Preserve any
        // externally supplied auth file and avoid repeatedly reporting change.
        return false;
      }
    }

    if (!previous && current) {
      await this.backup(current, "original");
    } else if (serialized && current && currentDigest !== expectedDigest) {
      await this.backup(current, "external-before-sync");
    }

    let managedAuthDigest: string | undefined;
    if (serialized) {
      managedAuthDigest = expectedDigest;
      await this.atomicWrite(this.authFile, serialized);
    } else if (current && previous?.managedAuthDigest === currentDigest) {
      await this.backup(current, "disconnected");
      await fsp.rm(this.authFile, { force: true });
    } else if (current && previous?.managedAuthDigest && previous.managedAuthDigest !== currentDigest) {
      log("warn", "codex-auth", "native Codex auth changed outside AgentParty; disconnect left it untouched");
    }

    await fsp.mkdir(path.dirname(this.stateFile), { recursive: true });
    await this.atomicWrite(this.stateFile, `${JSON.stringify({
      generation: update.generation,
      ...(managedAuthDigest ? { managedAuthDigest } : {}),
    } satisfies ManagedState, null, 2)}\n`);
    log("info", "codex-auth", update.credential
      ? "native Codex authentication synchronized"
      : "managed native Codex authentication disconnected");
    return true;
  }

  private async readState(): Promise<ManagedState | undefined> {
    try {
      return JSON.parse(await fsp.readFile(this.stateFile, "utf8")) as ManagedState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        log("warn", "codex-auth", "could not read managed auth state", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return undefined;
    }
  }

  private async readCurrent(): Promise<string | undefined> {
    try {
      return await fsp.readFile(this.authFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      return undefined;
    }
  }

  private async backup(content: string, reason: string): Promise<void> {
    await fsp.mkdir(this.backupDir, { recursive: true });
    const target = path.join(this.backupDir, `${Date.now()}-${process.pid}-${reason}.json`);
    await fsp.writeFile(target, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  }

  private async atomicWrite(target: string, content: string): Promise<void> {
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try {
      await fsp.rename(temporary, target);
    } catch (error) {
      if (process.platform === "win32" && fs.existsSync(target)) {
        await fsp.rm(target, { force: true });
        await fsp.rename(temporary, target);
      } else {
        throw error;
      }
    } finally {
      await fsp.rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
