import { EmbeddedRouter } from "../../core/routerShim";
import { SessionManager } from "../sessionManager";
import { WorkspaceManager } from "../workspaceManager";
import { setUserDataDir } from "../userDataDir";
import { EngineRegistry } from "./engineRegistry";
import type { EngineRegistryDeps } from "./engineRegistry";

export interface EngineHostConfig {
  /** Base dir for harness debug logs (Electron userData on desktop; an
   *  engine-chosen dir when headless, e.g. `~/.agent_party_app` in a distro). */
  storageDir: string;
  router: {
    preferredPort: number;
    authToken: string;
    openRouterApiKey?: string;
  };
  /** Desktop-only: builds a connection to an engine in another host (WSL). */
  createRemoteEngine?: EngineRegistryDeps["createRemoteEngine"];
}

/**
 * The engine — assembled without any Electron dependency, so the exact same
 * bootstrap runs in the desktop main process and as a standalone headless
 * process inside a WSL distro (under the distro's node). See docs/WSL_REMOTE.md
 * §4/§8. The desktop wires its windows/IPC/automation API around this; a
 * headless host drives it directly or over a transport.
 */
export interface EngineHost {
  readonly router: EmbeddedRouter;
  readonly sessionManager: SessionManager;
  readonly workspaceManager: WorkspaceManager;
  readonly engineRegistry: EngineRegistry;
  /** Starts the embedded router (router-backed models). Optional for mock-only runs. */
  startRouter(): Promise<void>;
  dispose(): void;
}

export function createEngineHost(config: EngineHostConfig): EngineHost {
  setUserDataDir(config.storageDir);
  const router = new EmbeddedRouter({
    preferredPort: config.router.preferredPort,
    authToken: config.router.authToken,
    openRouterApiKey: config.router.openRouterApiKey || "",
  });
  const sessionManager = new SessionManager(router, config.storageDir);
  const workspaceManager = new WorkspaceManager(sessionManager);
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
