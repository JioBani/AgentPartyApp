import * as fs from "node:fs";
import * as path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, IpcMainInvokeEvent, Menu, screen, shell } from "electron";
import { EmbeddedHarnessRouter } from "../core/routerShim";
import { AutomationApiServer } from "./automationApi";
import { initLogger, log, setDebugLoggingEnabled } from "./logger";
import { getPublicSettings, getSettings } from "./settings";
import { SessionManager } from "./sessionManager";
import { AppController } from "./application/appController";
import { WorkspaceManager } from "./workspaceManager";
import { createEngineHost } from "./engine/engineHost";
import type { EngineRegistry } from "./engine/engineRegistry";
import { spawnWslEngine } from "./engine/transport/wslEngine";
import { RemoteEngineClient } from "./engine/transport/remoteEngineClient";
import { setUserDataDir } from "./userDataDir";
import { parseWorkspaceLocation, serializeWorkspaceLocation, workspaceArgFromArgv } from "../shared/workspaceLocation";
import { WindowRegistry } from "./windowRegistry";
import type { MemberPermissionInput, StartPartyMemberInput, TranscriptSave, WindowInfo } from "../shared/types";
import { workspaceKey } from "../shared/workspaceLocation";
import { sessionsForWindow, windowsServedLocally } from "./sessionListRouting";
import { writeInstanceDiscovery, removeInstanceDiscovery } from "./discovery";
import { sanitizeAttachments } from "../shared/attachments";
import { parseQueueCommand } from "../shared/messageQueue";
import type { UsageLimitsSnapshot } from "../shared/usageLimits";
import { SubscriptionProxyService } from "./subscriptionProxyService";
import { subscriptionProxyConfig } from "../core/subscriptionProxy";
import { reviewGateMessage, type GateReviewMessage } from "../core/messageGateReviewer";
import type { GateReviewer } from "../shared/messageGate";
import { DiscordBridgeService } from "./discordBridgeService";
import { DiscordControlService } from "./discordControl";
import { loadDotEnv } from "./dotenv";
import { DEEPSEEK_API_KEY_ENV } from "../shared/deepseekDefaults";

// Let webContents.capturePage() return real pixels even when the window is
// occluded / behind other windows — the automation /api/capture relies on this
// for headless QA. Chromium's "native window occlusion" marks covered windows
// hidden and stops painting them, so capturePage yields an empty (0x0) image on
// Windows; disabling it (plus the occluded/renderer backgrounding switches)
// keeps frames flowing for a backgrounded window. See electron/electron#31992.
// Must run before app `ready` — module load is early enough.
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
if (process.env.AGENTPARTY_DISABLE_GPU === "1") {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
}
if (process.env.AGENTPARTY_USER_DATA) {
  app.setPath("userData", process.env.AGENTPARTY_USER_DATA);
}

// AgentParty runs as ONE process with MANY windows — any window on any
// workspace, any party. A second launch becomes a window here (see the
// single-instance lock at the bottom of this file).
//
// This reverses 5608fd5 ("remove single-instance lock", 2026-07-07), which
// dropped the lock because it stopped a user from opening the same cwd twice —
// at the time the only way to run two parties side by side was to run two apps.
// Multi-window removes that need, and the multi-process shape turned out to cost
// far more than it bought: session ids are per-process while the party store is
// shared on disk, so two processes on one workspace could not see each other's
// sessions and each started its own harness for the same member. Measured on a
// live install before the fix: one member holding EIGHT `claude` processes on
// the same conversation, ~2.5 GB, still climbing hours later.
//
// Per-workspace coordination did not go away — state still lives in the
// workspace's `.agent_party_app/` and discovery is still per-workspace
// (src/main/discovery.ts), which is what lets a member started here be
// recognised rather than cloned (PartyApplicationService.startMember).

let router: EmbeddedHarnessRouter | undefined;
let sessionManager: SessionManager | undefined;
let workspaceManager: WorkspaceManager | undefined;
let windowRegistry: WindowRegistry | undefined;
let automationApi: AutomationApiServer | undefined;
let appController: AppController | undefined;
let discordBridge: DiscordBridgeService | undefined;
let engineRegistry: EngineRegistry | undefined;
let subscriptionProxyService: SubscriptionProxyService | undefined;

/**
 * Workspace from `--workspace <uri>` in a process argv. Used both by the initial
 * launch (`agent-party` CLI, Explorer "open here") and by the single-instance
 * `second-instance` handler that receives the new process's argv.
 */
function workspaceFromArgv(argv: string[]): string | undefined {
  // Pure resolution lives in the shared, unit-tested `workspaceArgFromArgv`; here
  // we only surface its warning (a launcher that dropped the folder path, or a
  // non-absolute value) so it never silently opens a fabricated workspace.
  const { location, warning } = workspaceArgFromArgv(argv);
  if (warning) {
    log("warn", "window", warning, { argv: argv.slice(1) });
  }
  return location;
}

/** The Discord bridge, or an explicit error — never a silent no-op. */
function requireBridge(): DiscordBridgeService {
  if (!discordBridge) {
    throw new Error("The Discord bridge is not available on the desktop.");
  }
  return discordBridge;
}

function launchWorkspace(): string | undefined {
  return workspaceFromArgv(process.argv);
}

/**
 * Positions a new window on a chosen monitor when `AGENTPARTY_WINDOW_DISPLAY` is
 * set (`left` | `right` | a display index). Used by QA/e2e so the real window
 * opens on the left monitor and doesn't cover the user's other monitor. No-op
 * (normal launch behavior) when the env var is absent.
 */
function placeWindowOnDisplay(window: BrowserWindow): void {
  const target = process.env.AGENTPARTY_WINDOW_DISPLAY;
  if (!target) {
    return;
  }
  try {
    const displays = [...screen.getAllDisplays()].sort((a, b) => a.bounds.x - b.bounds.x);
    if (displays.length === 0) {
      return;
    }
    const index = Number(target);
    const display = Number.isInteger(index) ? displays[Math.max(0, Math.min(index, displays.length - 1))]
      : target === "right" ? displays[displays.length - 1]
      : displays[0];
    const area = display.workArea;
    const [w, h] = window.getSize();
    const width = Math.min(w, area.width);
    const height = Math.min(h, area.height);
    const x = Math.round(area.x + Math.max(0, (area.width - width) / 2));
    const y = Math.round(area.y + Math.max(0, (area.height - height) / 2));
    window.setBounds({ x, y, width, height });
    log("info", "window", "positioned on display", { target, x, y, width, height });
  } catch (error) {
    log("warn", "window", "display positioning failed", { error: error instanceof Error ? error.message : String(error) });
  }
}

function defaultWorkspace(): string {
  return getSettings().workspacePath || process.cwd();
}

async function createWindow(workspacePath: string): Promise<WindowInfo> {
  const window = new BrowserWindow({
    width: 1480,
    height: 960,
    minWidth: 1100,
    minHeight: 720,
    title: "AgentParty",
    backgroundColor: "#0f1419",
    titleBarStyle: "hidden",
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Keep painting when backgrounded so /api/capture works off-foreground.
      backgroundThrottling: false,
    },
  });

  placeWindowOnDisplay(window);

  const entry = registry().register(window, workspacePath);
  window.on("closed", () => {
    log("info", "window", "window closed", { id: entry.id });
    // Drop this window's per-window active-party entry so it can't leak to a
    // future window that happens to reuse the id.
    appController?.forgetWindow(entry.id);
    // Last window for this workspace → tear down its engine (kills a WSL child)
    // and drop its discovery entry.
    if (registry().forWorkspace(entry.workspacePath).length === 0) {
      engineRegistry?.dispose(entry.workspacePath);
    }
    reconcileDiscovery();
  });
  // Advertise this workspace as served by this process (once the API is up).
  reconcileDiscovery();

  const rendererUrl = process.env.AGENTPARTY_RENDERER_URL;
  if (rendererUrl) {
    await window.loadURL(rendererUrl);
    window.webContents.openDevTools({ mode: "detach" });
  } else {
    await window.loadFile(path.join(__dirname, "../../dist-renderer/index.html"));
  }
  log("info", "window", "window created", { id: entry.id, workspacePath: entry.workspacePath });
  return { id: entry.id, workspacePath: entry.workspacePath, focused: true };
}

async function bootstrap(): Promise<void> {
  setUserDataDir(app.getPath("userData"));
  initLogger();
  // Development/QA convenience: a .env next to the app fills env vars that are
  // not already set (e.g. DISCORD_BOT_TOKEN). Logged so a credential's origin is
  // never a mystery. Production credentials live in settings.json.
  const dotEnvKeys = loadDotEnv(app.getAppPath());
  if (dotEnvKeys.length) {
    log("info", "env", ".env values loaded", { keys: dotEnvKeys });
  }
  const settings = getSettings();
  setDebugLoggingEnabled(settings.debugEnabled);
  subscriptionProxyService = new SubscriptionProxyService({
    storageDir: app.getPath("userData"),
    resourcesPath: process.resourcesPath,
    packaged: app.isPackaged,
  });
  const subscriptionStatus = await subscriptionProxyService.ensureRunning();
  subscriptionProxyService.startMonitoring();
  log(subscriptionStatus.ok ? "info" : "error", "subscription-proxy", "automatic subscription bridge check completed", {
    ok: subscriptionStatus.ok,
    baseUrl: subscriptionStatus.baseUrl,
    detail: subscriptionStatus.service?.detail || subscriptionStatus.detail,
  });
  const acpRelayScript = app.isPackaged
    ? path.join(process.resourcesPath, "bin", "agentparty-acp-mcp-relay.mjs")
    : path.join(app.getAppPath(), "scripts", "agentparty-acp-mcp-relay.mjs");
  // The Discord bridge: outbound is the member's MCP tools, inbound is injected
  // through the ordinary party-message path so an idle member is woken and a busy
  // one queues it. See docs/기획 노트.md §11.
  discordBridge = new DiscordBridgeService({
    deliver: async ({ binding, authorName, content, attachments }) => {
      if (!appController) {
        return { delivered: false, error: "app is still starting" };
      }
      // Same wrapper convention as party messages, so a member reads its origin.
      // An image-only message still needs a body: an empty turn reads as "the
      // user said nothing" rather than "look at this".
      const body = content.trim() || `(이미지 ${attachments?.length || 0}장)`;
      const wrapped = `<channel source="discord" from="${authorName}">
${body}
</channel>`;
      try {
        // interrupt: a person typed this from their phone and is waiting. Queuing
        // it behind a long autonomous turn would swallow the instruction for
        // minutes; the adapters' queued-turn drain delivers it once the interrupt
        // settles (a compaction is never torn down — see sendUserMessage).
        const result: any = await appController.sendMemberMessage(binding.workspacePath, binding.member, wrapped, attachments, undefined, { interrupt: true });
        const delivered = result?.partyMessage?.delivered ?? result?.delivered ?? true;
        return { delivered: Boolean(delivered), error: result?.partyMessage?.error || result?.error };
      } catch (error) {
        return { delivered: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    onStatusChanged: (status) => {
      for (const entry of registry().all()) {
        entry.window.webContents.send("discord:update", status);
      }
    },
    log: (message) => log("info", "discord", message),
    // Identifies this process run on a machine where several instances share
    // userData; bindings record it so exactly one of them delivers (§11.14).
    instance: { pid: process.pid, startedAt: discoveryStartedAt },
    // Harness truth behind the delivery receipt: turnCount rises when the message
    // is really submitted to the model, so "received" is observed, not promised.
    memberTurn: async (binding) => {
      const status: any = await controller().handlePartyAction(binding.workspacePath, binding.member, "status", {}, undefined, binding.party);
      const entry = Array.isArray(status?.members) ? status.members.find((m: any) => m?.name === binding.member) : undefined;
      return { turnCount: Number(entry?.turnCount) || 0, turnActive: Boolean(entry?.turnActive) };
    },
  });
  // The control panel: mechanical commands typed in Discord, executed through the
  // same AppController methods the UI and HTTP use. Wired after construction
  // because the two reference each other.
  discordBridge.setControl(new DiscordControlService({
    bridge: () => requireBridge(),
    log: (message) => log("info", "discord", message),
    app: {
      // Only workspaces with an open window: a command must act on what this
      // instance is actually running, not on every folder it has ever opened.
      workspaces: () => [...new Set(registry().all().map((entry) => entry.workspacePath))],
      listParties: async (workspacePath) => {
        const listing: any = await controller().listPartyMembers(workspacePath);
        const members: any[] = Array.isArray(listing?.members) ? listing.members : [];
        return (Array.isArray(listing?.parties) ? listing.parties : []).map((party: any) => ({
          id: String(party?.id || ""),
          name: String(party?.name || party?.id || ""),
          memberCount: members.filter((member) => member?.partyId === party?.id).length,
        }));
      },
      listMembers: async (workspacePath, partyId) => {
        const listing: any = await controller().listPartyMembers(workspacePath, undefined, partyId);
        return (Array.isArray(listing?.members) ? listing.members : [])
          .filter((member: any) => !member?.partyId || member.partyId === partyId)
          .map((member: any) => ({
            name: String(member?.name || ""),
            status: String(member?.status || "unknown"),
            model: member?.model ? String(member.model) : undefined,
            runtime: member?.runtime ? String(member.runtime) : undefined,
          }));
      },
      interruptMember: async (workspacePath, partyId, member) => {
        const result: any = await controller().handlePartyAction(workspacePath, member, "interrupt", {}, undefined, partyId);
        return { interrupted: Boolean(result?.interrupted), message: String(result?.message || "") };
      },
      respawnMember: async (workspacePath, partyId, member) => {
        const result: any = await controller().handlePartyAction(workspacePath, member, "respawn", {}, undefined, partyId);
        return { message: String(result?.message || "") };
      },
    },
  }));
  const host = createEngineHost({
    storageDir: app.getPath("userData"),
    runtimeScope: "desktop",
    router: {
      preferredPort: parsePort(settings.routerBaseUrl),
      authToken: settings.routerAuthToken,
      openRouterApiKey: settings.openRouterApiKey || process.env.OPENROUTER_API_KEY || "",
      deepseekApiKey: settings.deepseekApiKey || process.env[DEEPSEEK_API_KEY_ENV] || "",
      cursorAcpRelayScriptPath: acpRelayScript,
      cursorExecutablePath: () => getSettings().cursorExecutablePath || undefined,
    },
    // Members reach Discord through their party tools; the bridge itself is
    // desktop-owned (it holds the token and the gateway socket).
    discord: discordBridge,
    // Desktop only: a WSL workspace is served by an engine spawned in the distro.
    createRemoteEngine: (location, serialized) => {
      if (location.host.kind !== "wsl") {
        throw new Error(`Unsupported remote host for '${serialized}'.`);
      }
      // In a packaged app the bundle is asar-unpacked (external wsl.exe/cp can't
      // read inside app.asar); use the on-disk unpacked path. No-op in dev.
      const serverBundle = path
        .join(__dirname, "../engine-server.mjs")
        .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
      const codexMcpServer = app.isPackaged
        ? path.join(process.resourcesPath, "bin", "agentparty-codex-mcp-server.mjs")
        : path.join(app.getAppPath(), "scripts", "agentparty-codex-mcp-server.mjs");
      const handle = spawnWslEngine({
        distro: location.host.distro,
        workspacePosix: location.path,
        serverBundleWinPath: serverBundle,
        codexMcpServerWinPath: codexMcpServer,
        acpRelayWinPath: acpRelayScript,
        openRouterApiKey: getSettings().openRouterApiKey || process.env.OPENROUTER_API_KEY || "",
        deepseekApiKey: getSettings().deepseekApiKey || process.env[DEEPSEEK_API_KEY_ENV] || "",
      });
      const client = new RemoteEngineClient(handle.transport, serialized, handle.dispose, {
        // The distro engine owns the gate decision but cannot reach a provider:
        // the subscription bridge and embedded router bind THIS host's loopback.
        // Run the reviewer call here and hand the verdict back, so credentials
        // stay on the desktop and the listeners stay closed.
        // A distro member drove a discord-* tool: run it on the desktop, where the
        // token and the gateway socket live.
        //
        // The workspace path is ALWAYS this connection's `serialized` URI
        // (`wsl+Ubuntu:/path`), never what the engine reported. Inside the distro
        // the workspace is a bare posix path, so trusting it would key the same
        // member two different ways — the desktop's HTTP path and the member's own
        // tool would then bind two separate channels for one member. (Observed:
        // the WSL e2e created a duplicate channel and the agent posted into it.)
        discordConnect: (input: any) => requireBridge().connectMember({ ...input, workspacePath: serialized }),
        discordSend: (_workspacePath: string, party: string, member: string, content: string) =>
          requireBridge().sendAsMember(serialized, party, member, content),
        discordSendImage: (_workspacePath: string, party: string, member: string, image: any, caption?: string) =>
          requireBridge().sendImageAsMember(serialized, party, member, image, caption),
        discordDisconnect: async (_workspacePath: string, party: string, member: string) =>
          requireBridge().disconnectMember(serialized, party, member),
        reviewGate: (message: GateReviewMessage, reviewer: GateReviewer) => {
          // Assigned right after createEngineHost returns, and this closure only
          // runs once a workspace resolves — but say so out loud rather than
          // letting a null deref surface as an opaque gate failure.
          if (!sessionManager) {
            throw new Error("Message Gate review requested before the engine host finished starting.");
          }
          return reviewGateMessage(message, reviewer, {
            routerBaseUrl: sessionManager.routerBaseUrl(),
            routerAuthToken: getSettings().routerAuthToken,
            subscriptionProxy: subscriptionProxyConfig(),
          });
        },
      },
      // The distro engine died on its own. Drop it from the registry so the very
      // next request builds a fresh one; a cached dead client would otherwise
      // reject every call for the rest of the app's life, and the workspace
      // would look permanently broken even though respawning fixes it.
      (error) => {
        log("warn", "engine", "dropping the dead remote engine so the next request respawns it", {
          workspace: serialized,
          error: error.message,
        });
        engineRegistry?.dispose(serialized);
      });
      // Stream the distro engine's live session activity to this workspace's windows.
      client.onEvent((channel, payload) => forwardRemoteEvent(serialized, channel, payload));
      return client;
    },
  });
  router = host.router;
  sessionManager = host.sessionManager;
  workspaceManager = host.workspaceManager;
  engineRegistry = host.engineRegistry;
  await host.startRouter();
  log("info", "router", "embedded router started", { baseUrl: router.baseUrl, openRouterConfigured: Boolean(settings.openRouterApiKey || process.env.OPENROUTER_API_KEY) });

  windowRegistry = new WindowRegistry();

  // Route session streams to the windows viewing that session's workspace.
  sessionManager.on("events", (payload: any) => {
    broadcastToWorkspace(payload.workspace, "session:events", payload);
  });
  sessionManager.on("snapshot", (payload: any) => {
    broadcastToWorkspace(payload.workspace, "session:snapshot", payload);
  });
  // Only the workspaces this process serves — a WSL workspace's list comes from
  // its own engine through forwardRemoteEvent, and `session:list` replaces rather
  // than merges. See main/sessionListRouting.ts for why that matters.
  sessionManager.on("sessions", () => {
    const sessions = sessionManager!.listSessions();
    for (const entry of windowsServedLocally(registry().all())) {
      pushSessionList(entry, "local", sessionsForWindow(sessions, entry.workspacePath));
    }
  });
  // A member drove a party tool in-process (member-create / send / remove);
  // re-broadcast that workspace's party state so its windows update.
  sessionManager.on("party", (payload: { workspace: string }) => {
    void appController?.notifyPartyChanged(payload.workspace);
  });
  // Codex catalog discovery settled (ready or error): push rebuilt model routes
  // so pickers update live and a failure is visible (no silent fallback).
  sessionManager.on("codex-models", () => {
    void appController?.notifyCodexModelsChanged();
  });
  // Provider rate-limit usage changed. These limits are ACCOUNT-global (shared by
  // every workspace/window using that provider), so push to ALL windows.
  sessionManager.on("usage", (snapshot: unknown) => {
    for (const entry of registry().all()) {
      entry.window.webContents.send("usage:update", snapshot);
    }
  });

  appController = new AppController({
    sessionManager,
    engineRegistry: host.engineRegistry,
    windowRegistry,
    subscriptionProxy: subscriptionProxyService,
    getRouterBaseUrl: () => router?.baseUrl || getSettings().routerBaseUrl,
    getAutomationBaseUrl: () => automationApi?.baseUrl || `http://127.0.0.1:${getSettings().automationApiPort}`,
    openWindow: (workspacePath) => createWindow(workspacePath),
    onSettingsChanged: () => applyRuntimeSettings(),
    onWorkspacesChanged: () => reconcileDiscovery(),
    discord: discordBridge,
  });
  automationApi = new AutomationApiServer({
    port: settings.automationApiPort,
    controller: appController,
    windowRegistry,
  });
  // Codex members' party MCP server fetches the automation API by URL; give the
  // SessionManager the ACTUAL bound base URL (lazy — resolved when a member
  // starts, after the API binds) so a port fallback never leaves it fetching a
  // dead configured port ("-32603: fetch failed" on send/list).
  sessionManager.setAutomationBaseUrlProvider(() => automationApi?.baseUrl);
  // Seed the idle-sleep policy before any engine exists, so the registry replays
  // it onto each one it builds. A WSL engine reads the distro's settings.json,
  // never the desktop's, so without this it silently runs on the built-in default.
  void engineRegistry.setIdleSleep(getSettings().idleSleep);
  registerIpc();
  registerApplicationMenu();
  const launched = launchWorkspace();
  log("info", "window", "initial launch workspace", { argv: process.argv.slice(1), resolvedWorkspace: launched, fellBackToDefault: !launched });
  await createWindow(launched || defaultWorkspace());
  await automationApi.start();
  reconcileDiscovery();
  // Re-open the Discord gateway for members bridged in an earlier run, so a
  // restart does not silently stop delivering what the user types there.
  discordBridge.resume();
}

/** Stamp identifying this process run, written into each discovery file. */
const discoveryStartedAt = new Date().toISOString();
/** workspaceKey → serialized workspace path this process currently advertises. */
const advertisedWorkspaces = new Map<string, string>();

/**
 * Syncs per-workspace discovery files to the CURRENT set of open windows: every
 * workspace this process hosts gets a `<workspace>/.agent_party_app/instances/
 * <pid>.json` pointing at the automation API; workspaces no longer hosted are
 * removed. Idempotent — safe to call after any window create/close/rebind.
 * Replaces the old machine-global `<userData>/automation.json` (which a second
 * process, even on a different cwd, overwrote — see docs/FEEDBACK.md).
 */
function reconcileDiscovery(): void {
  const baseUrl = automationApi?.baseUrl;
  // The API binds an ephemeral port; before it starts, baseUrl reads `:0`. Skip
  // until it holds the real port — `bootstrap()` calls this again post-start, and
  // we always (re)write below so an early `:0` is never left stale.
  if (!baseUrl || baseUrl.endsWith(":0")) {
    return;
  }
  const current = new Map<string, string>();
  for (const entry of registry().all()) {
    current.set(workspaceKey(entry.workspacePath), entry.workspacePath);
  }
  // Always write the CURRENT baseUrl for every hosted workspace (idempotent).
  for (const [key, workspace] of current) {
    writeInstanceDiscovery(workspace, baseUrl, discoveryStartedAt);
    advertisedWorkspaces.set(key, workspace);
  }
  // Drop discovery for workspaces this process no longer hosts.
  for (const [key, workspace] of [...advertisedWorkspaces]) {
    if (!current.has(key)) {
      removeInstanceDiscovery(workspace);
      advertisedWorkspaces.delete(key);
    }
  }
}

/** Removes every discovery file this process wrote (on quit). */
function removeAllDiscovery(): void {
  for (const [key, workspace] of [...advertisedWorkspaces]) {
    removeInstanceDiscovery(workspace);
    advertisedWorkspaces.delete(key);
  }
}

/**
 * The one place `session:list` is sent, so its "exactly one producer per window"
 * rule is auditable at runtime instead of only by reading two call sites.
 *
 * `source` is recorded because the failure mode is not a wrong list but a
 * SECOND one: the channel replaces the renderer's array, so a producer that does
 * not own the workspace silently overwrites the owner's list. Debug-level — this
 * fires on every session event, and the answer is only interesting when someone
 * is asking why a member is flickering.
 */
function pushSessionList(entry: { id: string; workspacePath: string; window: BrowserWindow }, source: "local" | "remote", list: unknown): void {
  log("debug", "window", "session list pushed", {
    source,
    window: entry.id,
    workspace: entry.workspacePath,
    count: Array.isArray(list) ? list.length : -1,
  });
  entry.window.webContents.send("session:list", list);
}

function broadcastToWorkspace(workspacePath: string, channel: string, payload: unknown): void {
  for (const entry of registry().forWorkspace(workspacePath)) {
    entry.window.webContents.send(channel, payload);
  }
}

/**
 * Forwards a remote (WSL) engine's pushed session event to the windows viewing
 * its workspace, re-stamping the workspace to the Windows-side URI (the distro
 * sends its own posix path). `session:sessions` maps to the `session:list` IPC.
 */
function forwardRemoteEvent(workspacePath: string, channel: string, payload: any): void {
  if (channel === "session:sessions") {
    const list = Array.isArray(payload) ? payload.map((session) => ({ ...session, workspace: workspacePath })) : payload;
    for (const entry of registry().forWorkspace(workspacePath)) {
      pushSessionList(entry, "remote", list);
    }
    return;
  }
  if (channel === "party:changed") {
    // Re-fetch this remote workspace's party (over RPC) and push party:update.
    void appController?.notifyPartyChanged(workspacePath);
    return;
  }
  if (channel === "codex-models:changed") {
    // The remote engine's codex catalog settled: rebuild and push model routes.
    void appController?.notifyCodexModelsChanged();
    return;
  }
  if (channel === "usage") {
    // Account-global provider rate limits from a WSL engine. Merge into this
    // process's aggregate; the "usage" listener above then pushes usage:update to
    // every window (NOT workspace-stamped — these limits are not per-workspace).
    sessionManager?.mergeRemoteUsage(payload as UsageLimitsSnapshot);
    return;
  }
  const stamped = payload && typeof payload === "object" ? { ...payload, workspace: workspacePath } : payload;
  broadcastToWorkspace(workspacePath, channel, stamped);
}

function focusedWindow(): BrowserWindow | undefined {
  return registry().resolve()?.window;
}

function registerApplicationMenu(): void {
  const navigate = (view: string) => focusedWindow()?.webContents.send("nav:set", { view });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: "File",
      submenu: [
        { label: "New Window", accelerator: "CmdOrCtrl+Shift+N", click: () => void createWindow(defaultWorkspace()) },
        { label: "Choose Workspace", click: () => focusedWindow()?.webContents.send("workspace:choose") },
        { type: "separator" },
        { label: "Close Window", role: "close" },
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Workbench", accelerator: "CmdOrCtrl+1", click: () => navigate("workbench") },
        { label: "Sessions", accelerator: "CmdOrCtrl+2", click: () => navigate("sessions") },
        { label: "Token Usage", accelerator: "CmdOrCtrl+3", click: () => navigate("usage") },
        { label: "Authentication", accelerator: "CmdOrCtrl+4", click: () => navigate("auth") },
        { label: "Runtime", accelerator: "CmdOrCtrl+5", click: () => navigate("runtime") },
        { label: "Automation", accelerator: "CmdOrCtrl+6", click: () => navigate("automation") },
        { type: "separator" },
        { label: "Reload", role: "reload" },
        { label: "Toggle DevTools", role: "toggleDevTools" },
      ],
    },
    {
      label: "Session",
      submenu: [
        { label: "New Party", accelerator: "CmdOrCtrl+N", click: () => focusedWindow()?.webContents.send("session:new") },
        { label: "Refresh History", click: () => focusedWindow()?.webContents.send("session:refreshHistory") },
      ],
    },
  ]));
}

function applyRuntimeSettings(): void {
  const settings = getSettings();
  setDebugLoggingEnabled(settings.debugEnabled);
  router?.updateOptions({
    authToken: settings.routerAuthToken,
    openRouterApiKey: settings.openRouterApiKey || process.env.OPENROUTER_API_KEY || "",
    deepseekApiKey: settings.deepseekApiKey || process.env[DEEPSEEK_API_KEY_ENV] || "",
  });
  log("info", "settings", "runtime settings applied", {
    routerBaseUrl: router?.baseUrl,
    selectedHarnessId: settings.selectedHarnessId,
    harnessDefaults: settings.harnessDefaults,
    openRouterConfigured: Boolean(settings.openRouterApiKey || process.env.OPENROUTER_API_KEY),
    deepseekConfigured: Boolean(settings.deepseekApiKey || process.env[DEEPSEEK_API_KEY_ENV]),
  });
}

function senderWorkspace(event: IpcMainInvokeEvent): string {
  return registry().byWebContents(event.sender)?.workspacePath || defaultWorkspace();
}

function senderWindowId(event: IpcMainInvokeEvent): string | undefined {
  return registry().byWebContents(event.sender)?.id;
}

function registerIpc(): void {
  handle("app:getInitialState", async (event) => controller().getState(senderWorkspace(event), senderWindowId(event)));

  handle("settings:update", async (_event, patch) => controller().updateSettings(patch || {}));

  handle("workspace:choose", async (event) => {
    const window = registry().byWebContents(event.sender)?.window;
    const result = await dialog.showOpenDialog(window!, {
      properties: ["openDirectory"],
      title: "Choose AgentParty workspace",
    });
    if (result.canceled || !result.filePaths[0]) {
      return getPublicSettings();
    }
    // A `\\wsl$\<distro>\...` selection is interpreted as a WSL workspace.
    const workspace = serializeWorkspaceLocation(parseWorkspaceLocation(result.filePaths[0]));
    const state = await controller().setWindowWorkspace(senderWindowId(event), workspace);
    return state.settings;
  });

  handle("auth:list", async () => controller().listAuthProviders());
  handle("auth:setDeepseekKey", async (_event, value: string) => controller().setDeepseekKey(value || ""));
  handle("auth:clearDeepseekKey", async () => controller().clearDeepseekKey());
  handle("auth:testDeepseekKey", async () => controller().testDeepseekKey());
  handle("auth:setOpenRouterKey", async (_event, value: string) => controller().setOpenRouterKey(value || ""));
  handle("auth:clearOpenRouterKey", async () => controller().clearOpenRouterKey());
  handle("auth:testOpenRouterKey", async () => controller().testOpenRouterKey());
  handle("auth:loginSubscription", async (_event, provider: string) => {
    if (provider !== "codex" && provider !== "claude") {
      throw new Error(`Unsupported subscription provider '${provider}'.`);
    }
    return controller().loginSubscriptionProvider(provider);
  });
  handle("auth:disconnectSubscription", async (_event, provider: string) => {
    if (provider !== "codex" && provider !== "claude" && provider !== "cursor") {
      throw new Error(`Unsupported subscription provider '${provider}'.`);
    }
    return controller().disconnectSubscriptionProvider(provider);
  });

  handle("models:list", async (event) => controller().listModels(senderWorkspace(event)));
  handle("models:refreshCodex", async (event) => controller().refreshCodexModels(senderWorkspace(event)));

  handle("discord:get", async () => controller().discordStatus());
  handle("discord:update", async (_event, patch) => controller().updateDiscordSettings(patch as any));
  handle("usage:get", async () => controller().getUsageLimits());
  handle("usage:refresh", async () => controller().refreshUsageLimits());
  handle("tokenUsage:get", async (event, query: unknown) => controller().getTokenUsage(senderWorkspace(event), query as any));
  handle("tokenUsage:turns", async (event, query: unknown) => controller().getTokenUsageTurns(senderWorkspace(event), query as any));

  handle("session:create", async (event, input?: unknown) => controller().createSession(senderWorkspace(event), input as any));
  handle("session:listResumable", async (event, workspacePath?: string) => controller().listResumableSessions(workspacePath || senderWorkspace(event)));
  handle("session:resume", async (event, sessionId: string, workspacePath?: string) => controller().resumeSession(workspacePath || senderWorkspace(event), sessionId));
  handle("session:close", async (event, sessionId: string) => controller().closeSession(senderWorkspace(event), sessionId));
  handle("session:send", async (event, sessionId: string, text: string, attachments?: unknown) => controller().sendSessionMessage(senderWorkspace(event), sessionId, text, sanitizeAttachments(attachments)));
  handle("session:interrupt", async (event, sessionId: string) => controller().interruptSession(senderWorkspace(event), sessionId));
  handle("session:forceStop", async (event, sessionId: string) => controller().forceStopSession(senderWorkspace(event), sessionId));
  handle("session:restart", async (event, sessionId: string) => controller().restartSession(senderWorkspace(event), sessionId));
  handle("session:compact", async (event, sessionId: string) => controller().compactSession(senderWorkspace(event), sessionId));
  handle("session:setModel", async (event, sessionId: string, model: string, providerId?: string, runtimeModel?: string) => {
    await controller().setSessionModel(senderWorkspace(event), sessionId, model, providerId, runtimeModel);
  });
  handle("session:setEffort", async (event, sessionId: string, effort: string) => controller().setSessionEffort(senderWorkspace(event), sessionId, effort));
  handle("session:setThinking", async (event, sessionId: string, mode: string, budget?: number) => controller().setSessionThinking(senderWorkspace(event), sessionId, mode, budget));
  handle("session:setPermissionMode", async (event, sessionId: string, permissionMode: string) => controller().setSessionPermissionMode(senderWorkspace(event), sessionId, permissionMode));
  handle("session:setCodexPolicy", async (event, sessionId: string, policy: any) => controller().setSessionCodexPolicy(senderWorkspace(event), sessionId, policy));
  handle("session:setCursorPolicy", async (event, sessionId: string, policy: any) => controller().setSessionCursorPolicy(senderWorkspace(event), sessionId, policy));
  handle("session:approve", async (event, sessionId: string, requestId: string, behavior: "allow" | "deny", updatedInput?: unknown, message?: string) => {
    await controller().approveSession(senderWorkspace(event), sessionId, requestId, behavior, updatedInput, message);
  });
  handle("session:mcpList", async (event, sessionId: string) => controller().listSessionMcpServers(senderWorkspace(event), sessionId));
  handle("session:mcpReconnect", async (event, sessionId: string, server: string) => controller().sessionMcpAction(senderWorkspace(event), sessionId, "reconnect", { server }));
  handle("session:mcpToggle", async (event, sessionId: string, server: string, enabled: boolean) => controller().sessionMcpAction(senderWorkspace(event), sessionId, "toggle", { server, enabled }));
  handle("session:mcpAuthenticate", async (event, sessionId: string, server: string) => controller().sessionMcpAction(senderWorkspace(event), sessionId, "authenticate", { server }));
  handle("shell:openExternal", async (_event, target: string) => {
    if (/^https?:\/\//i.test(String(target || ""))) {
      await shell.openExternal(String(target));
      return { ok: true };
    }
    return { ok: false, error: "Only http(s) URLs can be opened." };
  });
  // Same AppController method as POST /api/clipboard/image — one route for the
  // thumbnail's copy button and for an agent driving it.
  handle("clipboard:writeImage", async (_event, image: unknown) => controller().writeImageToClipboard((image || {}) as { dataBase64?: string; mediaType?: string }));

  handle("window:minimize", async (event) => controller().minimizeWindow(senderWindowId(event)));
  handle("window:maximize", async (event) => controller().toggleMaximizeWindow(senderWindowId(event)));
  handle("window:close", async (event) => controller().closeWindow(senderWindowId(event)));
  handle("window:new", async (_event, workspacePath?: string, partyId?: string) => controller().openWindow(workspacePath, partyId));
  handle("window:list", async () => controller().listWindows());

  // Party ops carry the SENDER WINDOW id: each window has its own active party, so
  // the same workspace's two windows view/act on different parties independently.
  handle("party:list", async (event) => controller().listPartyMembers(senderWorkspace(event), senderWindowId(event)));
  handle("party:createParty", async (event, input) => controller().createParty(senderWorkspace(event), input, senderWindowId(event)));
  handle("party:select", async (event, partyId: string) => controller().selectParty(senderWorkspace(event), partyId, senderWindowId(event)));
  handle("party:deleteParty", async (event, partyId: string) => controller().removeParty(senderWorkspace(event), partyId, senderWindowId(event)));
  handle("party:create", async (event, input) => controller().createPartyMember(senderWorkspace(event), input, senderWindowId(event)));
  handle("party:send", async (event, to: string, content: string, from?: string, attachments?: unknown) => controller().sendPartyMessage(senderWorkspace(event), to, content, from, sanitizeAttachments(attachments), senderWindowId(event)));
  handle("party:message", async (event, name: string, text: string, attachments?: unknown, options?: { interrupt?: boolean }) => controller().sendMemberMessage(senderWorkspace(event), name, text, sanitizeAttachments(attachments), senderWindowId(event), { interrupt: options?.interrupt === true }));
  handle("party:queue:get", async (event, name: string) => controller().getMemberQueue(senderWorkspace(event), name, senderWindowId(event)));
  // Untrusted-shape validation runs here too, not only on the HTTP edge, so a
  // malformed command from either caller is refused instead of guessed at.
  handle("party:queue:command", async (event, name: string, command: unknown) => controller().runQueueCommand(senderWorkspace(event), name, parseQueueCommand(command), senderWindowId(event)));
  handle("party:close", async (event, name: string) => controller().closePartyMember(senderWorkspace(event), name, senderWindowId(event)));
  handle("party:resume", async (event, name: string) => controller().resumePartyMember(senderWorkspace(event), name, senderWindowId(event)));
  handle("party:respawn", async (event, name: string, input?: StartPartyMemberInput) => controller().respawnPartyMember(senderWorkspace(event), name, optionalArg(input), senderWindowId(event)));
  handle("party:open", async (event, name: string) => controller().openPartyMember(senderWorkspace(event), name, senderWindowId(event)));
  handle("party:start", async (event, name: string, input?: unknown) => controller().startPartyMember(senderWorkspace(event), name, optionalArg(input) as any, senderWindowId(event)));
  handle("party:bind", async (event, name: string, sessionId: string) => controller().bindPartyMember(senderWorkspace(event), name, sessionId, senderWindowId(event)));
  handle("party:remove", async (event, name: string) => controller().removePartyMember(senderWorkspace(event), name, senderWindowId(event)));
  handle("party:autoCompact", async (event, name: string, autoCompact: unknown) => controller().setMemberAutoCompact(senderWorkspace(event), name, autoCompact, senderWindowId(event)));
  // Idle sleep, driven by hand from the sidebar menu. These reach the same three
  // party actions the idle sweep and the HTTP API use — one implementation.
  handle("party:keepAwake", async (event, name: string, keepAwake: boolean) => controller().setMemberKeepAwake(senderWorkspace(event), name, keepAwake === true, senderWindowId(event)));
  handle("party:sleep", async (event, name: string) => controller().sleepPartyMember(senderWorkspace(event), name, senderWindowId(event)));
  handle("party:wake", async (event, name: string) => controller().wakePartyMember(senderWorkspace(event), name, senderWindowId(event)));
  // Member-scoped permission: persists AND applies to the live adapter, so a
  // change made while the member's session is down is not dropped.
  handle("party:permission", async (event, name: string, permission: MemberPermissionInput) => controller().setMemberPermission(senderWorkspace(event), name, permission || {}, senderWindowId(event)));
  handle("party:gate", async (event, name: string, gate: unknown) => controller().setMemberGate(senderWorkspace(event), name, gate, senderWindowId(event)));
  handle("party:partyGate", async (event, partyId: string, gate: unknown) => controller().setPartyGate(senderWorkspace(event), partyId, gate, senderWindowId(event)));
  // Tab layout is PARTY state, not window state: one writer, broadcast to the
  // other windows on that party (see AppController.setPartyLayout).
  handle("party:layout:get", async (event) => controller().getPartyLayout(senderWorkspace(event), senderWindowId(event)));
  handle("party:layout:set", async (event, layout: unknown) => controller().setPartyLayout(senderWorkspace(event), layout, senderWindowId(event)));
  handle("party:transcript:get", async (event, name: string) => controller().getMemberTranscript(senderWorkspace(event), name, senderWindowId(event)));
  handle("party:transcript:save", async (event, name: string, save: TranscriptSave) => controller().saveMemberTranscript(senderWorkspace(event), name, save, senderWindowId(event)));
}

/**
 * Restores `undefined` for an omitted optional argument.
 *
 * Electron serializes an omitted/`undefined` invoke argument as `null`, so a
 * handler's `input?: T` arrives as `null` and any downstream TypeScript default
 * (`input: T = {}`) never fires — the callee then dereferences null. That is
 * exactly how `respawnPartyMember(name)` crashed with "Cannot read properties of
 * null (reading 'selectedHarnessId')". Normalize at the boundary that introduces
 * the null, so every optional-object handler is safe rather than each callee
 * having to re-guard.
 */
function optionalArg<T>(value: T | null | undefined): T | undefined {
  return value === null ? undefined : value;
}

function handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => Promise<unknown> | unknown): void {
  ipcMain.handle(channel, async (event, ...args) => {
    log("info", "ipc", channel, { args: summarizeIpcArgs(args) });
    try {
      return await listener(event, ...args);
    } catch (error) {
      log("error", "ipc", `${channel} failed`, { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  });
}

/**
 * Produces a compact, bounded description of IPC arguments for logging.
 *
 * The generic {@link handle} wrapper used to log the raw `args`, so channels
 * that carry bulk payloads — above all `party:transcript:save`, whose second
 * arg is the member's entire transcript array — dumped tens to hundreds of MB
 * per call into the synchronous log file (see the 2026-07-09 handoff). This
 * describes shape and size WITHOUT deep-serializing large payloads: an array of
 * 100k transcript blocks becomes `"[array 100000 items]"`, never 150 MB of JSON.
 * Diagnostic value (which channel, arg shapes, sizes) is preserved; the raw
 * request/response content lives in the per-session RawLogger, not here.
 */
function summarizeIpcArgs(args: unknown[]): unknown[] {
  return args.map((arg) => describeForLog(arg, 0));
}

const LOG_MAX_STRING = 200;
const LOG_MAX_ARRAY = 20;
const LOG_MAX_KEYS = 30;
const LOG_MAX_DEPTH = 2;

function describeForLog(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return value.length > LOG_MAX_STRING ? `[string ${value.length} chars]` : value;
  }
  if (typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.length > LOG_MAX_ARRAY
      ? `[array ${value.length} items]`
      : value.map((item) => describeForLog(item, depth + 1));
  }
  if (depth >= LOG_MAX_DEPTH) {
    return "[object]";
  }
  const output: Record<string, unknown> = {};
  let count = 0;
  for (const [key, item] of Object.entries(value)) {
    if (count >= LOG_MAX_KEYS) {
      output["…"] = "[more]";
      break;
    }
    count += 1;
    output[key] = describeForLog(item, depth + 1);
  }
  return output;
}

function controller(): AppController {
  if (!appController) {
    throw new Error("App controller is not initialized.");
  }
  return appController;
}

function registry(): WindowRegistry {
  if (!windowRegistry) {
    throw new Error("Window registry is not initialized.");
  }
  return windowRegistry;
}

/** Preferred router port from a configured baseUrl; 0 (ephemeral) when unset. */
function parsePort(baseUrl: string): number {
  try {
    return Number(new URL(baseUrl).port || 0);
  } catch {
    return 0;
  }
}

/**
 * One AgentParty process per machine — a second launch becomes a WINDOW here.
 *
 * The party store lives on disk next to the workspace, but a session id only
 * means anything inside the process that created it. Two processes on one
 * workspace therefore could not see each other's sessions, and each started its
 * own harness for the same member, overwrote the shared binding, and abandoned
 * the other's process. Measured on a live install: one member holding EIGHT
 * `claude` processes on the same conversation, ~2.5 GB, still growing.
 *
 * Multiplexing was never the problem — the app is already built for it.
 * `EngineRegistry.forWorkspace` keys engines BY WORKSPACE, `WindowRegistry`
 * tracks the workspace each window is viewing, and every request already routes
 * through `engineFor(workspacePath)` / `partyForWindow(windowId)`. So one
 * process can hold many workspaces and many parties at once; nothing but this
 * lock was missing. (`main.ts` even documented a `second-instance` handler that
 * did not exist.)
 *
 * `AGENTPARTY_ALLOW_MULTI_INSTANCE=1` keeps the old behaviour for QA: the e2e
 * scripts drive several isolated apps at once and pass it already.
 */
const allowMultiInstance = process.env.AGENTPARTY_ALLOW_MULTI_INSTANCE === "1";
if (!allowMultiInstance && !app.requestSingleInstanceLock()) {
  // Another instance owns the lock; it will open our workspace as a window.
  app.quit();
} else {
  if (!allowMultiInstance) {
    app.on("second-instance", (_event, argv) => {
      const requested = workspaceFromArgv(argv);
      log("info", "window", "second instance folded into this process", { argv: argv.slice(1), resolvedWorkspace: requested });
      // The lock is taken before `whenReady`, so a launch that races our own
      // startup can land here while `bootstrap` is still running — and
      // `registry()` throws until it finishes. Dropping the event is right: the
      // window bootstrap is about to open serves that user just as well.
      if (!windowRegistry) {
        log("info", "window", "second instance arrived during startup; the launching window covers it");
        return;
      }
      // A relaunch with no workspace is "show me the app", not "open a second
      // window of the same thing" — surface what is already open instead.
      const existing = registry().all();
      if (!requested && existing.length > 0) {
        const target = existing[0].window;
        if (target.isMinimized()) {
          target.restore();
        }
        target.focus();
        return;
      }
      void createWindow(requested || defaultWorkspace()).catch((error) => {
        log("error", "window", "could not open a window for the second instance", { error: error instanceof Error ? error.message : String(error) });
      });
    });
  }

  app.whenReady().then(bootstrap).catch((error) => {
    dialog.showErrorBox("AgentParty failed to start", error instanceof Error ? error.message : String(error));
    app.quit();
  });
}

app.on("activate", () => {
  if (registry().all().length === 0) {
    void createWindow(defaultWorkspace());
  }
});

app.on("before-quit", () => {
  log("info", "app", "before quit");
  removeAllDiscovery();
  engineRegistry?.disposeAll();
  sessionManager?.dispose();
  router?.dispose();
  automationApi?.dispose();
  subscriptionProxyService?.dispose();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
