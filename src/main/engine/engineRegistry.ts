import { isWslLocation, parseWorkspaceLocation, workspaceKey, type WorkspaceLocation } from "../../shared/workspaceLocation";
import type { SessionManager } from "../sessionManager";
import type { WorkspaceManager } from "../workspaceManager";
import type { EngineConnection } from "./engineConnection";
import { LocalEngine } from "./localEngine";
import type { CodexAuthenticationApplyResult, CodexAuthenticationUpdate } from "../../shared/codexAuthentication";
import type { IdleSleepSettings } from "../../shared/idleSleep";

export interface EngineRegistryDeps {
  workspaceManager: WorkspaceManager;
  sessionManager: SessionManager;
  /**
   * Builds a connection to an engine running in another host (e.g. a WSL
   * distro). Provided by the desktop; absent in a headless engine, which never
   * nests remotes. When absent, a WSL workspace is an explicit error.
   */
  createRemoteEngine?: (location: WorkspaceLocation, serialized: string) => EngineConnection;
}

/**
 * Resolves a workspace to the {@link EngineConnection} that serves it. Local
 * workspaces get an in-process {@link LocalEngine}; WSL workspaces get a remote
 * engine (running inside the distro). One connection per workspace identity, so
 * same-(host,workspace) windows share it — the locked single-source rule.
 * See the WSL remote-engine design §6.
 */
export class EngineRegistry {
  private readonly engines = new Map<string, EngineConnection>();
  private codexAuthentication: CodexAuthenticationUpdate | undefined;
  /** Latest idle-sleep policy, replayed onto engines built later (see setIdleSleep). */
  private idleSleep: IdleSleepSettings | undefined;

  constructor(private readonly deps: EngineRegistryDeps) {}

  forWorkspace(workspacePath: string): EngineConnection {
    const key = workspaceKey(workspacePath);
    let engine = this.engines.get(key);
    if (!engine) {
      engine = this.create(workspacePath);
      this.engines.set(key, engine);
      if (this.codexAuthentication) {
        void engine.setCodexAuthentication(this.codexAuthentication).catch(() => undefined);
      }
      // Replayed rather than fetched: an engine built later (a workspace opened
      // after startup) would otherwise run on its own host's settings file,
      // which for a distro is a different file entirely.
      if (this.idleSleep) {
        void engine.setIdleSleep(this.idleSleep).catch(() => undefined);
      }
    }
    return engine;
  }

  /** Applies one account generation to every currently hosted engine. */
  async setCodexAuthentication(update: CodexAuthenticationUpdate): Promise<CodexAuthenticationApplyResult[]> {
    this.codexAuthentication = update;
    return Promise.all([...this.engines.values()].map((engine) => engine.setCodexAuthentication(update)));
  }

  /** Applies the desktop's idle-sleep policy to every currently hosted engine. */
  async setIdleSleep(settings: IdleSleepSettings): Promise<void> {
    this.idleSleep = settings;
    await Promise.all([...this.engines.values()].map((engine) => engine.setIdleSleep(settings).catch(() => undefined)));
  }

  /** Tears down the engine for a workspace (e.g. when its last window closes). */
  dispose(workspacePath: string): void {
    const key = workspaceKey(workspacePath);
    disposeEngine(this.engines.get(key));
    this.engines.delete(key);
  }

  disposeAll(): void {
    for (const engine of this.engines.values()) {
      disposeEngine(engine);
    }
    this.engines.clear();
  }

  private create(workspacePath: string): EngineConnection {
    const location = parseWorkspaceLocation(workspacePath);
    // Shares one predicate with everything that asks "does THIS process serve
    // that workspace" (main's session-list broadcast). Two spellings of the same
    // rule drifting apart is how a workspace ends up with two producers.
    if (isWslLocation(location)) {
      if (!this.deps.createRemoteEngine) {
        // Surfaced explicitly — never silently downgraded to a local Windows run.
        throw new Error(
          `WSL workspace '${workspacePath}' requires the remote engine, which is not configured in this process.`,
        );
      }
      return this.deps.createRemoteEngine(location, workspacePath);
    }
    return new LocalEngine({
      workspacePath,
      party: this.deps.workspaceManager.context(workspacePath).party,
      sessionManager: this.deps.sessionManager,
    });
  }
}

/** A remote engine owns a child process; LocalEngine has nothing to tear down. */
function disposeEngine(engine: EngineConnection | undefined): void {
  const maybe = engine as { dispose?: () => void } | undefined;
  if (typeof maybe?.dispose === "function") {
    maybe.dispose();
  }
}
