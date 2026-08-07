/*
 * Regression: a member flickering idle ↔ not-started.
 *
 * Reported against `wsl+Ubuntu-20.04:/home/spdlqj8876/Claude`, party CARR-935,
 * member `req`: the row alternated between the two states many times a second
 * while another window in the SAME process was working on a Windows workspace.
 *
 * Nothing was restarting the member — the backend log for that window showed one
 * `party:start` and no loop. The renderer's session array was being overwritten
 * from two places. `session:list` REPLACES that array, so this process's
 * SessionManager (which holds no WSL sessions, and therefore sends an empty
 * list) and the WSL engine (which sends the real one) took turns, and
 * deriveStatus read `!session` → "not-started" every other message.
 *
 * The rule this pins down: a window whose workspace runs in another host process
 * is not this process's to speak for. Asserted at the routing seam rather than
 * through the UI because the bug is in WHO sends, not in what is rendered.
 */
import { build } from "esbuild";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { qaTempDir } from "./lib/qaTemp.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const built = await build({
  entryPoints: [path.join(projectRoot, "src/main/sessionListRouting.ts")],
  bundle: true, format: "esm", platform: "node", write: false, external: ["electron"],
});
const bundlePath = path.join(qaTempDir(), "session-list-routing.mjs");
writeFileSync(bundlePath, built.outputFiles[0].text);
const { sessionsForWindow, windowsServedLocally, workspaceRunsRemotely } = await import(pathToFileURL(bundlePath).href);

let failures = 0;
function assert(condition, label, detail) {
  console.log(`  ${condition ? "✓" : "✗"} ${label}${detail ? ` (${detail})` : ""}`);
  if (!condition) failures += 1;
}

const WSL = "wsl+Ubuntu-20.04:/home/spdlqj8876/Claude";
const LOCAL = "C:\\Project\\AgentPartyApp";

console.log("\nWorkspace ownership:");
assert(workspaceRunsRemotely(WSL) === true, "a WSL workspace runs in another host process");
assert(workspaceRunsRemotely(LOCAL) === false, "a Windows workspace runs in this one");

console.log("\nWho this process may push a session list to:");
const windows = [
  { id: "win-1", workspacePath: WSL },
  { id: "win-2", workspacePath: WSL },
  { id: "win-3", workspacePath: LOCAL },
  { id: "win-4", workspacePath: WSL },
];
const served = windowsServedLocally(windows);
assert(served.length === 1 && served[0].id === "win-3", "only the local-workspace window", served.map((w) => w.id).join(",") || "none");

// The exact reported shape: three WSL windows open while a Windows workspace is
// busy. Every local session event used to blast an empty list at all three.
assert(
  !served.some((entry) => entry.workspacePath === WSL),
  "no WSL window is written by this process while a local session is active",
);

console.log("\nWhat a served window receives:");
const sessions = [
  { id: "s-local-main", workspace: LOCAL },
  { id: "s-local-audit", workspace: LOCAL },
  { id: "s-other", workspace: "C:\\Other" },
];
const forLocal = sessionsForWindow(sessions, LOCAL);
assert(forLocal.length === 2, "its own workspace's sessions", forLocal.map((s) => s.id).join(","));
assert(!forLocal.some((s) => s.id === "s-other"), "and no other workspace's");

// Path spelling must not decide ownership: splitting one workspace into two
// identities resurrects the two-producer bug under a new name. `workspaceKey`
// resolves the path, so a trailing separator is the same workspace.
//
// NOT asserted here: case. `path.resolve` does not case-fold, so on Windows
// `c:\project\...` keys differently from `C:\Project\...` even though the OS
// treats them as one folder. That is a separate defect in workspace identity,
// not in this routing seam — see §7-2 of
// docs/BUG-REPORT-2026-08-07-CROSS-WORKSPACE-SESSION-LIST-FLAP.md.
assert(
  sessionsForWindow(sessions, LOCAL + "\\").length === 2,
  "workspace identity survives a trailing separator",
);

console.log("");
if (failures) {
  console.log(`SESSION LIST ROUTING FAILED (${failures})`);
  process.exit(1);
}
console.log("SESSION LIST ROUTING PASSED");
