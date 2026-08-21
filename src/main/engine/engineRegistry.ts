import * as path from "node:path";
import { isWslLocation, parseWorkspaceLocation, workspaceKey, type WorkspaceLocation } from "../../shared/workspaceLocation";
import type { SessionManager } from "../sessionManager";
import type { WorkspaceManager } from "../workspaceManager";
import type { EngineConnection } from "./engineConnection";
import { LocalEngine } from "./localEngine";
import type { IdleSleepSettings } from "../../shared/idleSleep";
import type { MemberMessagingSettings } from "../../shared/memberMessaging";

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
  /** Latest idle-sleep policy, replayed onto engines built later (see setIdleSleep). */
  private idleSleep: IdleSleepSettings | undefined;
  private memberMessaging: MemberMessagingSettings | undefined;

  constructor(private readonly deps: EngineRegistryDeps) {}

  forWorkspace(workspacePath: string): EngineConnection {
    assertUsableWorkspaceLocation(workspacePath);
    const key = workspaceKey(workspacePath);
    let engine = this.engines.get(key);
    if (!engine) {
      engine = this.create(workspacePath);
      this.engines.set(key, engine);
      // Replayed rather than fetched: an engine built later (a workspace opened
      // after startup) would otherwise run on its own host's settings file,
      // which for a distro is a different file entirely.
      if (this.idleSleep) {
        void engine.setIdleSleep(this.idleSleep).catch(() => undefined);
      }
      if (this.memberMessaging) {
        void engine.setMemberMessaging(this.memberMessaging).catch(() => undefined);
      }
    }
    return engine;
  }

  /**
   * Which LIVE workspace owns `partyId`, preferring `preferred` when it does.
   *
   * A harness that reaches the app over HTTP (Codex) carries no window id, so
   * the API falls back to the focused window's workspace — and one process
   * serves every open window. A Codex member in the second window therefore had
   * its party tools executed against the FIRST window's workspace, where its own
   * name does not exist: "Member 'refactor' is not in this party."
   *
   * The party id the member already sends is the reliable key. It also avoids
   * the workspace-path trap: a WSL engine knows its workspace as a bare posix
   * path while the desktop knows it as `wsl+Distro:/path`, so routing by path
   * would break exactly where routing matters most.
   *
   * Only live engines are consulted — a member's session exists only where its
   * engine is running, so there is nothing to find on disk.
   */
  async workspaceOwningParty(partyId: string, preferred?: string): Promise<string | undefined> {
    const owns = async (engine: EngineConnection) => {
      try {
        return (await engine.listParty(undefined)).parties.some((party) => party.id === partyId);
      } catch {
        return false;   // an engine that cannot answer cannot be the owner
      }
    };
    if (preferred) {
      const engine = this.engines.get(workspaceKey(preferred));
      if (engine && await owns(engine)) {
        return engine.workspacePath;
      }
    }
    for (const engine of this.engines.values()) {
      if (await owns(engine)) {
        return engine.workspacePath;
      }
    }
    return undefined;
  }

  /** Applies the desktop's idle-sleep policy to every currently hosted engine. */
  async setIdleSleep(settings: IdleSleepSettings): Promise<void> {
    this.idleSleep = settings;
    await Promise.all([...this.engines.values()].map((engine) => engine.setIdleSleep(settings).catch(() => undefined)));
  }

  /** Applies the desktop's member-message default to every hosted engine. */
  async setMemberMessaging(settings: MemberMessagingSettings): Promise<void> {
    this.memberMessaging = settings;
    await Promise.all([...this.engines.values()].map((engine) => engine.setMemberMessaging(settings).catch(() => undefined)));
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

/**
 * Rejects a workspace whose meaning would depend on whichever cwd happens to
 * launch the engine. This boundary covers UI, HTTP, CLI and restored settings;
 * validating only the launcher left the automation API able to create the same
 * fabricated relative workspaces the launcher already refuses.
 */
function assertUsableWorkspaceLocation(workspacePath: string): void {
  const location = parseWorkspaceLocation(workspacePath);
  if (location.host.kind === "wsl") {
    if (!location.host.distro || !path.posix.isAbsolute(location.path)) {
      throw new Error(`WSL workspace '${workspacePath}' must name a distro and an absolute POSIX path.`);
    }
    return;
  }
  if (!path.isAbsolute(location.path)) {
    throw new Error(`Workspace '${workspacePath}' must be an absolute path.`);
  }
}

/** A remote engine owns a child process; LocalEngine has nothing to tear down. */
function disposeEngine(engine: EngineConnection | undefined): void {
  const maybe = engine as { dispose?: () => void } | undefined;
  if (typeof maybe?.dispose === "function") {
    maybe.dispose();
  }
}
