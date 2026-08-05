import * as os from "node:os";
import * as path from "node:path";

/**
 * Base directory for app-level data (settings.json, logs) — Electron's
 * `userData` on the desktop, or an engine-chosen dir when running headless
 * (e.g. inside a WSL distro). Injected rather than read from `electron.app` so
 * the engine core bundles and runs under plain node. See the WSL remote-engine design.
 *
 * Configure once at startup: the desktop main sets it to `app.getPath("userData")`,
 * a headless engine host to its own storage dir.
 */
let userDataDir = process.env.AGENTPARTY_USER_DATA || path.join(os.homedir(), ".agent_party_app");

export function setUserDataDir(dir: string): void {
  if (dir) {
    userDataDir = dir;
  }
}

export function getUserDataDir(): string {
  return userDataDir;
}
