/*
 * Product E2E: idle sleep, driven through the real app.
 *
 * Idle sleep releases a quiet member's harness process and keeps its
 * conversation. Its two escape hatches are what this covers, because they are
 * what a user reaches for when the default is wrong:
 *
 *   - the global policy (on/off + how long "quiet" is), which the Settings →
 *     유휴 슬립 card writes, and
 *   - the per-member 계속 켜두기 pin, which the sidebar's right-click menu writes.
 *
 * Both go through the same AppController methods the UI calls, so this exercises
 * the production path rather than a test-only one. The member is created but
 * never messaged: sleeping is a process-lifecycle concern, so a real model call
 * would add cost without adding coverage.
 *
 * Usage: node scripts/e2e-idle-sleep.mjs
 */
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElectronE2eApp } from "./lib/electron-e2e.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const app = createElectronE2eApp({
  root,
  workspace: path.join(os.tmpdir(), "agentparty-e2e-idle-sleep-workspace"),
  userData: path.join(os.tmpdir(), "agentparty-e2e-idle-sleep-userdata"),
  port: 45233,
});

let failures = 0;
function check(label, condition, detail) {
  console.log(`${condition ? "PASS" : "FAIL"} — ${label}${detail ? ` (${detail})` : ""}`);
  if (!condition) failures += 1;
}

const memberOf = (party, name) => (party.members || []).find((m) => m.name === name);
const MEMBER = "sleeper";

await app.prepare();
await app.launch();
try {
  // --- global policy -------------------------------------------------------
  const health = await app.get("/api/health");
  check(
    "idle sleep ships on with a 5분 quiet period",
    health.settings?.idleSleep?.enabled === true && health.settings?.idleSleep?.timeoutMinutes === 5,
    JSON.stringify(health.settings?.idleSleep),
  );

  const saved = await app.post("/api/settings", { idleSleep: { enabled: true, timeoutMinutes: 1 } });
  check("the settings card's write is persisted", saved.idleSleep?.timeoutMinutes === 1, JSON.stringify(saved.idleSleep));

  // The card offers presets only, but HTTP callers can send anything. Out-of-range
  // values must be clamped rather than stored — a 0-minute timeout would tear a
  // member down between two halves of one thought.
  const tooSmall = await app.post("/api/settings", { idleSleep: { enabled: true, timeoutMinutes: 0 } });
  check("a sub-minute timeout is clamped up", tooSmall.idleSleep?.timeoutMinutes === 1, String(tooSmall.idleSleep?.timeoutMinutes));
  const tooBig = await app.post("/api/settings", { idleSleep: { enabled: true, timeoutMinutes: 99_999 } });
  check("an over-a-day timeout is clamped down", tooBig.idleSleep?.timeoutMinutes === 24 * 60, String(tooBig.idleSleep?.timeoutMinutes));

  const off = await app.post("/api/settings", { idleSleep: { enabled: false, timeoutMinutes: 5 } });
  check("the card can turn idle sleep off", off.idleSleep?.enabled === false, JSON.stringify(off.idleSleep));
  await app.post("/api/settings", { idleSleep: { enabled: true, timeoutMinutes: 5 } });

  // --- per-member pin ------------------------------------------------------
  await app.post("/api/parties", { name: "idle-sleep-e2e" });
  await app.post("/api/party/members", { name: MEMBER, runtime: "claude-code", requirement: "idle sleep e2e" });

  const pinned = await app.post(`/api/party/members/${MEMBER}/keep-awake`, { keepAwake: true });
  check("계속 켜두기 pins the member", memberOf(pinned, MEMBER)?.keepAwake === true, JSON.stringify(memberOf(pinned, MEMBER)?.keepAwake));

  // The pin must beat a direct sleep request, not only the timeout sweep —
  // otherwise 계속 켜두기 would be advisory and the menu would be lying.
  const refused = await app.post(`/api/party/members/${MEMBER}/sleep`, {});
  check("a pinned member refuses to sleep", memberOf(refused, MEMBER)?.status !== "sleeping", memberOf(refused, MEMBER)?.status);
  check("the refusal says why", /켜두|keep|awake|pin/i.test(String(refused.message || "")), String(refused.message || "").slice(0, 90));

  const unpinned = await app.post(`/api/party/members/${MEMBER}/keep-awake`, { keepAwake: false });
  check("un-pinning does not itself sleep the member", memberOf(unpinned, MEMBER)?.status !== "sleeping", memberOf(unpinned, MEMBER)?.status);

  // --- sleep / wake --------------------------------------------------------
  const slept = await app.post(`/api/party/members/${MEMBER}/sleep`, {});
  check("an un-pinned member sleeps on request", memberOf(slept, MEMBER)?.status === "sleeping", memberOf(slept, MEMBER)?.status);
  check("sleeping releases the session binding", !memberOf(slept, MEMBER)?.sessionId, String(memberOf(slept, MEMBER)?.sessionId));

  const woke = await app.post(`/api/party/members/${MEMBER}/wake`, {});
  check("waking brings the member back", memberOf(woke, MEMBER)?.status !== "sleeping", memberOf(woke, MEMBER)?.status);
  check("waking re-binds a session", Boolean(memberOf(woke, MEMBER)?.sessionId), String(memberOf(woke, MEMBER)?.sessionId));
} finally {
  await app.close().catch(() => undefined);
  app.kill();
}

console.log(failures === 0 ? "\nIdle sleep E2E: PASS" : `\nIdle sleep E2E: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
