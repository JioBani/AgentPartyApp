import { execFile, spawn, type ChildProcess } from "node:child_process";
import { log } from "../../logger";
import type { RemoteTransport } from "./remoteEngineClient";

export interface WslEngineOptions {
  distro: string;
  /** Workspace path inside the distro (posix, e.g. /home/dev/proj). */
  workspacePosix: string;
  /** Windows path to the bundled engine server (dist/engine-server.mjs). */
  serverBundleWinPath: string;
  /** Forwarded to the distro engine's router for router-backed models. */
  openRouterApiKey?: string;
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

    // Forward the OpenRouter key into the distro via WSLENV (not on the command
    // line, so it never appears in args/logs); the distro engine's router reads it.
    const env = { ...process.env };
    if (options.openRouterApiKey) {
      env.OPENROUTER_API_KEY = options.openRouterApiKey;
      env.WSLENV = appendWslEnv(env.WSLENV, "OPENROUTER_API_KEY");
    }
    child = spawn(
      "wsl.exe",
      [
        "-d", options.distro, "-e", "bash", "-lc",
        `exec node "${serverPath}" --workspace "${options.workspacePosix}" --storage "$HOME/.agent_party_app"`,
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
