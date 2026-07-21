/*
 * Fail-open must never read as success.
 *
 * When the reviewer cannot be reached — most often because the subscription its
 * model needs is not connected — the gate delivers the message unreviewed. That
 * is the intended policy, but it MUST be reported. The transcript badge alone is
 * not enough: it is only emitted when the sending member has a live session, and
 * an automation/MCP caller never sees it at all. Before this, such a send
 * returned a plain "Message delivered to 'x'." and looked identical to a
 * reviewed, approved delivery.
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const assert = (c, m) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) failures.push(m); };
const outDir = path.join(projectRoot, "node_modules/.qa"); mkdirSync(outDir, { recursive: true });

const workspace = path.join(os.tmpdir(), `qa-gate-failopen-${Date.now()}`);
mkdirSync(workspace, { recursive: true });
process.env.AGENTPARTY_USER_DATA = workspace;

const r = await build({
  entryPoints: [path.join(projectRoot, "src/main/application/partyApplicationService.ts")],
  bundle: true, format: "cjs", platform: "node", write: false, external: ["electron"],
});
const file = path.join(outDir, "party-service.cjs");
writeFileSync(file, r.outputFiles[0].text);
const { PartyApplicationService } = createRequire(import.meta.url)(file);

/** A session manager stub with NO live sessions — the case where no badge can be shown. */
const sessionManager = {
  hasSession: () => false,
  emitGateBadge: () => undefined,
  on: () => undefined,
  listSessions: () => [],
};

function serviceWith(reviewGate) {
  return new PartyApplicationService({ sessionManager, getWorkspacePath: () => workspace, reviewGate });
}

const RULE = "멤버 간 모든 메시지는 한국어로 작성해야 한다.";

async function setup(reviewGate) {
  const svc = serviceWith(reviewGate);
  const created = svc.createParty({ name: `p-${Math.random().toString(36).slice(2)}`, gate: { enabled: true, rule: RULE } });
  const partyId = created.parties[created.parties.length - 1].id;
  // A new party already carries a "main" member; only the sender is added.
  await svc.createMember({ partyId, name: "req", requirement: "sender" });
  return { svc, partyId };
}

console.log("\nreviewer unreachable (its subscription is not connected):");
{
  const { svc, partyId } = await setup(async () => {
    throw new Error("Model 'GPT-5.6 Terra' is not available from the local Codex/ChatGPT subscription proxy.");
  });
  const res = await svc.sendGatedMessage("main", "Hello, please review this.", "req", undefined, partyId);

  assert(/UNREVIEWED/i.test(res.message), "the result says the message went UNREVIEWED");
  assert(/Terra/.test(res.message), `the unusable reviewer is named (${res.message.slice(-90)})`);
  assert(/not available|subscription/i.test(res.message), "the underlying reason is carried, not swallowed");
  assert(/UNREVIEWED/i.test(res.partyMessage?.error || ""), "the recorded message carries the failure");
  // No session is bound in this harness, so the delivery layer records its own
  // diagnostic. The gate notice must be ADDED to it, not overwrite it.
  assert(
    /target_member_has_no_active_session/.test(res.partyMessage?.error || ""),
    `the delivery diagnostic survives alongside the gate notice (${res.partyMessage?.error})`,
  );
  assert(res.partyMessage?.delivered === false, "fail-open hands the message to delivery (its own outcome is unchanged by the gate)");
}

console.log("\na working reviewer stays clean:");
{
  const { svc, partyId } = await setup(async () => ({ verdict: "allow", reason: "" }));
  const res = await svc.sendGatedMessage("main", "안녕하세요.", "req", undefined, partyId);
  assert(!/UNREVIEWED/i.test(res.message), "an approved message carries no failure notice");
  assert(!/UNREVIEWED/i.test(res.partyMessage?.error || ""), "an approved message records no gate failure");
}

console.log("\na rejection is still a rejection (not confused with fail-open):");
{
  const { svc, partyId } = await setup(async () => ({ verdict: "reject", reason: "한국어로 작성해야 합니다." }));
  const res = await svc.sendGatedMessage("main", "Hello.", "req", undefined, partyId);
  assert(/rejected by the message gate/i.test(res.message), "a reject is reported as a reject");
  assert(res.partyMessage?.delivered === false, "a rejected message is NOT delivered");
  assert(!/UNREVIEWED/i.test(res.message), "a reject is not mislabelled as unreviewed");
}

rmSync(workspace, { recursive: true, force: true });
console.log(failures.length ? `\n${failures.length} FAILED` : "\nall passed");
process.exitCode = failures.length ? 1 : 0;
