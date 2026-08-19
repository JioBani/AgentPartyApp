import { spawn } from "node:child_process";
import * as readline from "node:readline";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ResolvedCodexExecutable } from "./codexExec";
import { terminateProcessTree } from "./processTree";
import { probeCommand, resolveOnPath, type CommandProbeResult } from "./commandProbe";
import { parseWorkspaceLocation } from "../shared/workspaceLocation";
import type { EnvironmentProbeStep } from "../shared/environment";

export interface HarnessExecutionProbeResult {
  ok: boolean;
  detail: string;
  error?: string;
  failureKind?: "spawn" | "timeout" | "exit" | "protocol";
  failureCode?: string;
}

const PROBE_TIMEOUT_MS = 15_000;
const OUTPUT_TAIL_LIMIT = 8_000;

export interface LocalWorkspaceProbe {
  cwd?: string;
  step: EnvironmentProbeStep;
}

/** Verifies that the current native workspace can be used as child cwd. */
export function probeLocalWorkspace(workspacePath: string): LocalWorkspaceProbe {
  const location = parseWorkspaceLocation(workspacePath);
  if (location.host.kind === "wsl") {
    return {
      step: {
        id: "workspace",
        label: "작업공간",
        status: "skipped",
        detail: `${location.host.distro} WSL 작업공간입니다. 이 PC의 네이티브 하네스가 아니라 WSL 환경 점검에서 검증합니다.`,
      },
    };
  }
  const cwd = path.resolve(location.path || ".");
  try {
    const stat = fs.statSync(cwd);
    if (!stat.isDirectory()) {
      return {
        step: {
          id: "workspace",
          label: "작업공간",
          status: "failed",
          detail: `작업공간 경로가 폴더가 아닙니다: ${cwd}`,
          raw: `not a directory (cwd=${cwd})`,
        },
      };
    }
    fs.accessSync(cwd, fs.constants.R_OK);
    return {
      cwd,
      step: {
        id: "workspace",
        label: "작업공간",
        status: "ok",
        detail: `프로세스 작업 폴더로 접근할 수 있습니다: ${cwd}`,
      },
    };
  } catch (error) {
    const fsError = error as NodeJS.ErrnoException;
    return {
      step: {
        id: "workspace",
        label: "작업공간",
        status: "failed",
        detail: workspaceFailureReason(fsError, cwd),
        raw: `${fsError.message} (code=${fsError.code || "UNKNOWN"}, cwd=${cwd})`,
      },
    };
  }
}

function workspaceFailureReason(error: NodeJS.ErrnoException, cwd: string): string {
  if (error.code === "ENOENT") return `작업공간 폴더가 존재하지 않습니다: ${cwd}`;
  if (error.code === "EACCES" || error.code === "EPERM") return `작업공간 폴더에 접근할 권한이 없습니다: ${cwd}`;
  return `작업공간을 프로세스 작업 폴더로 사용할 수 없습니다: ${cwd} (${error.code || "UNKNOWN"})`;
}

export function skippedStep(id: string, label: string, blocker: string): EnvironmentProbeStep {
  return { id, label, status: "skipped", detail: `${blocker} 단계가 실패해 검사하지 않았습니다.` };
}

export function successfulStep(id: string, label: string, detail: string, startedAt: number): EnvironmentProbeStep {
  return { id, label, status: "ok", detail, durationMs: Date.now() - startedAt };
}

export function failedCommandStep(id: string, label: string, subject: string, probe: CommandProbeResult, startedAt: number): EnvironmentProbeStep {
  return {
    id,
    label,
    status: "failed",
    detail: commandFailureReason(subject, probe),
    durationMs: Date.now() - startedAt,
    raw: probe.error,
  };
}

export function commandFailureReason(subject: string, probe: CommandProbeResult): string {
  if (probe.failureKind === "timeout") return `${subject} 응답 시간이 초과되었습니다.`;
  if (probe.failureKind === "spawn") {
    if (probe.failureCode === "ENOENT") return `${subject} 실행 파일 또는 작업공간 경로를 찾지 못했습니다.`;
    if (probe.failureCode === "EACCES" || probe.failureCode === "EPERM") return `${subject} 실행이 권한 또는 보안 정책에 의해 거부되었습니다.`;
    if (probe.failureCode === "EINVAL") return `${subject} 실행 파일 형식을 Windows가 실행할 수 없습니다.`;
    if (probe.failureCode === "UNKNOWN") {
      return `Windows가 ${subject} 프로세스 생성을 거부했지만 상세 오류 코드를 제공하지 않았습니다. 실행 파일 형식, 보안 차단, 작업공간 접근 권한을 확인하세요.`;
    }
    return `${subject} 프로세스를 생성하지 못했습니다 (${probe.failureCode || "원인 코드 없음"}).`;
  }
  return `${subject} 명령이 정상 종료되지 않았습니다${probe.code === undefined ? "" : ` (종료 코드 ${probe.code})`}.`;
}

/** Runs the same executable form the Agent SDK receives, including JS entrypoints. */
export function probeClaudeCommand(command: string, args: string[], cwd: string): Promise<CommandProbeResult> {
  const isScript = /\.(?:[cm]?js)$/i.test(command);
  if (isScript) {
    return probeCommand(
      resolveOnPath(process.platform === "win32" ? "node.exe" : "node") || "node",
      [command, ...args],
      { cwd },
    );
  }
  const shell = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
  return probeCommand(command, args, { shell, cwd });
}

export function claudeLoggedIn(stdout: string): boolean {
  try {
    return JSON.parse(stdout)?.loggedIn === true;
  } catch {
    return false;
  }
}

/**
 * Starts the same Codex app-server transport used by a real member and performs
 * its initialize handshake. This proves process creation, cwd usability and
 * JSON-RPC compatibility without starting a thread or making a model call.
 */
export function probeCodexAppServer(
  resolved: ResolvedCodexExecutable,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<HarnessExecutionProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let stderrTail = "";
    let stdoutTail = "";
    const requestId = "agentparty-environment-probe";

    const child = spawn(resolved.command, [...resolved.argsPrefix, ...args, "app-server"], {
      cwd,
      env,
      windowsHide: true,
      shell: resolved.shell,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = readline.createInterface({ input: child.stdout });

    const stop = () => {
      lines.close();
      if (child.pid) terminateProcessTree(child.pid);
    };
    const finish = (result: HarnessExecutionProbeResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      stop();
      resolve(result);
    };
    const evidence = (fallback: string) => stderrTail.trim() || stdoutTail.trim() || fallback;

    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-OUTPUT_TAIL_LIMIT);
    });
    lines.on("line", (line) => {
      stdoutTail = `${stdoutTail}${line}\n`.slice(-OUTPUT_TAIL_LIMIT);
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (String(message?.id ?? "") !== requestId) return;
      if (message.error) {
        finish({
          ok: false,
          detail: "Codex app-server가 초기화 요청을 거부했습니다.",
          error: evidence(JSON.stringify(message.error)),
          failureKind: "protocol",
        });
        return;
      }
      finish({ ok: true, detail: "Codex app-server 프로세스와 초기화 프로토콜이 정상입니다." });
    });
    child.once("error", (error) => {
      const spawnError = error as NodeJS.ErrnoException;
      finish({
        ok: false,
        detail: "Windows가 Codex app-server 프로세스를 생성하지 못했습니다.",
        error: `${error.message} (code=${spawnError.code || "UNKNOWN"}, syscall=${spawnError.syscall || "spawn"}, command=${resolved.command}, cwd=${cwd})`,
        failureKind: "spawn",
        failureCode: spawnError.code,
      });
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      finish({
        ok: false,
        detail: "Codex app-server가 초기화 전에 종료되었습니다.",
        error: evidence(`exit code=${code ?? "null"}, signal=${signal || "none"}`),
        failureKind: "exit",
      });
    });
    child.stdin.once("error", (error) => {
      finish({
        ok: false,
        detail: "Codex app-server 초기화 요청을 쓰지 못했습니다.",
        error: evidence(error.message),
        failureKind: "protocol",
      });
    });

    timer = setTimeout(() => {
      finish({
        ok: false,
        detail: `Codex app-server가 ${timeoutMs}ms 안에 초기화되지 않았습니다.`,
        error: evidence(`initialize timeout (command=${resolved.command}, cwd=${cwd})`),
        failureKind: "timeout",
      });
    }, timeoutMs);

    try {
      child.stdin.write(`${JSON.stringify({
        id: requestId,
        method: "initialize",
        params: {
          clientInfo: { name: "agentparty-environment", title: "AgentParty Environment Check", version: "1" },
          capabilities: { experimentalApi: true, requestAttestation: false },
        },
      })}\n`);
    } catch (error) {
      finish({
        ok: false,
        detail: "Codex app-server 초기화 요청을 쓰지 못했습니다.",
        error: error instanceof Error ? error.message : String(error),
        failureKind: "protocol",
      });
    }
  });
}

export function codexRuntimeFailureReason(probe: HarnessExecutionProbeResult): string {
  if (probe.failureKind === "spawn") {
    if (probe.failureCode === "ENOENT") return "Codex 실행 파일 또는 작업공간 경로를 찾지 못했습니다.";
    if (probe.failureCode === "EACCES" || probe.failureCode === "EPERM") return "Codex 프로세스 실행이 권한 또는 보안 정책에 의해 거부되었습니다.";
    if (probe.failureCode === "UNKNOWN") return "Windows가 Codex 프로세스 생성을 거부했지만 상세 오류 코드를 제공하지 않았습니다. 실행 파일 형식, 보안 차단, 작업공간 접근 권한을 확인하세요.";
  }
  return probe.detail;
}
