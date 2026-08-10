/*
 * Engine-level check for the QA interaction mock API (qaInteraction).
 * Builds an in-process engine host, seeds a mock member, calls qaInteraction,
 * and asserts the renderer-bound `approval_request` (AskUserQuestion) event is
 * streamed — proving the mock-prompt path the automation API exposes.
 */
import { build } from "esbuild";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { qaTempDir } from "./lib/qaTemp.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(root, "..");

const qaDir = qaTempDir();

const out = path.join(qaDir, "engine-host.mjs");
const result = await build({ entryPoints: [path.join(projectRoot, "src/main/engine/engineHost.ts")], bundle: true, format: "esm", platform: "node", write: false, external: ["electron"] });
writeFileSync(out, result.outputFiles[0].text);
const { createEngineHost } = await import(pathToFileURL(out).href);

const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };

const workspace = path.join(os.tmpdir(), "agentparty-qa-interaction");
mkdirSync(workspace, { recursive: true });
rmSync(path.join(workspace, ".agent_party_app"), { recursive: true, force: true });

const host = createEngineHost({ storageDir: workspace, router: { preferredPort: 0, authToken: "engine", openRouterApiKey: "" } });
const events = [];
host.sessionManager.on("events", (p) => { for (const e of p.events || []) events.push(e); });

const engine = host.engineRegistry.forWorkspace(workspace);
await engine.qaSeed({ members: [{ name: "qa-bot", autoReply: false }] });

const { requestId } = await engine.qaInteraction("qa-bot", {
  type: "askUserQuestion",
  questions: [{ question: "점심 뭐 먹지?", header: "Lunch", options: [{ label: "김밥" }, { label: "라멘" }] }],
});

await new Promise((r) => setTimeout(r, 50));
const ask = events.find((e) => e.type === "approval_request" && e.toolName === "AskUserQuestion");
console.log("\nQA interaction API assertions:");
assert(Boolean(requestId), `qaInteraction returned a requestId (${requestId})`);
assert(Boolean(ask), "approval_request(AskUserQuestion) was streamed to the renderer channel");
assert(ask?.input?.questions?.[0]?.options?.length === 2, "question options preserved");
assert(ask?.requestId === requestId, "event requestId matches the returned id");

// Default questions when omitted.
const { requestId: id2 } = await engine.qaInteraction("qa-bot", { type: "askUserQuestion" });
await new Promise((r) => setTimeout(r, 50));
const ask2 = events.find((e) => e.type === "approval_request" && e.requestId === id2);
assert(Boolean(ask2?.input?.questions?.length), "default question is used when none provided");

// ---- approval injection (B-18) ---------------------------------------------
// The mock could only ever produce a question card, so the approval card's real
// content had no way to be exercised. These drive the SAME engine method the
// HTTP route calls, with scenarios generated from recorded harness traffic.
console.log("\nApproval injection:");
{
  const { requestId: codexId } = await engine.qaInteraction("qa-bot", { type: "approval", scenario: "codex-command-once" });
  await new Promise((r) => setTimeout(r, 50));
  const codex = events.find((e) => e.type === "approval_request" && e.requestId === codexId);
  assert(Boolean(codex), "a recorded Codex approval reaches the renderer channel");
  assert(codex?.codex?.kind === "command", "it arrives as a command approval, not a question card");
  assert(typeof codex?.codex?.command === "string" && codex.codex.command.includes("echo one"), "carrying the real recorded command");
  assert(typeof codex?.codex?.cwd === "string" && codex.codex.cwd.length > 0, "…and the real working directory");
  assert(codex?.codex?.canAlways === true, "…and the prefix rule that enables 항상 허용");

  const { requestId: claudeId } = await engine.qaInteraction("qa-bot", { type: "approval", scenario: "claude-bash" });
  await new Promise((r) => setTimeout(r, 50));
  const claude = events.find((e) => e.type === "approval_request" && e.requestId === claudeId);
  assert(claude?.toolName === "Bash", "a recorded Claude approval reaches the channel");
  assert(typeof claude?.blockedPath === "string" && claude.blockedPath.length > 0, "blockedPath survives to the renderer (it used to stop at the adapter)");
  assert(Array.isArray(claude?.suggestions) && claude.suggestions.some((s) => s?.type === "addRules"), "…as does the always-allow rule");
}

// ---- refusals: a QA tool that cannot do the real thing must say so ([#21]) ---
console.log("\nRefusals (no silent success):");
{
  let unknown;
  try {
    await engine.qaInteraction("qa-bot", { type: "approval", scenario: "does-not-exist" });
  } catch (error) {
    unknown = String(error?.message || error);
  }
  assert(Boolean(unknown), "an unknown scenario throws instead of injecting nothing");
  assert(/does-not-exist/.test(unknown || "") && /codex-command-once/.test(unknown || ""), `…and names the available scenarios`);

  // A member backed by a REAL harness: that harness never issued the request,
  // so the card's buttons would have nothing to answer. Refusing beats shipping
  // a card that looks live and silently cannot be resolved. No model is called —
  // the session is created and never sent a turn.
  const real = await engine.createSession({ workspacePath: workspace, selectedHarnessId: "claude-code" });
  await engine.bindMember("qa-bot", real.id);
  let refused;
  try {
    await engine.qaInteraction("qa-bot", { type: "approval", scenario: "codex-command-once" });
  } catch (error) {
    refused = String(error?.message || error);
  }
  assert(Boolean(refused), "injecting into a REAL member throws instead of faking a card");
  assert(/real harness/i.test(refused || ""), `…with a reason that explains why (${(refused || "").slice(0, 70)}…)`);
}

host.dispose();
console.log(failures.length ? `\nFAILED (${failures.length})` : "\nQA INTERACTION API PASSED");
process.exit(failures.length ? 1 : 0);
