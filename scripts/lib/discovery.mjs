/*
 * Per-workspace automation discovery — the reader side of src/main/discovery.ts,
 * for QA scripts. A running app advertises itself at
 * `<workspace>/.agent_party_app/instances/<pid>.json`. Discovery is per-workspace
 * (no machine-global file), so a script targeting one workspace never picks up a
 * process serving a different cwd.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** The instances dir for a workspace (local path or `wsl+<distro>:/path` URI). */
export function instancesDir(workspace) {
  const wsl = /^wsl\+([^:]+):(.*)$/.exec(workspace);
  if (wsl) {
    const rel = (wsl[2] || "/").replace(/^\/+/, "").replace(/\//g, "\\");
    return path.win32.join(`\\\\wsl$\\${wsl[1].trim()}`, rel, ".agent_party_app", "instances");
  }
  return path.join(workspace, ".agent_party_app", "instances");
}

/** Every advertised baseUrl for a workspace (liveness is the caller's to check). */
export function discoverBaseUrls(workspace) {
  try {
    const dir = instancesDir(workspace);
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => { try { return JSON.parse(readFileSync(path.join(dir, f), "utf8")).baseUrl || ""; } catch { return ""; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** The first advertised baseUrl for a workspace (or "" if none yet). */
export function firstBaseUrl(workspace) {
  return discoverBaseUrls(workspace)[0] || "";
}
