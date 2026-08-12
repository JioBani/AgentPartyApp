/*
 * Opens the card design gallery in the real app.
 *
 * A party of MOCK members, one per transcript-card case, each already showing
 * its card — approvals, their resolved states, questions, answered questions,
 * and the compaction block. No harness is launched and no model is called, so
 * looking at every card costs nothing and cannot run a command.
 *
 * The case list lives in src/shared/designGallery.ts and is built by
 * `POST /api/qa/design-gallery`, so this script has no copy of its own to drift.
 *
 * Run: npm run design:gallery [-- --close]
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const closeAfter = process.argv.slice(2).includes("--close");

// Isolated userData + workspace: the gallery seeds a party, and doing that in
// the user's own workspace would put twenty mock members in their party list.
const ws = path.resolve(os.tmpdir(), "agentparty-design-gallery-ws");
const userData = path.resolve(os.tmpdir(), "agentparty-design-gallery-ud");
const port = 49251;
const base = `http://127.0.0.1:${port}`;

fs.rmSync(ws, { recursive: true, force: true });
fs.mkdirSync(ws, { recursive: true });
// The userData goes too. Keeping it carried the PREVIOUS run's open members and
// window layout into a workspace that no longer has them, so the app opened
// trying to start members that did not exist and logged three failures before
// the gallery was even built. The gallery should look the same every time.
fs.rmSync(userData, { recursive: true, force: true });

const post = async (route, body) => {
  const r = await fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  if (!r.ok) throw new Error(`${route} ${r.status}: ${await r.text()}`);
  return r.json();
};
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const stale = await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false);
if (stale) {
  console.error(`An app already serves ${base} — close it first, or its build may predate the cases you want to see.`);
  process.exit(1);
}

const build = spawnSync(process.env.ComSpec || "cmd.exe", ["/c", "npm", "run", "build"], { cwd: root, stdio: "inherit", windowsHide: true });
if (build.status !== 0) {
  console.error("Build failed — refusing to show a gallery that does not match the source.");
  process.exit(1);
}

const child = spawn(process.env.ComSpec || "cmd.exe", ["/c", "npm", "run", "start"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
  env: {
    ...process.env,
    // The gallery is QA-only surface: it fabricates members and cards.
    AGENTPARTY_QA: "1",
    AGENTPARTY_AUTOMATION_PORT: String(port),
    AGENTPARTY_USER_DATA: userData,
    AGENTPARTY_WINDOW_DISPLAY: "left",
  },
});
child.stdout.on("data", () => {});
child.stderr.on("data", (chunk) => process.stderr.write(chunk));

for (let i = 0; i < 120; i += 1) {
  if (await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false)) break;
  await delay(1000);
}

// Point the window at the isolated workspace FIRST — a fresh userData has no
// stored path and falls back to the cwd, which here is the user's own project.
const windows = (await fetch(`${base}/api/windows`).then((r) => r.json())).windows || [];
await post(`/api/windows/${windows[0].id}/workspace`, { workspacePath: ws });

/*
 * Then assert it took. A fixed port another instance had claimed would
 * otherwise be driven — and rewired — by this run.
 *
 * The field is `settings.workspacePath`; there is no top-level one. Reading the
 * wrong path made this `undefined`, and `if (served && …)` then skipped the
 * check entirely — a guard that reported success without ever comparing
 * anything. A missing value is now a failure, not a pass.
 */
const state = await fetch(`${base}/api/state`).then((r) => r.json());
const served = state?.settings?.workspacePath;
if (!served) {
  console.error(`Refusing to drive ${base}: /api/state reported no workspace, so the target cannot be verified.`);
  process.exit(1);
}
if (path.resolve(served) !== path.resolve(ws)) {
  console.error(`Refusing to drive ${base}: it serves ${served}, not ${ws}.`);
  process.exit(1);
}

await post("/api/qa/reset").catch(() => {});
const built = await post("/api/qa/design-gallery");
await post("/api/qa/open", { panels: [[built.members[0]]] });
await delay(600);

console.log(`\n${built.party} — ${built.members.length}개 케이스`);
for (const name of built.members) console.log(`  · ${name}`);

if (closeAfter) {
  await post("/api/window/close", {}).catch(() => {});
} else {
  console.log(`\n앱이 떠 있습니다 (${base}, 왼쪽 모니터). 멤버를 눌러 카드를 보세요.`);
  console.log("모든 멤버는 목업이라 실제 하네스 통신을 하지 않습니다. 창을 닫으면 종료됩니다.");
}
