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
 *  - Login state for Claude/Codex belongs to the Authentication view (the
 *    subscription bridge owns it). Here we only report what a FILE can prove.
 *  - WSL is never probed implicitly: a probe starts the distro. It runs only
 *    when the caller asks for it.
 */
import * as os from "node:os";
import * as path from "node:path";
import { getSettings } from "./settings";
import { log } from "./logger";
import { invalidateCursorAuthCache } from "./authService";
import { claudeAgentSdkSpec, claudeSdkVersion, sdkPackageJsonCandidates } from "./claudeSdkVersion";
import { firstLine, isFile, probeCommand, resolveOnPath } from "../core/commandProbe";
import { resolveClaudeCli } from "../core/claudeCli";
import { codexExecutable, resolveCodexExecutable } from "../core/codexExec";
import { resolveCursorAgentCommand, cursorAgentAuthStatus } from "../core/cursorAgentCli";
import { grokCliInstalledPath } from "../core/grokAgentCli";
import { grokSubscriptionAvailable } from "../core/grokSubscriptionAuth";
import { isEnvironmentBlockedError } from "../core/environmentError";
import { claudeCliVersionForSdk, type EnvironmentCheck, type EnvironmentRemedy, type EnvironmentReport } from "../shared/environment";

const CACHE_TTL_MS = 30_000;
/** A cold distro can take a while to boot before it answers anything. */
const WSL_TIMEOUT_MS = 90_000;

let cache: { at: number; report: EnvironmentReport } | undefined;

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
}

export async function probeEnvironment(options: EnvironmentProbeOptions = {}): Promise<EnvironmentReport> {
  if (mockReport) {
    return mockReport;
  }
  if (!options.refresh && !options.includeWsl && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.report;
  }
  const sdkVersion = claudeSdkVersion();
  const checks = [
    ...(await runtimeChecks()),
    ...(await harnessChecks(sdkVersion)),
    ...(options.includeWsl ? await wslChecks(sdkVersion) : []),
  ];
  const report: EnvironmentReport = {
    checkedAt: new Date().toISOString(),
    expectedClaudeCli: claudeCliVersionForSdk(sdkVersion),
    checks,
  };
  if (!options.includeWsl) {
    cache = { at: Date.now(), report };
  }
  return report;
}

/** Drops the cached report (call after a repair changes the machine). */
export function invalidateEnvironmentCache(): void {
  cache = undefined;
}

// ---------------------------------------------------------------- runtime

async function runtimeChecks(): Promise<EnvironmentCheck[]> {
  return [await gitCheck(), await nodeCheck()];
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

async function harnessChecks(sdkVersion: string | undefined): Promise<EnvironmentCheck[]> {
  return [
    await claudeCheck(sdkVersion),
    await codexCheck(),
    await cursorCheck(),
    await grokCheck(),
  ];
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
  const sdkNative = sdkNativeClaudeCli();
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

async function claudeCheck(sdkVersion: string | undefined): Promise<EnvironmentCheck> {
  const settings = getSettings();
  const expected = claudeCliVersionForSdk(sdkVersion);
  const chosen = chooseClaudeCli(String(settings.claudeExecutablePath || "").trim());

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
    return {
      id: "harness.claude-code",
      group: "harness",
      label: "Claude Code",
      status: "missing",
      detail: "Claude Code CLI를 찾지 못했습니다. Claude 하네스 멤버를 실행할 수 없습니다.",
      remedies,
    };
  }

  // npm installs Claude Code as a .cmd shim on Windows. The shared resolver
  // turns that shim into the package's cli.js because the Agent SDK cannot
  // spawn .cmd directly; probe the same resolved entrypoint used by a member.
  const isScript = /\.(?:[cm]?js)$/i.test(chosen.command);
  const shell = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(chosen.command);
  const probe = isScript
    // Match the Agent SDK, which invokes a configured JavaScript entrypoint
    // with `node` (not Electron's process.execPath).
    ? await probeCommand(resolveOnPath(process.platform === "win32" ? "node.exe" : "node") || "node", [chosen.command, "--version"])
    : await probeCommand(chosen.command, ["--version"], { shell });
  const version = probe.ok ? firstLine(probe.stdout) : undefined;
  const actual = version?.match(/\d+\.\d+\.\d+/)?.[0];
  const skewed = Boolean(expected && actual && expected !== actual);
  return {
    id: "harness.claude-code",
    group: "harness",
    label: "Claude Code",
    status: !probe.ok ? "error" : skewed ? "warn" : "ok",
    // Phrased as a labelled noun ("사용 중: …") rather than "<origin>을 사용합니다"
    // because the origins end in different syllables and would need different
    // Korean particles.
    detail: !probe.ok
      ? "실행 파일은 찾았지만 버전을 확인하지 못했습니다."
      : skewed
        ? `사용 중: ${chosen.origin}. 이 빌드의 Agent SDK는 ${expected}과 짝을 이루는데 설치된 버전은 ${actual}입니다. 대부분 동작하지만 문제가 생기면 이 차이를 먼저 의심하세요.`
        : `사용 중: ${chosen.origin}.`,
    version,
    path: chosen.command,
    raw: probe.ok ? undefined : probe.error,
    ...(probe.ok && !skewed ? {} : { remedies }),
  };
}

const CODEX_INSTALL_COMMAND = "npm install -g @openai/codex";

async function codexCheck(): Promise<EnvironmentCheck> {
  const settings = getSettings();
  const executable = codexExecutable(settings.codexExecutablePath);
  const resolved = resolveCodexExecutable(executable);
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

  const probe = await probeCommand(resolved.command, [...resolved.argsPrefix, "--version"], { shell: resolved.shell });
  if (!probe.ok) {
    return {
      id: "harness.codex",
      group: "harness",
      label: "Codex",
      status: "missing",
      detail: "Codex CLI를 실행하지 못했습니다. Codex 하네스 멤버를 실행할 수 없습니다.",
      path: resolveOnPath(executable) || executable,
      raw: probe.error,
      remedies,
    };
  }

  const authFile = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "auth.json");
  const signedIn = isFile(authFile);
  return {
    id: "harness.codex",
    group: "harness",
    label: "Codex",
    status: signedIn ? "ok" : "missing",
    detail: signedIn
      ? "설치되어 있고 로그인되어 있습니다."
      : `설치되어 있지만 로그인되어 있지 않습니다 (${authFile} 없음).`,
    version: firstLine(probe.stdout),
    path: resolveOnPath(executable) || executable,
    ...(signedIn ? {} : {
      remedies: [
        { kind: "command", label: "로그인 명령 복사", command: "codex login" },
        {
          kind: "repair",
          label: "로그인",
          repairId: "harness.codex.login",
          command: "codex login",
          confirm: "Codex 로그인을 실행합니다. 브라우저가 열릴 수 있습니다.",
        },
      ],
    }),
  };
}

const CURSOR_INSTALL_COMMAND = process.platform === "win32"
  ? "irm 'https://cursor.com/install?win32=true' | iex"
  : "curl https://cursor.com/install -fsS | bash";

async function cursorCheck(): Promise<EnvironmentCheck> {
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

  let source: string;
  try {
    source = resolveCursorAgentCommand(settings.cursorExecutablePath).source;
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
      // A wrong path is fixed by fixing the path, so the install buttons stand
      // down to a secondary role and the duplicate settings entry is dropped.
      remedies: configured
        ? [...pathRemedies("cursorExecutablePath"), ...installRemedies.filter((remedy) => remedy.kind !== "settings")]
        : installRemedies,
    };
  }

  const auth = await cursorAgentAuthStatus(settings.cursorExecutablePath);
  if (auth.authenticated === false) {
    return {
      id: "harness.cursor",
      group: "harness",
      label: "Cursor",
      status: "missing",
      detail: "설치되어 있지만 로그인되어 있지 않습니다.",
      path: source,
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
    status: auth.authenticated ? "ok" : "warn",
    detail: auth.authenticated
      ? `설치되어 있고 로그인되어 있습니다${auth.email ? ` (${auth.email})` : ""}.`
      : "설치되어 있지만 로그인 상태를 확인하지 못했습니다.",
    path: source,
    raw: auth.error,
  };
}

const GROK_INSTALL_COMMAND = process.platform === "win32"
  ? "irm https://x.ai/cli/install.ps1 | iex"
  : "curl -fsSL https://x.ai/cli/install.sh | bash";

async function grokCheck(): Promise<EnvironmentCheck> {
  const settings = getSettings();
  const installed = grokCliInstalledPath(settings.grokExecutablePath);
  if (!installed) {
    return {
      id: "harness.grok",
      group: "harness",
      label: "Grok Build",
      status: "missing",
      detail: "Grok Build CLI가 설치되어 있지 않습니다. Grok 하네스 멤버를 실행할 수 없습니다.",
      remedies: [
        { kind: "command", label: "설치 명령 복사", command: GROK_INSTALL_COMMAND },
        {
          kind: "repair",
          label: "설치하기",
          repairId: "harness.grok.install",
          command: GROK_INSTALL_COMMAND,
          confirm: `이 PC에 Grok Build CLI를 설치합니다.\n\n${GROK_INSTALL_COMMAND}`,
        },
        { kind: "docs", label: "설치 안내", url: "https://x.ai/cli" },
        { kind: "settings", label: "실행 파일 경로 지정", settingsField: "grokExecutablePath" },
      ],
    };
  }

  const probe = await probeCommand(installed, ["--version"]);
  const text = firstLine(probe.stdout);
  // The official build prints a commit hash; the community `grok-dev` package
  // installs a different agent under the same name and does not.
  const official = /^grok\s+\S+\s+\([0-9a-f]{6,}\)/i.test(text);
  const login = grokSubscriptionAvailable();
  if (probe.ok && !official) {
    return {
      id: "harness.grok",
      group: "harness",
      label: "Grok Build",
      status: "error",
      detail: "같은 이름의 다른 CLI(커뮤니티 grok-dev)가 설치되어 있습니다. 공식 Grok Build CLI가 필요합니다.",
      version: text,
      path: installed,
      remedies: [
        { kind: "command", label: "공식 CLI 설치 명령 복사", command: GROK_INSTALL_COMMAND },
        { kind: "docs", label: "설치 안내", url: "https://x.ai/cli" },
      ],
    };
  }
  return {
    id: "harness.grok",
    group: "harness",
    label: "Grok Build",
    status: login.ok ? "ok" : "missing",
    detail: login.ok
      ? `설치되어 있고 로그인되어 있습니다${login.email ? ` (${login.email})` : ""}.`
      : "설치되어 있지만 로그인되어 있지 않습니다.",
    version: text || undefined,
    path: installed,
    raw: login.ok ? undefined : (login.raw || login.reason),
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
export async function runEnvironmentRepair(repairId: string): Promise<EnvironmentRepairResult> {
  const wslDistro = repairId.startsWith("wsl.sdk.reinstall:") ? repairId.slice("wsl.sdk.reinstall:".length) : undefined;
  const before = await probeEnvironment({ refresh: true, includeWsl: Boolean(wslDistro) });
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
  const report = await probeEnvironment({ refresh: true, includeWsl: Boolean(wslDistro) });
  if (!result.ok) {
    log("warn", "environment", "repair failed", { repairId, error: result.error });
  }
  return {
    ok: result.ok,
    detail: result.ok ? "완료했습니다." : "실패했습니다. 아래 출력을 확인하거나 명령을 직접 실행해 보세요.",
    output: tail(result.ok ? result.stdout : (result.error || result.stderr)),
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

export async function listWslDistros(): Promise<{ names: string[]; error?: string }> {
  const probe = await probeCommand("wsl.exe", ["-l", "-q"], { timeoutMs: 30_000 });
  if (!probe.ok) {
    return { names: [], error: probe.error };
  }
  const names = probe.stdout
    .split(/\r?\n/)
    .map((line) => line.replace(/\0/g, "").trim())
    .filter(Boolean);
  return { names };
}

async function wslChecks(sdkVersion: string | undefined): Promise<EnvironmentCheck[]> {
  if (process.platform !== "win32") {
    return [];
  }
  const { names, error } = await listWslDistros();
  if (error) {
    return [{
      id: "wsl.available",
      group: "wsl",
      label: "WSL",
      status: "missing",
      detail: "WSL을 사용할 수 없습니다. WSL 워크스페이스를 열려면 WSL이 필요합니다.",
      raw: error,
      remedies: [
        { kind: "command", label: "설치 명령 복사", command: "wsl --install" },
        { kind: "docs", label: "WSL 설치 안내", url: "https://learn.microsoft.com/windows/wsl/install" },
      ],
    }];
  }

  const targets = names.filter(isProbableWorkspaceDistro);
  const checks: EnvironmentCheck[] = [{
    id: "wsl.available",
    group: "wsl",
    label: "WSL",
    status: targets.length ? "ok" : "warn",
    detail: targets.length ? `배포판 ${targets.length}개: ${targets.join(", ")}` : "사용 가능한 배포판이 없습니다.",
  }];
  for (const distro of targets) {
    checks.push(...await wslDistroChecks(distro, sdkVersion));
  }
  return checks;
}

async function wslDistroChecks(distro: string, sdkVersion: string | undefined): Promise<EnvironmentCheck[]> {
  const node = await probeCommand(
    "wsl.exe",
    ["-d", distro, "-e", "bash", "-lc", "command -v node >/dev/null 2>&1 && node -v || exit 3"],
    { timeoutMs: WSL_TIMEOUT_MS },
  );
  const nodeCheck: EnvironmentCheck = node.ok
    ? {
        id: `wsl.${distro}.node`,
        group: "wsl",
        label: `${distro} · Node.js`,
        status: "ok",
        detail: "배포판 안에 Node.js가 있습니다.",
        version: firstLine(node.stdout),
      }
    : {
        id: `wsl.${distro}.node`,
        group: "wsl",
        label: `${distro} · Node.js`,
        status: "missing",
        detail: "배포판 안에 Node.js가 없습니다. 이 배포판의 워크스페이스는 열 수 없습니다.",
        raw: node.error,
        remedies: [
          { kind: "command", label: "설치 명령 복사", command: `wsl -d ${distro} -e bash -lc "sudo apt update && sudo apt install -y nodejs npm"` },
          { kind: "docs", label: "WSL에 Node 설치", url: "https://learn.microsoft.com/windows/dev-environment/javascript/nodejs-on-wsl" },
        ],
      };

  // Only meaningful once node exists — the engine bundle runs under it.
  if (!node.ok) {
    return [nodeCheck];
  }

  const sdk = await probeCommand(
    "wsl.exe",
    ["-d", distro, "-e", "bash", "-lc", "cat \"$HOME/.agent_party_app/server/node_modules/@anthropic-ai/claude-agent-sdk/package.json\" 2>/dev/null || exit 3"],
    { timeoutMs: WSL_TIMEOUT_MS },
  );
  const reinstall: EnvironmentRemedy = {
    kind: "repair",
    label: "SDK 다시 설치",
    repairId: `wsl.sdk.reinstall:${distro}`,
  };
  if (!sdk.ok) {
    return [nodeCheck, {
      id: `wsl.${distro}.sdk`,
      group: "wsl",
      label: `${distro} · Claude Agent SDK`,
      status: "unknown",
      detail: "아직 설치되지 않았습니다. 이 배포판의 워크스페이스를 처음 열 때 자동으로 설치됩니다.",
      remedies: [reinstall],
    }];
  }

  const installed = safeJsonVersion(sdk.stdout);
  const skewed = Boolean(installed && sdkVersion && installed !== sdkVersion);
  return [nodeCheck, {
    id: `wsl.${distro}.sdk`,
    group: "wsl",
    label: `${distro} · Claude Agent SDK`,
    status: skewed ? "warn" : "ok",
    detail: skewed
      ? `이 배포판에는 ${installed}이 설치되어 있고 앱은 ${sdkVersion}을 씁니다. 배포판 SDK는 처음 설치된 뒤 자동으로 갱신되지 않습니다.`
      : "앱과 같은 버전이 설치되어 있습니다.",
    version: installed,
    ...(skewed ? { remedies: [reinstall] } : {}),
  }];
}

function safeJsonVersion(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------- SDK

/**
 * The native binary the SDK installed next to itself. This is what a dev run
 * actually spawns, and it is invisible from PATH — so the environment screen
 * would otherwise report the host CLI while the app used a different one.
 */
function sdkNativeClaudeCli(): string | undefined {
  const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : "";
  if (!arch) {
    return undefined;
  }
  const packageName = `claude-agent-sdk-${process.platform}-${arch}`;
  const executable = process.platform === "win32" ? "claude.exe" : "claude";
  for (const file of sdkPackageJsonCandidates()) {
    const sdkDir = path.dirname(file);
    const candidates = [
      path.join(sdkDir, "node_modules", "@anthropic-ai", packageName, executable),
      path.join(sdkDir, "..", packageName, executable),
    ];
    for (const candidate of candidates) {
      if (isFile(candidate)) {
        return path.normalize(candidate);
      }
    }
  }
  return undefined;
}
