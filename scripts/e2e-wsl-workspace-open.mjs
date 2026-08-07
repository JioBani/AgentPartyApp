/*
 * Product E2E: opening a WSL workspace in the real app.
 *
 * Reproduces the reported failure — `agent-party` from inside a distro (or any
 * `POST /api/windows` with a `wsl+<distro>:` URI) opened a window that showed
 * "작업공간 없음". The cause was load-time: the bundled engine server imported
 * `electron` and read `__dirname`, neither of which exists under a distro's
 * plain node, so the engine died and `getState` never resolved a workspace.
 *
 * Drives the SAME surface the CLI and the UI use: the real AgentParty process,
 * its automation HTTP API, no mocks and no special code path.
 *
 * Usage: node scripts/e2e-wsl-workspace-open.mjs [distro]
 */
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElectronE2eApp } from "./lib/electron-e2e.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distro = process.argv[2] || "Ubuntu-20.04";
const wslWorkspacePosix = "/tmp/agentparty-e2e-wsl-workspace";
const wslUri = `wsl+${distro}:${wslWorkspacePosix}`;

const app = createElectronE2eApp({
  root,
  workspace: path.join(os.tmpdir(), "agentparty-e2e-wsl-open-workspace"),
  userData: path.join(os.tmpdir(), "agentparty-e2e-wsl-open-userdata"),
  port: 45231,
});

function check(label, condition, detail) {
  console.log(`${condition ? "PASS" : "FAIL"} — ${label}${detail ? ` (${detail})` : ""}`);
  if (!condition) {
    failures += 1;
  }
}
let failures = 0;

execFileSync("wsl.exe", ["-d", distro, "-e", "bash", "-lc", `mkdir -p "${wslWorkspacePosix}"`], { stdio: "inherit" });

await app.prepare();
await app.launch();
try {
  // The exact call `agent-party` makes when the app is already running.
  const win = await app.post("/api/windows", { workspacePath: wslUri });
  check("POST /api/windows returns the WSL workspace", win.workspacePath === wslUri, `${win.workspacePath}`);

  // What the header renders from: an empty `workspace` is the "작업공간 없음" bug.
  const state = await app.get(`/api/state?window=${encodeURIComponent(win.id)}`);
  check("state resolves a workspace at all", Boolean(state.workspace), JSON.stringify(state.workspace));
  check("workspace host is the distro", state.workspace?.kind === "wsl" && state.workspace?.distro === distro, `${state.workspace?.kind}/${state.workspace?.distro}`);
  check("workspace path is the distro path", state.workspace?.path === wslWorkspacePosix, `${state.workspace?.path}`);

  // Proof the in-distro engine actually answered (not just a parsed URI): this
  // field comes back over the stdio RPC from the engine running inside WSL.
  check("in-distro engine served the session list", Array.isArray(state.sessions), typeof state.sessions);
} finally {
  // Two windows are open here (the default one plus the WSL one), so the close
  // API leaves the process alive — kill is the teardown, not a fallback.
  await app.close().catch(() => undefined);
  app.kill();
}

console.log(failures === 0 ? "\nWSL workspace open E2E: PASS" : `\nWSL workspace open E2E: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
