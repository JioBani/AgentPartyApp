import * as path from "node:path";
import { EmbeddedHarnessRouter } from "../../core/routerShim";
import { SessionManager } from "../sessionManager";
import { WorkspaceManager, type ReviewGate } from "../workspaceManager";
import { setUserDataDir } from "../userDataDir";
import { EngineRegistry } from "./engineRegistry";
import type { EngineRegistryDeps } from "./engineRegistry";
import type { DiscordBridgePort } from "../application/partyApplicationService";

export interface EngineHostConfig {
  /** Base dir for harness debug logs (Electron userData on desktop; an
   *  engine-chosen dir when headless, e.g. `~/.agent_party_app` in a distro). */
  storageDir: string;
  router: {
    preferredPort: number;
    authToken: string;
    openRouterApiKey?: string;
    /** DeepSeek official API key; enables provider "deepseek" catalog models. */
    deepseekApiKey?: string;
    /** Enables Cursor-subscription cross-harness models (the ACP bridge). */
    cursorAcpRelayScriptPath?: string;
    cursorExecutablePath?: () => string | undefined;
  };
  /** Desktop-only: builds a connection to an engine in another host (WSL). */
  createRemoteEngine?: EngineRegistryDeps["createRemoteEngine"];
  /**
   * Overrides how the Message Gate reaches a reviewer model. Set by a headless
   * engine running away from the desktop's loopback (a WSL distro), where the
   * subscription bridge and embedded router cannot be reached directly.
   */
  reviewGate?: ReviewGate;
  /**
   * Discord bridge for the party tools. Desktop-only: a headless engine has no
   * bridge, and the tools then report that plainly instead of doing nothing.
   */
  discord?: DiscordBridgePort;
}

/**
 * The engine — assembled without any Electron dependency, so the exact same
 * bootstrap runs in the desktop main process and as a standalone headless
 * process inside a WSL distro (under the distro's node). See docs/WSL_REMOTE.md
 * §4/§8. The desktop wires its windows/IPC/automation API around this; a
 * headless host drives it directly or over a transport.
 */
export interface EngineHost {
  readonly router: EmbeddedHarnessRouter;
  readonly sessionManager: SessionManager;
  readonly workspaceManager: WorkspaceManager;
  readonly engineRegistry: EngineRegistry;
  /** Starts the embedded router (router-backed models). Optional for mock-only runs. */
  startRouter(): Promise<void>;
  dispose(): void;
}

export function createEngineHost(config: EngineHostConfig): EngineHost {
  setUserDataDir(config.storageDir);
  const router = new EmbeddedHarnessRouter({
    preferredPort: config.router.preferredPort,
    authToken: config.router.authToken,
    openRouterApiKey: config.router.openRouterApiKey || "",
    deepseekApiKey: config.router.deepseekApiKey || "",
    cursorBridge: config.router.cursorAcpRelayScriptPath
      ? {
          relayScriptPath: config.router.cursorAcpRelayScriptPath,
          workspacesDir: path.join(config.storageDir, "acp-bridge"),
          cursorExecutablePath: config.router.cursorExecutablePath,
        }
      : undefined,
  });
  const sessionManager = new SessionManager(router, config.storageDir);
  const workspaceManager = new WorkspaceManager(sessionManager, config.reviewGate, config.discord);
  const engineRegistry = new EngineRegistry({ workspaceManager, sessionManager, createRemoteEngine: config.createRemoteEngine });

  return {
    router,
    sessionManager,
    workspaceManager,
    engineRegistry,
    startRouter: () => router.start(),
    dispose: () => {
      sessionManager.dispose();
      router.dispose();
    },
  };
}
