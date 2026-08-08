/*
 * RECORDER for B-18 — captures what the real harnesses actually send when they
 * ask for approval, so QA fixtures hold measured values instead of guesses.
 *
 * Follows the subagent precedent (scripts/fixtures/subagents/*.jsonl replayed by
 * scripts/qa-subagent-tracker.mjs): record real traffic once, drive QA off the
 * recording. Nothing here is hand-authored protocol.
 *
 * WHY IT DOES NOT LAUNCH THE APP: the frames we need ARE the harness protocol,
 * so driving the harness process directly yields byte-identical traffic while
 * touching no port, no userData and no running AgentParty instance. The app's
 * own rendering of these frames is verified separately, by injecting the
 * fixtures (B-18 §5).
 *
 * The handshake below mirrors src/core/codexAdapter.ts exactly (initialize →
 * initialized → thread/start → turn/start, newline-delimited {id,method,params}
 * — note this is NOT JSON-RPC 2.0, there is no `jsonrpc` field).
 *
 * Usage:
 *   node scripts/record-approval-traffic.mjs --harness codex [--scenario command]
 *
 * ⚠️ Refuses rather than inventing: a scenario that raises no approval is
 * reported NOT CAPTURED and the run exits non-zero. A recorder that quietly
 * writes an empty fixture is the [#21] failure again.
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const harness = argOf("--harness", "codex");
const only = argOf("--scenario", "");
const model = argOf("--model", "gpt-5.4-mini");
const stringifyId = argv.includes("--stringify-id");

const outDir = path.join(root, "scripts", "fixtures", "approvals");
const workspace = path.join(os.tmpdir(), `agentparty-b18-${harness}-ws`);

/**
 * One short turn each, chosen to force a specific approval kind and decision.
 * Prompts are minimal on purpose: the goal is the traffic shape, not a chat.
 */
/*
 * MEASURED (2026-08-08): `git status` under approvalPolicy=untrusted runs with
 * NO approval — it is on Codex's trusted read-only list. Only commands that
 * escalate beyond the sandbox actually raise an approval, so every scenario
 * below writes. Recorded proof of the auto-approved case is kept as
 * `codex-no-approval-trusted-read.jsonl` (a negative control: it shows the
 * approval path is genuinely absent, not merely missed by the recorder).
 */
const CODEX_SCENARIOS = [
  { id: "command-once", prompt: "Run this exact shell command, then stop: echo one > b18a.txt", decision: "once" },
  { id: "command-session", prompt: "Run this exact shell command, then stop: echo two > b18b.txt", decision: "session" },
  { id: "command-always", prompt: "Run this exact shell command, then stop: echo three > b18c.txt", decision: "always" },
  { id: "command-decline", prompt: "Run this exact shell command, then stop: echo four > b18d.txt", decision: "decline" },
  // read-only sandbox so the patch itself has to be approved rather than just applied.
  { id: "file-write", prompt: "Create a file named b18.txt whose only content is the word hi. Then stop.", decision: "once" },
  { id: "no-approval-trusted-read", prompt: "Run this exact shell command, then stop: git status", decision: "once", expectNoApproval: true },
  /*
   * MEASURED correction: `untrusted` does NOT suppress the approval — one still
   * arrives. What differs is (a) it carries NO `reason`, because the model is
   * not asking to escalate, and (b) approving it does not lift the sandbox, so
   * the write fails anyway. The two policies produce visibly different cards.
   */
  { id: "untrusted-no-reason", prompt: "Run this exact shell command, then stop: echo five > b18e.txt", decision: "once", approvalPolicy: "untrusted" },
];

const notCaptured = [];
const captured = [];

function prepareWorkspace() {
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(workspace, { recursive: true });
  // A real git repo so `git status` is a meaningful command to approve.
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  fs.writeFileSync(path.join(workspace, "seed.txt"), "seed\n");
  execFileSync("git", ["add", "-A"], { cwd: workspace });
  execFileSync("git", ["-c", "user.email=b18@qa", "-c", "user.name=b18", "commit", "-qm", "seed"], { cwd: workspace });
  fs.writeFileSync(path.join(workspace, "seed.txt"), "seed changed\n");
}

/** Drives one codex app-server turn and records every frame in both directions. */
function recordCodexScenario(scenario) {
  return new Promise((resolve) => {
    const frames = [];
    const sandbox = scenario.sandbox || "read-only";
    const approvalPolicy = scenario.approvalPolicy || "on-request";
    const child = spawn("codex", ["-c", 'cli_auth_credentials_store="file"', "app-server"], {
      cwd: workspace,
      env: process.env,
      windowsHide: true,
      shell: true,
    });

    let seq = 0;
    let threadId = "";
    let approvalSeen = false;
    let done = false;
    const send = (message) => {
      frames.push({ ts: new Date().toISOString(), direction: "out", payload: message });
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const request = (method, params) => {
      const id = `agentparty-${++seq}`;
      send({ id, method, params });
      return id;
    };
    const respond = (id, result) => send({ id, result });

    const finish = (reason) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already gone */ }
      resolve({ frames, approvalSeen, reason });
    };
    const timer = setTimeout(() => finish("timeout"), 180_000);

    let initId = request("initialize", {
      clientInfo: { name: "agentparty", title: "AgentParty", version: "0.1.0" },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: [
          "command/exec/outputDelta",
          "item/agentMessage/delta",
          "item/plan/delta",
          "item/fileChange/outputDelta",
          "item/reasoning/summaryTextDelta",
          "item/reasoning/textDelta",
        ],
      },
    });
    let startId = "";
    let turnId = "";

    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      if (!line.trim()) return;
      let message;
      try { message = JSON.parse(line); } catch { return; }
      frames.push({ ts: new Date().toISOString(), direction: "in", payload: message });

      // --- responses to our requests ---
      if (message.id !== undefined && message.method === undefined) {
        if (message.id === initId) {
          send({ method: "initialized", params: {} });
          startId = request("thread/start", {
            model,
            modelProvider: null,
            cwd: workspace,
            approvalPolicy,
            approvalsReviewer: "user",
            sandbox,
            config: {},
            developerInstructions: null,
          });
          return;
        }
        if (message.id === startId) {
          threadId = String(message.result?.thread?.id || message.result?.threadId || "");
          turnId = request("turn/start", {
            threadId,
            input: [{ type: "text", text: scenario.prompt, text_elements: [] }],
            cwd: workspace,
            approvalPolicy,
            approvalsReviewer: "user",
            sandboxPolicy: sandboxPolicyObject(sandbox),
            model,
            effort: null,
          });
          return;
        }
        return;
      }

      // --- server → client requests (this is what we came for) ---
      if (message.method && message.id !== undefined) {
        if (/requestApproval|requestUserInput|elicitation\/request/.test(message.method)) {
          approvalSeen = true;
          // `RequestId = string | number` and real Codex sends a NUMBER here.
          // `--stringify-id` reproduces what src/core/codexAdapter.ts does
          // (`String(message.id)`) so the two can be compared directly.
          respond(stringifyId ? String(message.id) : message.id, approvalResultFor(message.method, scenario.decision, message.params));
          return;
        }
        // Anything else the server asks for, answer minimally so the turn ends.
        respond(stringifyId ? String(message.id) : message.id, {});
        return;
      }

      // --- notifications ---
      if (message.method === "turn/completed" || message.method === "turn/failed" || message.method === "turn/aborted") {
        setTimeout(() => finish(message.method), 1500);
      }
    });

    child.stderr.on("data", (chunk) => {
      frames.push({ ts: new Date().toISOString(), direction: "stderr", payload: String(chunk) });
    });
    child.on("error", (error) => {
      frames.push({ ts: new Date().toISOString(), direction: "spawn-error", payload: String(error) });
      finish("spawn-error");
    });
    child.on("exit", () => finish("exit"));
  });
}

/** Mirrors src/shared/codexApproval.ts so the recording exercises OUR mapping. */
function approvalResultFor(method, decision, params) {
  const amendment = Array.isArray(params?.proposedExecpolicyAmendment) ? params.proposedExecpolicyAmendment : undefined;
  if (method === "item/commandExecution/requestApproval" || method === "execCommandApproval") {
    if (decision === "once") return { decision: "accept" };
    if (decision === "session") return { decision: "acceptForSession" };
    if (decision === "always") {
      return amendment && amendment.length
        ? { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: amendment } } }
        : { decision: "acceptForSession" };
    }
    return { decision: "decline" };
  }
  if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval") {
    if (decision === "once") return { decision: "accept" };
    if (decision === "decline") return { decision: "decline" };
    return { decision: "acceptForSession" };
  }
  if (method === "item/tool/requestUserInput") {
    return { answers: {} };
  }
  if (method === "mcpServer/elicitation/request") {
    return { action: decision === "decline" ? "decline" : "accept", content: null, _meta: null };
  }
  return { decision: decision === "decline" ? "decline" : "accept" };
}

function sandboxPolicyObject(mode) {
  if (mode === "danger-full-access") return { type: "dangerFullAccess" };
  if (mode === "workspace-write") {
    return { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
  }
  return { type: "readOnly", networkAccess: false };
}

async function main() {
  if (harness !== "codex") {
    throw new Error(`--harness ${harness} not implemented yet in this recorder.`);
  }
  fs.mkdirSync(outDir, { recursive: true });

  const scenarios = CODEX_SCENARIOS.filter((s) => !only || s.id === only);
  for (const scenario of scenarios) {
    prepareWorkspace();
    process.stdout.write(`\n── codex/${scenario.id} (${scenario.sandbox || "read-only"}) ──\n`);
    const { frames, approvalSeen, reason } = await recordCodexScenario(scenario);
    const file = path.join(outDir, `codex-${scenario.id}.jsonl`);
    fs.writeFileSync(file, frames.map((f) => JSON.stringify(f)).join("\n") + "\n");
    console.log(`  ${frames.length} frames → ${path.basename(file)} (ended: ${reason})`);
    if (scenario.expectNoApproval) {
      // Negative control: this scenario is recorded precisely to show the
      // harness auto-approves it. An approval here would be the surprise.
      if (approvalSeen) {
        notCaptured.push(`codex/${scenario.id}: expected NO approval but one arrived`);
        console.log("  ✗ unexpected approval request");
      } else {
        captured.push(`codex/${scenario.id} (negative control: auto-approved, as expected)`);
        console.log("  ✓ negative control: no approval, as expected");
      }
    } else if (approvalSeen) {
      captured.push(`codex/${scenario.id}`);
      console.log("  ✓ approval request captured");
    } else {
      notCaptured.push(`codex/${scenario.id}: no approval request in this turn (ended: ${reason})`);
      console.log("  ✗ NOT CAPTURED — no approval request");
    }
  }

  console.log("\n=== summary ===");
  captured.forEach((l) => console.log(`  ✓ ${l}`));
  notCaptured.forEach((l) => console.log(`  ✗ ${l}`));
  process.exit(notCaptured.length ? 1 : 0);
}

main().catch((error) => {
  console.error(`Recorder failed: ${error?.message || error}`);
  process.exit(1);
});
