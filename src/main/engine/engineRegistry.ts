import { parseWorkspaceLocation, workspaceKey } from "../../shared/workspaceLocation";
import type { SessionManager } from "../sessionManager";
import type { WorkspaceManager } from "../workspaceManager";
import type { EngineConnection } from "./engineConnection";
import { LocalEngine } from "./localEngine";

export interface EngineRegistryDeps {
  workspaceManager: WorkspaceManager;
  sessionManager: SessionManager;
}

/**
 * Resolves a workspace to the {@link EngineConnection} that serves it. Local
 * workspaces get an in-process {@link LocalEngine}; WSL workspaces will get a
 * remote engine in later stages. One connection per workspace identity, so
 * same-workspace windows share it (the locked single-source rule, extended to
 * `(host, workspace)`). See docs/WSL_REMOTE.md §6.
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
      // Surfaced explicitly — never silently downgraded to a local Windows run.
      throw new Error(
        `WSL workspace '${workspacePath}' requires the remote engine, which is not available yet ` +
          "(see docs/WSL_REMOTE.md, stages S3–S5).",
      );
    }
    return new LocalEngine({
      workspacePath,
      party: this.deps.workspaceManager.context(workspacePath).party,
      sessionManager: this.deps.sessionManager,
    });
  }
}
