import { execFile, spawn, type ChildProcess } from "node:child_process";
import { log } from "../../logger";
import type { RemoteTransport } from "./remoteEngineClient";
import { DEEPSEEK_API_KEY_ENV } from "../../../shared/deepseekDefaults";

export interface WslEngineOptions {
  distro: string;
  /** Workspace path inside the distro (posix, e.g. /home/dev/proj). */
  workspacePosix: string;
  /** Windows path to the bundled engine server (dist/engine-server.mjs). */
  serverBundleWinPath: string;
  /** Windows path to the Codex-facing AgentParty MCP stdio server. */
  codexMcpServerWinPath?: string;
  /** Windows path to the Cursor ACP bridge's relay MCP stub. */
  acpRelayWinPath?: string;
  /** Forwarded to the distro engine's router for router-backed models. */
  openRouterApiKey?: string;
  deepseekApiKey?: string;
}

export interface WslEngineHandle {
  transport: Promise<RemoteTransport>;
  dispose(): void;
}

/**
 * Spawns the engine server inside a WSL distro and returns a transport to it.
 * Mirrors VS Code's "server install on connect": the bundle is copied onto the
 * distro's ext4 home, then run with the distro's node so the engine (and its
 * cwd, fs, git, claude binary) is fully native. stdio is the RPC channel.
 *
 * Failures (no node, copy error, spawn/handshake failure) reject the transport
 * — never a silent Windows fallback (convention #3). See docs/WSL_REMOTE.md §8.
 */
export function spawnWslEngine(options: WslEngineOptions): WslEngineHandle {
  let child: ChildProcess | undefined;

  const transport: Promise<RemoteTransport> = (async () => {
    await assertNode(options.distro);
    const wslBundle = await wslpath(options.distro, options.serverBundleWinPath);
    const serverDir = "$HOME/.agent_party_app/server";
    const serverPath = `${serverDir}/engine-server.mjs`;
    await runBash(options.distro, `mkdir -p "${serverDir}" && cp "${wslBundle}" "${serverPath}"`);
    if (options.codexMcpServerWinPath) {
      const wslMcpScript = await wslpath(options.distro, options.codexMcpServerWinPath);
      await runBash(options.distro, `cp "${wslMcpScript}" "${serverDir}/agentparty-codex-mcp-server.mjs"`);
    }
    if (options.acpRelayWinPath) {
      const wslRelayScript = await wslpath(options.distro, options.acpRelayWinPath);
      await runBash(options.distro, `cp "${wslRelayScript}" "${serverDir}/agentparty-acp-mcp-relay.mjs"`);
    }
    await ensureSdk(options.distro, serverDir);

    // Forward the OpenRouter key into the distro via WSLENV (not on the command
    // line, so it never appears in args/logs); the distro engine's router reads it.
    const env = { ...process.env };
    if (options.deepseekApiKey) {
      env[DEEPSEEK_API_KEY_ENV] = options.deepseekApiKey;
    }
    if (options.openRouterApiKey) {
      env.OPENROUTER_API_KEY = options.openRouterApiKey;
      env.WSLENV = appendWslEnv(env.WSLENV, "OPENROUTER_API_KEY");
    }
    // Forward the Codex party-tool call-log path (a distro path) into the distro
    // so the in-distro party MCP server can record its tool calls where a test
    // (or a debugging session) can read them back with `wsl.exe cat`. Verbatim
    // (no WSLENV `/p` translation): the value is already a Linux path. Unset in
    // normal use, so this is a no-op outside diagnostics.
    if (process.env.AGENTPARTY_CODEX_MCP_OUT) {
      env.WSLENV = appendWslEnv(env.WSLENV, "AGENTPARTY_CODEX_MCP_OUT");
    }
    // A WSL login shell can discard WSLENV-forwarded test/runtime overrides on
    // some installations. Export these non-secret values in the shell command
    // as well, with strict quoting, so an isolated CODEX_HOME can never
    // accidentally fall through to the user's real ~/.codex.
    const codexRuntimeExports = [
      "AGENTPARTY_NATIVE_CODEX_HOME",
      "AGENTPARTY_CODEX_BIN",
      "AGENTPARTY_CODEX_ARGS",
      "AGENTPARTY_FAKE_CODEX_AUTH_OUT",
    ].flatMap((name) => process.env[name]
      ? [`export ${name}=${bashQuote(process.env[name]!)};`]
      : []);
    if (codexRuntimeExports.length > 0) {
      log("info", "wsl-engine", "forwarding isolated Codex runtime configuration", {
        variables: ["AGENTPARTY_NATIVE_CODEX_HOME", "AGENTPARTY_CODEX_BIN", "AGENTPARTY_CODEX_ARGS", "AGENTPARTY_FAKE_CODEX_AUTH_OUT"]
          .filter((name) => Boolean(process.env[name])),
      });
    }
    child = spawn(
      "wsl.exe",
      [
        "-d", options.distro, "-e", "bash", "-lc",
        // cd into the server dir so the engine resolves @anthropic-ai/claude-agent-sdk
        // from ~/.agent_party_app/server/node_modules (provisioned for real sessions).
        `${codexRuntimeExports.join(" ")} cd "${serverDir}" && ${options.codexMcpServerWinPath ? 'export AGENTPARTY_CODEX_MCP_SERVER="$HOME/.agent_party_app/server/agentparty-codex-mcp-server.mjs" && ' : ""}${options.acpRelayWinPath ? 'export AGENTPARTY_ACP_RELAY_SCRIPT="$HOME/.agent_party_app/server/agentparty-acp-mcp-relay.mjs" && ' : ""}exec node engine-server.mjs --workspace "${options.workspacePosix}" --storage "$HOME/.agent_party_app"`,
      ],
      { stdio: ["pipe", "pipe", "pipe"], env },
    );
    child.on("error", (error) => log("error", "wsl-engine", "spawn error", { distro: options.distro, error: error.message }));

    await waitForReady(child);
    log("info", "wsl-engine", "engine server ready", { distro: options.distro, workspace: options.workspacePosix });
    return { input: child.stdout!, output: child.stdin! };
  })();
  // Avoid an unhandled rejection if no caller has awaited yet; real callers see it.
  transport.catch(() => undefined);

  return {
    transport,
    dispose: () => {
      try {
        child?.kill();
      } catch {
        // already gone
      }
    },
  };
}

/** Keep in sync with the app's @anthropic-ai/claude-agent-sdk dependency. */
const SDK_SPEC = "@anthropic-ai/claude-agent-sdk@^0.3.186";

/**
 * Provisions the Claude Agent SDK (incl. the linux native binary) into the
 * distro server dir so real sessions resolve it — VS Code's "server install on
 * connect". Guarded, so it only installs once. Best-effort: if it fails (e.g.
 * no network), we log and continue — mock/QA sessions don't need it, and a real
 * session then fails with the SDK's own explicit error (no silent fallback).
 */
async function ensureSdk(distro: string, serverDir: string): Promise<void> {
  try {
    await runBash(
      distro,
      `cd "${serverDir}" && [ -d node_modules/@anthropic-ai/claude-agent-sdk ] || { npm init -y >/dev/null 2>&1; npm install ${SDK_SPEC} >/dev/null 2>&1; }`,
    );
  } catch (error) {
    log("warn", "wsl-engine", "could not provision the Claude Agent SDK in the distro (real sessions will fail until installed)", {
      distro,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function assertNode(distro: string): Promise<void> {
  try {
    await runBash(distro, "command -v node >/dev/null 2>&1 || { echo NO_NODE >&2; exit 3; }");
  } catch {
    throw new Error(
      `WSL distro '${distro}' has no 'node' on PATH. Install Node.js in the distro (e.g. 'sudo apt install nodejs') and retry.`,
    );
  }
}

/** Adds a var name to a `WSLENV` list (colon-separated) so wsl.exe forwards it. */
function appendWslEnv(current: string | undefined, name: string): string {
  if (!current) {
    return name;
  }
  return current.split(":").includes(name) ? current : `${current}:${name}`;
}

function bashQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function wslpath(distro: string, winPath: string): Promise<string> {
  return execWsl(["-d", distro, "-e", "wslpath", "-a", winPath]).then((out) => out.trim());
}

function runBash(distro: string, command: string): Promise<string> {
  return execWsl(["-d", distro, "-e", "bash", "-lc", command]);
}

function execWsl(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("wsl.exe", args, { encoding: "utf8", maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr?.toString().trim() || error.message));
      } else {
        resolve(stdout.toString());
      }
    });
  });
}

function waitForReady(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("WSL engine did not signal ready within 20s")), 20000);
    child.stderr?.on("data", (chunk) => {
      buffer += chunk.toString();
      if (buffer.includes("ENGINE_SERVER_READY")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`WSL engine exited before ready (code ${code})`));
    });
  });
}
