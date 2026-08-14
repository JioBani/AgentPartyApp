/**
 * Locating the Claude Code CLI that a Claude-harness member will actually run.
 *
 * Mirrors {@link ./cursorAgentCli} and {@link ./grokAgentCli}: a GUI-launched
 * Electron process cannot be trusted to have the per-user install dirs on its
 * PATH, so candidates are probed as concrete files and the winner is reported
 * with WHERE it came from — "it is installed, I promise" is otherwise
 * unarguable.
 *
 * Kept out of `claudeAdapter` so the environment screen can ask "what would you
 * run, and is it there?" without importing the whole session adapter.
 *
 * No `__dirname` / `electron` here: this module is bundled into the ESM
 * engine-server that runs under a distro's plain node.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isFile, resolveOnPath, resolveWindowsNpmCommand } from "./commandProbe";

export interface ClaudeCliLocation {
  command: string;
  /** How it was found — shown verbatim by the environment screen. */
  source: "settings" | "env" | "path" | "wellKnown" | "bundled";
}

const NATIVE_EXECUTABLE = process.platform === "win32" ? "claude.exe" : "claude";

/**
 * The user's own Claude Code install, in the order a user would expect it to
 * win: an explicit setting, then the documented env override, then PATH, then
 * the installer's default location.
 */
export function resolveHostClaudeCli(explicitPath?: string): ClaudeCliLocation | undefined {
  const configured = String(explicitPath || "").trim();
  if (configured && isFile(configured)) {
    const command = spawnableClaudePath(configured);
    if (command) return { command, source: "settings" };
  }
  const fromEnv = String(process.env.AGENTPARTY_CLAUDE_BIN || "").trim();
  if (fromEnv && isFile(fromEnv)) {
    const command = spawnableClaudePath(fromEnv);
    if (command) return { command, source: "env" };
  }
  // Do not ask for `claude.exe` here. The install command shown by AgentParty
  // is npm-based and npm exposes Claude Code as `claude.cmd` on Windows. Asking
  // for the extensionless command lets PATHEXT find both the native installer
  // (`.exe`) and the npm shim (`.cmd`).
  const onPath = resolveOnPath("claude");
  if (onPath) {
    const command = spawnableClaudePath(onPath);
    if (command) return { command, source: "path" };
  }
  for (const candidate of wellKnownPaths()) {
    if (isFile(candidate)) {
      const command = spawnableClaudePath(candidate);
      if (command) return { command, source: "wellKnown" };
    }
  }
  return undefined;
}

/**
 * The Claude Code binary shipped inside the installed app, if this build still
 * carries one. Electron unpacks it out of the asar because it must be spawned
 * as a real file.
 *
 * `process.resourcesPath` only exists in a packaged desktop process, so this is
 * `undefined` in a dev run and inside the WSL engine — both of which then fall
 * through to the host install.
 */
export function packagedClaudeCli(): string | undefined {
  const resourcesPath = process.resourcesPath;
  const platformPackage = platformPackageName();
  if (!resourcesPath || !platformPackage) {
    return undefined;
  }
  const candidate = path.join(
    resourcesPath,
    "app.asar.unpacked",
    "node_modules",
    "@anthropic-ai",
    "claude-agent-sdk",
    "node_modules",
    platformPackage,
    NATIVE_EXECUTABLE,
  );
  return isFile(candidate) ? candidate : undefined;
}

function platformPackageName(): string | undefined {
  const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : "";
  if (!arch) {
    return undefined;
  }
  const platform = process.platform;
  if (platform !== "win32" && platform !== "darwin" && platform !== "linux") {
    return undefined;
  }
  return `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`;
}

/**
 * What a Claude member will actually be spawned with — the one answer both the
 * adapter and the environment screen read, so they can never disagree about
 * which binary is in play.
 *
 * The installed app no longer ships a Claude binary (it was 230 MB of the
 * installer and froze users on whatever version the release was cut against),
 * so the USER'S install is the normal answer. `packagedClaudeCli` stays ahead of
 * it for older builds that still carry one.
 *
 * `undefined` means "let the Agent SDK resolve its own copy" — the dev tree and
 * a WSL distro both have one next to the SDK. It is deliberately LAST: a user
 * who installed Claude Code expects that to be what runs.
 */
export function resolveClaudeCli(explicitPath?: string): ClaudeCliLocation | undefined {
  const configured = String(explicitPath || "").trim();
  if (configured) {
    return { command: isFile(configured) ? (spawnableClaudePath(configured) || configured) : configured, source: "settings" };
  }
  const packaged = packagedClaudeCli();
  if (packaged) {
    return { command: packaged, source: "bundled" };
  }
  return resolveHostClaudeCli();
}

/** Where the official installer puts `claude` when PATH has not caught up. */
function wellKnownPaths(): string[] {
  const home = os.homedir();
  const directories = [
    path.join(home, ".local", "bin"),
    path.join(home, ".claude", "local"),
  ];

  // A GUI-launched Electron process can retain an old PATH after Node/npm was
  // installed. The Windows npm prefix is stable even in that case, so inspect
  // it directly. This is also the exact destination used by the install remedy
  // (`npm install -g @anthropic-ai/claude-code`).
  const names = process.platform === "win32"
    ? ["claude.exe", "claude.cmd", "claude.bat"]
    : ["claude"];
  return [
    ...directories.flatMap((directory) => names.map((name) => path.join(directory, name))),
    resolveWindowsNpmCommand("claude"),
  ].filter((candidate): candidate is string => Boolean(candidate));
}

/**
 * The Agent SDK spawns native paths directly, so it cannot execute a Windows
 * `.cmd` shim (Node reports EINVAL). npm's shim is only a launcher for whatever
 * the package declares as its `bin`, so ask the package itself: releases have
 * shipped both a `cli.js` (invoked with Node, as the SDK's executable option
 * documents) and, since 2.1.x, a native `bin/claude.exe`. Guessing one layout
 * makes a perfectly good install look missing.
 *
 * `undefined` means "this shim leads nowhere we can spawn" — the caller then
 * keeps looking rather than handing the SDK a path that fails at launch.
 */
function spawnableClaudePath(candidate: string): string | undefined {
  if (!/\.(?:cmd|bat)$/i.test(candidate)) {
    return candidate;
  }
  const packageRoot = path.join(path.dirname(candidate), "node_modules", "@anthropic-ai", "claude-code");
  for (const relative of [declaredBin(packageRoot), "bin/claude.exe", "cli.js"]) {
    const target = relative ? path.join(packageRoot, relative) : "";
    if (target && isFile(target)) {
      return target;
    }
  }
  return undefined;
}

/** The package's own `bin` entry for `claude`, when it can be read. */
function declaredBin(packageRoot: string): string | undefined {
  let bin: unknown;
  try {
    bin = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"))?.bin;
  } catch {
    return undefined; // Not an npm layout, or unreadable: the known layouts still apply.
  }
  if (typeof bin === "string") {
    return bin;
  }
  const named = (bin as Record<string, unknown> | undefined)?.claude;
  return typeof named === "string" ? named : undefined;
}

/**
 * Why a missing CLI is an error rather than a silent `undefined`: the Agent SDK
 * would otherwise go looking for a native binary this build no longer ships and
 * fail somewhere far from the cause.
 */
export function claudeCliMissingMessage(): string {
  return (
    "Claude Code CLI를 찾지 못했습니다. https://claude.com/claude-code 에서 설치하거나 " +
    "설정 → 환경에서 실행 파일 경로를 지정하세요."
  );
}

/**
 * Whether this process is an INSTALLED app rather than a dev tree or the WSL
 * engine. Only the installed build ships without a Claude binary of its own, so
 * only there does "nothing resolved" mean "the user must install it" — anywhere
 * else the SDK still has its own copy to fall back to.
 */
export function isInstalledApp(): boolean {
  return Boolean(process.resourcesPath);
}
