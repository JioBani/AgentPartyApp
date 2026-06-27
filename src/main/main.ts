import * as fs from "node:fs";
import * as path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, IpcMainInvokeEvent, Menu } from "electron";
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
import { parseWorkspaceLocation, serializeWorkspaceLocation } from "../shared/workspaceLocation";
import { WindowRegistry } from "./windowRegistry";
import type { WindowInfo } from "../shared/types";
import { workspaceKey } from "../shared/workspaceLocation";

let router: EmbeddedRouter | undefined;
let sessionManager: SessionManager | undefined;
let workspaceManager: WorkspaceManager | undefined;
let windowRegistry: WindowRegistry | undefined;
let automationApi: AutomationApiServer | undefined;
let appController: AppController | undefined;
let engineRegistry: EngineRegistry | undefined;

/** `AgentParty.exe --workspace <uri>` (used by the agent-party CLI auto-launch). */
function launchWorkspace(): string | undefined {
  const index = process.argv.indexOf("--workspace");
  const value = index >= 0 ? process.argv[index + 1] : "";
  return value ? serializeWorkspaceLocation(parseWorkspaceLocation(value)) : undefined;
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
    },
  });

  const entry = registry().register(window, workspacePath);
  window.on("closed", () => {
    log("info", "window", "window closed", { id: entry.id });
    // Last window for this workspace → tear down its engine (kills a WSL child).
    if (registry().forWorkspace(entry.workspacePath).length === 0) {
      engineRegistry?.dispose(entry.workspacePath);
    }
  });

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

  appController = new AppController({
    sessionManager,
    engineRegistry: host.engineRegistry,
    windowRegistry,
    getRouterBaseUrl: () => router?.baseUrl || getSettings().routerBaseUrl,
    getAutomationBaseUrl: () => automationApi?.baseUrl || `http://127.0.0.1:${getSettings().automationApiPort}`,
    openWindow: (workspacePath) => createWindow(workspacePath),
    onSettingsChanged: () => applyRuntimeSettings(),
  });
  automationApi = new AutomationApiServer({
    port: settings.automationApiPort,
    controller: appController,
    windowRegistry,
  });
  registerIpc();
  registerApplicationMenu();
  await createWindow(launchWorkspace() || defaultWorkspace());
  await automationApi.start();
  writeAutomationDiscovery();
}

/**
 * Publishes the automation URL to <userData>/automation.json so the agent-party
 * CLI's Windows launcher can find the running app (the port may be a fallback).
 * See docs/WSL_REMOTE.md §13.
 */
function writeAutomationDiscovery(): void {
  try {
    const file = path.join(app.getPath("userData"), "automation.json");
    fs.writeFileSync(file, `${JSON.stringify({ baseUrl: automationApi?.baseUrl, pid: process.pid }, null, 2)}\n`);
  } catch (error) {
    log("warn", "automation", "failed to write discovery file", { error: error instanceof Error ? error.message : String(error) });
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
        { label: "Party", accelerator: "CmdOrCtrl+3", click: () => navigate("party") },
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
  });
  log("info", "settings", "runtime settings applied", {
    routerBaseUrl: router?.baseUrl,
    selectedProviderId: settings.selectedProviderId,
    claudeModel: settings.claudeModel,
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

  handle("session:create", async (event, input?: unknown) => controller().createSession(senderWorkspace(event), input as any));
  handle("session:listResumable", async (event, workspacePath?: string) => controller().listResumableSessions(workspacePath || senderWorkspace(event)));
  handle("session:resume", async (event, sessionId: string, workspacePath?: string) => controller().resumeSession(workspacePath || senderWorkspace(event), sessionId));
  handle("session:close", async (event, sessionId: string) => controller().closeSession(senderWorkspace(event), sessionId));
  handle("session:send", async (event, sessionId: string, text: string) => controller().sendSessionMessage(senderWorkspace(event), sessionId, text));
  handle("session:interrupt", async (event, sessionId: string) => controller().interruptSession(senderWorkspace(event), sessionId));
  handle("session:restart", async (event, sessionId: string) => controller().restartSession(senderWorkspace(event), sessionId));
  handle("session:compact", async (event, sessionId: string) => controller().compactSession(senderWorkspace(event), sessionId));
  handle("session:setModel", async (event, sessionId: string, model: string, providerId?: string, runtimeModel?: string) => {
    await controller().setSessionModel(senderWorkspace(event), sessionId, model, providerId, runtimeModel);
  });
  handle("session:setEffort", async (event, sessionId: string, effort: string) => controller().setSessionEffort(senderWorkspace(event), sessionId, effort));
  handle("session:setPermissionMode", async (event, sessionId: string, permissionMode: string) => controller().setSessionPermissionMode(senderWorkspace(event), sessionId, permissionMode));
  handle("session:approve", async (event, sessionId: string, requestId: string, behavior: "allow" | "deny", updatedInput?: unknown, message?: string) => {
    await controller().approveSession(senderWorkspace(event), sessionId, requestId, behavior, updatedInput, message);
  });

  handle("window:minimize", async (event) => controller().minimizeWindow(senderWindowId(event)));
  handle("window:maximize", async (event) => controller().toggleMaximizeWindow(senderWindowId(event)));
  handle("window:close", async (event) => controller().closeWindow(senderWindowId(event)));
  handle("window:new", async (_event, workspacePath?: string) => controller().openWindow(workspacePath));
  handle("window:list", async () => controller().listWindows());

  handle("party:list", async (event) => controller().listPartyMembers(senderWorkspace(event)));
  handle("party:createParty", async (event, input) => controller().createParty(senderWorkspace(event), input));
  handle("party:select", async (event, partyId: string) => controller().selectParty(senderWorkspace(event), partyId));
  handle("party:create", async (event, input) => controller().createPartyMember(senderWorkspace(event), input));
  handle("party:send", async (event, to: string, content: string, from?: string) => controller().sendPartyMessage(senderWorkspace(event), to, content, from));
  handle("party:close", async (event, name: string) => controller().closePartyMember(senderWorkspace(event), name));
  handle("party:resume", async (event, name: string) => controller().resumePartyMember(senderWorkspace(event), name));
  handle("party:open", async (event, name: string) => controller().openPartyMember(senderWorkspace(event), name));
  handle("party:start", async (event, name: string, input?: unknown) => controller().startPartyMember(senderWorkspace(event), name, input as any));
  handle("party:bind", async (event, name: string, sessionId: string) => controller().bindPartyMember(senderWorkspace(event), name, sessionId));
  handle("party:remove", async (event, name: string) => controller().removePartyMember(senderWorkspace(event), name));
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
