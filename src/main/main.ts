import * as fs from "node:fs";
import * as path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, IpcMainInvokeEvent, Menu, screen, shell } from "electron";
import { EmbeddedRouter } from "../core/routerShim";
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
import type { StartPartyMemberInput, WindowInfo } from "../shared/types";
import { workspaceKey } from "../shared/workspaceLocation";
import { writeInstanceDiscovery, removeInstanceDiscovery } from "./discovery";
import { sanitizeAttachments } from "../shared/attachments";
import type { UsageLimitsSnapshot } from "../shared/usageLimits";
import { SubscriptionProxyService } from "./subscriptionProxyService";

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

// AgentParty runs as MANY independent processes — one per launch, for the same
// cwd or different cwds. There is NO machine-global single-instance lock (it made
// every process share/clobber global state, and forced a second launch to defer
// to the first). Coordination is per-workspace instead: state lives in the
// workspace's `.agent_party_app/` and discovery is per-workspace
// (src/main/discovery.ts). "Open this workspace in the running app rather than a
// duplicate" is the `agent-party` CLI's job (it finds the workspace's process via
// discovery and asks it to open a window), not a global OS lock.

let router: EmbeddedRouter | undefined;
let sessionManager: SessionManager | undefined;
let workspaceManager: WorkspaceManager | undefined;
let windowRegistry: WindowRegistry | undefined;
let automationApi: AutomationApiServer | undefined;
let appController: AppController | undefined;
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
  const host = createEngineHost({
    storageDir: app.getPath("userData"),
    router: {
      preferredPort: parsePort(settings.routerBaseUrl),
      authToken: settings.routerAuthToken,
      openRouterApiKey: settings.openRouterApiKey || process.env.OPENROUTER_API_KEY || "",
    },
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
        openRouterApiKey: getSettings().openRouterApiKey || process.env.OPENROUTER_API_KEY || "",
      });
      const client = new RemoteEngineClient(handle.transport, serialized, handle.dispose);
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
  sessionManager.on("sessions", () => {
    for (const entry of registry().all()) {
      const key = workspaceKey(entry.workspacePath);
      const subset = sessionManager!.listSessions().filter((session) => workspaceKey(session.workspace) === key);
      entry.window.webContents.send("session:list", subset);
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
  registerIpc();
  registerApplicationMenu();
  const launched = launchWorkspace();
  log("info", "window", "initial launch workspace", { argv: process.argv.slice(1), resolvedWorkspace: launched, fellBackToDefault: !launched });
  await createWindow(launched || defaultWorkspace());
  await automationApi.start();
  reconcileDiscovery();
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
      entry.window.webContents.send("session:list", list);
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
  const navigate = (view: string) => focusedWindow()?.webContents.send("nav:set", view);
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
        { label: "Authentication", accelerator: "CmdOrCtrl+3", click: () => navigate("auth") },
        { label: "Runtime", accelerator: "CmdOrCtrl+4", click: () => navigate("runtime") },
        { label: "Automation", accelerator: "CmdOrCtrl+5", click: () => navigate("automation") },
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
  });
  log("info", "settings", "runtime settings applied", {
    routerBaseUrl: router?.baseUrl,
    selectedHarnessId: settings.selectedHarnessId,
    harnessDefaults: settings.harnessDefaults,
    openRouterConfigured: Boolean(settings.openRouterApiKey || process.env.OPENROUTER_API_KEY),
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
  handle("auth:setOpenRouterKey", async (_event, value: string) => controller().setOpenRouterKey(value || ""));
  handle("auth:clearOpenRouterKey", async () => controller().clearOpenRouterKey());
  handle("auth:testOpenRouterKey", async () => controller().testOpenRouterKey());
  handle("auth:loginSubscription", async (_event, provider: string) => {
    if (provider !== "codex" && provider !== "claude") {
      throw new Error(`Unsupported subscription provider '${provider}'.`);
    }
    return controller().loginSubscriptionProvider(provider);
  });

  handle("models:list", async (event) => controller().listModels(senderWorkspace(event)));
  handle("models:refreshCodex", async (event) => controller().refreshCodexModels(senderWorkspace(event)));

  handle("usage:get", async () => controller().getUsageLimits());
  handle("usage:refresh", async () => controller().refreshUsageLimits());

  handle("session:create", async (event, input?: unknown) => controller().createSession(senderWorkspace(event), input as any));
  handle("session:listResumable", async (event, workspacePath?: string) => controller().listResumableSessions(workspacePath || senderWorkspace(event)));
  handle("session:resume", async (event, sessionId: string, workspacePath?: string) => controller().resumeSession(workspacePath || senderWorkspace(event), sessionId));
  handle("session:close", async (event, sessionId: string) => controller().closeSession(senderWorkspace(event), sessionId));
  handle("session:send", async (event, sessionId: string, text: string, attachments?: unknown) => controller().sendSessionMessage(senderWorkspace(event), sessionId, text, sanitizeAttachments(attachments)));
  handle("session:interrupt", async (event, sessionId: string) => controller().interruptSession(senderWorkspace(event), sessionId));
  handle("session:restart", async (event, sessionId: string) => controller().restartSession(senderWorkspace(event), sessionId));
  handle("session:compact", async (event, sessionId: string) => controller().compactSession(senderWorkspace(event), sessionId));
  handle("session:setModel", async (event, sessionId: string, model: string, providerId?: string, runtimeModel?: string) => {
    await controller().setSessionModel(senderWorkspace(event), sessionId, model, providerId, runtimeModel);
  });
  handle("session:setEffort", async (event, sessionId: string, effort: string) => controller().setSessionEffort(senderWorkspace(event), sessionId, effort));
  handle("session:setThinking", async (event, sessionId: string, mode: string, budget?: number) => controller().setSessionThinking(senderWorkspace(event), sessionId, mode, budget));
  handle("session:setPermissionMode", async (event, sessionId: string, permissionMode: string) => controller().setSessionPermissionMode(senderWorkspace(event), sessionId, permissionMode));
  handle("session:setCodexPolicy", async (event, sessionId: string, policy: any) => controller().setSessionCodexPolicy(senderWorkspace(event), sessionId, policy));
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

  handle("window:minimize", async (event) => controller().minimizeWindow(senderWindowId(event)));
  handle("window:maximize", async (event) => controller().toggleMaximizeWindow(senderWindowId(event)));
  handle("window:close", async (event) => controller().closeWindow(senderWindowId(event)));
  handle("window:new", async (_event, workspacePath?: string) => controller().openWindow(workspacePath));
  handle("window:list", async () => controller().listWindows());

  // Party ops carry the SENDER WINDOW id: each window has its own active party, so
  // the same workspace's two windows view/act on different parties independently.
  handle("party:list", async (event) => controller().listPartyMembers(senderWorkspace(event), senderWindowId(event)));
  handle("party:createParty", async (event, input) => controller().createParty(senderWorkspace(event), input, senderWindowId(event)));
  handle("party:select", async (event, partyId: string) => controller().selectParty(senderWorkspace(event), partyId, senderWindowId(event)));
  handle("party:deleteParty", async (event, partyId: string) => controller().removeParty(senderWorkspace(event), partyId, senderWindowId(event)));
  handle("party:create", async (event, input) => controller().createPartyMember(senderWorkspace(event), input, senderWindowId(event)));
  handle("party:send", async (event, to: string, content: string, from?: string, attachments?: unknown) => controller().sendPartyMessage(senderWorkspace(event), to, content, from, sanitizeAttachments(attachments), senderWindowId(event)));
  handle("party:message", async (event, name: string, text: string, attachments?: unknown) => controller().sendMemberMessage(senderWorkspace(event), name, text, sanitizeAttachments(attachments), senderWindowId(event)));
  handle("party:close", async (event, name: string) => controller().closePartyMember(senderWorkspace(event), name, senderWindowId(event)));
  handle("party:resume", async (event, name: string) => controller().resumePartyMember(senderWorkspace(event), name, senderWindowId(event)));
  handle("party:respawn", async (event, name: string, input?: StartPartyMemberInput) => controller().respawnPartyMember(senderWorkspace(event), name, input, senderWindowId(event)));
  handle("party:open", async (event, name: string) => controller().openPartyMember(senderWorkspace(event), name, senderWindowId(event)));
  handle("party:start", async (event, name: string, input?: unknown) => controller().startPartyMember(senderWorkspace(event), name, input as any, senderWindowId(event)));
  handle("party:bind", async (event, name: string, sessionId: string) => controller().bindPartyMember(senderWorkspace(event), name, sessionId, senderWindowId(event)));
  handle("party:remove", async (event, name: string) => controller().removePartyMember(senderWorkspace(event), name, senderWindowId(event)));
  handle("party:autoCompact", async (event, name: string, autoCompact: unknown) => controller().setMemberAutoCompact(senderWorkspace(event), name, autoCompact, senderWindowId(event)));
  handle("party:transcript:get", async (event, name: string) => controller().getMemberTranscript(senderWorkspace(event), name, senderWindowId(event)));
  handle("party:transcript:save", async (event, name: string, blocks: unknown[]) => controller().saveMemberTranscript(senderWorkspace(event), name, blocks, senderWindowId(event)));
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

app.whenReady().then(bootstrap).catch((error) => {
  dialog.showErrorBox("AgentParty failed to start", error instanceof Error ? error.message : String(error));
  app.quit();
});

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
