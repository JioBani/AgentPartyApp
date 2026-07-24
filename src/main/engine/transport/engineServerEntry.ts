import { setConsoleLogging } from "../../logger";
import { createEngineHost } from "../engineHost";
import { AppController } from "../../application/appController";
import { AutomationApiServer } from "../../automationApi";
import { WindowRegistry } from "../../windowRegistry";
import { serveEngine } from "./engineServer";
import { HostChannel } from "./hostChannel";
import { writeLine } from "./rpc";
import type { GateReviewResult } from "../../../shared/messageGate";

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

  // The Message Gate reviewer is the one piece of engine work that CANNOT run
  // here: it talks to the subscription bridge / embedded router, both bound to
  // the desktop's 127.0.0.1, which from inside a distro is the distro's own
  // loopback. Delegating it upward keeps the verdict, badge and rejection record
  // in this engine (where the party state lives) while the credentialed HTTP call
  // stays on the host. Without this the review throws on every message and the
  // fail-open policy delivers them all unreviewed.
  const hostChannel = new HostChannel(process.stdout);
  const host = createEngineHost({
    storageDir: storage,
    router: {
      preferredPort: 0,
      authToken: "engine",
      openRouterApiKey: process.env.OPENROUTER_API_KEY || "",
      // Cursor-subscription cross-harness models run HERE (the distro owns the
      // cursor-agent login), unlike the gate reviewer which must run upward.
      cursorAcpRelayScriptPath: process.env.AGENTPARTY_ACP_RELAY_SCRIPT || undefined,
    },
    reviewGate: (message, reviewer) => hostChannel.call<GateReviewResult>("reviewGate", message, reviewer),
  });
  // Start the embedded router so router-backed models (MiniMax M3, etc.) work —
  // it runs inside the distro alongside the harness. preferredPort 0 binds a
  // free port; without this the harness sees the router at 127.0.0.1:0.
  await host.startRouter();
  const engine = host.engineRegistry.forWorkspace(workspace);

  // Codex party tools reach the app through the local automation HTTP API. In a
  // headless engine (e.g. inside a WSL distro), the desktop's automation API is
  // NOT reachable across the process/network boundary — 127.0.0.1 there is the
  // distro loopback, not the Windows host — so a Codex member's party MCP server
  // gets "-32603: fetch failed" on every tool. Serve the SAME automation surface
  // locally on the distro's loopback, backed by this engine (which owns this
  // workspace's party state), and hand its real URL to the harness. An empty
  // WindowRegistry is correct headless: there are no windows to broadcast to, and
  // `defaultWorkspace` resolves every request to the one workspace served here.
  const windowRegistry = new WindowRegistry();
  let automationApi: AutomationApiServer | undefined;
  const appController = new AppController({
    sessionManager: host.sessionManager,
    engineRegistry: host.engineRegistry,
    windowRegistry,
    getRouterBaseUrl: () => host.router.baseUrl,
    getAutomationBaseUrl: () => automationApi?.baseUrl || "",
    openWindow: () => Promise.reject(new Error("openWindow is not supported in the headless engine server")),
    onSettingsChanged: () => undefined,
    onWorkspacesChanged: () => undefined,
  });
  automationApi = new AutomationApiServer({ port: 0, controller: appController, windowRegistry, defaultWorkspace: workspace });
  await automationApi.start();
  // Bake the ACTUAL bound URL into every Codex session this engine spawns, so the
  // in-distro party MCP server fetches a live local endpoint (never 127.0.0.1:0).
  host.sessionManager.setAutomationBaseUrlProvider(() => automationApi?.baseUrl);

  serveEngine(engine, process.stdin, process.stdout, hostChannel);

  // Push this workspace's live session activity to the client over the same
  // channel (distinguished from RPC responses by `kind: "event"`).
  host.sessionManager.on("events", (payload) => writeLine(process.stdout, { kind: "event", channel: "session:events", payload }));
  host.sessionManager.on("snapshot", (payload) => writeLine(process.stdout, { kind: "event", channel: "session:snapshot", payload }));
  host.sessionManager.on("sessions", (payload) => writeLine(process.stdout, { kind: "event", channel: "session:sessions", payload }));
  // A member drove a party tool inside this engine (member-create / send /
  // remove). Signal the client so it re-fetches and re-broadcasts party state —
  // without this, agent-driven party changes never reach a remote workspace's UI.
  host.sessionManager.on("party", (payload) => writeLine(process.stdout, { kind: "event", channel: "party:changed", payload }));
  // Codex model discovery settled inside this engine — signal the client so it
  // re-fetches routes and pushes models:update (same rule: no silent state).
  host.sessionManager.on("codex-models", (payload) => writeLine(process.stdout, { kind: "event", channel: "codex-models:changed", payload }));
  // Provider rate-limit usage changed inside this engine (Claude rate_limit_event
  // / Codex account/rateLimits/updated). These limits are account-global, so the
  // client merges them into its own snapshot — without this the desktop's usage
  // indicator for a WSL workspace is stuck on "불러오는 중…" forever.
  host.sessionManager.on("usage", (payload) => writeLine(process.stdout, { kind: "event", channel: "usage", payload }));

  const shutdown = () => {
    hostChannel.dispose();
    automationApi?.dispose();
    host.dispose();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.stdin.on("close", shutdown);

  // Readiness handshake on stderr (stdout is reserved for RPC). The in-distro
  // automation base URL is appended for diagnostics/tests; existing readers match
  // the token with `includes()`, so the suffix is backwards-compatible.
  process.stderr.write(`ENGINE_SERVER_READY ${automationApi.baseUrl}\n`);
}

main().catch((error) => {
  process.stderr.write(`ENGINE_SERVER_ERROR ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
