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
import type { WindowInfo } from "../shared/types";
import { workspaceKey } from "../shared/workspaceLocation";
import { writeInstanceDiscovery, removeInstanceDiscovery } from "./discovery";
import { sanitizeAttachments } from "../shared/attachments";

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

// One running instance owns all windows for a workspace (shared in-memory
// source + a single engine per workspace storage). A second launch — Explorer
// "open here", another `agent-party` call — must forward its argv to us instead
// of starting a rival process. QA/e2e launches a single process, so the lock is
// harmless there. Skipped when QA explicitly allows parallel instances.
const allowMultiInstance = process.env.AGENTPARTY_ALLOW_MULTI_INSTANCE === "1";
const gotInstanceLock = allowMultiInstance || app.requestSingleInstanceLock();
if (!gotInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => handleSecondInstance(argv));
}

let router: EmbeddedRouter | undefined;
let sessionManager: SessionManager | undefined;
let workspaceManager: WorkspaceManager | undefined;
let windowRegistry: WindowRegistry | undefined;
let automationApi: AutomationApiServer | undefined;
let appController: AppController | undefined;
let engineRegistry: EngineRegistry | undefined;

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

/** Brings an open window to the foreground (restoring it if minimized). */
function focusWindow(window: BrowserWindow): void {
  if (window.isMinimized()) {
    window.restore();
  }
  window.show();
  window.focus();
}

/**
 * Routes a re-launch (Explorer "open here", a second `agent-party` invocation)
 * into the already-running instance: focus the window already viewing that
 * workspace, else open a new window for it — never a duplicate engine on the
 * same workspace storage.
 */
function handleSecondInstance(argv: string[]): void {
  const workspace = workspaceFromArgv(argv);
  // Diagnostic: the reported "opens the app's own folder instead of the picked
  // one" bug lands here (a re-launch while an instance holds the single-instance
  // lock). Log the raw argv + what we resolved so a live repro is pinpointable.
  log("info", "window", "second-instance launch", { argv: argv.slice(1), resolvedWorkspace: workspace, fellBackToDefault: !workspace });
  const target = workspace ? windowRegistry?.forWorkspace(workspace)[0] : undefined;
  if (target) {
    focusWindow(target.window);
    return;
  }
  if (workspace) {
    void createWindow(workspace);
    return;
  }
  const existing = windowRegistry?.all()[0];
  if (existing) {
    focusWindow(existing.window);
  } else {
    void createWindow(defaultWorkspace());
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
      const handle = spawnWslEngine({
        distro: location.host.distro,
        workspacePosix: location.path,
        serverBundleWinPath: serverBundle,
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

  appController = new AppController({
    sessionManager,
    engineRegistry: host.engineRegistry,
    windowRegistry,
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
  if (!baseUrl) {
    return;
  }
  const current = new Map<string, string>();
  for (const entry of registry().all()) {
    current.set(workspaceKey(entry.workspacePath), entry.workspacePath);
  }
  for (const [key, workspace] of current) {
    if (!advertisedWorkspaces.has(key)) {
      writeInstanceDiscovery(workspace, baseUrl, discoveryStartedAt);
      advertisedWorkspaces.set(key, workspace);
    }
  }
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
  handle("app:getInitialState", async (event) => controller().getState(senderWorkspace(event)));

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

  handle("models:list", async (event) => controller().listModels(senderWorkspace(event)));
  handle("models:refreshCodex", async (event) => controller().refreshCodexModels(senderWorkspace(event)));

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

  handle("party:list", async (event) => controller().listPartyMembers(senderWorkspace(event)));
  handle("party:createParty", async (event, input) => controller().createParty(senderWorkspace(event), input));
  handle("party:select", async (event, partyId: string) => controller().selectParty(senderWorkspace(event), partyId));
  handle("party:deleteParty", async (event, partyId: string) => controller().removeParty(senderWorkspace(event), partyId));
  handle("party:create", async (event, input) => controller().createPartyMember(senderWorkspace(event), input));
  handle("party:send", async (event, to: string, content: string, from?: string, attachments?: unknown) => controller().sendPartyMessage(senderWorkspace(event), to, content, from, sanitizeAttachments(attachments)));
  handle("party:message", async (event, name: string, text: string, attachments?: unknown) => controller().sendMemberMessage(senderWorkspace(event), name, text, sanitizeAttachments(attachments)));
  handle("party:close", async (event, name: string) => controller().closePartyMember(senderWorkspace(event), name));
  handle("party:resume", async (event, name: string) => controller().resumePartyMember(senderWorkspace(event), name));
  handle("party:open", async (event, name: string) => controller().openPartyMember(senderWorkspace(event), name));
  handle("party:start", async (event, name: string, input?: unknown) => controller().startPartyMember(senderWorkspace(event), name, input as any));
  handle("party:bind", async (event, name: string, sessionId: string) => controller().bindPartyMember(senderWorkspace(event), name, sessionId));
  handle("party:remove", async (event, name: string) => controller().removePartyMember(senderWorkspace(event), name));
  handle("party:transcript:get", async (event, name: string) => controller().getMemberTranscript(senderWorkspace(event), name));
  handle("party:transcript:save", async (event, name: string, blocks: unknown[]) => controller().saveMemberTranscript(senderWorkspace(event), name, blocks));
}

function handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => Promise<unknown> | unknown): void {
  ipcMain.handle(channel, async (event, ...args) => {
    log("info", "ipc", channel, { args });
    try {
      return await listener(event, ...args);
    } catch (error) {
      log("error", "ipc", `${channel} failed`, { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  });
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

function parsePort(baseUrl: string): number {
  try {
    return Number(new URL(baseUrl).port || 3455);
  } catch {
    return 3455;
  }
}

if (gotInstanceLock) {
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
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
