import * as path from "node:path";
import { EmbeddedHarnessRouter } from "../../core/routerShim";
import { SessionManager } from "../sessionManager";
import { WorkspaceManager, type ReviewGate } from "../workspaceManager";
import { setUserDataDir } from "../userDataDir";
import { EngineRegistry } from "./engineRegistry";
import type { EngineRegistryDeps } from "./engineRegistry";
import type { DiscordBridgePort, PartyExecutionLocationPort } from "../application/partyApplicationService";
import type { PartyBridge } from "../../core/partyBridge";
import type { HostedPartySessionBinding } from "../../shared/types";
import { RemoteHarnessSession, type RemoteHarnessSessionOptions } from "../harness/remoteHarnessSession";

export interface EngineHostConfig {
  /** Base dir for harness debug logs (Electron userData on desktop; an
   *  engine-chosen dir when headless, e.g. `~/.agent_party_app` in a distro). */
  storageDir: string;
  /** Stable identity for processes sharing storage (notably one per WSL workspace). */
  runtimeScope?: string;
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
  /** Headless execution-engine hook that delegates hosted member tools to their owner. */
  createHostedPartyBridge?: (binding: HostedPartySessionBinding) => PartyBridge;
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
  /** Desktop-global validator and suggestion catalog for member execution cwd. */
  executionLocations?: PartyExecutionLocationPort;
}

/**
 * The engine — assembled without any Electron dependency, so the exact same
 * bootstrap runs in the desktop main process and as a standalone headless
 * process inside a WSL distro (under the distro's node). See the WSL remote-engine design
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
  let engineRegistry!: EngineRegistry;
  const sessionManager = new SessionManager(router, config.storageDir, config.runtimeScope, {
    createCrossHostAdapter: config.createRemoteEngine
      ? (input) => {
          const engine = engineRegistry.forWorkspace(input.target) as ReturnType<EngineRegistry["forWorkspace"]> & {
            onEvent?: (listener: (channel: string, payload: unknown) => void) => () => void;
          };
          if (typeof engine.onEvent !== "function") {
            throw new Error(`Execution engine '${input.target}' does not expose a session event stream.`);
          }
          return new RemoteHarnessSession({ ...input, engine: engine as RemoteHarnessSessionOptions["engine"] });
        }
      : undefined,
    createHostedPartyBridge: config.createHostedPartyBridge,
  });
  const workspaceManager = new WorkspaceManager(sessionManager, config.reviewGate, config.discord, config.executionLocations);
  engineRegistry = new EngineRegistry({ workspaceManager, sessionManager, createRemoteEngine: config.createRemoteEngine });

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
