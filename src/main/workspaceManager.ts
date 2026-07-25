import { PartyApplicationService, type DiscordBridgePort } from "./application/partyApplicationService";
import { workspaceKey } from "../shared/workspaceLocation";
import type { SessionManager } from "./sessionManager";
import { getSettings } from "./settings";
import { subscriptionProxyConfig } from "../core/subscriptionProxy";
import { reviewGateMessage, type GateReviewMessage } from "../core/messageGateReviewer";
import type { GateReviewer, GateReviewResult } from "../shared/messageGate";

/**
 * The single in-memory source of truth for one workspace. All windows viewing
 * the same workspace share this context, so a change in one window is reflected
 * in the others (the broadcast happens in the window layer).
 */
export class WorkspaceContext {
  readonly party: PartyApplicationService;

  constructor(readonly workspacePath: string, sessionManager: SessionManager, reviewGate?: ReviewGate, discord?: DiscordBridgePort) {
    this.party = new PartyApplicationService({
      sessionManager,
      getWorkspacePath: () => this.workspacePath,
      discord,
      // Headless Message Gate reviewer, bound to the LIVE router + current
      // settings + subscription proxy — the same transports real sessions use.
      reviewGate: reviewGate || ((message: GateReviewMessage, reviewer: GateReviewer) => {
        const settings = getSettings();
        return reviewGateMessage(message, reviewer, {
          routerBaseUrl: sessionManager.routerBaseUrl(),
          routerAuthToken: settings.routerAuthToken,
          subscriptionProxy: subscriptionProxyConfig(),
        });
      }),
    });
  }
}

/** How a workspace's Message Gate reviews one message. */
export type ReviewGate = (message: GateReviewMessage, reviewer: GateReviewer) => Promise<GateReviewResult>;

/** Lazily creates and caches one {@link WorkspaceContext} per workspace path. */
export class WorkspaceManager {
  private contexts = new Map<string, WorkspaceContext>();

  /**
   * `reviewGate` overrides how the Message Gate reaches a model. A headless
   * engine inside a distro passes one that delegates to the desktop, because the
   * provider transports bind the desktop's loopback and are unreachable from
   * there — without it every review throws and the fail-open policy delivers
   * messages unreviewed.
   */
  constructor(private readonly sessionManager: SessionManager, private readonly reviewGate?: ReviewGate, private readonly discord?: DiscordBridgePort) {}

  context(workspacePath: string): WorkspaceContext {
    const key = workspaceKey(workspacePath || process.cwd());
    let context = this.contexts.get(key);
    if (!context) {
      context = new WorkspaceContext(key, this.sessionManager, this.reviewGate, this.discord);
      this.contexts.set(key, context);
    }
    return context;
  }
}
