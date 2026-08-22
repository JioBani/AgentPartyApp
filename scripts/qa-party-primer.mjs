/*
 * Contract test for the canonical party-member primer. Verifies that the
 * built-in collaboration defaults come from one assembled source, render for
 * new member identities, and reach every harness through its actual prompt
 * channel without being repeated after delivery.
 */
import assert from "node:assert/strict";
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { qaTempDir } from "./lib/qaTemp.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = qaTempDir();

async function load(entry, name, external = []) {
  const outfile = path.join(outDir, name);
  await build({
    entryPoints: [path.join(projectRoot, entry)],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile,
    external,
    logLevel: "silent",
  });
  return import(pathToFileURL(outfile).href);
}

const primerModule = await load("src/shared/partyPrimer.ts", "party-primer.mjs");
const { ClaudeAdapter } = await load("src/core/claudeAdapter.ts", "claude-adapter.mjs", ["@anthropic-ai/claude-agent-sdk"]);
const { CodexAdapter } = await load("src/core/codexAdapter.ts", "codex-adapter.mjs");
const { CursorAdapter } = await load("src/core/cursorAdapter.ts", "cursor-adapter.mjs");
const { GrokAdapter } = await load("src/core/grokAdapter.ts", "grok-adapter.mjs");

const identity = { party: "party-contract", member: "new-worker", role: "Unblock dependent work" };
const primer = primerModule.buildPartyPrimer(identity);
const discipline = primerModule.PARTY_PRIMER_SECTIONS.find((section) => section.id === "discipline");
const disciplineView = primerModule.partyPrimerView().find((section) => section.id === "discipline");

assert(discipline, "the canonical primer keeps collaboration guidance in the existing discipline section");
assert.equal(disciplineView?.defaultText, discipline.body, "settings and API defaults stay synchronized with the canonical section body");
assert.equal((primer.match(/## Talking to other members — keep it tight/g) || []).length, 1, "the collaboration prompt is assembled exactly once");
for (const phrase of [
  "Keep the user's current priorities in place unless the user explicitly changes them",
  "minimum useful answer or output first",
  "never a bare acknowledgement",
  "continue your primary task and parallelize independent work",
  "queue the request, or coordinate the ordering explicitly",
  "reduce the overall task's critical path and other members' waiting time",
]) {
  assert(primer.includes(phrase), `the canonical default includes: ${phrase}`);
  assert.equal(primer.indexOf(phrase), primer.lastIndexOf(phrase), `the canonical default does not duplicate: ${phrase}`);
}
assert(primer.includes("party-contract") && primer.includes("new-worker") && primer.includes(identity.role), "a new member receives the same defaults with its own identity rendered");

assert.deepEqual(
  primerModule.PARTY_PRIMER_DELIVERY.map(({ harness, channel, delivered }) => ({ harness, channel, delivered })),
  [
    { harness: "claude-code", channel: "system", delivered: true },
    { harness: "codex", channel: "developer", delivered: true },
    { harness: "cursor", channel: "user", delivered: true },
    { harness: "grok", channel: "user", delivered: true },
  ],
  "every supported harness declares the canonical primer delivery contract",
);

const claude = new ClaudeAdapter({
  id: "primer-claude",
  cwd: projectRoot,
  model: "sonnet",
  effort: "medium",
  safeMode: true,
  debugEnabled: false,
  storageDir: outDir,
  customModelRoutes: [],
  routerBaseUrl: "",
  routerAuthToken: "qa",
  partyIdentity: identity,
});
assert.equal(claude.partySystemPrompt().systemPrompt?.append, primer, "Claude appends the canonical default to its system prompt");

const codex = new CodexAdapter({
  id: "primer-codex",
  cwd: projectRoot,
  model: "gpt-5.5",
  effort: "medium",
  debugEnabled: false,
  storageDir: outDir,
  partyIdentity: identity,
});
assert.equal(codex.partyDeveloperInstructions(), primer, "Codex installs the canonical default as developer instructions");

const cursor = new CursorAdapter({
  id: "primer-cursor",
  cwd: projectRoot,
  model: "Auto",
  effort: "medium",
  debugEnabled: false,
  storageDir: outDir,
  partyPrimer: primer,
});
assert.equal(cursor.buildPrompt("first task"), `${primer}\n\nfirst task`, "Cursor prepends the canonical default to the first prompt");
cursor.commitTurn();
assert.equal(cursor.buildPrompt("next task"), "next task", "Cursor does not repeat the primer after a committed turn");

const grok = new GrokAdapter({ sessionId: "primer-grok", cwd: projectRoot, partyPrimer: primer });
assert.equal(grok.withPartyPrimer("first task"), `${primer}\n\nfirst task`, "Grok prepends the canonical default to the first prompt");
const resumedGrok = new GrokAdapter({ sessionId: "primer-grok-resumed", cwd: projectRoot, resumeSessionId: "thread-existing", partyPrimer: primer });
assert.equal(resumedGrok.withPartyPrimer("next task"), "next task", "Grok does not repeat the primer when resuming its recorded thread");

console.log("PARTY PRIMER CONTRACT PASSED");
