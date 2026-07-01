/*
 * Fake Codex app-server — a deterministic JSON-RPC stub over stdio for full-
 * process e2e (no model, no network). It speaks just enough of the real protocol
 * for CodexAdapter to drive a turn that pauses on a command-execution approval,
 * then records the decision the client sends back so the e2e can assert the whole
 * approval path (adapter → engine → /api/approve → respondApproval → protocol).
 *
 * Spawned as: node fake-codex-appserver.mjs app-server
 * The approval kind is taken from the turn's input text ("KIND=fileChange" →
 * file-change approval; otherwise a command approval), so one launched stub can
 * serve both cases across sessions.
 *
 * Env:
 *   AGENTPARTY_FAKE_CODEX_OUT   — file to write the received decision JSON to
 */
import readline from "node:readline";
import fs from "node:fs";

const APPROVAL_ID = "srv-approval-1";
const outFile = process.env.AGENTPARTY_FAKE_CODEX_OUT || "";

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const text = line.trim();
  if (!text) {
    return;
  }
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }

  // Response to our server→client approval request: { id: APPROVAL_ID, result }.
  if (msg.id !== undefined && msg.result !== undefined && String(msg.id) === APPROVAL_ID) {
    if (outFile) {
      try {
        fs.writeFileSync(outFile, JSON.stringify(msg.result));
      } catch {
        // best effort
      }
    }
    // Close out the turn so the session returns to idle.
    send({ method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } });
    return;
  }

  // Client → server requests (have id + method).
  if (msg.id !== undefined && msg.method) {
    if (msg.method === "initialize") {
      send({ id: msg.id, result: { userAgent: "fake-codex/0.0.0" } });
      return;
    }
    if (msg.method === "thread/start" || msg.method === "thread/resume") {
      send({ id: msg.id, result: { thread: { id: "thr-fake" }, model: msg.params?.model || "fake" } });
      return;
    }
    if (msg.method === "turn/start") {
      send({ id: msg.id, result: { turn: { id: "turn-1" } } });
      send({ method: "turn/started", params: { turn: { id: "turn-1" } } });
      const inputText = (msg.params?.input || []).map((part) => String(part?.text || "")).join(" ");
      const kind = inputText.includes("KIND=fileChange") ? "fileChange" : "command";
      send(approvalRequest(kind, msg.params?.cwd || ""));
      return;
    }
    // Any other request: acknowledge with an empty result so nothing hangs.
    send({ id: msg.id, result: {} });
    return;
  }
  // Notifications (initialized, etc.) need no response.
});

function approvalRequest(kind, cwd) {
  if (kind === "fileChange") {
    return {
      id: APPROVAL_ID,
      method: "item/fileChange/requestApproval",
      params: { threadId: "thr-fake", turnId: "turn-1", itemId: "it-1", startedAtMs: 0, reason: "패치 적용", diff: "--- a/x\n+++ b/x\n@@\n-old\n+new" },
    };
  }
  return {
    id: APPROVAL_ID,
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thr-fake",
      turnId: "turn-1",
      itemId: "it-1",
      startedAtMs: 0,
      command: "git status",
      cwd,
      proposedExecpolicyAmendment: ["git", "status"],
    },
  };
}
