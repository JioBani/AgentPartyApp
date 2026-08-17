import { spawn } from "node:child_process";
import type { CliContinuationTarget } from "../shared/cliContinuation";
import { cliContinuationArgv, formatCliContinuationCommand } from "../shared/cliContinuation";
import type { WorkspaceLocation } from "../shared/workspaceLocation";

export interface CliContinuationLaunch {
  target: CliContinuationTarget;
  location: WorkspaceLocation;
}

export interface CliContinuationSpawnSpec {
  command: string;
  args: string[];
}

/**
 * Opens an interactive CLI in a NEW console. Windows routes console processes
 * through the user's configured default terminal host (Windows Terminal or the
 * classic console); WSL stays inside the selected distro and its native cwd.
 */
export function launchCliContinuation(input: CliContinuationLaunch): Promise<number> {
  const spec = cliContinuationSpawnSpec(input);
  return spawnDetached(spec.command, spec.args);
}

/** Pure launch plan, exported so WSL/cwd quoting can be verified without opening a terminal. */
export function cliContinuationSpawnSpec(input: CliContinuationLaunch): CliContinuationSpawnSpec {
  const argv = cliContinuationArgv(input.target, input.location.host);
  if (input.location.host.kind === "wsl") {
    const command = `exec ${formatCliContinuationCommand(argv, "bash")}`;
    return {
      command: "wsl.exe",
      args: ["-d", input.location.host.distro, "--cd", input.location.path, "-e", "bash", "-lc", command],
    };
  }

  // Match the executable selected by AgentParty itself. This matters for
  // custom installs and keeps an app configured with a CLI override from
  // handing the same thread to a different binary found by a fresh shell.
  argv[0] = configuredLocalExecutable(input.target.harness) || argv[0];

  // Use argv all the way into PowerShell. The generated script only contains
  // single-quoted literals, so a workspace/member id can never become syntax.
  const command = [
    `Set-Location -LiteralPath ${powerShellLiteral(input.location.path)}`,
    `& ${argv.map(powerShellLiteral).join(" ")}`,
  ].join("; ");
  return { command: "powershell.exe", args: ["-NoLogo", "-Command", command] };
}

function configuredLocalExecutable(harness: CliContinuationTarget["harness"]): string {
  const variable = {
    "claude-code": "AGENTPARTY_CLAUDE_BIN",
    codex: "AGENTPARTY_CODEX_BIN",
    cursor: "AGENTPARTY_CURSOR_BIN",
    grok: "AGENTPARTY_GROK_BIN",
  }[harness];
  return String(process.env[variable] || "").trim();
}

function spawnDetached(command: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    // Electron is a GUI process, so a directly detached console child can be
    // reported as spawned without Windows ever attaching a visible terminal.
    // A hidden bootstrap shell asks Windows to start the interactive process;
    // console delegation then goes through the user's configured default host.
    const argumentLine = args.map(quoteWindowsArgument).join(" ");
    const bootstrap = [
      `$process = Start-Process -FilePath ${powerShellLiteral(command)}`,
      `-ArgumentList ${powerShellLiteral(argumentLine)}`,
      "-PassThru",
      "; [Console]::Out.Write($process.Id)",
    ].join(" ");
    const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", bootstrap], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      const pid = Number(stdout.trim());
      if (code !== 0 || !Number.isInteger(pid) || pid <= 0) {
        reject(new Error(`Default terminal launch failed (${code ?? "no exit code"}): ${stderr.trim() || stdout.trim() || "no process id"}`));
        return;
      }
      resolve(pid);
    });
  });
}

/** CommandLineToArgvW-compatible quoting for Start-Process's single argument line. */
function quoteWindowsArgument(value: string): string {
  if (value && !/[\s"]/u.test(value)) return value;
  return `"${value.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/g, "$1$1")}"`;
}

function powerShellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
