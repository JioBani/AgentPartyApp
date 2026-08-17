/*
 * Full-process E2E for member → native CLI handoff. Runs the real Electron app,
 * opens the real panel menu/modal, exercises the HTTP capability, and launches
 * a real detached PowerShell terminal whose fake Codex command records cwd+argv.
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createElectronE2eApp, delay } from "./lib/electron-e2e.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ws = path.join(os.tmpdir(), "ap cli continuation e2e ws");
const userData = path.join(os.tmpdir(), "ap cli continuation e2e ud");
const marker = path.join(os.tmpdir(), `ap-cli-continuation-${process.pid}.json`);
const releaseMarker = path.join(os.tmpdir(), `ap-cli-continuation-release-${process.pid}`);
const failures = [];
const assert = (condition, message) => {
  console.log(`  ${condition ? "✓" : "✗"} ${message}`);
  if (!condition) failures.push(message);
};

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function main() {
  let terminalPid;
  const port = await freePort();
  // Keep the executable path space-free: the product cwd deliberately has
  // spaces to test terminal quoting, but Codex's executable override is parsed
  // as a command path by the adapter rather than shell-quoted text.
  const fakeBin = path.join(os.tmpdir(), `ap-cli-continuation-bin-${process.pid}`);
  const fakeCodexCommand = path.join(fakeBin, "codex.cmd");
  const app = createElectronE2eApp({
    root,
    workspace: ws,
    userData,
    port,
    env: { AGENTPARTY_CODEX_BIN: fakeCodexCommand },
  });
  await app.prepare();
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.rmSync(marker, { force: true });
  fs.rmSync(releaseMarker, { force: true });
  const fakeCodex = path.join(fakeBin, "fake-codex.mjs");
  fs.writeFileSync(fakeCodex, [
    'import fs from "node:fs";',
    "const args = process.argv.slice(2);",
    `if (args[0] === "resume") {`,
    `  fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ cwd: process.cwd(), args }));`,
    `  const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(releaseMarker)})) { clearInterval(timer); process.exit(0); } }, 100);`,
    `}`,
  ].join("\n"), "utf8");
  fs.writeFileSync(
    fakeCodexCommand,
    [
      "@echo off",
      'if "%1"=="resume" goto resume',
      `"${process.execPath}" "${path.join(root, "scripts", "fake-codex-appserver.mjs")}" %*`,
      "exit /b %errorlevel%",
      ":resume",
      `"${process.execPath}" "${fakeCodex}" %*`,
      "",
    ].join("\r\n"),
    "utf8",
  );

  try {
    await app.launch();
    const { get, post } = app;
    const state = await get("/api/state");
    assert((state.runtime?.appRoot || "").toLowerCase().startsWith(root.toLowerCase()), `app runs this worktree (${state.runtime?.appRoot})`);

    await post("/api/qa/reset").catch(() => {});
    await post("/api/qa/seed", {
      party: "cli-handoff",
      members: [
        { name: "native", role: "CLI continuation QA", runtime: "codex", model: "GPT-5.6 Sol", autoReply: true },
        { name: "routed", role: "unsupported app-router QA", runtime: "claude-code", model: "Kimi K3", autoReply: true },
      ],
    });
    await post("/api/party/members/native/message", { text: "commit a resumable mock turn" });
    await post("/api/party/members/routed/message", { text: "commit an app-routed mock turn" });
    await waitForTurn(get, "native");
    await waitForTurn(get, "routed");

    const spec = await get("/api/spec");
    assert(spec.endpoints.includes("POST /api/party/members/:name/cli-continuation"), "CLI continuation is published in the automation spec");
    assert(!spec.methods.includes("member.cliContinuation"), "desktop terminal action is excluded from mobile RPC");

    const inspected = await post("/api/party/members/native/cli-continuation", { action: "inspect" });
    assert(inspected.supported === true, "native Codex member can be continued");
    assert(inspected.cwd === ws, `local cwd is exact (${inspected.cwd})`);
    assert(inspected.command === `codex resume ${inspected.sessionId}`, "resume command uses the harness thread id");
    assert(inspected.transcriptSync === "not-automatic", "API reports the transcript synchronization boundary");

    const routed = await post("/api/party/members/routed/cli-continuation", { action: "inspect" });
    assert(routed.supported === false && /외부 라우터/.test(routed.reason), "app-router member is explicitly refused");

    // Drive the visible workflow: member panel ⋯ → CLI로 이어가기 → modal.
    await post("/api/qa/open", { panels: [["native"]] });
    await delay(400);
    await click(post, ".wb-header-more");
    await click(post, ".wb-header-menu .wb-menu-item:last-child");
    const capture = await post("/api/capture", { selector: ".wb-cli-continuation" });
    assert(capture.ok && capture.path && capture.bytes > 1_000, `CLI continuation modal renders (${capture.path})`);

    const launched = await post("/api/party/members/native/cli-continuation", { action: "launch" });
    terminalPid = launched.terminalPid;
    assert(launched.launched === true, "launch action reports a spawned default-terminal process");
    await waitForFile(marker);
    const terminal = JSON.parse(fs.readFileSync(marker, "utf8").replace(/^\uFEFF/, ""));
    assert(path.resolve(terminal.cwd) === path.resolve(ws), `detached terminal starts in member cwd (${terminal.cwd})`);
    assert(JSON.stringify(terminal.args) === JSON.stringify(["resume", inspected.sessionId]), `terminal invoked codex with the resume id (${JSON.stringify(terminal.args)})`);
    const nativeAfter = (await get("/api/party")).members.find((member) => member.name === "native");
    assert(nativeAfter?.status === "external_cli" && nativeAfter?.externalCli?.terminalPid === terminalPid && !nativeAfter?.sessionId, "member stays visible and records external CLI ownership");
    const disabledTab = await post("/api/capture", { selector: ".wb-tab.is-external-cli" });
    const disabledPanel = await post("/api/capture", { selector: ".wb-external-cli-state" });
    assert(disabledTab.ok && disabledTab.bytes > 100, "CLI-owned tab renders in its disabled visual state");
    assert(disabledPanel.ok && disabledPanel.bytes > 100, "CLI-owned panel explains why chat controls are disabled");

    await app.close();
    await app.launch();
    const restoredOwnership = (await get("/api/party")).members.find((member) => member.name === "native");
    assert(restoredOwnership?.status === "external_cli" && restoredOwnership?.externalCli?.terminalPid === terminalPid, "app restart restores the disabled tab ownership and process watcher");

    const userSendError = await postFailure(post, "/api/party/members/native/message", { text: "must not race the external writer" });
    assert(/external CLI/i.test(userSendError), "user messages are refused before reaching the external writer");
    const restartError = await postFailure(post, "/api/party/members/native/respawn", {});
    assert(/external CLI/i.test(restartError), "session restart is refused while the external writer owns the thread");
    const routedDuringCli = await post("/api/party/messages", { to: "native", from: "routed", content: "do not wake or queue this" });
    assert(routedDuringCli.partyMessage?.error === "target_member_in_external_cli", "another member gets an explicit non-delivery result");

    // Close stays available while disabled, but does not lie that ownership was
    // released. Once the terminal exits, the member remains closed and can be
    // explicitly resumed without a stale writer.
    await post("/api/party/members/native/close", {});
    const closedDuringCli = (await get("/api/party")).members.find((member) => member.name === "native");
    assert(closedDuringCli?.status === "closed" && Boolean(closedDuringCli?.externalCli), "closing the disabled tab preserves CLI ownership until the process exits");
    fs.writeFileSync(releaseMarker, "release", "utf8");
    await waitForMember(get, "native", (member) => !member.externalCli && member.status === "closed", "closed member ownership was not released after CLI exit");
    const reopened = await post("/api/party/members/native/resume", {});
    assert(Boolean(reopened.member?.sessionId), "a closed member resumes normally after external CLI exit");
    const resumedSend = await post("/api/party/members/native/message", { text: "send after external CLI exit" });
    assert(Boolean(resumedSend.member?.sessionId), "messages are accepted again after CLI ownership is released");

    await app.close();
    if (failures.length) {
      throw new Error(`CLI continuation E2E failed: ${failures.join("; ")}`);
    }
    console.log("CLI CONTINUATION E2E PASSED");
  } catch (error) {
    app.kill();
    throw error;
  } finally {
    if (Number.isInteger(terminalPid) && terminalPid > 0) {
      try { execFileSync("taskkill", ["/PID", String(terminalPid), "/T", "/F"], { stdio: "ignore" }); } catch { /* already exited */ }
    }
    fs.rmSync(marker, { force: true });
    fs.rmSync(releaseMarker, { force: true });
    fs.rmSync(fakeBin, { recursive: true, force: true });
  }
}

async function click(post, selector) {
  const result = await post("/api/capture", { click: selector });
  if (!result.clicked) throw new Error(`capture did not click '${selector}'`);
  await delay(250);
}

async function waitForTurn(get, name) {
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    const party = await get("/api/party");
    const member = party.members.find((entry) => entry.name === name);
    const state = await get("/api/state");
    const session = state.sessions.find((entry) => entry.id === member?.sessionId);
    if (session?.snapshot?.turnCount > 0 && session.snapshot.status === "idle") return;
    await delay(150);
  }
  throw new Error(`${name} mock turn did not commit`);
}

async function waitForFile(file) {
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    if (fs.existsSync(file)) return;
    await delay(100);
  }
  throw new Error(`detached CLI did not write ${file}`);
}

async function waitForMember(get, name, predicate, failure) {
  const started = Date.now();
  while (Date.now() - started < 12_000) {
    const member = (await get("/api/party")).members.find((entry) => entry.name === name);
    if (member && predicate(member)) return member;
    await delay(150);
  }
  throw new Error(failure);
}

async function postFailure(post, route, body) {
  try {
    await post(route, body);
  } catch (error) {
    return String(error?.message || error);
  }
  return "";
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
