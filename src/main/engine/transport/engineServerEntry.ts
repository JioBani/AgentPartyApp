import { setConsoleLogging } from "../../logger";
import { createEngineHost } from "../engineHost";
import { serveEngine } from "./engineServer";
import { writeLine } from "./rpc";

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

async function main(): Promise<void> {
  setConsoleLogging(false);

  const workspace = arg("workspace") || process.cwd();
  const storage = arg("storage") || workspace;

  const host = createEngineHost({
    storageDir: storage,
    router: { preferredPort: 0, authToken: "engine", openRouterApiKey: process.env.OPENROUTER_API_KEY || "" },
  });
  // Start the embedded router so router-backed models (MiniMax M3, etc.) work —
  // it runs inside the distro alongside the harness. preferredPort 0 binds a
  // free port; without this the harness sees the router at 127.0.0.1:0.
  await host.startRouter();
  const engine = host.engineRegistry.forWorkspace(workspace);

  serveEngine(engine, process.stdin, process.stdout);

  // Push this workspace's live session activity to the client over the same
  // channel (distinguished from RPC responses by `kind: "event"`).
  host.sessionManager.on("events", (payload) => writeLine(process.stdout, { kind: "event", channel: "session:events", payload }));
  host.sessionManager.on("snapshot", (payload) => writeLine(process.stdout, { kind: "event", channel: "session:snapshot", payload }));
  host.sessionManager.on("sessions", (payload) => writeLine(process.stdout, { kind: "event", channel: "session:sessions", payload }));
  // A member drove a party tool inside this engine (member-create / send /
  // remove). Signal the client so it re-fetches and re-broadcasts party state —
  // without this, agent-driven party changes never reach a remote workspace's UI.
  host.sessionManager.on("party", (payload) => writeLine(process.stdout, { kind: "event", channel: "party:changed", payload }));

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

main().catch((error) => {
  process.stderr.write(`ENGINE_SERVER_ERROR ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
