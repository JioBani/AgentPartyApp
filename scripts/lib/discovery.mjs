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

/** Every advertisement for a workspace, with the metadata, not just the URL. */
export function discoverInstances(workspace) {
  try {
    const dir = instancesDir(workspace);
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => { try { return JSON.parse(readFileSync(path.join(dir, f), "utf8")); } catch { return null; } })
      .filter((entry) => entry && entry.baseUrl);
  } catch {
    return [];
  }
}

/**
 * The endpoint of the app you just STARTED, waiting for it to come up.
 *
 * Two ways to get the wrong answer here, and this has been bitten by both:
 *
 *   1. A killed app leaves its advertisement behind. Taking the first entry
 *      hands back that corpse forever, and the caller times out reporting "the
 *      app never came up" while it is up and listening on the entry behind it.
 *   2. An app someone left running on the same workspace ANSWERS. Taking the
 *      first entry that responds then attaches the caller to a different
 *      process — usually an older build — and everything it measures or
 *      photographs afterwards is true of an app nobody asked about.
 *
 * The second is the more dangerous: it produces confident, wrong output rather
 * than an error. So pass `since` (the moment before the launch) and only an app
 * that advertised itself after that point is accepted.
 */
export async function waitForLiveBaseUrl(workspace, options = {}) {
  const { timeoutMs = 60_000, since = 0 } = typeof options === "number" ? { timeoutMs: options } : options;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    for (const instance of discoverInstances(workspace)) {
      if (since && !isNewerThan(instance, since)) {
        continue;
      }
      try {
        const response = await fetch(`${instance.baseUrl}/api/health`);
        if (response.ok && (await response.json()).ok) return instance.baseUrl;
      } catch { /* dead or still starting — try the next one */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return "";
}

/** An advertisement with no timestamp predates this check; treat it as old. */
function isNewerThan(instance, since) {
  const at = Date.parse(instance.startedAt || "");
  return Number.isFinite(at) && at >= since;
}

/** Every app currently answering on a workspace — for a caller that owns it. */
export async function liveInstances(workspace) {
  const alive = [];
  for (const instance of discoverInstances(workspace)) {
    try {
      const response = await fetch(`${instance.baseUrl}/api/health`);
      if (response.ok && (await response.json()).ok) alive.push(instance);
    } catch { /* not answering */ }
  }
  return alive;
}
