/*
 * Product E2E: a member must not flicker while ANOTHER workspace is busy.
 *
 * Reported against party CARR-935's `req` on a WSL workspace: its sidebar row
 * alternated between "대기" and "시작 안 함" many times a second. Nothing was
 * restarting it — the backend log showed one `party:start` and no loop. Two
 * producers were overwriting the renderer's session array: this process's
 * SessionManager (which holds no WSL sessions, so it sent an empty list) and the
 * WSL engine (which sent the real one). `session:list` REPLACES that array, so
 * they took turns and deriveStatus read `!session` → "not-started" every other
 * message. Hosting several workspaces in one process made it constant, because a
 * local session's every event fired the empty broadcast at the WSL windows.
 *
 * Reproduces the reported shape with the real app: two windows, two workspaces,
 * one process — a LOCAL member producing session traffic while a REMOTE member
 * sits idle — then asserts on the PUSHES, read from the app's own debug log.
 *
 * Deliberately not asserted through the UI. An earlier version of this test
 * polled the rendered status every 400ms and passed against the BROKEN build:
 * the empty list is overwritten within milliseconds, so a DOM poll almost never
 * catches it even though React paints it and the user sees the flicker. The same
 * run's log showed the truth — 13 empty lists from the local manager alternating
 * with 13 real ones on the same window. Measure the cause, not the strobe.
 *
 * Requires the WSL distro. Offline and unbilled — members are started but never
 * messaged, since this is about IPC routing, not model behaviour.
 *
 * Usage: node scripts/e2e-cross-workspace-status-flap.mjs [distro]
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElectronE2eApp } from "./lib/electron-e2e.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distro = process.argv[2] || "Ubuntu-20.04";
// Per-run directories. A previous run that was killed leaves a Windows handle on
// its workspace folder for a while, and `prepare()` deletes before it creates —
// sharing one path makes the NEXT run fail with EPERM on a directory that is
// already empty. Nothing here is meant to outlive the run, so uniqueness costs
// nothing and also lets two runs overlap.
const runId = `${process.pid}`;
const wslPosix = `/tmp/agentparty-e2e-flap-${runId}`;
const wslUri = `wsl+${distro}:${wslPosix}`;

const app = createElectronE2eApp({
  root,
  workspace: path.join(os.tmpdir(), `agentparty-e2e-flap-ws-${runId}`),
  userData: path.join(os.tmpdir(), `agentparty-e2e-flap-ud-${runId}`),
  port: 45237,
});

let failures = 0;
function check(label, condition, detail) {
  console.log(`${condition ? "PASS" : "FAIL"} — ${label}${detail ? ` (${detail})` : ""}`);
  if (!condition) failures += 1;
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

execFileSync("wsl.exe", ["-d", distro, "-e", "bash", "-lc", `mkdir -p "${wslPosix}"`], { stdio: "inherit" });

await app.prepare();
await app.launch();
try {
  // The routing record is debug-level: it fires on every session event, and only
  // matters when someone is asking why a member flickers.
  await app.post("/api/settings", { debugEnabled: true });

  // --- the local workspace: a member whose session traffic drives the bug ----
  // Every call is window-scoped: opening the WSL window moves focus, and an
  // unscoped call would then land on the WRONG workspace.
  const localWindowId = ((await app.get("/api/windows")).windows || [])[0]?.id;
  const local = `?window=${encodeURIComponent(localWindowId)}`;
  check("the local window is known", Boolean(localWindowId), String(localWindowId));
  await app.post(`/api/parties${local}`, { name: "flap-local" });
  await app.post(`/api/party/members${local}`, { name: "busy", runtime: "claude-code", requirement: "local traffic" });

  // --- the remote workspace, in a second window of the SAME process ---------
  const win = await app.post("/api/windows", { workspacePath: wslUri });
  check("the WSL window opened in this process", win.workspacePath === wslUri, String(win.workspacePath));
  const w = `?window=${encodeURIComponent(win.id)}`;
  await app.post(`/api/parties${w}`, { name: "flap-remote" });
  await app.post(`/api/party/members${w}`, { name: "watched", runtime: "claude-code", requirement: "remote idle member" });
  await app.post(`/api/party/members/watched/start${w}`, {});

  const remote = await app.get(`/api/party${w}`);
  const watched = (remote.members || []).find((m) => m.name === "watched");
  check("the remote member holds a live session", Boolean(watched?.sessionId), String(watched?.sessionId));

  // --- generate local session traffic, which is what used to leak across ----
  await app.post(`/api/party/members/busy/start${local}`, {});
  await delay(6_000);

  // --- who pushed what, from the app's own log ------------------------------
  const logPath = (await app.get("/api/logs")).logFilePath;
  const pushes = readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return undefined; } })
    .filter((entry) => entry && entry.message === "session list pushed")
    .map((entry) => entry.data);

  check("session lists were pushed at all", pushes.length > 0, `${pushes.length} pushes`);
  const remoteWindowPushes = pushes.filter((p) => p.workspace === wslUri);
  check("the WSL window received its list", remoteWindowPushes.some((p) => p.source === "remote"), `${remoteWindowPushes.length} to it`);

  // The bug, stated exactly: this process wrote a workspace it does not serve.
  const trespass = remoteWindowPushes.filter((p) => p.source === "local");
  check(
    "this process never wrote the WSL window's session list",
    trespass.length === 0,
    trespass.length ? `${trespass.length} pushes, counts: ${[...new Set(trespass.map((p) => p.count))].join(",")}` : "none",
  );

  // The local window must still be served — the fix must not silence it.
  const localPushes = pushes.filter((p) => p.workspace !== wslUri);
  check("the local window is still served", localPushes.some((p) => p.source === "local" && p.count > 0), `${localPushes.length} pushes`);
} finally {
  await app.close().catch(() => undefined);
  app.kill();
}

console.log(failures === 0 ? "\nCross-workspace status flap E2E: PASS" : `\nCross-workspace status flap E2E: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
