/**
 * Running a CLI just to ask it a question ("are you there?", "--version").
 *
 * Generalised from the Cursor diagnostic runner so every harness probe shares
 * one timeout, one encoding rule and one failure shape — four near-identical
 * spawn wrappers is how they drift apart.
 *
 * Never throws. A probe that fails IS the answer the environment screen wants,
 * and turning it into an exception at every call site invites a `catch {}` that
 * silently reports "not installed" for what was really a timeout.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface CommandProbeResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** Populated whenever `ok` is false: spawn error, timeout, or exit code. */
  error?: string;
  code?: number | null;
}

export interface CommandProbeOptions {
  timeoutMs?: number;
  /** Needed for bare Windows command names that are `.cmd`/`.ps1` shims. */
  shell?: boolean;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

const DEFAULT_TIMEOUT_MS = 20_000;

export function probeCommand(
  command: string,
  args: string[],
  options: CommandProbeOptions = {},
): Promise<CommandProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: CommandProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    // Under `shell: true` Node concatenates argv into the command line anyway
    // and warns (DEP0190) about doing it for you. Building the line ourselves
    // silences that and keeps the escaping decision visible: `shell` is only
    // used for bare command names (Windows `.cmd`/`.ps1` shims), so there is
    // nothing here that needs quoting.
    const child = options.shell
      ? spawn([command, ...args].join(" "), { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], shell: true, env: options.env, cwd: options.cwd })
      : spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: options.env, cwd: options.cwd });

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, stdout: "", stderr: "", error: `'${command}' 응답이 ${timeoutMs}ms 안에 없었습니다.` });
    }, timeoutMs);

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error) => {
      finish({ ok: false, stdout: "", stderr: "", error: error instanceof Error ? error.message : String(error) });
    });
    child.on("close", (code) => {
      const stdout = decode(Buffer.concat(out));
      const stderr = decode(Buffer.concat(err));
      finish({
        ok: code === 0,
        stdout,
        stderr,
        code,
        ...(code === 0 ? {} : { error: stderr.trim() || stdout.trim() || `'${command}' 종료 코드 ${code}` }),
      });
    });
  });
}

/**
 * `wsl.exe` writes its own output (distro lists, errors) as UTF-16LE while every
 * other CLI here writes UTF-8, and decoding one as the other yields NUL-riddled
 * text that silently fails every downstream match. Sniffing the NUL density is
 * more robust than special-casing wsl at each call site.
 */
function decode(buffer: Buffer): string {
  if (buffer.length === 0) {
    return "";
  }
  const sample = buffer.subarray(0, Math.min(buffer.length, 512));
  let nulls = 0;
  for (const byte of sample) {
    if (byte === 0) nulls += 1;
  }
  return nulls / sample.length > 0.2 ? buffer.toString("utf16le") : buffer.toString("utf8");
}

/**
 * A `which` that does not depend on a shell.
 *
 * A GUI-launched Electron process inherits the PATH from whatever started it,
 * which on Windows regularly lacks the per-user npm and `.local\bin` dirs the
 * harness CLIs install into. Resolving to a concrete file also lets the
 * environment screen SHOW where something was found.
 */
export function resolveOnPath(name: string): string | undefined {
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  for (const dir of dirs) {
    for (const extension of path.extname(name) ? [""] : extensions) {
      const candidate = path.join(dir, name + extension);
      if (isFile(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

export function isFile(value: string): boolean {
  try {
    return fs.statSync(value).isFile();
  } catch {
    return false;
  }
}

/** First non-empty line — what `--version` output is worth keeping. */
export function firstLine(value: string): string {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
}
