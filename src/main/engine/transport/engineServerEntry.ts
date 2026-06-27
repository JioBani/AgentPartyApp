import { setConsoleLogging } from "../../logger";
import { createEngineHost } from "../engineHost";
import { serveEngine } from "./engineServer";

/**
 * Standalone engine server: builds an Electron-free engine host and serves one
 * workspace's engine over stdin/stdout. Spawned as a child by the desktop
 * client — locally as `node engineServerEntry`, and (Stage 5) inside a distro as
 * `wsl.exe -d <distro> -e node engineServerEntry`. stdout is the RPC channel, so
 * console logging is disabled (file logging continues). See docs/WSL_REMOTE.md.
 *
 * Args: --workspace <path> --storage <dir>
 */
function arg(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] || "" : "";
}

function main(): void {
  setConsoleLogging(false);

  const workspace = arg("workspace") || process.cwd();
  const storage = arg("storage") || workspace;

  const host = createEngineHost({
    storageDir: storage,
    router: { preferredPort: 0, authToken: "engine", openRouterApiKey: process.env.OPENROUTER_API_KEY || "" },
  });
  const engine = host.engineRegistry.forWorkspace(workspace);

  serveEngine(engine, process.stdin, process.stdout);

  const shutdown = () => {
    host.dispose();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.stdin.on("close", shutdown);

  // Readiness handshake on stderr (stdout is reserved for RPC).
  process.stderr.write("ENGINE_SERVER_READY\n");
}

main();
