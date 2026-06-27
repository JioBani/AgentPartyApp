import { parseWorkspaceLocation, workspaceKey, type WorkspaceLocation } from "../../shared/workspaceLocation";
import type { SessionManager } from "../sessionManager";
import type { WorkspaceManager } from "../workspaceManager";
import type { EngineConnection } from "./engineConnection";
import { LocalEngine } from "./localEngine";

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
 * See docs/WSL_REMOTE.md §6.
 */
export class EngineRegistry {
  private readonly engines = new Map<string, EngineConnection>();

  constructor(private readonly deps: EngineRegistryDeps) {}

  forWorkspace(workspacePath: string): EngineConnection {
    const key = workspaceKey(workspacePath);
    let engine = this.engines.get(key);
    if (!engine) {
      engine = this.create(workspacePath);
      this.engines.set(key, engine);
    }
    return engine;
  }

  private create(workspacePath: string): EngineConnection {
    const location = parseWorkspaceLocation(workspacePath);
    if (location.host.kind === "wsl") {
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
