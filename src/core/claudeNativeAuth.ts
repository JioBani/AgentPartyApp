import * as path from "node:path";
import { resolveOnPath, type CommandProbeResult } from "./commandProbe";
import { resolveClaudeCli, resolveSdkClaudeCli } from "./claudeCli";
import { probeClaudeCommand } from "./harnessExecutionProbe";

export type ClaudeNativeAuthStatus = "authenticated" | "auth_required" | "missing" | "error";

export interface ClaudeNativeAuthState {
  status: ClaudeNativeAuthStatus;
  authenticated: boolean;
  checkedAt: string;
  host: { kind: "windows" | "wsl" | "native"; label: string; distro?: string };
  workspace: string;
  executable?: string;
  command?: string;
  loginCommand: string;
  authMethod?: string;
  apiProvider?: string;
  detail: string;
  failureKind?: "spawn" | "timeout" | "exit" | "protocol";
  failureCode?: string;
}

export interface ClaudeNativeAuthProbeOptions {
  workspacePath: string;
  executablePath?: string;
  forceHostLabel?: string;
  probe?: (command: string, args: string[], cwd: string) => Promise<CommandProbeResult>;
}

/**
 * Runs `claude auth status` on the process host that will execute the member.
 * It reads only the CLI's small status response and whitelists three fields;
 * OAuth tokens and credential-file contents never enter this result or logs.
 */
export async function probeClaudeNativeAuth(options: ClaudeNativeAuthProbeOptions): Promise<ClaudeNativeAuthState> {
  const workspace = path.resolve(options.workspacePath || ".");
  const distro = process.env.WSL_DISTRO_NAME;
  const host = process.platform === "win32"
    ? { kind: "windows" as const, label: options.forceHostLabel || "Windows" }
    : distro
      ? { kind: "wsl" as const, label: options.forceHostLabel || `WSL · ${distro}`, distro }
      : { kind: "native" as const, label: options.forceHostLabel || process.platform };
  const resolved = resolveClaudeCli(options.executablePath)?.command || resolveSdkClaudeCli();
  const loginCommand = resolved ? claudeDisplayCommand(resolved, []) : "claude";
  if (!resolved) {
    return {
      status: "missing",
      authenticated: false,
      checkedAt: new Date().toISOString(),
      host,
      workspace,
      loginCommand,
      detail: `${host.label}에서 Claude Code 실행 파일을 찾지 못했습니다. 이 호스트에 Claude Code를 설치하세요.`,
    };
  }

  const run = options.probe || probeClaudeCommand;
  const result = await run(resolved, ["auth", "status"], workspace);
  const command = claudeDisplayCommand(resolved, ["auth", "status"]);
  const parsed = safeAuthStatus(result.stdout);
  if (parsed?.loggedIn === true) {
    return {
      status: "authenticated",
      authenticated: true,
      checkedAt: new Date().toISOString(),
      host,
      workspace,
      executable: resolved,
      command,
      loginCommand,
      authMethod: parsed.authMethod,
      apiProvider: parsed.apiProvider,
      detail: `${host.label}의 네이티브 Claude Code 로그인이 유효합니다.`,
    };
  }
  if (parsed && parsed.loggedIn === false) {
    return {
      status: "auth_required",
      authenticated: false,
      checkedAt: new Date().toISOString(),
      host,
      workspace,
      executable: resolved,
      command,
      loginCommand,
      authMethod: parsed.authMethod,
      apiProvider: parsed.apiProvider,
      detail: `${host.label}의 네이티브 Claude Code 로그인이 필요합니다. ${host.label} 터미널에서 \`${loginCommand}\`를 실행하세요.`,
    };
  }
  return {
    status: "error",
    authenticated: false,
    checkedAt: new Date().toISOString(),
    host,
    workspace,
    executable: resolved,
    command,
    loginCommand,
    detail: `${host.label}에서 Claude Code 인증 상태를 확인하지 못했습니다. 명령과 작업 위치를 확인하세요.`,
    failureKind: result.failureKind || "protocol",
    failureCode: result.failureCode || (result.code === undefined || result.code === null ? undefined : String(result.code)),
  };
}

export function safeAuthStatus(value: string): { loggedIn: boolean; authMethod?: string; apiProvider?: string } | undefined {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (typeof parsed.loggedIn !== "boolean") return undefined;
    return {
      loggedIn: parsed.loggedIn,
      ...(typeof parsed.authMethod === "string" ? { authMethod: parsed.authMethod } : {}),
      ...(typeof parsed.apiProvider === "string" ? { apiProvider: parsed.apiProvider } : {}),
    };
  } catch {
    return undefined;
  }
}

function displayCommand(command: string, args: string[]): string {
  return [command, ...args].map((part) => /\s/.test(part) ? `"${part.replace(/"/g, '\\"')}"` : part).join(" ");
}

function claudeDisplayCommand(command: string, args: string[]): string {
  return /\.(?:[cm]?js)$/i.test(command)
    ? displayCommand(resolveOnPath(process.platform === "win32" ? "node.exe" : "node") || "node", [command, ...args])
    : displayCommand(command, args);
}
