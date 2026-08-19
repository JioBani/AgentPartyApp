/**
 * Answers "can this machine actually run a member, and if not, what do I do?"
 *
 * Every harness already knows how to find its own CLI; this module runs those
 * SAME resolvers ahead of time instead of waiting for a turn to fail, and turns
 * each answer into a check the user can act on. Nothing here re-implements
 * discovery — {@link resolveCursorAgentCommand}, {@link grokCliInstalledPath},
 * {@link resolveCodexExecutable} and {@link resolveClaudeCli} stay the single
 * source of truth, so the screen cannot claim a CLI the adapter would not find.
 *
 * Two deliberate restraints:
 *  - Execution checks stop at local process/protocol initialization. They do
 *    not send a model prompt or spend provider tokens.
 *  - WSL is never probed implicitly: a probe starts the distro. It runs only
 *    when the caller asks for it.
 */
import * as path from "node:path";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import { getSettings } from "./settings";
import { log } from "./logger";
import { invalidateCursorAuthCache } from "./authService";
import { claudeAgentSdkSpec, claudeSdkVersion } from "./claudeSdkVersion";
import { firstLine, isFile, probeCommand, resolveOnPath, type CommandProbeResult } from "../core/commandProbe";
import { resolveClaudeCli, resolveSdkClaudeCli } from "../core/claudeCli";
import { codexExecutable, codexExtraArgs, resolveCodexExecutable } from "../core/codexExec";
import { agentPartyCodexSqliteHome } from "../core/codexSqliteHome";
import {
  claudeLoggedIn,
  codexRuntimeFailureReason,
  commandFailureReason,
  failedCommandStep,
  commandProbeFailureKind,
  probeAppServerCommand,
  probeClaudeCommand,
  probeCodexAppServer,
  probeLocalWorkspace,
  skippedStep,
  successfulStep,
} from "../core/harnessExecutionProbe";
import { resolveCursorAgentCommand } from "../core/cursorAgentCli";
import { grokCliInstalledPath } from "../core/grokAgentCli";
import { grokHomeDir, grokSubscriptionAvailable } from "../core/grokSubscriptionAuth";
import { isEnvironmentBlockedError } from "../core/environmentError";
import { workspaceKey } from "../shared/workspaceLocation";
import { parseWorkspaceLocation } from "../shared/workspaceLocation";
import { getUserDataDir } from "./userDataDir";
import { claudeCliVersionForSdk, type EnvironmentCheck, type EnvironmentExecutionHost, type EnvironmentProbeFailureKind, type EnvironmentProbeStep, type EnvironmentRemedy, type EnvironmentReport } from "../shared/environment";

const CACHE_TTL_MS = 30_000;
/** A cold distro can take a while to boot before it answers anything. */
const WSL_TIMEOUT_MS = 90_000;

const cache = new Map<string, { at: number; report: EnvironmentReport }>();

function displayCommand(command: string, args: string[] = []): string {
  const parts = [command, ...args].map((part, index, all) => redactEnvironmentCommandPart(part, index > 0 ? all[index - 1] : ""));
  return parts.map((part) => /\s/.test(part) ? `"${part.replace(/"/g, '\\"')}"` : part).join(" ");
}

export function redactEnvironmentCommandPart(value: string, previous: string): string {
  if (/^(?:--?)?(?:api[-_]?key|token|password|secret|authorization)$/i.test(previous)) return "[redacted]";
  if (/^(?:sk-|xai-|Bearer\s)/i.test(value)) return "[redacted]";
  return value.replace(/((?:api[-_]?key|token|password|secret|authorization)\s*[=:]\s*)[^\s,;]+/gi, "$1[redacted]");
}

function claudeDisplayCommand(command: string, args: string[]): string {
  return /\.(?:[cm]?js)$/i.test(command)
    ? displayCommand(resolveOnPath(process.platform === "win32" ? "node.exe" : "node") || "node", [command, ...args])
    : displayCommand(command, args);
}

/**
 * A fixed report standing in for the real probe (QA only).
 *
 * The screen exists to report THIS machine, so on a healthy one its
 * interesting states never render and its design cannot be reviewed. Installed
 * by `POST /api/qa/environment`, which is itself refused unless the app was
 * launched in QA mode — so a normal run can never show anything but the truth.
 */
let mockReport: EnvironmentReport | undefined;

export function setMockEnvironmentReport(report: EnvironmentReport | undefined): void {
  mockReport = report;
  invalidateEnvironmentCache();
}

export interface EnvironmentProbeOptions {
  /** Ignore the cache — what the "다시 점검" button sends. */
  refresh?: boolean;
  /** Probe WSL distros too. Off by default because it boots them. */
  includeWsl?: boolean;
  /** Workspace whose real cwd will be used for harness process creation. */
  workspacePath?: string;
}

export async function probeEnvironment(options: EnvironmentProbeOptions = {}): Promise<EnvironmentReport> {
  if (mockReport) {
    return mockReport;
  }
  const workspacePath = options.workspacePath || getSettings().workspacePath || process.cwd();
  const cacheKey = workspaceKey(workspacePath);
  const cached = cache.get(cacheKey);
  if (!options.refresh && !options.includeWsl && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.report;
  }
  const sdkVersion = claudeSdkVersion();
  const checks = [
    ...(await runtimeChecks(workspacePath)),
    ...(await harnessChecks(sdkVersion, workspacePath)),
    ...(options.includeWsl ? await wslChecks(sdkVersion, workspacePath) : []),
  ];
  const report: EnvironmentReport = {
    checkedAt: new Date().toISOString(),
    expectedClaudeCli: claudeCliVersionForSdk(sdkVersion),
    checks,
  };
  if (!options.includeWsl) {
    cache.set(cacheKey, { at: Date.now(), report });
  }
  return report;
}

/** Drops the cached report (call after a repair changes the machine). */
export function invalidateEnvironmentCache(): void {
  cache.clear();
}

// ---------------------------------------------------------------- runtime

async function runtimeChecks(workspacePath: string): Promise<EnvironmentCheck[]> {
  const host = windowsExecutionHost(workspacePath);
  return [await gitCheck(), await nodeCheck()].map((check) => ({ ...check, host }));
}

async function gitCheck(): Promise<EnvironmentCheck> {
  const found = resolveOnPath(process.platform === "win32" ? "git.exe" : "git");
  if (!found) {
    return {
      id: "runtime.git",
      group: "runtime",
      label: "Git",
      status: "warn",
      detail: "Git이 PATH에 없습니다. 멤버가 diff·커밋 같은 작업을 할 때 실패합니다.",
      remedies: [{ kind: "docs", label: "Git 설치 안내", url: "https://git-scm.com/downloads" }],
    };
  }
  const probe = await probeCommand(found, ["--version"]);
  return {
    id: "runtime.git",
    group: "runtime",
    label: "Git",
    status: probe.ok ? "ok" : "error",
    detail: probe.ok ? "사용 가능합니다." : "Git을 찾았지만 실행하지 못했습니다.",
    version: probe.ok ? firstLine(probe.stdout) : undefined,
    path: found,
    raw: probe.ok ? undefined : probe.error,
  };
}

async function nodeCheck(): Promise<EnvironmentCheck> {
  const found = resolveOnPath(process.platform === "win32" ? "node.exe" : "node");
  if (!found) {
    return {
      id: "runtime.node",
      group: "runtime",
      label: "Node.js",
      status: "warn",
      detail: "Node.js가 PATH에 없습니다. npm으로 설치하는 하네스 CLI(codex 등)를 쓸 수 없습니다.",
      remedies: [{ kind: "docs", label: "Node.js 설치 안내", url: "https://nodejs.org/" }],
    };
  }
  const probe = await probeCommand(found, ["-v"]);
  return {
    id: "runtime.node",
    group: "runtime",
    label: "Node.js",
    status: probe.ok ? "ok" : "error",
    detail: probe.ok ? "사용 가능합니다." : "Node.js를 찾았지만 실행하지 못했습니다.",
    version: probe.ok ? firstLine(probe.stdout) : undefined,
    path: found,
    raw: probe.ok ? undefined : probe.error,
  };
}

// ---------------------------------------------------------------- harness

async function harnessChecks(sdkVersion: string | undefined, workspacePath: string): Promise<EnvironmentCheck[]> {
  const host = windowsExecutionHost(workspacePath);
  return [
    await claudeCheck(sdkVersion, workspacePath),
    await codexCheck(workspacePath),
    await cursorCheck(workspacePath),
    await grokCheck(workspacePath),
  ].map((check) => ({ ...check, host }));
}

function windowsExecutionHost(workspacePath: string): EnvironmentExecutionHost {
  const location = parseWorkspaceLocation(workspacePath);
  return {
    kind: "windows",
    label: "Windows",
    ...(location.host.kind === "local" ? { workspace: path.resolve(location.path || ".") } : {}),
  };
}

/**
 * The way out when the user pointed at the wrong file: clear the override so
 * auto-discovery resumes, or go fix the path. Offered BEFORE any install
 * button, because the CLI is usually already there.
 */
function pathRemedies(settingsField: string): EnvironmentRemedy[] {
  return [{ kind: "settings", label: "실행 파일 경로 고치기", settingsField }];
}

const CLAUDE_INSTALL_COMMAND = "npm install -g @anthropic-ai/claude-code";

/**
 * Which Claude binary is really in play, in the adapter's own precedence order,
 * extended with the host install this screen exists to talk about. The origin
 * string is shown to the user because "Claude Code 2.1.191" is confusing when
 * they just installed 2.1.229 themselves.
 */
function chooseClaudeCli(configured: string): { command: string; origin: string } | undefined {
  // Delegates to the adapter's own resolver, so this screen can never name a
  // different binary than the one a member would spawn.
  const resolved = resolveClaudeCli(configured);
  if (resolved) {
    return { command: resolved.command, origin: CLAUDE_ORIGIN_LABEL[resolved.source] };
  }
  // The resolver answered "let the SDK use its own copy"; name that copy, since
  // it IS what a dev run and a WSL distro execute.
  const sdkNative = resolveSdkClaudeCli();
  return sdkNative ? { command: sdkNative, origin: CLAUDE_ORIGIN_LABEL.sdk } : undefined;
}

const CLAUDE_ORIGIN_LABEL = {
  settings: "설정에서 지정한 경로",
  env: "AGENTPARTY_CLAUDE_BIN 환경 변수",
  path: "이 PC에 설치된 Claude Code (PATH)",
  wellKnown: "이 PC에 설치된 Claude Code",
  bundled: "앱에 번들된 실행 파일",
  sdk: "Agent SDK가 함께 설치한 실행 파일",
} as const;

async function claudeCheck(sdkVersion: string | undefined, workspacePath: string): Promise<EnvironmentCheck> {
  const settings = getSettings();
  const expected = claudeCliVersionForSdk(sdkVersion);
  const configured = String(settings.claudeExecutablePath || "").trim();
  const chosen = chooseClaudeCli(configured);
  const workspace = probeLocalWorkspace(workspacePath);
  const steps: EnvironmentProbeStep[] = [workspace.step];

  const remedies: EnvironmentRemedy[] = [
    { kind: "command", label: "설치 명령 복사", command: CLAUDE_INSTALL_COMMAND },
    {
      kind: "repair",
      label: "설치하기",
      repairId: "harness.claude-code.install",
      command: CLAUDE_INSTALL_COMMAND,
      confirm: `이 PC에 Claude Code를 설치합니다.\n\n${CLAUDE_INSTALL_COMMAND}`,
    },
    { kind: "docs", label: "설치 안내", url: "https://claude.com/claude-code" },
    { kind: "settings", label: "실행 파일 경로 지정", settingsField: "claudeExecutablePath" },
  ];

  if (!chosen) {
    steps.push({ id: "executable", label: "실행 파일", status: "failed", detail: "Claude Code CLI를 찾지 못했습니다." });
    steps.push(skippedStep("version", "버전 확인", "실행 파일"));
    steps.push(skippedStep("runtime", "프로세스 실행", "실행 파일"));
    steps.push(skippedStep("authentication", "로그인", "실행 파일"));
    return {
      id: "harness.claude-code",
      group: "harness",
      label: "Claude Code",
      status: "missing",
      detail: "Claude Code CLI를 찾지 못했습니다. Claude 하네스 멤버를 실행할 수 없습니다.",
      steps,
      remedies,
    };
  }

  const executableExists = isFile(chosen.command) || Boolean(resolveOnPath(chosen.command));
  steps.push({
    id: "executable",
    label: "실행 파일",
    status: executableExists ? "ok" : "failed",
    detail: executableExists ? `${chosen.origin}: ${chosen.command}` : `설정된 실행 파일을 찾을 수 없습니다: ${chosen.command}`,
    ...(executableExists ? {} : { raw: `file not found: ${chosen.command}` }),
  });

  if (!executableExists) {
    steps.push(skippedStep("version", "버전 확인", "실행 파일"));
    steps.push(skippedStep("runtime", "프로세스 실행", "실행 파일"));
    steps.push(skippedStep("authentication", "로그인", "실행 파일"));
    return {
      id: "harness.claude-code",
      group: "harness",
      label: "Claude Code",
      status: "missing",
      detail: `Claude Code 실행 파일을 찾을 수 없습니다: ${chosen.command}`,
      path: chosen.command,
      raw: `file not found: ${chosen.command}`,
      steps,
      remedies: configured
        ? [...pathRemedies("claudeExecutablePath"), ...remedies.filter((remedy) => remedy.kind !== "settings")]
        : remedies,
    };
  }

  if (!workspace.cwd) {
    steps.push(skippedStep("version", "버전 확인", "작업공간"));
    steps.push(skippedStep("runtime", "프로세스 실행", "작업공간"));
    steps.push(skippedStep("authentication", "로그인", "작업공간"));
    return {
      id: "harness.claude-code",
      group: "harness",
      label: "Claude Code",
      status: workspace.step.status === "failed" ? "error" : "warn",
      detail: workspace.step.status === "failed"
        ? "현재 작업공간을 사용할 수 없어 Claude 실행 검증을 중단했습니다."
        : "현재 작업공간은 WSL에 있어 네이티브 Claude 실행 검증을 건너뛰었습니다. WSL 환경 점검을 실행하세요.",
      path: chosen.command,
      raw: workspace.step.raw,
      steps,
    };
  }

  const versionStartedAt = Date.now();
  const versionProbe = await probeClaudeCommand(chosen.command, ["--version"], workspace.cwd);
  if (!versionProbe.ok) {
    steps.push(failedCommandStep("version", "버전 확인", "Claude Code", versionProbe, versionStartedAt, {
      command: claudeDisplayCommand(chosen.command, ["--version"]),
      cwd: workspace.cwd,
    }));
    steps.push(skippedStep("runtime", "프로세스 실행", "버전 확인"));
    steps.push(skippedStep("authentication", "로그인", "버전 확인"));
    return {
      id: "harness.claude-code",
      group: "harness",
      label: "Claude Code",
      status: "error",
      detail: `버전 확인 단계에서 실패했습니다. ${commandFailureReason("Claude Code", versionProbe)}`,
      path: chosen.command,
      raw: versionProbe.error,
      steps,
      remedies: configured
        ? [...pathRemedies("claudeExecutablePath"), ...remedies.filter((remedy) => remedy.kind !== "settings")]
        : remedies,
    };
  }
  const version = firstLine(versionProbe.stdout);
  steps.push(successfulStep("version", "버전 확인", version, versionStartedAt, {
    command: claudeDisplayCommand(chosen.command, ["--version"]),
    cwd: workspace.cwd,
  }));

  // `auth status` starts the same resolved Claude executable in the real cwd.
  // It does not call a model, but proves process creation and account state.
  const authStartedAt = Date.now();
  const authProbe = await probeClaudeCommand(chosen.command, ["auth", "status"], workspace.cwd);
  const processStarted = authProbe.failureKind !== "spawn" && authProbe.failureKind !== "timeout";
  if (!processStarted) {
    steps.push(failedCommandStep("runtime", "프로세스 실행", "Claude Code", authProbe, authStartedAt, {
      command: claudeDisplayCommand(chosen.command, ["auth", "status"]),
      cwd: workspace.cwd,
    }));
    steps.push(skippedStep("authentication", "로그인", "프로세스 실행"));
    return {
      id: "harness.claude-code",
      group: "harness",
      label: "Claude Code",
      status: "error",
      detail: `프로세스 실행 단계에서 실패했습니다. ${commandFailureReason("Claude Code", authProbe)}`,
      version,
      path: chosen.command,
      raw: authProbe.error,
      steps,
      remedies,
    };
  }
  steps.push(successfulStep("runtime", "프로세스 실행", `현재 작업공간에서 Claude Code 프로세스를 생성했습니다.`, authStartedAt, {
    command: claudeDisplayCommand(chosen.command, ["auth", "status"]),
    cwd: workspace.cwd,
  }));
  const signedIn = authProbe.ok && claudeLoggedIn(authProbe.stdout);
  if (!signedIn) {
    steps.push({
      id: "authentication",
      label: "로그인",
      status: "failed",
      detail: "Claude Code 로그인이 유효하지 않습니다.",
      durationMs: Date.now() - authStartedAt,
      raw: authProbe.error || authProbe.stderr.trim() || "claude auth status did not report loggedIn=true",
      command: claudeDisplayCommand(chosen.command, ["auth", "status"]),
      cwd: workspace.cwd,
      failureKind: "authentication",
      failureCode: authProbe.failureCode || (authProbe.code === undefined || authProbe.code === null ? undefined : String(authProbe.code)),
    });
    return {
      id: "harness.claude-code",
      group: "harness",
      label: "Claude Code",
      status: "missing",
      detail: "프로세스는 실행됐지만 Claude Code 로그인 확인 단계에서 실패했습니다.",
      version,
      path: chosen.command,
      raw: authProbe.error || authProbe.stderr.trim(),
      steps,
      remedies: [{ kind: "command", label: "로그인 명령 복사", command: "claude" }],
    };
  }
  steps.push(successfulStep("authentication", "로그인", "Claude Code 계정 로그인이 유효합니다.", authStartedAt, {
    command: claudeDisplayCommand(chosen.command, ["auth", "status"]),
    cwd: workspace.cwd,
  }));

  const actual = version?.match(/\d+\.\d+\.\d+/)?.[0];
  const skewed = Boolean(expected && actual && expected !== actual);
  return {
    id: "harness.claude-code",
    group: "harness",
    label: "Claude Code",
    status: skewed ? "warn" : "ok",
    // Phrased as a labelled noun ("사용 중: …") rather than "<origin>을 사용합니다"
    // because the origins end in different syllables and would need different
    // Korean particles.
    detail: skewed
        ? `사용 중: ${chosen.origin}. 이 빌드의 Agent SDK는 ${expected}과 짝을 이루는데 설치된 버전은 ${actual}입니다. 대부분 동작하지만 문제가 생기면 이 차이를 먼저 의심하세요.`
        : `사용 중: ${chosen.origin}. 현재 작업공간에서 실행 및 로그인을 확인했습니다.`,
    version,
    path: chosen.command,
    steps,
    ...(skewed ? { remedies } : {}),
  };
}

const CODEX_INSTALL_COMMAND = "npm install -g @openai/codex";

async function codexCheck(workspacePath: string): Promise<EnvironmentCheck> {
  const settings = getSettings();
  const configured = String(settings.codexExecutablePath || "").trim();
  const executable = codexExecutable(settings.codexExecutablePath);
  const resolved = resolveCodexExecutable(executable);
  const reportedPath = resolveOnPath(executable) || executable;
  const workspace = probeLocalWorkspace(workspacePath);
  const executableExists = isFile(resolved.command)
    || Boolean(resolveOnPath(resolved.command))
    || Boolean(resolved.argsPrefix[0] && isFile(resolved.argsPrefix[0]));
  const steps: EnvironmentProbeStep[] = [workspace.step, {
    id: "executable",
    label: "실행 파일",
    status: executableExists ? "ok" : "failed",
    detail: executableExists ? `Codex 실행 경로: ${reportedPath}` : `Codex 실행 파일을 찾을 수 없습니다: ${reportedPath}`,
    ...(executableExists ? {} : { raw: `file not found: ${reportedPath}` }),
  }];
  const remedies: EnvironmentRemedy[] = [
    { kind: "command", label: "설치 명령 복사", command: CODEX_INSTALL_COMMAND },
    {
      kind: "repair",
      label: "설치하기",
      repairId: "harness.codex.install",
      command: CODEX_INSTALL_COMMAND,
      confirm: `이 PC에 Codex CLI를 설치합니다.\n\n${CODEX_INSTALL_COMMAND}`,
    },
    { kind: "docs", label: "설치 안내", url: "https://developers.openai.com/codex/cli" },
    { kind: "settings", label: "실행 파일 경로 지정", settingsField: "codexExecutablePath" },
  ];

  if (!executableExists) {
    steps.push(skippedStep("version", "버전 확인", "실행 파일"));
    steps.push(skippedStep("authentication", "로그인", "실행 파일"));
    steps.push(skippedStep("runtime", "app-server 초기화", "실행 파일"));
    return {
      id: "harness.codex",
      group: "harness",
      label: "Codex",
      status: "missing",
      detail: `Codex 실행 파일을 찾을 수 없습니다: ${reportedPath}`,
      path: reportedPath,
      raw: `file not found: ${reportedPath}`,
      steps,
      remedies: configured
        ? [...pathRemedies("codexExecutablePath"), ...remedies.filter((remedy) => remedy.kind !== "settings")]
        : remedies,
    };
  }

  if (!workspace.cwd) {
    steps.push(skippedStep("version", "버전 확인", "작업공간"));
    steps.push(skippedStep("authentication", "로그인", "작업공간"));
    steps.push(skippedStep("runtime", "app-server 초기화", "작업공간"));
    return {
      id: "harness.codex",
      group: "harness",
      label: "Codex",
      status: workspace.step.status === "failed" ? "error" : "warn",
      detail: workspace.step.status === "failed"
        ? "현재 작업공간을 사용할 수 없어 Codex 실행 검증을 중단했습니다."
        : "현재 작업공간은 WSL에 있어 네이티브 Codex 실행 검증을 건너뛰었습니다. WSL 환경 점검을 실행하세요.",
      path: reportedPath,
      raw: workspace.step.raw,
      steps,
    };
  }

  const versionStartedAt = Date.now();
  const codexEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...(process.env.AGENTPARTY_NATIVE_CODEX_HOME
      ? { CODEX_HOME: process.env.AGENTPARTY_NATIVE_CODEX_HOME }
      : {}),
  };
  const versionProbe = await probeCommand(
    resolved.command,
    [...resolved.argsPrefix, "--version"],
    { shell: resolved.shell, cwd: workspace.cwd, env: codexEnv },
  );
  if (!versionProbe.ok) {
    steps.push(failedCommandStep("version", "버전 확인", "Codex", versionProbe, versionStartedAt, {
      command: displayCommand(resolved.command, [...resolved.argsPrefix, "--version"]),
      cwd: workspace.cwd,
    }));
    steps.push(skippedStep("authentication", "로그인", "버전 확인"));
    steps.push(skippedStep("runtime", "app-server 초기화", "버전 확인"));
    return {
      id: "harness.codex",
      group: "harness",
      label: "Codex",
      status: "error",
      detail: `버전 확인 단계에서 실패했습니다. ${commandFailureReason("Codex", versionProbe)}`,
      path: reportedPath,
      raw: versionProbe.error,
      steps,
      remedies: configured
        ? [...pathRemedies("codexExecutablePath"), ...remedies.filter((remedy) => remedy.kind !== "settings")]
        : remedies,
    };
  }
  const version = firstLine(versionProbe.stdout);
  steps.push(successfulStep("version", "버전 확인", version, versionStartedAt, {
    command: displayCommand(resolved.command, [...resolved.argsPrefix, "--version"]),
    cwd: workspace.cwd,
  }));

  const authStartedAt = Date.now();
  const authProbe = await probeCommand(
    resolved.command,
    [...resolved.argsPrefix, "login", "status"],
    { shell: resolved.shell, cwd: workspace.cwd, env: codexEnv },
  );
  const signedIn = authProbe.ok;
  steps.push(signedIn
    ? successfulStep("authentication", "로그인", "Codex 계정 로그인이 유효합니다.", authStartedAt, {
        command: displayCommand(resolved.command, [...resolved.argsPrefix, "login", "status"]),
        cwd: workspace.cwd,
      })
    : {
        ...failedCommandStep("authentication", "로그인", "Codex 로그인 확인", authProbe, authStartedAt, {
          command: displayCommand(resolved.command, [...resolved.argsPrefix, "login", "status"]),
          cwd: workspace.cwd,
        }),
        failureKind: "authentication",
      });

  const sqliteHome = agentPartyCodexSqliteHome(getUserDataDir(), `environment:${workspaceKey(workspacePath)}`);
  const storageStartedAt = Date.now();
  try {
    fs.mkdirSync(sqliteHome, { recursive: true });
    codexEnv.CODEX_SQLITE_HOME = sqliteHome;
    steps.push(successfulStep("state", "상태 저장소", `멤버와 분리된 진단용 SQLite 경로를 준비했습니다: ${sqliteHome}`, storageStartedAt, {
      path: sqliteHome,
    }));
  } catch (error) {
    const fsError = error as NodeJS.ErrnoException;
    steps.push({
      id: "state",
      label: "상태 저장소",
      status: "failed",
      detail: `Codex 상태 저장소를 만들 수 없습니다: ${sqliteHome}`,
      durationMs: Date.now() - storageStartedAt,
      path: sqliteHome,
      failureKind: "workspace",
      failureCode: fsError.code || "UNKNOWN",
      raw: fsError.message,
    });
    steps.push(skippedStep("runtime", "app-server 초기화", "상태 저장소"));
    return {
      id: "harness.codex",
      group: "harness",
      label: "Codex",
      status: "error",
      detail: "상태 저장소 준비 단계에서 실패해 Codex app-server를 실행하지 않았습니다.",
      version,
      path: reportedPath,
      raw: fsError.message,
      steps,
    };
  }

  const runtimeStartedAt = Date.now();
  const runtimeArgs = [...resolved.argsPrefix, ...codexExtraArgs(), "-c", 'cli_auth_credentials_store="file"', "app-server"];
  const runtimeProbe = await probeCodexAppServer(
    resolved,
    [...codexExtraArgs(), "-c", 'cli_auth_credentials_store="file"'],
    workspace.cwd,
    codexEnv,
    60_000,
  );
  steps.push(runtimeProbe.ok
    ? successfulStep("runtime", "app-server 초기화", runtimeProbe.detail, runtimeStartedAt, {
        command: displayCommand(resolved.command, runtimeArgs),
        cwd: workspace.cwd,
      })
    : {
        id: "runtime",
        label: "app-server 초기화",
        status: "failed",
        detail: codexRuntimeFailureReason(runtimeProbe),
        durationMs: Date.now() - runtimeStartedAt,
        raw: runtimeProbe.error,
        command: displayCommand(resolved.command, runtimeArgs),
        cwd: workspace.cwd,
        failureKind: runtimeProbe.failureKind,
        failureCode: runtimeProbe.failureCode,
      });

  const loginRemedies: EnvironmentRemedy[] = [
    { kind: "command", label: "로그인 명령 복사", command: "codex login" },
    {
      kind: "repair",
      label: "로그인",
      repairId: "harness.codex.login",
      command: "codex login",
      confirm: "Codex 로그인을 실행합니다. 브라우저가 열릴 수 있습니다.",
    },
  ];
  return {
    id: "harness.codex",
    group: "harness",
    label: "Codex",
    status: !runtimeProbe.ok ? "error" : signedIn ? "ok" : "missing",
    detail: !runtimeProbe.ok
      ? `app-server 초기화 단계에서 실패했습니다. ${codexRuntimeFailureReason(runtimeProbe)}`
      : signedIn
        ? "현재 작업공간에서 Codex app-server 실행과 로그인을 확인했습니다."
        : "Codex app-server는 실행됐지만 로그인 확인 단계에서 실패했습니다.",
    version,
    path: reportedPath,
    raw: !runtimeProbe.ok ? runtimeProbe.error : signedIn ? undefined : authProbe.error,
    steps,
    ...(!runtimeProbe.ok ? { remedies } : signedIn ? {} : { remedies: loginRemedies }),
  };
}

const CURSOR_INSTALL_COMMAND = process.platform === "win32"
  ? "irm 'https://cursor.com/install?win32=true' | iex"
  : "curl https://cursor.com/install -fsS | bash";

async function cursorCheck(workspacePath: string): Promise<EnvironmentCheck> {
  const settings = getSettings();
  const installRemedies: EnvironmentRemedy[] = [
    { kind: "command", label: "설치 명령 복사", command: CURSOR_INSTALL_COMMAND },
    {
      kind: "repair",
      label: "설치하기",
      repairId: "harness.cursor.install",
      command: CURSOR_INSTALL_COMMAND,
      confirm: `이 PC에 Cursor Agent CLI를 설치합니다.\n\n${CURSOR_INSTALL_COMMAND}`,
    },
    { kind: "docs", label: "설치 안내", url: "https://cursor.com/cli" },
    { kind: "settings", label: "실행 파일 경로 지정", settingsField: "cursorExecutablePath" },
  ];

  let resolved: ReturnType<typeof resolveCursorAgentCommand>;
  try {
    resolved = resolveCursorAgentCommand(settings.cursorExecutablePath);
  } catch (error) {
    // A path the user typed and a CLI that was never installed are different
    // problems with different fixes. Leading with "설치하기" for a typo'd path
    // sends them to reinstall something they already have.
    const configured = String(settings.cursorExecutablePath || "").trim();
    return {
      id: "harness.cursor",
      group: "harness",
      label: "Cursor",
      status: "missing",
      detail: configured
        ? `설정된 경로에서 실행 파일을 찾지 못했습니다: ${configured}. 경로를 고치거나 비워서 자동 탐색으로 되돌리세요.`
        : "Cursor Agent CLI를 찾지 못했습니다. Cursor 하네스 멤버를 실행할 수 없습니다.",
      raw: isEnvironmentBlockedError(error) ? error.raw : (error instanceof Error ? error.message : String(error)),
      steps: [{
        id: "executable",
        label: "실행 파일",
        status: "failed",
        detail: configured ? `설정한 경로에 파일이 없습니다: ${configured}` : "Cursor Agent CLI를 찾지 못했습니다.",
        command: configured || "cursor-agent",
        failureKind: "not-found",
        raw: isEnvironmentBlockedError(error) ? error.raw : (error instanceof Error ? error.message : String(error)),
      }],
      // A wrong path is fixed by fixing the path, so the install buttons stand
      // down to a secondary role and the duplicate settings entry is dropped.
      remedies: configured
        ? [...pathRemedies("cursorExecutablePath"), ...installRemedies.filter((remedy) => remedy.kind !== "settings")]
        : installRemedies,
    };
  }

  const cwd = windowsExecutionHost(workspacePath).workspace || process.cwd();
  const versionStartedAt = Date.now();
  const versionProbe = await probeCommand(resolved.command, [...resolved.argsPrefix, "--version"], { cwd });
  const steps: EnvironmentProbeStep[] = [{
    id: "executable", label: "실행 파일", status: "ok", detail: resolved.source,
    command: displayCommand(resolved.command, resolved.argsPrefix), cwd,
  }];
  steps.push(versionProbe.ok
    ? successfulStep("version", "버전 확인", firstLine(versionProbe.stdout), versionStartedAt, {
        command: displayCommand(resolved.command, [...resolved.argsPrefix, "--version"]), cwd,
      })
    : failedCommandStep("version", "버전 확인", "Cursor", versionProbe, versionStartedAt, {
        command: displayCommand(resolved.command, [...resolved.argsPrefix, "--version"]), cwd,
      }));
  const authProbe = await probeCommand(resolved.command, [...resolved.argsPrefix, "status", "--format", "json"], { cwd });
  let auth: { authenticated?: boolean; email?: string; error?: string };
  try {
    const parsed = JSON.parse(authProbe.stdout) as { isAuthenticated?: unknown; userInfo?: { email?: unknown } };
    auth = {
      authenticated: Boolean(parsed.isAuthenticated),
      email: typeof parsed.userInfo?.email === "string" ? parsed.userInfo.email : undefined,
      error: authProbe.ok ? undefined : authProbe.error,
    };
  } catch {
    auth = { error: authProbe.error || authProbe.stderr.trim() || "Cursor status output was not valid JSON" };
  }
  steps.push({
    id: "authentication",
    label: "로그인",
    status: auth.authenticated ? "ok" : "failed",
    detail: auth.authenticated ? "Cursor 계정 로그인이 유효합니다." : auth.authenticated === false ? "Cursor 로그인이 필요합니다." : "Cursor 로그인 상태를 확인하지 못했습니다.",
    command: displayCommand(resolved.command, [...resolved.argsPrefix, "status", "--format", "json"]),
    cwd,
    ...(auth.authenticated ? {} : {
      failureKind: authProbe.ok ? "authentication" : commandProbeFailureKind(authProbe),
      failureCode: probeFailureCode(authProbe),
      raw: auth.error,
    }),
  });
  if (auth.authenticated === false) {
    return {
      id: "harness.cursor",
      group: "harness",
      label: "Cursor",
      status: versionProbe.ok ? "missing" : "error",
      detail: versionProbe.ok ? "설치되어 있지만 로그인되어 있지 않습니다." : "Cursor 실행 파일은 찾았지만 버전 확인에 실패했습니다.",
      version: versionProbe.ok ? firstLine(versionProbe.stdout) : undefined,
      path: resolved.source,
      steps,
      remedies: [
        { kind: "command", label: "로그인 명령 복사", command: "cursor-agent login" },
        {
          kind: "repair",
          label: "로그인",
          repairId: "harness.cursor.login",
          command: "cursor-agent login",
          confirm: "Cursor 로그인을 실행합니다. 브라우저가 열릴 수 있습니다.",
        },
      ],
    };
  }
  return {
    id: "harness.cursor",
    group: "harness",
    label: "Cursor",
    status: !versionProbe.ok ? "error" : auth.authenticated ? "ok" : "warn",
    detail: !versionProbe.ok
      ? "Cursor 실행 파일은 찾았지만 버전 확인에 실패했습니다."
      : auth.authenticated
        ? `설치되어 있고 로그인되어 있습니다${auth.email ? ` (${auth.email})` : ""}.`
        : "설치되어 있지만 로그인 상태를 확인하지 못했습니다.",
    version: versionProbe.ok ? firstLine(versionProbe.stdout) : undefined,
    path: resolved.source,
    raw: auth.error,
    steps,
  };
}

const GROK_INSTALL_COMMAND = process.platform === "win32"
  ? "irm https://x.ai/cli/install.ps1 | iex"
  : "curl -fsSL https://x.ai/cli/install.sh | bash";

async function grokCheck(workspacePath: string): Promise<EnvironmentCheck> {
  const settings = getSettings();
  const configured = String(settings.grokExecutablePath || "").trim();
  const installed = grokCliInstalledPath(settings.grokExecutablePath);
  if (!installed) {
    return {
      id: "harness.grok",
      group: "harness",
      label: "Grok Build",
      status: "missing",
      detail: configured
        ? `설정된 경로에서 Grok Build CLI를 찾지 못했습니다: ${configured}. 경로를 고치거나 비워서 자동 탐색으로 되돌리세요.`
        : "Grok Build CLI가 설치되어 있지 않습니다. Grok 하네스 멤버를 실행할 수 없습니다.",
      steps: [{
        id: "executable",
        label: "실행 파일",
        status: "failed",
        detail: configured ? `설정한 경로에 파일이 없습니다: ${configured}` : "Grok Build CLI를 찾지 못했습니다.",
        command: configured || "grok",
        failureKind: "not-found",
      }],
      remedies: [
        ...(configured ? pathRemedies("grokExecutablePath") : []),
        { kind: "command", label: "설치 명령 복사", command: GROK_INSTALL_COMMAND },
        {
          kind: "repair",
          label: "설치하기",
          repairId: "harness.grok.install",
          command: GROK_INSTALL_COMMAND,
          confirm: `이 PC에 Grok Build CLI를 설치합니다.\n\n${GROK_INSTALL_COMMAND}`,
        },
        { kind: "docs", label: "설치 안내", url: "https://x.ai/cli" },
        ...(!configured ? [{ kind: "settings" as const, label: "실행 파일 경로 지정", settingsField: "grokExecutablePath" }] : []),
      ],
    };
  }

  const cwd = windowsExecutionHost(workspacePath).workspace || process.cwd();
  const versionStartedAt = Date.now();
  const probe = await probeCommand(installed, ["--version"], { cwd });
  const text = firstLine(probe.stdout);
  // The official build prints a commit hash; the community `grok-dev` package
  // installs a different agent under the same name and does not.
  const official = /^grok\s+\S+\s+\([0-9a-f]{6,}\)/i.test(text);
  const login = grokSubscriptionAvailable();
  const steps: EnvironmentProbeStep[] = [{
    id: "executable", label: "실행 파일", status: "ok", detail: installed,
    command: installed, cwd,
  }];
  steps.push(probe.ok
    ? successfulStep("version", "버전 확인", text, versionStartedAt, { command: displayCommand(installed, ["--version"]), cwd })
    : failedCommandStep("version", "버전 확인", "Grok Build", probe, versionStartedAt, { command: displayCommand(installed, ["--version"]), cwd }));
  if (probe.ok && !official) {
    steps.push({
      id: "identity", label: "공식 CLI 확인", status: "failed",
      detail: "공식 Grok Build가 출력하는 commit hash가 없습니다.",
      command: displayCommand(installed, ["--version"]), cwd,
      failureKind: "protocol", raw: text,
    });
    return {
      id: "harness.grok",
      group: "harness",
      label: "Grok Build",
      status: "error",
      detail: "같은 이름의 다른 CLI(커뮤니티 grok-dev)가 설치되어 있습니다. 공식 Grok Build CLI가 필요합니다.",
      version: text,
      path: installed,
      steps,
      remedies: [
        { kind: "command", label: "공식 CLI 설치 명령 복사", command: GROK_INSTALL_COMMAND },
        { kind: "docs", label: "설치 안내", url: "https://x.ai/cli" },
      ],
    };
  }
  const authFile = path.join(grokHomeDir(), "auth.json");
  steps.push({
    id: "authentication", label: "로그인", status: login.ok ? "ok" : "failed",
    detail: login.ok ? `Grok 인증 파일을 확인했습니다: ${authFile}` : "Grok 인증 파일이 없거나 자격증명이 유효하지 않습니다.",
    path: authFile,
    ...(login.ok ? {} : { failureKind: "not-found" as const, raw: login.raw || login.reason }),
  });
  return {
    id: "harness.grok",
    group: "harness",
    label: "Grok Build",
    status: !probe.ok ? "error" : login.ok ? "ok" : "missing",
    detail: !probe.ok
      ? "Grok Build 실행 파일은 찾았지만 버전 확인에 실패했습니다."
      : login.ok
        ? `설치되어 있고 로그인되어 있습니다${login.email ? ` (${login.email})` : ""}.`
        : "설치되어 있지만 로그인되어 있지 않습니다.",
    version: text || undefined,
    path: installed,
    raw: login.ok ? undefined : (login.raw || login.reason),
    steps,
    ...(login.ok ? {} : {
      remedies: [
        { kind: "command", label: "로그인 명령 복사", command: "grok login" },
        {
          kind: "repair",
          label: "로그인",
          repairId: "harness.grok.login",
          command: "grok login",
          confirm: "Grok 로그인을 실행합니다. 브라우저가 열릴 수 있습니다.",
        },
      ],
    }),
  };
}

// ---------------------------------------------------------------- repair

export interface EnvironmentRepairResult {
  ok: boolean;
  detail: string;
  /** Tail of the command output — shown under "자세히", never hidden on failure. */
  output?: string;
  /** The report after the repair, so the caller re-renders from one source. */
  report: EnvironmentReport;
}

/** Installs and logins are slow, and a browser login waits on a human. */
const REPAIR_TIMEOUT_MS = 10 * 60_000;

/**
 * Runs one of the fixes the report itself offered.
 *
 * The caller sends only a `repairId`; the COMMAND is looked up in a freshly
 * built report. That is the whole security model — this endpoint can never run
 * a string that came from outside, only one this app authored.
 */
export async function runEnvironmentRepair(repairId: string, workspacePath?: string): Promise<EnvironmentRepairResult> {
  const wslDistro = repairId.startsWith("wsl.sdk.reinstall:") ? repairId.slice("wsl.sdk.reinstall:".length) : undefined;
  const before = await probeEnvironment({ refresh: true, includeWsl: Boolean(wslDistro), workspacePath });
  const remedy = before.checks
    .flatMap((check) => check.remedies || [])
    .find((candidate) => candidate.kind === "repair" && candidate.repairId === repairId);
  if (!remedy) {
    throw new Error(`알 수 없는 복구 동작입니다: ${repairId}. 환경을 다시 점검한 뒤 시도하세요.`);
  }

  log("info", "environment", "running repair", { repairId });
  const result = wslDistro
    ? await reinstallWslSdk(wslDistro)
    : await runHostCommand(String(remedy.command || ""));

  invalidateEnvironmentCache();
  invalidateCursorAuthCache();
  const report = await probeEnvironment({ refresh: true, includeWsl: Boolean(wslDistro), workspacePath });
  if (!result.ok) {
    log("warn", "environment", "repair failed", { repairId, error: result.error });
  }
  const repairedCheckId = wslDistro
    ? `wsl.${wslDistro}.sdk`
    : repairId.replace(/\.(install|login)$/, "");
  const repairedCheck = report.checks.find((check) => check.id === repairedCheckId);
  const verified = Boolean(repairedCheck && (
    repairedCheck.status === "ok"
    || repairedCheck.status === "warn"
    // Reinstalling the WSL SDK intentionally removes it; the next workspace
    // connection performs the fresh install. `unknown` is expected here.
    || (Boolean(wslDistro) && repairedCheck.status === "unknown")
  ));
  const ok = result.ok && verified;
  if (result.ok && !verified) {
    log("warn", "environment", "repair command completed but verification failed", {
      repairId,
      checkId: repairedCheckId,
      status: repairedCheck?.status,
      detail: repairedCheck?.detail,
    });
  }
  return {
    ok,
    detail: !result.ok
      ? "실패했습니다. 아래 출력을 확인하거나 명령을 직접 실행해 보세요."
      : verified
        ? `${repairedCheck?.label || "환경"} 준비를 확인했습니다.`
        : `명령은 완료됐지만 ${repairedCheck?.label || "환경"}을 아직 사용할 수 없습니다. ${repairedCheck?.detail || "다시 점검해 주세요."}`,
    output: tail(result.ok
      ? [result.stdout, verified ? "" : repairedCheck?.raw].filter(Boolean).join("\n")
      : (result.error || result.stderr)),
    report,
  };
}

/**
 * Host installs are published as shell one-liners (`irm … | iex`), so they must
 * run through a shell rather than as argv.
 */
function runHostCommand(command: string) {
  if (!command) {
    throw new Error("이 복구 동작에는 실행할 명령이 없습니다.");
  }
  return process.platform === "win32"
    ? probeCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { timeoutMs: REPAIR_TIMEOUT_MS })
    : probeCommand("bash", ["-lc", command], { timeoutMs: REPAIR_TIMEOUT_MS });
}

/**
 * Removes the app's own SDK copy inside the distro and lets the next connect
 * reinstall it. Scoped to `~/.agent_party_app`, which the app owns — nothing
 * the user put there is touched, which is why this repair needs no confirmation.
 */
function reinstallWslSdk(distro: string) {
  const serverDir = "$HOME/.agent_party_app/server";
  return probeCommand(
    "wsl.exe",
    ["-d", distro, "-e", "bash", "-lc", `cd "${serverDir}" 2>/dev/null || exit 3; rm -rf node_modules package-lock.json && npm install ${claudeAgentSdkSpec()} 2>&1 | tail -5`],
    { timeoutMs: REPAIR_TIMEOUT_MS },
  );
}

function tail(text: string | undefined, lines = 12): string | undefined {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.split(/\r?\n/).slice(-lines).join("\n");
}

// -------------------------------------------------------------------- WSL

/**
 * Docker Desktop's utility distros are not workspaces and booting them is pure
 * side effect, so they are never probed.
 */
function isProbableWorkspaceDistro(name: string): boolean {
  return !/^docker-desktop/i.test(name);
}

interface WslTarget {
  distro: string;
  workspace: string;
  host: EnvironmentExecutionHost;
}

interface WslSdkResult {
  check: EnvironmentCheck;
  binary?: string;
}

export async function listWslDistros(): Promise<{ names: string[]; error?: string; probe?: CommandProbeResult }> {
  const probe = await probeCommand("wsl.exe", ["-l", "-q"], { timeoutMs: 30_000 });
  if (!probe.ok) {
    return { names: [], error: probe.error, probe };
  }
  const names = probe.stdout
    .split(/\r?\n/)
    .map((line) => line.replace(/\0/g, "").trim())
    .filter(Boolean);
  return { names, probe };
}

async function wslChecks(sdkVersion: string | undefined, workspacePath: string): Promise<EnvironmentCheck[]> {
  if (process.platform !== "win32") {
    return [];
  }
  const listed = await listWslDistros();
  if (listed.error) {
    const kind = listed.probe?.failureKind === "spawn" && listed.probe.failureCode === "ENOENT" ? "not-found" : commandProbeFailureKind(listed.probe!);
    return [{
      id: "wsl.available",
      group: "wsl",
      label: "WSL",
      status: kind === "not-found" ? "missing" : "error",
      detail: kind === "not-found"
        ? "Windows에서 wsl.exe를 찾지 못했습니다."
        : `Windows에서 WSL 배포판 목록을 읽지 못했습니다 (${failureLabel(kind)}).`,
      host: { kind: "windows", label: "Windows" },
      raw: listed.error,
      steps: [{
        id: "distribution-list",
        label: "배포판 목록",
        status: "failed",
        detail: kind === "timeout" ? "wsl.exe가 제한 시간 안에 응답하지 않았습니다." : "wsl.exe 배포판 조회가 실패했습니다.",
        command: "wsl.exe -l -q",
        cwd: process.cwd(),
        failureKind: kind,
        failureCode: probeFailureCode(listed.probe!),
        raw: listed.error,
      }],
      remedies: kind === "not-found" ? [
        { kind: "command", label: "설치 명령 복사", command: "wsl --install" },
        { kind: "docs", label: "WSL 설치 안내", url: "https://learn.microsoft.com/windows/wsl/install" },
      ] : undefined,
    }];
  }

  const location = parseWorkspaceLocation(workspacePath);
  const available = listed.names.filter(isProbableWorkspaceDistro);
  const selected = location.host.kind === "wsl"
    ? [location.host.distro]
    : available;
  const targets = selected.map((distro): WslTarget => {
    const workspace = location.host.kind === "wsl" && location.host.distro === distro ? location.path : "$HOME";
    return {
      distro,
      workspace,
      host: { kind: "wsl", distro, label: `WSL · ${distro}`, workspace },
    };
  });
  const checks: EnvironmentCheck[] = [{
    id: "wsl.available",
    group: "wsl",
    label: "WSL",
    status: targets.length ? "ok" : "warn",
    detail: targets.length
      ? location.host.kind === "wsl"
        ? `현재 작업공간의 배포판 ${location.host.distro}를 검사합니다.`
        : `배포판 ${targets.length}개를 각각 검사합니다: ${targets.map((target) => target.distro).join(", ")}`
      : "사용 가능한 배포판이 없습니다.",
    host: { kind: "windows", label: "Windows" },
    steps: [{
      id: "distribution-list",
      label: "배포판 목록",
      status: "ok",
      detail: available.length ? available.join(", ") : "워크스페이스용 배포판 없음",
      command: "wsl.exe -l -q",
      cwd: process.cwd(),
    }],
  }];
  for (const target of targets) {
    checks.push(...await wslDistroChecks(target, sdkVersion));
  }
  return checks;
}

async function wslDistroChecks(target: WslTarget, sdkVersion: string | undefined): Promise<EnvironmentCheck[]> {
  const workspaceCheck = await wslWorkspaceCheck(target);
  if (workspaceCheck.status !== "ok") {
    return [workspaceCheck];
  }

  const nodeCheck = await wslNodeCheck(target);
  if (nodeCheck.status !== "ok") {
    return [workspaceCheck, nodeCheck];
  }

  const sdk = await wslSdkCheck(target, sdkVersion);
  const checks = [workspaceCheck, nodeCheck, sdk.check];
  if (sdk.binary) {
    checks.push(await wslClaudeCheck(target, sdk.binary));
  }
  checks.push(await wslCodexCheck(target));
  return checks;
}

async function wslWorkspaceCheck(target: WslTarget): Promise<EnvironmentCheck> {
  const script = target.workspace === "$HOME"
    ? "cd \"$HOME\" && pwd -P"
    : `test -d ${bashQuote(target.workspace)} || { echo AGENTPARTY_WORKSPACE_NOT_FOUND >&2; exit 44; }; cd ${bashQuote(target.workspace)} && pwd -P`;
  const startedAt = Date.now();
  const probe = await wslShellProbe(target, script, false);
  const command = wslDisplayCommand(target, script, false);
  if (probe.ok) {
    const resolved = firstLine(probe.stdout) || target.workspace;
    target.workspace = resolved;
    target.host = { kind: "wsl", distro: target.distro, label: `WSL · ${target.distro}`, workspace: resolved };
    return {
      id: `wsl.${target.distro}.workspace`,
      group: "wsl",
      label: `${target.distro} · 작업공간`,
      status: "ok",
      detail: `배포판 안에서 실제 작업 폴더에 접근했습니다: ${resolved}`,
      path: resolved,
      host: target.host,
      steps: [successfulStep("workspace", "작업공간 접근", `cwd를 사용할 수 있습니다: ${resolved}`, startedAt, { command, cwd: resolved })],
    };
  }
  const failureKind = classifyWslProbeFailure(probe, "AGENTPARTY_WORKSPACE_NOT_FOUND", "workspace");
  const notFound = failureKind === "workspace";
  return {
    id: `wsl.${target.distro}.workspace`,
    group: "wsl",
    label: `${target.distro} · 작업공간`,
    status: "error",
    detail: notFound
      ? `배포판 안에 작업공간 폴더가 없습니다: ${target.workspace}`
      : wslFailureDetail(target, "작업공간 접근", probe),
    path: target.workspace,
    host: target.host,
    raw: probe.error,
    steps: [{
      id: "workspace",
      label: "작업공간 접근",
      status: "failed",
      detail: notFound ? "지정한 POSIX 경로가 배포판 안에 없습니다." : wslFailureDetail(target, "작업공간 접근", probe),
      durationMs: Date.now() - startedAt,
      command,
      cwd: target.workspace,
      failureKind,
      failureCode: probeFailureCode(probe),
      raw: probe.error,
    }],
  };
}

async function wslNodeCheck(target: WslTarget): Promise<EnvironmentCheck> {
  const script = `command -v node >/dev/null 2>&1 || { echo AGENTPARTY_NODE_NOT_FOUND >&2; exit 44; }; node -v`;
  const startedAt = Date.now();
  const probe = await wslShellProbe(target, script);
  const command = wslDisplayCommand(target, script);
  if (probe.ok) {
    return {
      id: `wsl.${target.distro}.node`,
      group: "wsl",
      label: `${target.distro} · Node.js`,
      status: "ok",
      detail: `WSL 엔진이 실행되는 ${target.workspace}에서 Node.js를 확인했습니다.`,
      version: firstLine(probe.stdout),
      host: target.host,
      steps: [successfulStep("runtime", "Node.js 실행", firstLine(probe.stdout), startedAt, { command, cwd: target.workspace })],
    };
  }
  const failureKind = classifyWslProbeFailure(probe, "AGENTPARTY_NODE_NOT_FOUND");
  const missing = failureKind === "not-found";
  return {
    id: `wsl.${target.distro}.node`,
    group: "wsl",
    label: `${target.distro} · Node.js`,
    status: missing ? "missing" : "error",
    detail: missing
      ? `배포판의 PATH에서 Node.js를 찾지 못했습니다. 작업공간: ${target.workspace}`
      : wslFailureDetail(target, "Node.js 실행", probe),
    host: target.host,
    raw: probe.error,
    steps: [{
      id: "runtime",
      label: "Node.js 실행",
      status: "failed",
      detail: missing ? "command -v node가 실행 파일을 찾지 못했습니다." : wslFailureDetail(target, "Node.js 실행", probe),
      durationMs: Date.now() - startedAt,
      command,
      cwd: target.workspace,
      failureKind,
      failureCode: probeFailureCode(probe),
      raw: probe.error,
    }],
    remedies: missing ? [
      { kind: "command", label: "설치 명령 복사", command: `wsl -d ${target.distro} -e bash -lc "sudo apt update && sudo apt install -y nodejs npm"` },
      { kind: "docs", label: "WSL에 Node 설치", url: "https://learn.microsoft.com/windows/dev-environment/javascript/nodejs-on-wsl" },
    ] : undefined,
  };
}

async function wslSdkCheck(target: WslTarget, sdkVersion: string | undefined): Promise<WslSdkResult> {
  const reinstall: EnvironmentRemedy = { kind: "repair", label: "SDK 다시 설치", repairId: `wsl.sdk.reinstall:${target.distro}` };
  const script = [
    'server="$HOME/.agent_party_app/server"',
    'pkg="$server/node_modules/@anthropic-ai/claude-agent-sdk/package.json"',
    '[ -f "$pkg" ] || { echo AGENTPARTY_SDK_NOT_FOUND >&2; exit 44; }',
    'version="$(node -e \'const p=require(process.argv[1]);process.stdout.write(String(p.version||""))\' "$pkg")"',
    'binary="$(find "$server/node_modules/@anthropic-ai" -maxdepth 5 -type f -name claude -path "*claude-agent-sdk-linux-*/*" -print -quit)"',
    '[ -n "$binary" ] || { echo AGENTPARTY_SDK_BINARY_NOT_FOUND >&2; exit 45; }',
    'printf "%s\\t%s\\n" "$version" "$binary"',
  ].join("; ");
  const startedAt = Date.now();
  const probe = await wslShellProbe(target, script);
  const command = wslDisplayCommand(target, script);
  if (!probe.ok) {
    const output = combinedProbeOutput(probe);
    const missingPackage = output.includes("AGENTPARTY_SDK_NOT_FOUND");
    const missingBinary = output.includes("AGENTPARTY_SDK_BINARY_NOT_FOUND");
    const failureKind = classifyWslProbeFailure(probe, missingPackage ? "AGENTPARTY_SDK_NOT_FOUND" : missingBinary ? "AGENTPARTY_SDK_BINARY_NOT_FOUND" : undefined);
    return { check: {
      id: `wsl.${target.distro}.sdk`,
      group: "wsl",
      label: `${target.distro} · Claude Agent SDK`,
      status: missingPackage ? "unknown" : missingBinary ? "error" : "error",
      detail: missingPackage
        ? "AgentParty의 WSL 엔진 SDK가 아직 설치되지 않았습니다. 이 배포판의 작업공간을 처음 열 때 설치됩니다."
        : missingBinary
          ? "SDK 패키지는 있지만 실제로 실행할 Linux Claude 바이너리가 없습니다."
          : wslFailureDetail(target, "SDK와 Claude 바이너리 확인", probe),
      host: target.host,
      raw: probe.error,
      steps: [{
        id: "sdk",
        label: "SDK와 실행 파일",
        status: "failed",
        detail: missingPackage ? "SDK package.json을 찾지 못했습니다." : missingBinary ? "SDK Linux 실행 파일을 찾지 못했습니다." : wslFailureDetail(target, "SDK 확인", probe),
        durationMs: Date.now() - startedAt,
        command,
        cwd: target.workspace,
        failureKind,
        failureCode: probeFailureCode(probe),
        raw: probe.error,
      }],
      remedies: [reinstall],
    } };
  }
  const [installed, binary] = firstLine(probe.stdout).split("\t");
  const skewed = Boolean(installed && sdkVersion && installed !== sdkVersion);
  return {
    binary,
    check: {
      id: `wsl.${target.distro}.sdk`,
      group: "wsl",
      label: `${target.distro} · Claude Agent SDK`,
      status: skewed ? "warn" : "ok",
      detail: skewed
        ? `배포판 SDK ${installed}과 앱 SDK ${sdkVersion}의 버전이 다릅니다.`
        : "앱과 같은 SDK 버전과 실제 Linux Claude 바이너리를 확인했습니다.",
      version: installed,
      path: binary,
      host: target.host,
      steps: [successfulStep("sdk", "SDK와 실행 파일", binary, startedAt, { command, cwd: target.workspace })],
      ...(skewed ? { remedies: [reinstall] } : {}),
    },
  };
}

async function wslClaudeCheck(target: WslTarget, binary: string): Promise<EnvironmentCheck> {
  const resolveScript = `command -v claude 2>/dev/null || { candidate=${bashQuote(binary)}; [ -x "$candidate" ] && printf "%s\\n" "$candidate" || { echo AGENTPARTY_CLAUDE_NOT_FOUND >&2; exit 44; }; }`;
  const resolveStartedAt = Date.now();
  const resolved = await wslShellProbe(target, resolveScript);
  const steps: EnvironmentProbeStep[] = [{ id: "workspace", label: "작업공간", status: "ok", detail: target.workspace, cwd: target.workspace }];
  if (!resolved.ok) {
    const missing = classifyWslProbeFailure(resolved, "AGENTPARTY_CLAUDE_NOT_FOUND") === "not-found";
    steps.push(wslFailedStep(target, "executable", "실행 파일", resolveScript, resolved, resolveStartedAt, missing ? "WSL의 PATH와 AgentParty SDK에서 Claude Code 실행 파일을 찾지 못했습니다." : undefined, missing ? "not-found" : undefined));
    return {
      id: `wsl.${target.distro}.claude-code`, group: "wsl", label: `${target.distro} · Claude Code`, status: missing ? "missing" : "error",
      detail: missing ? "이 WSL 배포판에 Claude Code가 없습니다." : wslFailureDetail(target, "Claude Code 실행 파일 탐색", resolved),
      host: target.host, raw: resolved.error, steps,
      remedies: missing ? [{ kind: "command", label: "WSL 설치 명령 복사", command: `wsl -d ${target.distro} -e bash -lc "npm install -g @anthropic-ai/claude-code"` }] : undefined,
    };
  }
  binary = firstLine(resolved.stdout);
  steps.push(successfulStep("executable", "실행 파일", binary, resolveStartedAt, { command: wslDisplayCommand(target, resolveScript), cwd: target.workspace }));
  const versionScript = `${bashQuote(binary)} --version`;
  const versionStartedAt = Date.now();
  const versionProbe = await wslShellProbe(target, versionScript);
  if (!versionProbe.ok) {
    steps.push(wslFailedStep(target, "version", "버전 확인", versionScript, versionProbe, versionStartedAt));
    return wslHarnessFailure(target, "claude-code", "Claude Code", "버전 확인", binary, steps, versionProbe);
  }
  const version = firstLine(versionProbe.stdout);
  steps.push(successfulStep("version", "버전 확인", version, versionStartedAt, { command: wslDisplayCommand(target, versionScript), cwd: target.workspace }));

  const authScript = `${bashQuote(binary)} auth status`;
  const authStartedAt = Date.now();
  const authProbe = await wslShellProbe(target, authScript);
  const processStarted = authProbe.failureKind !== "spawn" && authProbe.failureKind !== "timeout";
  if (!processStarted) {
    steps.push(wslFailedStep(target, "runtime", "프로세스 실행", authScript, authProbe, authStartedAt));
    return wslHarnessFailure(target, "claude-code", "Claude Code", "프로세스 실행", binary, steps, authProbe);
  }
  steps.push(successfulStep("runtime", "프로세스 실행", "SDK Linux Claude 바이너리를 작업공간에서 실행했습니다.", authStartedAt, {
    command: wslDisplayCommand(target, authScript), cwd: target.workspace,
  }));
  const signedIn = authProbe.ok && claudeLoggedIn(authProbe.stdout);
  if (!signedIn) {
    steps.push(wslFailedStep(target, "authentication", "로그인", authScript, authProbe, authStartedAt, "WSL 안의 Claude 로그인이 유효하지 않습니다.", "authentication"));
  } else {
    steps.push(successfulStep("authentication", "로그인", "WSL 안의 Claude 로그인이 유효합니다.", authStartedAt, {
      command: wslDisplayCommand(target, authScript), cwd: target.workspace,
    }));
  }
  return {
    id: `wsl.${target.distro}.claude-code`,
    group: "wsl",
    label: `${target.distro} · Claude Code`,
    status: signedIn ? "ok" : "missing",
    detail: signedIn ? "실제 WSL 작업공간에서 SDK Claude 실행과 로그인을 확인했습니다." : "Claude 프로세스는 실행됐지만 WSL 로그인이 필요합니다.",
    version,
    path: binary,
    host: target.host,
    raw: signedIn ? undefined : (authProbe.error || authProbe.stderr.trim() || authProbe.stdout.trim()),
    steps,
    remedies: signedIn ? undefined : [{ kind: "command", label: "WSL 로그인 명령 복사", command: `wsl -d ${target.distro} -e ${binary}` }],
  };
}

async function wslCodexCheck(target: WslTarget): Promise<EnvironmentCheck> {
  const resolveScript = process.env.AGENTPARTY_CODEX_BIN
    ? `candidate=${bashQuote(process.env.AGENTPARTY_CODEX_BIN)}; [ -x "$candidate" ] || { echo AGENTPARTY_CODEX_NOT_FOUND >&2; exit 44; }; printf "%s\\n" "$candidate"`
    : 'command -v codex || { echo AGENTPARTY_CODEX_NOT_FOUND >&2; exit 44; }';
  const resolveStartedAt = Date.now();
  const resolved = await wslShellProbe(target, resolveScript);
  const steps: EnvironmentProbeStep[] = [{ id: "workspace", label: "작업공간", status: "ok", detail: target.workspace, cwd: target.workspace }];
  if (!resolved.ok) {
    const missing = classifyWslProbeFailure(resolved, "AGENTPARTY_CODEX_NOT_FOUND") === "not-found";
    steps.push(wslFailedStep(target, "executable", "실행 파일", resolveScript, resolved, resolveStartedAt, missing ? "WSL의 PATH에서 Codex를 찾지 못했습니다." : undefined, missing ? "not-found" : undefined));
    return {
      id: `wsl.${target.distro}.codex`, group: "wsl", label: `${target.distro} · Codex`, status: missing ? "missing" : "error",
      detail: missing ? "WSL 안에 Codex CLI가 없습니다." : wslFailureDetail(target, "Codex 실행 파일 탐색", resolved),
      host: target.host, raw: resolved.error, steps,
      remedies: missing ? [{ kind: "command", label: "WSL 설치 명령 복사", command: `wsl -d ${target.distro} -e bash -lc "npm install -g @openai/codex"` }] : undefined,
    };
  }
  const binary = firstLine(resolved.stdout);
  steps.push(successfulStep("executable", "실행 파일", binary, resolveStartedAt, { command: wslDisplayCommand(target, resolveScript), cwd: target.workspace }));

  const versionScript = `${bashQuote(binary)} --version`;
  const versionStartedAt = Date.now();
  const versionProbe = await wslShellProbe(target, versionScript);
  if (!versionProbe.ok) {
    steps.push(wslFailedStep(target, "version", "버전 확인", versionScript, versionProbe, versionStartedAt));
    return wslHarnessFailure(target, "codex", "Codex", "버전 확인", binary, steps, versionProbe);
  }
  const version = firstLine(versionProbe.stdout);
  steps.push(successfulStep("version", "버전 확인", version, versionStartedAt, { command: wslDisplayCommand(target, versionScript), cwd: target.workspace }));

  const authScript = `${bashQuote(binary)} login status`;
  const authStartedAt = Date.now();
  const authProbe = await wslShellProbe(target, authScript);
  const signedIn = authProbe.ok;
  steps.push(signedIn
    ? successfulStep("authentication", "로그인", "WSL 안의 Codex 로그인이 유효합니다.", authStartedAt, { command: wslDisplayCommand(target, authScript), cwd: target.workspace })
    : wslFailedStep(target, "authentication", "로그인", authScript, authProbe, authStartedAt, "WSL 안의 Codex 로그인이 유효하지 않습니다.", "authentication"));

  const digest = crypto.createHash("sha256").update(`${target.distro}:${target.workspace}`).digest("hex").slice(0, 16);
  const sqliteHome = `$HOME/.agent_party_app/codex-sqlite/environment-${digest}`;
  const extraArgs = codexExtraArgs();
  const runtimeScript = [
    `mkdir -p \"${sqliteHome}\"`,
    `export CODEX_SQLITE_HOME=\"${sqliteHome}\"`,
    process.env.AGENTPARTY_NATIVE_CODEX_HOME ? `export CODEX_HOME=${bashQuote(process.env.AGENTPARTY_NATIVE_CODEX_HOME)}` : "",
    `exec ${bashQuote(binary)} ${[...extraArgs, "-c", 'cli_auth_credentials_store="file"', "app-server"].map(bashQuote).join(" ")}`,
  ].filter(Boolean).join("; ");
  const runtimeStartedAt = Date.now();
  const runtimeProbe = await probeAppServerCommand(
    "wsl.exe",
    ["-d", target.distro, "-e", "bash", "-lc", `cd ${bashQuote(target.workspace)} && ${runtimeScript}`],
    process.cwd(),
    process.env,
    WSL_TIMEOUT_MS,
    false,
    `WSL · ${target.distro}`,
  );
  const runtimeCommand = wslDisplayCommand(target, runtimeScript);
  steps.push(runtimeProbe.ok
    ? successfulStep("runtime", "app-server 초기화", runtimeProbe.detail, runtimeStartedAt, { command: runtimeCommand, cwd: target.workspace })
    : {
        id: "runtime", label: "app-server 초기화", status: "failed", detail: runtimeProbe.detail,
        durationMs: Date.now() - runtimeStartedAt, command: runtimeCommand, cwd: target.workspace,
        failureKind: runtimeProbe.failureKind, failureCode: runtimeProbe.failureCode, raw: runtimeProbe.error,
      });
  return {
    id: `wsl.${target.distro}.codex`,
    group: "wsl",
    label: `${target.distro} · Codex`,
    status: !runtimeProbe.ok ? "error" : signedIn ? "ok" : "missing",
    detail: !runtimeProbe.ok
      ? `실제 WSL 실행 조건에서 app-server 초기화에 실패했습니다 (${failureLabel(runtimeProbe.failureKind || "protocol")}).`
      : signedIn ? "실제 WSL 작업공간에서 Codex app-server 실행과 로그인을 확인했습니다." : "app-server는 정상이나 WSL 로그인이 필요합니다.",
    version,
    path: binary,
    host: target.host,
    raw: runtimeProbe.ok ? (signedIn ? undefined : authProbe.error) : runtimeProbe.error,
    steps,
  };
}

function wslShellProbe(target: WslTarget, script: string, useWorkspace = true): Promise<CommandProbeResult> {
  const shellCommand = useWorkspace ? `${wslCd(target.workspace)} && ${script}` : script;
  return probeCommand("wsl.exe", ["-d", target.distro, "-e", "bash", "-lc", shellCommand], { timeoutMs: WSL_TIMEOUT_MS });
}

function wslDisplayCommand(target: WslTarget, script: string, useWorkspace = true): string {
  const shellCommand = useWorkspace ? `${wslCd(target.workspace)} && ${script}` : script;
  return displayCommand("wsl.exe", ["-d", target.distro, "-e", "bash", "-lc", shellCommand]);
}

function wslCd(workspace: string): string {
  return workspace === "$HOME" ? 'cd "$HOME"' : `cd ${bashQuote(workspace)}`;
}

function wslFailedStep(
  target: WslTarget,
  id: string,
  label: string,
  script: string,
  probe: CommandProbeResult,
  startedAt: number,
  detail = wslFailureDetail(target, label, probe),
  failureKind = commandProbeFailureKind(probe),
): EnvironmentProbeStep {
  return {
    id, label, status: "failed", detail, durationMs: Date.now() - startedAt,
    command: wslDisplayCommand(target, script), cwd: target.workspace,
    failureKind, failureCode: probeFailureCode(probe), raw: probe.error || combinedProbeOutput(probe),
  };
}

function wslHarnessFailure(
  target: WslTarget,
  id: string,
  label: string,
  stage: string,
  path: string,
  steps: EnvironmentProbeStep[],
  probe: CommandProbeResult,
): EnvironmentCheck {
  return {
    id: `wsl.${target.distro}.${id}`, group: "wsl", label: `${target.distro} · ${label}`, status: "error",
    detail: `${stage} 단계에서 실패했습니다. ${wslFailureDetail(target, label, probe)}`,
    path, host: target.host, raw: probe.error, steps,
  };
}

function wslFailureDetail(target: WslTarget, subject: string, probe: CommandProbeResult): string {
  if (probe.failureKind === "timeout") return `${target.distro} WSL이 ${subject} 명령에 ${WSL_TIMEOUT_MS}ms 안에 응답하지 않았습니다.`;
  if (probe.failureKind === "spawn") return `Windows에서 wsl.exe 프로세스를 만들지 못했습니다 (${probe.failureCode || "원인 코드 없음"}).`;
  return `${target.distro} WSL의 ${subject} 명령이 종료 코드 ${probe.code ?? "없음"}로 실패했습니다.`;
}

function probeFailureCode(probe: CommandProbeResult): string | undefined {
  return probe.failureCode || (probe.code === undefined || probe.code === null ? undefined : String(probe.code));
}

function combinedProbeOutput(probe: CommandProbeResult): string {
  return [probe.stdout, probe.stderr, probe.error].filter(Boolean).join("\n");
}

/** Pure classification seam used by the WSL checks and focused regression QA. */
export function classifyWslProbeFailure(
  probe: CommandProbeResult,
  missingMarker?: string,
  markerKind: EnvironmentProbeFailureKind = "not-found",
): EnvironmentProbeFailureKind {
  if (missingMarker && combinedProbeOutput(probe).includes(missingMarker)) return markerKind;
  return commandProbeFailureKind(probe);
}

function failureLabel(kind: string): string {
  if (kind === "not-found") return "실행 파일 없음";
  if (kind === "authentication") return "로그인 오류";
  if (kind === "spawn") return "프로세스 생성 실패";
  if (kind === "timeout") return "응답 시간 초과";
  if (kind === "protocol") return "프로토콜 오류";
  if (kind === "workspace") return "작업공간 오류";
  return "명령 종료 오류";
}

function bashQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// ------------------------------------------------------------------- SDK

/**
 * The native binary the SDK installed next to itself. This is what a dev run
 * actually spawns, and it is invisible from PATH — so the environment screen
 * would otherwise report the host CLI while the app used a different one.
 */
