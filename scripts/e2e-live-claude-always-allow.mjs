/*
 * LIVE check that Claude Code's "항상 허용 (규칙)" actually stores a rule
 * (billed — two short turns).
 *
 * ⚠️ MEASURED, and it shaped this test: re-running the same command in the SAME
 * session does not re-prompt EVEN WHEN nothing was stored — Claude remembers the
 * approval for the session on its own. So "it did not ask again" proves nothing
 * about the rule, and an earlier version of this check passed for that wrong
 * reason. What separates the two choices deterministically is what lands on
 * disk, and whether a FRESH session is still asked. Those are the assertions.
 *
 * The card offering the choice and the adapter sending `updatedPermissions` are
 * both verified offline, but neither proves the thing the user cares about:
 * that the SAME command is not asked about a second time. Only a real session
 * can show that, so this drives the REAL ClaudeAdapter through two turns.
 *
 * Turn 1: run a write command → approval → answer with the "always" scope.
 * Turn 2: run the SAME command → assert NO approval is raised.
 *
 * Everything stays inside a temp workspace: the rule Claude offers is scoped to
 * `localSettings`, which is the workspace's own .claude directory, so the user's
 * global settings are untouched.
 *
 * Run: node scripts/e2e-live-claude-always-allow.mjs [--model claude-haiku-4-5-20251001]
 *      node scripts/e2e-live-claude-always-allow.mjs --regress
 *
 * `--regress` answers with the plain "allow once" scope instead, and asserts the
 * second turn DOES ask again — so the check cannot pass for the wrong reason
 * (e.g. Claude simply not calling the tool twice).
 */
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { qaTempDir } from "./lib/qaTemp.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const argOf = (flag, fallback) => { const i = argv.indexOf(flag); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };
const model = argOf("--model", "claude-haiku-4-5-20251001");
const regress = argv.includes("--regress");

const failures = [];
const assert = (c, m) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) failures.push(m); };

const workspace = path.resolve(os.tmpdir(), "agentparty-b18-always-ws");
fs.rmSync(workspace, { recursive: true, force: true });
fs.mkdirSync(workspace, { recursive: true });
execFileSync("git", ["init", "-q"], { cwd: workspace });
fs.writeFileSync(path.join(workspace, "seed.txt"), "seed\n");

const outDir = qaTempDir();
const bundled = await build({
  entryPoints: [path.join(projectRoot, "src/core/claudeAdapter.ts")],
  bundle: true, format: "esm", platform: "node", write: false, external: ["electron"],
});
const modulePath = path.join(outDir, "claude-adapter.mjs");
fs.writeFileSync(modulePath, bundled.outputFiles[0].text);
const { ClaudeAdapter } = await import(pathToFileURL(modulePath).href);

const adapter = new ClaudeAdapter({
  id: "b18-always",
  cwd: workspace,
  model,
  effort: "medium",
  permissionMode: "default",
  safeMode: false,
  debugEnabled: true,
  storageDir: outDir,
  customModelRoutes: [],
  routerBaseUrl: "",
  routerAuthToken: "",
});

const PROMPT = "Run this exact shell command, then stop: echo one > b18a.txt";
const settingsPath = path.join(workspace, ".claude", "settings.local.json");
const approvals = [];
let turnEnded = false;

adapter.on("event", (event) => {
  if (event.type === "approval_request") {
    approvals.push(event);
    const rule = (event.suggestions || []).find((s) => s?.type === "addRules");
    console.log(`  → approval: ${event.toolName}${rule ? ` (offers rule: ${rule.rules?.[0]?.ruleContent})` : " (no rule offered)"}`);
    // Exactly the call the card makes. Without the scope this is "allow once".
    adapter.respondApproval(event.requestId, "allow", regress ? undefined : { __approvalScope: "always" });
  }
  if (event.type === "turn_complete") turnEnded = true;
});

const runTurn = async (session, label) => {
  turnEnded = false;
  console.log(`
  [${label}]`);
  session.sendUserTurn(PROMPT);
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline && !turnEnded) {
    await new Promise((r) => setTimeout(r, 500));
  }
  return turnEnded;
};

console.log(`
Live Claude always-allow (${model}${regress ? ", REGRESSION MODE — approving ONCE" : ""}):`);
adapter.start?.();

assert(await runTurn(adapter, "turn 1"), "turn 1 finished");
assert(approvals.length >= 1, "turn 1 raised an approval");
const offered = (approvals[0]?.suggestions || []).find((s) => s?.type === "addRules");
assert(Boolean(offered), `the request offered a rule (${offered?.rules?.[0]?.ruleContent || "none"})`);

// What landed on disk is the deterministic difference between the two choices.
const stored = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, "utf8") : "";
if (regress) {
  assert(!/Bash\(echo one/.test(stored), `"이번만 허용" stores NO rule (${stored.replace(/\s+/g, " ").slice(0, 60) || "no file"})`);
} else {
  assert(/Bash\(echo one/.test(stored), `"항상 허용" wrote the rule (${stored.replace(/\s+/g, " ").slice(0, 80)})`);
}

// The payoff the user actually cares about: a NEW session does not ask again.
console.log("\n  [turn 2 — FRESH session on the same workspace]");
adapter.dispose?.();
await new Promise((r) => setTimeout(r, 1500));
fs.rmSync(path.join(workspace, "b18a.txt"), { force: true });

const fresh = new ClaudeAdapter({
  id: "b18-always-2", cwd: workspace, model, effort: "medium", permissionMode: "default",
  safeMode: false, debugEnabled: true, storageDir: outDir,
  customModelRoutes: [], routerBaseUrl: "", routerAuthToken: "",
});
let freshAsked = false;
let freshBlockedPath = "";
fresh.on("event", (event) => {
  if (event.type === "approval_request") {
    freshAsked = true;
    freshBlockedPath = event.blockedPath || "";
    console.log(`  → approval: ${event.toolName}`);
    fresh.respondApproval(event.requestId, "allow");
  }
  if (event.type === "turn_complete") turnEnded = true;
});
fresh.start?.();
assert(await runTurn(fresh, "turn 2"), "turn 2 finished");

/*
 * MEASURED, and it is why the card must not promise silence: a fresh session can
 * still be stopped by a SECOND gate. The stored rule settles the command, but a
 * write outside the allowed working directories raises its own approval, whose
 * only remedy (`addDirectories`) is `destination: "session"` — session-scoped by
 * definition, so it can never be stored. `blockedPath` is what distinguishes the
 * two: set = the directory gate, absent = the command rule failed to apply.
 */
if (regress) {
  assert(freshAsked, "REGRESSION CHECK: with no rule stored, a fresh session DOES ask again");
} else if (!freshAsked) {
  assert(true, "a fresh session was not asked at all — the stored rule fully covered it");
} else {
  assert(Boolean(freshBlockedPath), `it asked again only for the DIRECTORY, not the command (blockedPath=${freshBlockedPath ? "set" : "ABSENT — the stored rule did not apply"})`);
  console.log("  note: the directory gate offers only a session-scoped grant, so no choice can silence it permanently.");
}
fresh.dispose?.();

console.log(failures.length ? `\nFAILED (${failures.length})` : "\nLIVE CLAUDE ALWAYS-ALLOW PASSED");
setTimeout(() => process.exit(failures.length ? 1 : 0), 500);
