const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = "C:\\Project\\AgentPartyApp";
const qaWorkspace = path.join(os.tmpdir(), "agentparty-app-e2e-workspace");
const ports = Array.from({ length: 30 }, (_, index) => 47831 + index);

async function main() {
  fs.rmSync(qaWorkspace, { recursive: true, force: true });
  fs.mkdirSync(qaWorkspace, { recursive: true });
  const child = spawn(process.env.ComSpec || "cmd.exe", ["/c", "npm", "run", "start"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, AGENTPARTY_E2E: "1" },
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
    assert(createdParty.members.some((member) => member.name === "main" && member.status === "idle"), "main member created without started session");

    const createdMember = await postJson(`${baseUrl}/api/party/members`, {
      name: `qa-${Date.now()}`,
      runtime: "claude-code",
      requirement: "E2E-only member. Do not call providers.",
    });
    assert(createdMember.ok && createdMember.members?.length, "party member created");
    const memberName = createdMember.member.name;
    const party = await getJson(`${baseUrl}/api/party`);
    assert(party.members.some((member) => member.name === memberName), "party member listed");
    const partyMessage = await postJson(`${baseUrl}/api/party/messages`, {
      from: "qa",
      to: memberName,
      content: "This should be queued because no session is bound.",
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

    const capture = await postJson(`${baseUrl}/api/capture`, {});
    assert(capture.ok && capture.path && capture.bytes > 1000, "capture returns png file");
    await postJson(`${baseUrl}/api/navigation`, { view: "sessions" });

    await postJson(`${baseUrl}/api/window/maximize`, {});
    await postJson(`${baseUrl}/api/window/maximize`, {});
    await postJson(`${baseUrl}/api/window/close`, {});
    await waitForExit(child);
    console.log("E2E smoke passed");
  } catch (error) {
    child.kill();
    throw error;
  }
}

async function waitForApi() {
  const started = Date.now();
  while (Date.now() - started < 30000) {
    for (const port of ports) {
      const baseUrl = `http://127.0.0.1:${port}`;
      try {
        const health = await getJson(`${baseUrl}/api/health`);
        if (health?.ok) {
          return baseUrl;
        }
      } catch {
        // keep polling
      }
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
