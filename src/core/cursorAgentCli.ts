import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";

export interface CursorAgentCommand {
  command: string;
  argsPrefix: string[];
  source: string;
}

export interface CursorAgentStatus {
  installed: boolean;
  source?: string;
  version?: string;
  grok45Models: string[];
  /** CLI login state (`status --format json`); undefined when the read failed. */
  authenticated?: boolean;
  /** Signed-in account email, when authenticated. */
  accountEmail?: string;
  error?: string;
}

/** Read-only CLI diagnostics used by AppController/HTTP and QA. */
export async function inspectCursorAgent(explicitPath?: string): Promise<CursorAgentStatus> {
  let resolved: CursorAgentCommand;
  try {
    resolved = resolveCursorAgentCommand(explicitPath);
  } catch (error) {
    return { installed: false, grok45Models: [], error: error instanceof Error ? error.message : String(error) };
  }
  try {
    const [version, models, auth] = await Promise.all([
      runCursorCommand(resolved, ["--version"]),
      runCursorCommand(resolved, ["--list-models"]),
      cursorAgentAuthStatus(explicitPath),
    ]);
    const grok45Models = models.stdout.split(/\r?\n/)
      .map((line) => line.match(/^\s*(cursor-grok-4\.5-[a-z-]+)\s+-/i)?.[1])
      .filter((value): value is string => Boolean(value));
    return {
      installed: true,
      source: resolved.source,
      version: version.stdout.trim(),
      grok45Models,
      authenticated: auth.authenticated,
      accountEmail: auth.email,
      ...(version.stderr.trim() || models.stderr.trim()
        ? { error: [version.stderr, models.stderr].filter(Boolean).join("\n").trim() }
        : {}),
    };
  } catch (error) {
    return {
      installed: true,
      source: resolved.source,
      grok45Models: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface CursorAgentAuthStatus {
  /** Undefined when the CLI could not be run or answered garbage. */
  authenticated?: boolean;
  email?: string;
  error?: string;
}

/** The CLI's own login state (`cursor-agent status --format json`). */
export async function cursorAgentAuthStatus(explicitPath?: string): Promise<CursorAgentAuthStatus> {
  let resolved: CursorAgentCommand;
  try {
    resolved = resolveCursorAgentCommand(explicitPath);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  try {
    const result = await runCursorCommand(resolved, ["status", "--format", "json"]);
    const parsed = JSON.parse(result.stdout) as { isAuthenticated?: unknown; userInfo?: { email?: unknown } };
    return {
      authenticated: Boolean(parsed.isAuthenticated),
      email: typeof parsed.userInfo?.email === "string" ? parsed.userInfo.email : undefined,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Signs the Cursor Agent CLI out on THIS host (`cursor-agent logout`). */
export async function cursorAgentLogout(explicitPath?: string): Promise<{ ok: boolean; detail: string }> {
  const resolved = resolveCursorAgentCommand(explicitPath);
  const before = await cursorAgentAuthStatus(explicitPath);
  if (before.authenticated === false) {
    return { ok: true, detail: "Cursor CLI는 이미 로그아웃 상태입니다." };
  }
  const result = await runCursorCommand(resolved, ["logout"]);
  const after = await cursorAgentAuthStatus(explicitPath);
  if (after.authenticated === true) {
    throw new Error(`Cursor logout이 완료되지 않았습니다: ${result.stderr.trim() || result.stdout.trim() || "still authenticated"}`);
  }
  return {
    ok: true,
    detail: before.email ? `Cursor 계정(${before.email}) 연결을 끊었습니다.` : "Cursor 계정 연결을 끊었습니다.",
  };
}

/**
 * Finds a spawnable Cursor Agent CLI without relying on the Electron process's
 * inherited PATH. Cursor's Windows installer keeps the real Node bundle under
 * LOCALAPPDATA and its small `agent.ps1` launcher is frequently absent from an
 * already-running app's PATH. Spawning that concrete bundle also avoids
 * `shell: true`, so prompts containing shell metacharacters remain plain argv.
 */
export function resolveCursorAgentCommand(explicitPath?: string): CursorAgentCommand {
  const configured = String(explicitPath || process.env.AGENTPARTY_CURSOR_BIN || "").trim();
  if (configured) {
    return commandFromConfiguredPath(configured);
  }

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      const versions = path.join(localAppData, "cursor-agent", "versions");
      const bundle = newestCursorBundle(versions);
      if (bundle) {
        return bundle;
      }
    }
    throw new Error(
      "Cursor Agent CLI was not found. Install it with the official Windows installer " +
      "(`irm 'https://cursor.com/install?win32=true' | iex`) or set AGENTPARTY_CURSOR_BIN.",
    );
  }

  const localBin = path.join(os.homedir(), ".local", "bin");
  for (const name of ["agent", "cursor-agent"]) {
    const candidate = path.join(localBin, name);
    if (isFile(candidate)) {
      return { command: candidate, argsPrefix: cursorExtraArgs(), source: candidate };
    }
  }
  // Let spawn perform the final PATH lookup on Unix. An ENOENT is surfaced by
  // the adapter as a visible diagnostic; there is no silent model fallback.
  return { command: "agent", argsPrefix: cursorExtraArgs(), source: "PATH:agent" };
}

function commandFromConfiguredPath(configured: string): CursorAgentCommand {
  const resolved = path.resolve(configured);
  if (!isFile(resolved)) {
    throw new Error(`Configured Cursor Agent executable does not exist: ${resolved}`);
  }
  if (resolved.toLowerCase().endsWith(".js")) {
    return { command: process.execPath, argsPrefix: [resolved, ...cursorExtraArgs()], source: resolved };
  }
  return { command: resolved, argsPrefix: cursorExtraArgs(), source: resolved };
}

function newestCursorBundle(versionsDir: string): CursorAgentCommand | undefined {
  if (!isDirectory(versionsDir)) {
    return undefined;
  }
  const dirs = fs.readdirSync(versionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(versionsDir, entry.name))
    .sort((a, b) => mtimeMs(b) - mtimeMs(a));
  for (const dir of dirs) {
    const node = path.join(dir, "node.exe");
    const entry = path.join(dir, "index.js");
    if (isFile(node) && isFile(entry)) {
      return { command: node, argsPrefix: [entry, ...cursorExtraArgs()], source: dir };
    }
    const executable = path.join(dir, "cursor-agent.exe");
    if (isFile(executable)) {
      return { command: executable, argsPrefix: cursorExtraArgs(), source: executable };
    }
  }
  return undefined;
}

function cursorExtraArgs(): string[] {
  const raw = process.env.AGENTPARTY_CURSOR_ARGS;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
      throw new Error("expected a JSON array of strings");
    }
    return parsed;
  } catch (error) {
    throw new Error(`AGENTPARTY_CURSOR_ARGS is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isFile(value: string): boolean {
  try {
    return fs.statSync(value).isFile();
  } catch {
    return false;
  }
}

function isDirectory(value: string): boolean {
  try {
    return fs.statSync(value).isDirectory();
  } catch {
    return false;
  }
}

function mtimeMs(value: string): number {
  try {
    return fs.statSync(value).mtimeMs;
  } catch {
    return 0;
  }
}

function runCursorCommand(resolved: CursorAgentCommand, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolved.command, [...resolved.argsPrefix, ...args], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Cursor Agent diagnostic timed out: ${args.join(" ")}`));
    }, 30_000);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim() || stdout.trim() || `Cursor Agent exited with code ${code}.`));
    });
  });
}
