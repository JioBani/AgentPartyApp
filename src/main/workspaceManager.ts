import * as path from "node:path";
import { PartyApplicationService } from "./application/partyApplicationService";
import type { SessionManager } from "./sessionManager";

/**
 * The single in-memory source of truth for one workspace. All windows viewing
 * the same workspace share this context, so a change in one window is reflected
 * in the others (the broadcast happens in the window layer).
 */
export class WorkspaceContext {
  readonly party: PartyApplicationService;

  constructor(readonly workspacePath: string, sessionManager: SessionManager) {
    this.party = new PartyApplicationService({
      sessionManager,
      getWorkspacePath: () => this.workspacePath,
    });
  }
}

/** Lazily creates and caches one {@link WorkspaceContext} per workspace path. */
export class WorkspaceManager {
  private contexts = new Map<string, WorkspaceContext>();

  constructor(private readonly sessionManager: SessionManager) {}

  context(workspacePath: string): WorkspaceContext {
    const key = path.resolve(workspacePath || process.cwd());
    let context = this.contexts.get(key);
    if (!context) {
      context = new WorkspaceContext(key, this.sessionManager);
      this.contexts.set(key, context);
    }
    return context;
  }
}
