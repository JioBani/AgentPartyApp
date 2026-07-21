import { PartyApplicationService } from "./application/partyApplicationService";
import { workspaceKey } from "../shared/workspaceLocation";
import type { SessionManager } from "./sessionManager";
import { getSettings } from "./settings";
import { subscriptionProxyConfig } from "../core/subscriptionProxy";
import { reviewGateMessage, type GateReviewMessage } from "../core/messageGateReviewer";
import type { GateReviewer } from "../shared/messageGate";

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
      // Headless Message Gate reviewer, bound to the LIVE router + current
      // settings + subscription proxy — the same transports real sessions use.
      reviewGate: (message: GateReviewMessage, reviewer: GateReviewer) => {
        const settings = getSettings();
        return reviewGateMessage(message, reviewer, {
          routerBaseUrl: sessionManager.routerBaseUrl(),
          routerAuthToken: settings.routerAuthToken,
          subscriptionProxy: subscriptionProxyConfig(),
        });
      },
    });
  }
}

/** Lazily creates and caches one {@link WorkspaceContext} per workspace path. */
export class WorkspaceManager {
  private contexts = new Map<string, WorkspaceContext>();

  constructor(private readonly sessionManager: SessionManager) {}

  context(workspacePath: string): WorkspaceContext {
    const key = workspaceKey(workspacePath || process.cwd());
    let context = this.contexts.get(key);
    if (!context) {
      context = new WorkspaceContext(key, this.sessionManager);
      this.contexts.set(key, context);
    }
    return context;
  }
}
