/*
 * Generates src/shared/approvalScenarios.ts from the RECORDED approval traffic
 * in scripts/fixtures/approvals/*.jsonl.
 *
 * The QA mock has to ship inside the app, but its values must not be typed by
 * hand — hand-typed values are what let the approval card be "verified" against
 * a `diff` field no Codex build ever sends (B-18). So the scenarios are
 * generated from the recordings, and scripts/qa-approval-shapes.mjs asserts the
 * generated module still matches them, which makes drift a test failure rather
 * than a quiet lie.
 *
 * Run after recording: node scripts/build-approval-scenarios.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDir = path.join(root, "scripts", "fixtures", "approvals");
const outFile = path.join(root, "src", "shared", "approvalScenarios.ts");

const readJsonl = (file) =>
  fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));

/**
 * The file edits belonging to an approval, taken from the `fileChange` item it
 * names in `itemId`. A file-change approval carries no diff itself, so without
 * this the injected card is as empty as the live one used to be.
 */
function editsFor(frames, itemId) {
  if (!itemId) return undefined;
  for (const frame of frames) {
    const item = frame.payload?.params?.item;
    if (item?.type === "fileChange" && item.id === itemId && Array.isArray(item.changes)) {
      return item.changes;
    }
  }
  return undefined;
}

/** Pulls the one approval request out of a recording, with its harness tag. */
function scenarioOf(file) {
  const frames = readJsonl(file);
  for (const frame of frames) {
    const p = frame.payload;
    if (frame.direction === "in" && p && typeof p.method === "string" && p.id !== undefined
      && /requestApproval|requestUserInput|elicitation\/request/.test(p.method)) {
      const changes = editsFor(frames, p.params?.itemId);
      return { harness: "codex", method: p.method, params: p.params, ...(changes ? { changes } : {}) };
    }
    if (frame.direction === "permission_request") {
      const options = { ...p.options };
      delete options.signal;
      return { harness: "claude-code", toolName: p.toolName, input: p.input, options };
    }
  }
  return undefined;
}

const entries = [];
for (const name of fs.readdirSync(fixtureDir).filter((n) => n.endsWith(".jsonl")).sort()) {
  const scenario = scenarioOf(path.join(fixtureDir, name));
  const id = name.replace(/\.jsonl$/, "");
  if (!scenario) {
    // Negative controls hold no approval on purpose; skip rather than emit an
    // empty scenario that would inject a blank card.
    console.log(`  – ${id}: no approval request (negative control), skipped`);
    continue;
  }
  entries.push([id, scenario]);
  console.log(`  ✓ ${id} (${scenario.harness})`);
}

if (!entries.length) {
  console.error("No approval recordings found. Run scripts/record-approval-traffic.mjs first.");
  process.exit(1);
}

const header = `/**
 * Recorded approval scenarios — GENERATED, DO NOT EDIT BY HAND.
 *
 * Produced by scripts/build-approval-scenarios.mjs from the real traffic in
 * scripts/fixtures/approvals/*.jsonl (codex-cli 0.145.0 + gpt-5.4-mini,
 * claude-haiku-4-5). Injecting one of these drives the approval card through the
 * SAME mapping a live harness does (src/shared/approvalRequest.ts), so the UI can
 * be designed, demoed and QA'd without paying for a model turn each time.
 *
 * Every value here was sent by a real harness. Nothing is authored.
 * Re-record with scripts/record-approval-traffic.mjs, then re-run the generator.
 */

/** A recorded server request, tagged with the harness that sent it. */
export type ApprovalScenario =
  | { harness: "codex"; method: string; params: Record<string, unknown>; changes?: unknown[] }
  | { harness: "claude-code"; toolName: string; input: unknown; options: Record<string, unknown> };

export const APPROVAL_SCENARIOS: Record<string, ApprovalScenario> = `;

const body = JSON.stringify(Object.fromEntries(entries), null, 2);

const footer = `;

export function approvalScenarioNames(): string[] {
  return Object.keys(APPROVAL_SCENARIOS);
}
`;

fs.writeFileSync(outFile, `${header}${body}${footer}`);
console.log(`\n${entries.length} scenarios → ${path.relative(root, outFile)}`);
