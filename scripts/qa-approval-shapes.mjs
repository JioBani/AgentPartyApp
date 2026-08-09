/*
 * Approval card shapes — REPLAY of recorded real harness traffic.
 *
 * Feeds the frames captured from a live codex-cli 0.145.0 session
 * (scripts/fixtures/approvals/*.jsonl, recorded by scripts/record-approval-traffic.mjs)
 * through the SAME functions the adapter calls, and asserts what the approval
 * card can actually show. This locks the card against the ACTUAL protocol
 * payloads rather than the hand-written ones in scripts/fake-codex-appserver.mjs
 * — which is what let B-18's defects hide (see the fake's invented `diff` field).
 *
 * Offline and unbilled: it reads recordings, it does not call a model.
 *
 * Run: node scripts/qa-approval-shapes.mjs
 */
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { qaTempDir } from "./lib/qaTemp.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDir = path.join(projectRoot, "scripts", "fixtures", "approvals");
const failures = [];
const assert = (c, m) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) failures.push(m); };

const outDir = qaTempDir();
async function bundle(entry, name) {
  const r = await build({ entryPoints: [path.join(projectRoot, entry)], bundle: true, format: "esm", platform: "node", write: false });
  const p = path.join(outDir, name);
  writeFileSync(p, r.outputFiles[0].text);
  return import(pathToFileURL(p).href);
}

const readJsonl = (file) =>
  readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));

const {
  approvalMeta,
  approvalKindOf,
  codexApprovalOptions,
  approvalResult,
} = await bundle("src/shared/codexApproval.ts", "codex-approval.mjs");

if (!existsSync(fixtureDir) || !readdirSync(fixtureDir).some((n) => n.endsWith(".jsonl"))) {
  // No fixtures = nothing was measured. Say so instead of passing vacuously.
  console.error(`No recordings in ${fixtureDir}. Run scripts/record-approval-traffic.mjs first.`);
  process.exit(1);
}

/** Pulls the server→client approval request out of a recording. */
function approvalRequestOf(file) {
  for (const frame of readJsonl(file)) {
    const p = frame.payload;
    if (p && typeof p.method === "string" && p.id !== undefined && /requestApproval|requestUserInput|elicitation\/request/.test(p.method)) {
      return p;
    }
  }
  return undefined;
}

function outcomeOf(file) {
  const frames = readJsonl(file);
  const last = frames[frames.length - 1];
  const completed = frames.some((f) => f.payload?.method === "turn/completed");
  return { completed, lastDirection: last.direction, lastMethod: last.payload?.method };
}

const files = readdirSync(fixtureDir).filter((n) => n.endsWith(".jsonl")).sort();

// ============ 1. every recording is a real command approval ============
console.log("\nRecorded requests (codex-cli 0.145.0, gpt-5.4-mini):");
const requests = new Map();
for (const name of files) {
  const request = approvalRequestOf(path.join(fixtureDir, name));
  if (request) requests.set(name, request);
}
assert(requests.size >= 5, `${requests.size} recordings carry an approval request`);

// ============ 2. the request id is a NUMBER — the hang that cost a whole turn ============
console.log("\nRequest id type (regression lock for the stringified-id hang):");
{
  const numeric = [...requests.values()].filter((r) => typeof r.id === "number");
  assert(numeric.length === requests.size, `every recorded approval id is a NUMBER (${numeric.length}/${requests.size})`);

  const good = outcomeOf(path.join(fixtureDir, "codex-command-once.jsonl"));
  const hang = outcomeOf(path.join(fixtureDir, "codex-command-once-stringid-hang.jsonl"));
  assert(good.completed, "echoing the id back unchanged → the turn reaches turn/completed");
  assert(!hang.completed, "echoing it back as a STRING → the turn never completes (recorded)");
  assert(hang.lastDirection === "out", "…and the last frame is our own reply: the server answered nothing further");
}

// ============ 3. what the card can actually display ============
console.log("\nCard content available from a REAL command approval:");
{
  const request = requests.get("codex-command-once.jsonl");
  const meta = approvalMeta(request.method, request.params);
  assert(approvalKindOf(request.method) === "command", `kind = command (${request.method})`);
  assert(typeof meta.command === "string" && meta.command.length > 0, "명령 원문 present");
  assert(typeof meta.cwd === "string" && meta.cwd.length > 0, "작업 디렉터리 present");
  assert(typeof meta.reason === "string" && meta.reason.length > 0, "요청 사유 present (a real sentence, not a placeholder)");
  assert(meta.canAlways === true, "항상 허용 가능 (proposedExecpolicyAmendment is a string[])");
  assert(typeof meta.alwaysHint === "string" && meta.alwaysHint.length > 0, "항상 허용될 규칙 hint present");

  // The measured wrapper problem: the command shown is the PowerShell wrapper,
  // while the readable form Codex already parsed sits unused in commandActions.
  const actions = request.params.commandActions || [];
  assert(meta.command.includes("powershell.exe"), "⚠ the displayed command is the PowerShell wrapper, not what the user asked for");
  assert(actions.length > 0 && typeof actions[0].command === "string", "…while commandActions[0].command holds the readable form (currently dropped)");
}

// ============ 4. no file diff anywhere in real traffic ============
console.log("\n파일 diff (기능정의서 1-10-1):");
{
  const withDiff = [...requests.values()].filter((r) => r.params.diff || r.params.unifiedDiff);
  assert(withDiff.length === 0, "NO recorded approval carries diff/unifiedDiff — the card cannot show a diff");
  const metas = [...requests.values()].map((r) => approvalMeta(r.method, r.params));
  assert(metas.every((m) => m.diff === undefined), "…so approvalMeta().diff is undefined for every real request");
}

// ============ 5. decision scopes — all four verified against the real server ============
console.log("\nCodex 결정 범위 4가지 (each recorded end-to-end):");
{
  const request = requests.get("codex-command-once.jsonl");
  const options = codexApprovalOptions(approvalMeta(request.method, request.params));
  assert(options.join(",") === "decline,once,session,always", `card offers all four (${options.join(", ")})`);

  const expected = {
    "codex-command-once.jsonl": ["once", "accept", "completed"],
    "codex-command-session.jsonl": ["session", "acceptForSession", "completed"],
    "codex-command-always.jsonl": ["always", "acceptWithExecpolicyAmendment", "completed"],
    "codex-command-decline.jsonl": ["decline", "decline", "declined"],
  };
  for (const [name, [decision, wire, execStatus]] of Object.entries(expected)) {
    const request2 = requests.get(name);
    const result = approvalResult(request2.method, decision, request2.params, undefined);
    const sent = typeof result.decision === "string" ? result.decision : Object.keys(result.decision)[0];
    assert(sent === wire, `${decision} → ${wire}`);

    const frames = readJsonl(path.join(fixtureDir, name));
    const exec = frames.filter((f) => f.payload?.method === "item/completed" && f.payload.params?.item?.type === "commandExecution");
    assert(exec.some((f) => f.payload.params.item.status === execStatus), `…and the real server actually ${execStatus} the command`);
  }
}

// ============ 6. availableDecisions: a real field the generated schema omits ============
console.log("\navailableDecisions (present in traffic, absent from `codex app-server generate-ts`):");
{
  const request = requests.get("codex-command-once.jsonl");
  const available = request.params.availableDecisions;
  assert(Array.isArray(available), "the server advertises availableDecisions");
  const names = available.map((d) => (typeof d === "string" ? d : Object.keys(d)[0]));
  assert(!names.includes("acceptForSession"), `it OMITS acceptForSession (${names.join(", ")})`);
  // Measured: acceptForSession is honoured anyway (§5 above proves the command ran),
  // so the list under-reports. Building the button set from it would REMOVE a
  // working choice — recorded here so nobody "fixes" the card by trusting it.
  assert(true, "…yet acceptForSession works — the list under-reports, so the card must not be built from it");
}

// ============ 7. approvalPolicy changes the card, not just the frequency ============
console.log("\napprovalPolicy 별 카드 차이 (measured):");
{
  const escalation = requests.get("codex-command-once.jsonl");            // on-request
  const untrusted = requests.get("codex-untrusted-no-reason.jsonl");      // untrusted
  assert(typeof escalation.params.reason === "string", "on-request: the model explains WHY (reason present)");
  assert(untrusted.params.reason === undefined, "untrusted: NO reason at all — the 요청 사유 line has nothing to show");

  // Approving under `untrusted` permits the command but not the sandbox escape,
  // so the user can approve and still watch it fail. Recorded, not assumed.
  const frames = readJsonl(path.join(fixtureDir, "codex-untrusted-no-reason.jsonl"));
  const exec = frames.filter((f) => f.payload?.method === "item/completed" && f.payload.params?.item?.type === "commandExecution");
  assert(exec.some((f) => f.payload.params.item.status === "failed"), "…and approving it still fails: approval ≠ sandbox escalation");
}

// ============ 8. a trusted read runs with no approval at all ============
console.log("\n음성 대조 (negative control):");
{
  const auto = approvalRequestOf(path.join(fixtureDir, "codex-no-approval-trusted-read.jsonl"));
  assert(auto === undefined, "`git status` raises NO approval — it is on Codex's trusted list");
  assert(outcomeOf(path.join(fixtureDir, "codex-no-approval-trusted-read.jsonl")).completed, "…and the turn still completes");
}

// ============ 9. Claude Code — the SDK callback boundary ============
console.log("\nClaude Code (canUseTool, recorded from claude-haiku-4-5):");
{
  const claudeRequest = (name) => {
    for (const frame of readJsonl(path.join(fixtureDir, name))) {
      if (frame.direction === "permission_request") return frame.payload;
    }
    return undefined;
  };

  const bash = claudeRequest("claude-bash.jsonl");
  const edit = claudeRequest("claude-file-edit.jsonl");
  assert(bash !== undefined && edit !== undefined, "Bash + Edit approvals recorded");

  // Unlike Codex, the SDK's declared option list is complete — nothing extra.
  const declared = ["signal", "suggestions", "blockedPath", "decisionReason", "title", "displayName", "description", "toolUseID", "agentID"];
  const unknown = bash.optionKeys.filter((k) => !declared.includes(k));
  assert(unknown.length === 0, `no undeclared option keys (unlike Codex's availableDecisions)`);

  // C2: blockedPath is real and populated — and never reaches the UI.
  assert(typeof bash.options.blockedPath === "string" && bash.options.blockedPath.length > 0,
    `blockedPath carries a real path (${path.basename(bash.options.blockedPath)})`);

  // C1: the "always allow" payload is not just present, it is a PREFIX RULE.
  const rules = (bash.options.suggestions || []).filter((s) => s.type === "addRules");
  assert(rules.length > 0, "suggestions include an addRules update");
  const rule = rules[0].rules[0];
  assert(typeof rule.ruleContent === "string" && rule.ruleContent.includes("*"),
    `…and it is a displayable prefix rule (${JSON.stringify(rule.ruleContent)})`);
  assert(rules[0].destination === "localSettings", "…persisted to localSettings, not merely the session");

  // 설명 (1-10-1): Bash carries the model's own description of the command.
  assert(typeof bash.options.description === "string" && bash.options.description.length > 0,
    `설명 present (${JSON.stringify(bash.options.description)})`);
  assert(bash.options.title === undefined, "title is absent → the card falls back to displayName");

  // 파일 diff: Claude does carry the before/after, unlike Codex.
  assert(typeof edit.input.old_string === "string" && typeof edit.input.new_string === "string",
    "Edit input carries old_string/new_string — a diff IS reconstructable for Claude");
  assert(edit.options.decisionReason === undefined, "…but an ordinary in-cwd edit has NO decisionReason (사유 칸이 빈다)");

  // The outside-cwd variant is a different card: it gains a reason.
  const outside = claudeRequest("claude-write-outside-cwd.jsonl");
  assert(outside.options.decisionReason === "Path is outside allowed working directories",
    "writing outside the workspace DOES give a reason");

  const auto = claudeRequest("claude-no-approval-trusted-read.jsonl");
  assert(auto === undefined, "`git status` never reaches canUseTool — auto-allowed, like Codex");
}

// ============ 10. the shipped QA mock is the recording, not a copy ============
console.log("\nQA 목업 (src/shared/approvalScenarios.ts, generated):");
{
  const { APPROVAL_SCENARIOS, approvalScenarioNames } = await bundle("src/shared/approvalScenarios.ts", "approval-scenarios.mjs");
  const { codexApprovalFields, claudeApprovalFields } = await bundle("src/shared/approvalRequest.ts", "approval-request.mjs");

  // Drift guard: regenerating from the fixtures must reproduce the module.
  // Without this the generated file could be edited by hand and quietly stop
  // being real traffic — the failure mode this whole issue is about.
  for (const name of approvalScenarioNames()) {
    const recorded = approvalRequestOf(path.join(fixtureDir, `${name}.jsonl`));
    const scenario = APPROVAL_SCENARIOS[name];
    if (scenario.harness === "codex") {
      assert(JSON.stringify(scenario.params) === JSON.stringify(recorded.params),
        `${name}: shipped params are byte-identical to the recording`);
    } else {
      const frame = readJsonl(path.join(fixtureDir, `${name}.jsonl`)).find((f) => f.direction === "permission_request");
      assert(JSON.stringify(scenario.input) === JSON.stringify(frame.payload.input),
        `${name}: shipped input is byte-identical to the recording`);
    }
  }

  // Expansion: injecting a scenario must produce the same card fields a live
  // harness produces, because both go through the same mapping.
  const codexCard = codexApprovalFields(APPROVAL_SCENARIOS["codex-command-once"].method, APPROVAL_SCENARIOS["codex-command-once"].params);
  assert(codexCard.codex.kind === "command" && codexCard.codex.command.includes("echo one"), "codex scenario expands to a command card with the real command");
  assert(codexCard.title === "명령 실행 승인", "…with the harness-specific title");

  const bash = APPROVAL_SCENARIOS["claude-bash"];
  const claudeCard = claudeApprovalFields(bash.toolName, bash.input, bash.options);
  assert(claudeCard.blockedPath && claudeCard.blockedPath.endsWith("b18a.txt"), "claude scenario expands with blockedPath reaching the card (C2)");
  assert(Array.isArray(claudeCard.suggestions) && claudeCard.suggestions.some((s) => s.type === "addRules"), "…and the prefix rule reaching the card (C1)");
  assert(claudeCard.title === "Bash", "…and displayName standing in for the absent title");

  // Negative controls must NOT become injectable blank cards.
  assert(!approvalScenarioNames().includes("codex-no-approval-trusted-read"), "negative controls are excluded from the injectable set");
}

console.log(`\n${failures.length ? `FAILED (${failures.length})` : "PASSED"} — ${files.length} recordings`);
failures.forEach((f) => console.log(`  ✗ ${f}`));
process.exit(failures.length ? 1 : 0);
