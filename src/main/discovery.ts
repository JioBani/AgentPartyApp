import * as fs from "node:fs";
import * as path from "node:path";
import { parseWorkspaceLocation } from "../shared/workspaceLocation";
import { log } from "./logger";

/**
 * Per-WORKSPACE automation discovery — how external tools (the `agent-party`
 * CLI, member liveness checks, QA scripts) find the app process serving a given
 * workspace, WITHOUT a machine-global file that different cwds / multiple
 * processes would clobber.
 *
 * Each process advertises itself under the workspace's OWN storage:
 *   `<workspace>/.agent_party_app/instances/<pid>.json` = { baseUrl, pid, workspace, startedAt }
 *
 * A per-pid file (not one shared file) means several processes can serve the
 * same workspace and all be discoverable; a reader scans the directory and
 * prunes dead pids. Different workspaces live in different directories, so
 * cross-cwd processes never interfere. For a WSL workspace the file lives inside
 * the distro (`\\wsl$\<distro>\...`) so the in-distro shim reads the same path.
 */

const ROOT_DIR = ".agent_party_app";
const INSTANCES_DIR = "instances";

/** The `.agent_party_app/instances` dir on the host where the workspace lives. */
function instancesDir(workspace: string): string {
  const loc = parseWorkspaceLocation(workspace);
  if (loc.host.kind === "wsl") {
    // Windows UNC view of the distro path — the same ext4 dir the shim sees.
    const rel = loc.path.replace(/^\/+/, "").replace(/\//g, "\\");
    return path.win32.join(`\\\\wsl$\\${loc.host.distro}`, rel, ROOT_DIR, INSTANCES_DIR);
  }
  return path.join(loc.path, ROOT_DIR, INSTANCES_DIR);
}

function instanceFile(workspace: string): string {
  return path.join(instancesDir(workspace), `${process.pid}.json`);
}

/** Advertises this process as serving `workspace` at `baseUrl`. */
export function writeInstanceDiscovery(workspace: string, baseUrl: string, startedAt: string): void {
  try {
    const file = instanceFile(workspace);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ baseUrl, pid: process.pid, workspace, startedAt }, null, 2)}\n`);
  } catch (error) {
    log("warn", "discovery", "failed to write instance discovery", { workspace, error: msg(error) });
  }
}

/** Removes THIS process's discovery entry for a workspace (best-effort). */
export function removeInstanceDiscovery(workspace: string): void {
  try {
    fs.rmSync(instanceFile(workspace), { force: true });
  } catch {
    // Best-effort cleanup only — a stale entry is pruned by readers on liveness.
  }
}

function msg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
