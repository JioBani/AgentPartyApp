/*
 * LIVE round-trip through the REAL CodexAdapter (billed, one short turn).
 *
 * The stringified-request-id hang was found and fixed, but everything proving it
 * so far ran through the RECORDER's own protocol client — a second
 * implementation. That proves the protocol, not the product. This drives
 * src/core/codexAdapter.ts itself against a real `codex app-server`, approves
 * what it asks, and asserts the turn actually finishes.
 *
 * It is the only check that would have caught the bug in the shipping path:
 * scripts/fake-codex-appserver.mjs answers with a STRING id, so no test built on
 * it can ever reproduce the failure.
 *
 * Run: node scripts/e2e-live-codex-approval-roundtrip.mjs [--model gpt-5.6-luna]
 *      node scripts/e2e-live-codex-approval-roundtrip.mjs --regress
 *
 * `--regress` re-breaks the fix in memory (stringifies the id on the way out) and
 * asserts the turn then hangs — so a future "cleanup" that reverts it fails here
 * loudly instead of silently costing every Codex user their approvals.
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
const model = argOf("--model", "gpt-5.6-luna");
const regress = argv.includes("--regress");

const failures = [];
const assert = (c, m) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) failures.push(m); };

const workspace = path.resolve(os.tmpdir(), "agentparty-b18-roundtrip-ws");
fs.rmSync(workspace, { recursive: true, force: true });
fs.mkdirSync(workspace, { recursive: true });
execFileSync("git", ["init", "-q"], { cwd: workspace });
fs.writeFileSync(path.join(workspace, "seed.txt"), "seed\n");

const outDir = qaTempDir();
const bundled = await build({
  entryPoints: [path.join(projectRoot, "src/core/codexAdapter.ts")],
  bundle: true, format: "esm", platform: "node", write: false, external: ["electron"],
});
const modulePath = path.join(outDir, "codex-adapter.mjs");
fs.writeFileSync(modulePath, bundled.outputFiles[0].text);
const { CodexAdapter } = await import(pathToFileURL(modulePath).href);

const adapter = new CodexAdapter({
  id: "b18-roundtrip",
  cwd: workspace,
  model,
  effort: "medium",
  // read-only + on-request is what makes a write ask for escalation. `untrusted`
  // also prompts but does not lift the sandbox, so the command fails either way
  // and the turn end would not prove the reply was understood.
  policy: { sandbox: "read-only", approval: "on-request", guardian: false },
  debugEnabled: true,
  storageDir: outDir,
});

if (regress) {
  // Re-break the fix in memory: reply with the id as a STRING, which is what
  // the adapter used to do. Written against the live process rather than
  // through respond() so the check does not depend on the very code it guards.
  adapter.respond = (id, result) => {
    const message = { id: String(id), result };
    adapter.log?.("out", message);
    adapter.process.stdin.write(`${JSON.stringify(message)}\n`);
  };
}

let approvalSeen;
let resolved = false;
let turnEnded = false;
let errorText = "";

adapter.on("event", (event) => {
  if (process.env.B18_TRACE) console.log("    [event]", event.type, JSON.stringify(event).slice(0, 220));
  if (event.type === "approval_request") {
    approvalSeen = event;
    console.log(`  → approval: ${event.toolName}`);
    console.log(`    command: ${event.codex?.commandDisplay || event.codex?.command}`);
    // Approve through the REAL respondApproval, exactly as the card does.
    adapter.respondApproval(event.requestId, "allow", { codexDecision: "once" });
  }
  if (event.type === "approval_resolved") resolved = true;
  if (event.type === "turn_complete") turnEnded = true;
  if (event.type === "error") errorText += `${event.message}\n`;
});

console.log(`\nLive Codex approval round-trip (${model}${regress ? ", REGRESSION MODE" : ""}):`);
adapter.start?.();
adapter.sendUserTurn("Run this exact shell command, then stop: echo one > b18a.txt");

// The regression run is EXPECTED to hang; give it a shorter leash so proving
// the failure does not cost three minutes of wall clock.
const deadline = Date.now() + (regress ? 45_000 : 180_000);
while (Date.now() < deadline && !turnEnded) {
  await new Promise((r) => setTimeout(r, 500));
}

assert(Boolean(approvalSeen), "the real adapter emitted an approval_request");
if (approvalSeen) {
  assert(typeof approvalSeen.codex?.command === "string" && approvalSeen.codex.command.length > 0, "…carrying the command");
  assert(typeof approvalSeen.codex?.cwd === "string", "…and the working directory");
  assert(Boolean(approvalSeen.codex?.commandDisplay), "…and Codex's readable parse of it");
}
assert(resolved, "approval_resolved was emitted");

if (regress) {
  assert(!turnEnded, "REGRESSION CHECK: with a stringified id the turn does NOT finish (this is the bug)");
} else {
  assert(turnEnded, "the turn finished after approval — the reply was understood");
}
if (errorText) console.log(`  (errors: ${errorText.trim().slice(0, 200)})`);

adapter.dispose?.();
console.log(failures.length ? `\nFAILED (${failures.length})` : "\nLIVE CODEX APPROVAL ROUND-TRIP PASSED");
setTimeout(() => process.exit(failures.length ? 1 : 0), 500);
