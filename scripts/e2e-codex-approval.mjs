/*
 * Full-process e2e for Codex approval decisions (Item 2), driven by a fake codex
 * app-server (no model). Launches the REAL app on the LEFT monitor, creates a
 * Codex session, sends a turn that pauses on a command-execution approval, then
 * resolves it via the automation API with { codexDecision: "session" } and asserts
 * the whole path produced the correct protocol decision ("acceptForSession").
 *
 * A second pass resolves a file-change approval with "always" and asserts it
 * degrades to "acceptForSession" (patches have no prefix rule).
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fakeServer = path.join(root, "scripts", "fake-codex-appserver.mjs");
const qaWorkspace = path.join(os.tmpdir(), "agentparty-codex-approval-e2e-workspace");
const qaUserData = path.join(os.tmpdir(), "agentparty-codex-approval-e2e-user-data");
const decisionFile = path.join(os.tmpdir(), `agentparty-codex-approval-decision-${process.pid}.json`);
const automationPort = Number(process.env.AGENTPARTY_APPROVAL_E2E_PORT || "") || 48934;

async function main() {
  await removePath(qaWorkspace);
  await removePath(qaUserData);
  await removePath(decisionFile);
  fs.mkdirSync(qaWorkspace, { recursive: true });

  const child = spawn(process.env.ComSpec || "cmd.exe", ["/c", "npm", "run", "start"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      AGENTPARTY_ALLOW_MULTI_INSTANCE: "1",
      AGENTPARTY_AUTOMATION_PORT: String(automationPort),
      AGENTPARTY_USER_DATA: qaUserData,
      AGENTPARTY_WINDOW_DISPLAY: "left",
      AGENTPARTY_CODEX_BIN: process.execPath,
      AGENTPARTY_CODEX_ARGS: JSON.stringify([fakeServer]),
      AGENTPARTY_FAKE_CODEX_OUT: decisionFile,
    },
    windowsHide: true,
  });
  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  try {
    const baseUrl = await waitForApi();
    assert((await getJson(`${baseUrl}/api/health`)).ok, "health ok");

    const windows = await getJson(`${baseUrl}/api/windows`);
    const windowId = windows.windows?.[0]?.id;
    assert(windowId, "test window discovered");
    await postJson(`${baseUrl}/api/windows/${encodeURIComponent(windowId)}/workspace`, { workspacePath: qaWorkspace });

    // ---- command approval → "this session" → acceptForSession -----------------
    await removePath(decisionFile);
    const decision = await runApproval(baseUrl, "command", { codexDecision: "session" });
    assert(JSON.stringify(decision) === JSON.stringify({ decision: "acceptForSession" }), `command 'this session' → acceptForSession (got ${JSON.stringify(decision)})`);

    // ---- command approval → "always" (rule offered) → execpolicy amendment ----
    await removePath(decisionFile);
    const always = await runApproval(baseUrl, "command", { codexDecision: "always" });
    assert(always?.decision?.acceptWithExecpolicyAmendment?.execpolicy_amendment?.join(" ") === "git status", `command 'always' → acceptWithExecpolicyAmendment (got ${JSON.stringify(always)})`);

    // ---- file-change approval → "always" → degrades to acceptForSession -------
    await removePath(decisionFile);
    const patch = await runApproval(baseUrl, "fileChange", { codexDecision: "always" });
    assert(JSON.stringify(patch) === JSON.stringify({ decision: "acceptForSession" }), `fileChange 'always' degrades to acceptForSession (got ${JSON.stringify(patch)})`);

    await postJson(`${baseUrl}/api/window/close`, {});
    await waitForExit(child);
    console.log("CODEX APPROVAL E2E PASSED");
    // Exit explicitly. Every assertion passes and the app process is gone, but
    // the script's own stdio pipes keep the event loop alive, so node never
    // returned on its own — the run reported a non-zero exit long after it had
    // actually succeeded, which is worse than failing loudly.
    process.exitCode = 0;
  } catch (error) {
    killProcessTree(child.pid);
    throw error;
  } finally {
    await removePath(decisionFile);
    process.exit(process.exitCode ?? 0);
  }
}

/** Creates a Codex session (fake server keyed to `kind`), sends a turn, waits for
 *  the approval, resolves it, and returns the decision the fake server received. */
async function runApproval(baseUrl, kind, updatedInput) {
  // The fake server picks its approval kind from the turn's input text ("KIND=...").
  const session = await postJson(`${baseUrl}/api/sessions`, {
    workspacePath: qaWorkspace,
    selectedHarnessId: "codex",
    selectedProviderId: "openai",
    model: "gpt-5.4-mini",
    permissionMode: "default",
    codexPolicy: { sandbox: "read-only", approval: "on-request", guardian: false },
  });
  assert(session.id, `${kind}: codex session created`);

  await postJson(`${baseUrl}/api/sessions/${session.id}/send`, { text: `KIND=${kind} please act` });
  await waitForApproval(baseUrl, session.id);
  assert(true, `${kind}: session paused on an approval`);

  await postJson(`${baseUrl}/api/sessions/${session.id}/approve`, { requestId: "srv-approval-1", behavior: updatedInput.codexDecision === "decline" ? "deny" : "allow", updatedInput });
  const decision = await waitForDecisionFile();
  await postJson(`${baseUrl}/api/sessions/${session.id}/close`, {});
  return decision;
}

async function waitForApproval(baseUrl, sessionId) {
  const started = Date.now();
  while (Date.now() - started < 30000) {
    const state = await getJson(`${baseUrl}/api/state`);
    const session = state.sessions.find((item) => item.id === sessionId);
    if (Number(session?.snapshot?.pendingApprovalCount || 0) >= 1) {
      return;
    }
    if (session?.snapshot?.status === "error") {
      throw new Error(session.snapshot.lastError || "session errored before approval");
    }
    await delay(400);
  }
  throw new Error("approval did not surface within 30s");
}

async function waitForDecisionFile() {
  const started = Date.now();
  while (Date.now() - started < 15000) {
    try {
      const raw = fs.readFileSync(decisionFile, "utf8");
      if (raw.trim()) {
        return JSON.parse(raw);
      }
    } catch {
      // not written yet
    }
    await delay(200);
  }
  throw new Error("fake server never recorded a decision");
}

async function waitForApi() {
  const started = Date.now();
  while (Date.now() - started < 30000) {
    const baseUrl = `http://127.0.0.1:${automationPort}`;
    try {
      if ((await getJson(`${baseUrl}/api/health`))?.ok) {
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
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function removePath(targetPath) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.rmSync(targetPath, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error?.code !== "EBUSY" || attempt === 9) {
        return;
      }
      await delay(300);
    }
  }
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("App did not exit after close API.")), 10000);
    child.once("exit", () => { clearTimeout(timeout); resolve(); });
  });
}

function killProcessTree(pid) {
  if (!pid) {
    return;
  }
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    try { process.kill(pid); } catch { /* already gone */ }
  }
}

function assert(value, message) {
  if (!value) {
    throw new Error(`Assertion failed: ${message}`);
  }
  console.log(`  ok: ${message}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
