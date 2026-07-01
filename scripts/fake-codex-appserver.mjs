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
    if (msg.method === "skills/list") {
      send({ id: msg.id, result: { data: [{ cwd: msg.params?.cwds?.[0] || "/w", skills: [
        { name: "deep-dive", shortDescription: "심층 분석 스킬", enabled: true },
        { name: "legacy-skill", description: "구버전", enabled: false },
      ], errors: [] }] } });
      return;
    }
    if (msg.method === "plugin/installed") {
      send({ id: msg.id, result: { marketplaces: [{ plugins: [
        { summary: { id: "fmt", name: "formatter", installed: true, enabled: true, availability: "AVAILABLE", keywords: ["format"] } },
        { summary: { id: "blk", name: "blocked-plugin", installed: true, enabled: true, availability: "DISABLED_BY_ADMIN" } },
      ] }], marketplaceLoadErrors: [] } });
      return;
    }
    if (msg.method === "turn/start") {
      send({ id: msg.id, result: { turn: { id: "turn-1" } } });
      send({ method: "turn/started", params: { turn: { id: "turn-1" } } });
      const inputText = (msg.params?.input || []).map((part) => String(part?.text || "")).join(" ");
      const cwd = msg.params?.cwd || "";
      if (inputText.includes("KIND=items")) {
        emitItemStream(cwd);
        send({ method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } });
        return;
      }
      const kind = inputText.includes("KIND=fileChange") ? "fileChange" : "command";
      send(approvalRequest(kind, cwd));
      return;
    }
    // Any other request: acknowledge with an empty result so nothing hangs.
    send({ id: msg.id, result: {} });
    return;
  }
  // Notifications (initialized, etc.) need no response.
});

/** Emits every transcript ThreadItem type so the adapter's normalizeItem is exercised end-to-end. */
function emitItemStream(cwd) {
  // plan (structured steps via turn/plan/updated)
  send({ method: "turn/plan/updated", params: { threadId: "thr-fake", turnId: "turn-1", explanation: "작업 계획", plan: [{ step: "환경 점검", status: "completed" }, { step: "테스트 실행", status: "inProgress" }] } });
  // commandExecution with live output
  const cmd = { type: "commandExecution", id: "cmd-1", command: "npm test", cwd, source: "agent", status: "inProgress", commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null, processId: null };
  send({ method: "item/started", params: { item: cmd } });
  send({ method: "item/commandExecution/outputDelta", params: { threadId: "thr-fake", turnId: "turn-1", itemId: "cmd-1", delta: "running tests...\n" } });
  send({ method: "item/commandExecution/outputDelta", params: { threadId: "thr-fake", turnId: "turn-1", itemId: "cmd-1", delta: "PASS 12 tests\n" } });
  send({ method: "item/completed", params: { item: { ...cmd, status: "completed", aggregatedOutput: "running tests...\nPASS 12 tests\n", exitCode: 0, durationMs: 1420 } } });
  // fileChange (per-file diff)
  send({ method: "item/completed", params: { item: { type: "fileChange", id: "fc-1", status: "completed", changes: [{ path: "src/app.ts", kind: { type: "update" }, diff: "--- a/src/app.ts\n+++ b/src/app.ts\n@@\n-const x = 1;\n+const x = 2;\n+const y = 3;" }] } } });
  // mcpToolCall (source badge)
  send({ method: "item/completed", params: { item: { type: "mcpToolCall", id: "mcp-1", server: "brave", tool: "search", status: "completed", arguments: { q: "codex" }, pluginId: null, result: { ok: true }, error: null, durationMs: 210 } } });
  // webSearch
  send({ method: "item/completed", params: { item: { type: "webSearch", id: "ws-1", query: "codex app-server", action: null } } });
}

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
