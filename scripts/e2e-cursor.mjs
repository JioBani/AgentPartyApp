import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { firstBaseUrl } from "./lib/discovery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspace = path.join(os.tmpdir(), "agentparty-cursor-e2e-workspace");
const userData = path.join(os.tmpdir(), "agentparty-cursor-e2e-user-data");
const argsOut = path.join(os.tmpdir(), "agentparty-cursor-e2e-args.ndjson");
const fakeCli = path.join(root, "scripts", "fixtures", "fake-cursor-agent.mjs");
let base = "";

async function main() {
  await removePath(workspace);
  await removePath(userData);
  fs.rmSync(argsOut, { force: true });
  fs.mkdirSync(workspace, { recursive: true });

  const child = spawn(process.execPath, [path.join(root, "scripts", "launch-electron.mjs"), "--workspace", workspace], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      AGENTPARTY_QA: "1",
      AGENTPARTY_E2E: "1",
      AGENTPARTY_ALLOW_MULTI_INSTANCE: "1",
      AGENTPARTY_USER_DATA: userData,
      AGENTPARTY_CURSOR_BIN: process.execPath,
      AGENTPARTY_CURSOR_ARGS: JSON.stringify([fakeCli]),
      AGENTPARTY_FAKE_CURSOR_ARGS_OUT: argsOut,
      AGENTPARTY_WINDOW_DISPLAY: "left",
    },
    windowsHide: true,
  });
  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  try {
    await waitForApi();
    assert((await get("/api/health")).ok, "real app process is healthy");

    const spec = await get("/api/spec");
    assert(spec.endpoints.includes("GET /api/harnesses/cursor/status"), "Cursor diagnostics endpoint is registered");
    assert(spec.endpoints.includes("POST /api/sessions/:id/cursor-policy"), "Cursor policy endpoint is registered");

    const status = await get("/api/harnesses/cursor/status");
    assert(status.installed && status.version === "2099.01.01-fake", "AppController drives Cursor CLI diagnostics");
    assert(status.grok45Models.length === 3, "Cursor diagnostics reports all Grok 4.5 effort slugs");

    const models = await get("/api/models");
    const cursorRoutes = models.modelRoutes.filter((route) => route.harnessId === "cursor");
    assert(cursorRoutes.some((route) => route.model === "Auto") && cursorRoutes.some((route) => route.model === "Grok 4.5"), "Cursor harness exposes Auto and Grok 4.5 catalog variants");
    assert(cursorRoutes.some((route) => route.model === "Auto" && route.runtimeModel === "auto"), "Cursor Auto route is available");
    assert(cursorRoutes.some((route) => route.model === "Grok 4.5" && route.runtimeModel === "cursor-grok-4.5-high"), "Cursor named route is Grok 4.5");
    const cursorHarness = models.harnesses.find((harness) => harness.id === "cursor");
    assert(cursorHarness?.permission?.kind === "cursorPolicy", "Cursor harness exposes its own permission contract");
    assert(cursorHarness.permission.mode.join() === "agent,ask,plan", "Cursor mode options match Cursor CLI");
    assert(cursorHarness.permission.approval.join() === "allowlist,auto-review,unrestricted", "Cursor approval options match Cursor CLI");

    await post("/api/settings", {
      selectedHarnessId: "cursor",
      harnessDefaults: {
        "claude-code": { model: "sonnet", effort: "medium", permissionMode: "default" },
        codex: { model: "gpt-5.4", effort: "medium", codexPolicy: { sandbox: "workspace-write", approval: "on-request", guardian: false } },
        cursor: { model: "Grok 4.5", effort: "high", cursorPolicy: { mode: "plan", approval: "auto-review" } },
      },
    });
    const party = await post("/api/parties", { name: "Cursor E2E" });
    assert(party.ok && party.currentPartyId, "Cursor QA party created");
    const created = await post("/api/party/members", {
      name: "grok-worker",
      runtime: "cursor",
      model: "Grok 4.5",
      effort: "high",
      cursorPolicy: { mode: "plan", approval: "auto-review" },
      requirement: "Verify the Cursor CLI integration.",
    });
    assert(created.member?.runtime === "cursor", "Cursor member created through AppController");

    const started = await post("/api/party/members/grok-worker/start", {});
    assert(started.session?.id, "Cursor member session started");
    await post("/api/party/members/grok-worker/message", { text: "first Cursor turn" });
    await waitForTranscript("grok-worker", "CURSOR_FAKE_OK", 1);
    await post(`/api/sessions/${started.session.id}/cursor-policy`, { policy: { mode: "ask", approval: "unrestricted" } });
    await post("/api/party/members/grok-worker/message", { text: "second Cursor turn" });
    await waitForTranscript("grok-worker", "CURSOR_FAKE_OK", 2);

    const calls = fs.readFileSync(argsOut, "utf8").trim().split(/\r?\n/).map(JSON.parse);
    const turns = calls.filter((args) => args.includes("--output-format"));
    assert(turns.length >= 2, "real app spawned Cursor CLI for both user turns");
    assert(turns.every((args) => args.includes("cursor-grok-4.5-high")), "every app turn stays pinned to Grok 4.5 High");
    assert(turns[0].includes("plan") && turns[0].includes("--auto-review"), "first turn applies Cursor Plan + Auto-review");
    assert(turns[1].includes("ask") && turns[1].includes("--force") && !turns[1].includes("--auto-review"), "live policy update applies Cursor Ask + Run Everything");
    assert(turns[1].includes("--resume") && turns[1].includes("cursor-fake-session"), "second app turn resumes the Cursor chat id");
    assert(turns[0].includes("--plugin-dir") && turns[0].includes("--approve-mcps"), "party session injects the AgentParty MCP plugin");
    assert(turns.every((args) => !args.includes("auto")), "Cursor integration never silently falls back to Auto");

    await post("/api/navigation", { view: "workbench" });
    await post("/api/qa/open", { panels: [["grok-worker"]] });
    // Let the "session already running" toast clear so the composer-level
    // Cursor mode/approval control is visible in the product screenshot.
    await delay(2_500);
    const screenshot = path.join(os.tmpdir(), "agentparty-cursor-e2e.png");
    const capture = await post("/api/capture", { path: screenshot });
    assert(capture.ok && fs.existsSync(screenshot), "captured user-visible Cursor member workflow");

    await post("/api/window/close", {});
    await waitForExit(child);
    console.log(`CURSOR APP E2E PASSED (${screenshot})`);
  } catch (error) {
    killProcessTree(child.pid);
    throw error;
  }
}

async function waitForTranscript(member, marker, count) {
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    const transcript = await get(`/api/party/members/${encodeURIComponent(member)}/transcript`);
    const occurrences = JSON.stringify(transcript.blocks || []).split(marker).length - 1;
    if (occurrences >= count) return;
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${count} ${marker} transcript block(s).`);
}

async function waitForApi() {
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    base = firstBaseUrl(workspace);
    if (base) {
      try { if ((await get("/api/health")).ok) return; } catch {}
    }
    await delay(300);
  }
  throw new Error("Cursor E2E app API did not start.");
}

async function get(url) {
  const response = await fetch(base + url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${await response.text()}`);
  return response.json();
}

async function post(url, body) {
  const response = await fetch(base + url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${await response.text()}`);
  return response.json();
}

async function removePath(target) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error?.code !== "EBUSY" || attempt === 9) throw error;
      await delay(300);
    }
  }
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => reject(new Error("App did not exit after close API.")), 10_000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

function killProcessTree(pid) {
  if (!pid) return;
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    try { process.kill(pid); } catch {}
  }
}

function assert(value, message) {
  if (!value) throw new Error(`Assertion failed: ${message}`);
  console.log(`  ok: ${message}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
