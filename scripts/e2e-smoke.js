const { execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = "C:\\Project\\AgentPartyApp";
const qaWorkspace = path.join(os.tmpdir(), "agentparty-app-e2e-workspace");
const automationPort = Number(process.env.AGENTPARTY_E2E_PORT || "") || 48931;

async function main() {
  await removeQaWorkspace();
  fs.mkdirSync(qaWorkspace, { recursive: true });
  const fakeCodex = writeFakeCodex();
  const child = spawn(process.env.ComSpec || "cmd.exe", ["/c", "npm", "run", "start"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      AGENTPARTY_E2E: "1",
      AGENTPARTY_ALLOW_MULTI_INSTANCE: "1",
      AGENTPARTY_AUTOMATION_PORT: String(automationPort),
      AGENTPARTY_CODEX_BIN: process.execPath,
      AGENTPARTY_CODEX_ARGS: JSON.stringify([fakeCodex]),
    },
    windowsHide: true,
  });
  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  try {
    const baseUrl = await waitForApi();
    const health = await getJson(`${baseUrl}/api/health`);
    assert(health.ok, "health ok");
    assert(health.router?.baseUrl, "router base url present");
    assert(health.logs?.logFilePath, "log file path present");

    const spec = await getJson(`${baseUrl}/api/spec`);
    assert(spec.endpoints.includes("POST /api/window/maximize"), "window api in spec");
    assert(spec.endpoints.includes("POST /api/parties"), "party create api in spec");
    assert(spec.endpoints.includes("POST /api/parties/:id/select"), "party select api in spec");
    assert(spec.endpoints.includes("POST /api/party/members"), "party api in spec");
    assert(spec.endpoints.includes("POST /api/party/messages"), "party message api in spec");
    assert(spec.endpoints.includes("POST /api/party/members/:name/bind"), "party bind api in spec");
    assert(spec.endpoints.includes("POST /api/harness/party/messages"), "harness party api in spec");
    assert(spec.endpoints.includes("GET /api/sessions/history"), "session history api in spec");
    assert(spec.endpoints.includes("POST /api/capture"), "capture api in spec");
    assert(spec.endpoints.includes("POST /api/sessions/:id/close"), "session close api in spec");
    assert(spec.endpoints.includes("POST /api/navigation"), "navigation api in spec");

    const settings = await postJson(`${baseUrl}/api/settings`, {
      selectedHarnessId: "claude-code",
      selectedProviderId: "openrouter",
      claudeModel: "MiniMax M3",
      claudeEffort: "medium",
      claudePermissionMode: "plan",
      workspacePath: qaWorkspace,
    });
    assert(settings.selectedProviderId === "openrouter", "provider setting updated");
    assert(settings.claudeModel === "MiniMax M3", "model setting updated");
    assert(settings.claudePermissionMode === "plan", "permission mode setting updated");

    const auth = await postJson(`${baseUrl}/api/auth/openrouter/test`, {});
    assert(Array.isArray(auth), "auth test returns providers");

    const history = await getJson(`${baseUrl}/api/sessions/history`);
    assert(Array.isArray(history.sessions), "history returns session array");

    const createdParty = await postJson(`${baseUrl}/api/parties`, {
      name: `QA Party ${Date.now()}`,
    });
    assert(createdParty.ok && createdParty.currentPartyId, "party created");
    assert(createdParty.members.some((member) => member.name === "main"), "main member created for skill discovery");

    const createdMember = await postJson(`${baseUrl}/api/party/members`, {
      name: `qa-${Date.now()}`,
      runtime: "claude-code",
      requirement: "E2E-only member. Do not call providers.",
    });
    assert(createdMember.ok && createdMember.members?.length, "party member created");
    const memberName = createdMember.member.name;
    const party = await getJson(`${baseUrl}/api/party`);
    assert(party.members.some((member) => member.name === memberName), "party member listed");
    await postJson(`${baseUrl}/api/party/members/${encodeURIComponent(memberName)}/close`, {});
    const partyMessage = await postJson(`${baseUrl}/api/party/messages`, {
      from: "qa",
      to: memberName,
      content: "This should be queued because this non-main member was closed.",
    });
    assert(partyMessage.ok && partyMessage.partyMessage?.delivered === false, "party message queued without live call");
    await postJson(`${baseUrl}/api/party/members/${encodeURIComponent(memberName)}/remove`, {});

    const session = await postJson(`${baseUrl}/api/sessions`, {
      workspacePath: qaWorkspace,
      selectedHarnessId: "claude-code",
      selectedProviderId: "openrouter",
      model: "MiniMax M3",
      effort: "medium",
      permissionMode: "plan",
    });
    assert(session.id && session.snapshot?.model === "MiniMax M3", "session created with preset model");
    assert(session.snapshot?.permissionMode === "plan", "session created with preset permission mode");
    await postJson(`${baseUrl}/api/sessions/${session.id}/close`, {});

    const codexSession = await postJson(`${baseUrl}/api/sessions`, {
      workspacePath: qaWorkspace,
      selectedHarnessId: "codex",
      selectedProviderId: "openai",
      model: "gpt-5.4",
      permissionMode: "plan",
    });
    assert(codexSession.id && codexSession.snapshot?.model === "gpt-5.4", "codex session created with preset model");
    assert(codexSession.snapshot?.slashCommands?.some((command) => command.name === "approvals"), "codex session exposes codex slash commands");
    await postJson(`${baseUrl}/api/sessions/${codexSession.id}/send`, { text: "Reply with PONG." });
    await waitForCodexTurn(baseUrl, codexSession.id);
    await postJson(`${baseUrl}/api/sessions/${codexSession.id}/close`, {});

    const capture = await postJson(`${baseUrl}/api/capture`, {});
    assert(capture.ok && capture.path && capture.bytes > 1000, "capture returns png file");
    await postJson(`${baseUrl}/api/navigation`, { view: "sessions" });

    await postJson(`${baseUrl}/api/window/maximize`, {});
    await postJson(`${baseUrl}/api/window/maximize`, {});
    await postJson(`${baseUrl}/api/window/close`, {});
    await waitForExit(child);
    console.log("E2E smoke passed");
  } catch (error) {
    killProcessTree(child.pid);
    throw error;
  }
}

function writeFakeCodex() {
  const scriptPath = path.join(qaWorkspace, "fake-codex.mjs");
  fs.writeFileSync(scriptPath, [
    "import readline from 'node:readline';",
    "const threadId = 'codex-e2e-thread';",
    "let turn = 0;",
    "const out = (value) => console.log(JSON.stringify(value));",
    "const rl = readline.createInterface({ input: process.stdin });",
    "rl.on('line', (line) => {",
    "  const msg = JSON.parse(line);",
    "  if (msg.method === 'initialize') {",
    "    out({ id: msg.id, result: { userAgent: 'fake-codex-app-server', codexHome: process.cwd(), platformFamily: 'windows', platformOs: 'windows' } });",
    "    return;",
    "  }",
    "  if (msg.method === 'initialized') { return; }",
    "  if (msg.method === 'thread/start' || msg.method === 'thread/resume') {",
    "    out({ id: msg.id, result: { thread: { id: threadId, sessionId: threadId, status: { type: 'idle' }, cwd: process.cwd(), turns: [] }, model: msg.params?.model || 'gpt-5.4', modelProvider: 'openai', cwd: process.cwd(), instructionSources: [], approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'readOnly', networkAccess: false }, reasoningEffort: 'medium' } });",
    "    return;",
    "  }",
    "  if (msg.method === 'turn/start') {",
    "    turn += 1;",
    "    const turnId = `turn-${turn}`;",
    "    out({ id: msg.id, result: { turn: { id: turnId, items: [], itemsView: 'notLoaded', status: 'inProgress', error: null, startedAt: null, completedAt: null, durationMs: null } } });",
    "    out({ method: 'thread/started', params: { thread: { id: threadId, sessionId: threadId, status: { type: 'idle' }, cwd: process.cwd(), turns: [] } } });",
    "    out({ method: 'turn/started', params: { threadId, turn: { id: turnId, items: [], itemsView: 'notLoaded', status: 'inProgress', error: null, startedAt: 1, completedAt: null, durationMs: null } } });",
    "    out({ method: 'item/started', params: { threadId, turnId, item: { type: 'commandExecution', id: 'cmd-1', command: 'echo PONG', cwd: process.cwd(), processId: null, source: 'exec', status: 'inProgress', commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null } } });",
    "    out({ method: 'item/completed', params: { threadId, turnId, item: { type: 'commandExecution', id: 'cmd-1', command: 'echo PONG', cwd: process.cwd(), processId: null, source: 'exec', status: 'completed', commandActions: [], aggregatedOutput: 'PONG', exitCode: 0, durationMs: 1 } } });",
    "    out({ method: 'item/completed', params: { threadId, turnId, item: { type: 'agentMessage', id: `msg-${turn}`, text: 'PONG', phase: 'final_answer', memoryCitation: null } } });",
    "    out({ method: 'thread/tokenUsage/updated', params: { threadId, turnId, tokenUsage: { total: { totalTokens: 12, inputTokens: 10, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 }, last: { totalTokens: 12, inputTokens: 10, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 }, modelContextWindow: 1000 } } });",
    "    out({ method: 'thread/status/changed', params: { threadId, status: { type: 'idle' } } });",
    "    out({ method: 'turn/completed', params: { threadId, turn: { id: turnId, items: [], itemsView: 'notLoaded', status: 'completed', error: null, startedAt: 1, completedAt: 2, durationMs: 1 } } });",
    "  }",
    "});",
  ].join("\n"), "utf8");
  return scriptPath;
}

async function waitForCodexTurn(baseUrl, sessionId) {
  const started = Date.now();
  while (Date.now() - started < 10000) {
    const state = await getJson(`${baseUrl}/api/state`);
    const session = state.sessions.find((item) => item.id === sessionId);
    if (session?.snapshot?.turnCount >= 1 && session.snapshot.status === "idle") {
      return;
    }
    await delay(250);
  }
  throw new Error("Codex fake turn did not complete.");
}

async function removeQaWorkspace() {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.rmSync(qaWorkspace, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error?.code !== "EBUSY" || attempt === 9) {
        throw error;
      }
      await delay(300);
    }
  }
}

async function waitForApi() {
  const started = Date.now();
  while (Date.now() - started < 30000) {
    const baseUrl = `http://127.0.0.1:${automationPort}`;
    try {
      const health = await getJson(`${baseUrl}/api/health`);
      if (health?.ok) {
        return baseUrl;
      }
    } catch {
      // keep polling
    }
    await delay(500);
  }
  throw new Error("Automation API did not start.");
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }
  return response.json();
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("App did not exit after close API.")), 10000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function killProcessTree(pid) {
  if (!pid) {
    return;
  }
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    try {
      process.kill(pid);
    } catch {
      // Process already exited.
    }
  }
}

function assert(value, message) {
  if (!value) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
