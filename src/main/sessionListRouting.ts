/**
 * Who may write a window's session list.
 *
 * `session:list` REPLACES the renderer's whole session array rather than merging
 * into it, so a workspace with two producers does not get a union — it gets
 * whichever message landed last. That makes "exactly one producer per window"
 * an invariant, not a preference.
 *
 * There are two producers in the desktop:
 *
 *   - this process's SessionManager, which holds in-process sessions only, and
 *   - each remote (WSL) engine, forwarding the list from inside its distro.
 *
 * A WSL workspace is served by the remote engine, so this process holds none of
 * its sessions and the filtered subset it would send is always empty. Sending it
 * anyway made the two producers alternate a full list with an empty one, and a
 * member flickered idle ↔ not-started for as long as any local session stayed
 * active. Hosting several workspaces in ONE process (the single-instance change)
 * turned that from rare into constant, because a local session's every event
 * fired the empty broadcast at the WSL windows.
 */
import { isWslLocation, parseWorkspaceLocation, workspaceKey } from "../shared/workspaceLocation";

/** The minimum a window entry must expose to be routed. */
export interface WorkspaceScopedWindow {
  workspacePath: string;
}

/**
 * Whether a workspace is served by an engine in another host process rather than
 * this one. The single rule behind two decisions that must agree: which engine
 * {@link EngineRegistry} builds for a workspace, and which windows this process
 * may push a session list to.
 */
export function workspaceRunsRemotely(workspacePath: string): boolean {
  return isWslLocation(parseWorkspaceLocation(workspacePath));
}

/** The windows whose session list this process's SessionManager owns. */
export function windowsServedLocally<T extends WorkspaceScopedWindow>(entries: readonly T[]): T[] {
  return entries.filter((entry) => !workspaceRunsRemotely(entry.workspacePath));
}

/** The sessions this process holds for one window's workspace. */
export function sessionsForWindow<S extends { workspace: string }>(sessions: readonly S[], workspacePath: string): S[] {
  const key = workspaceKey(workspacePath);
  return sessions.filter((session) => workspaceKey(session.workspace) === key);
}
