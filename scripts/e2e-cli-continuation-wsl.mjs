/* Real-app E2E for WSL cwd/distro-aware CLI continuation inspection. */
import { execFileSync } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElectronE2eApp, delay } from "./lib/electron-e2e.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distro = process.argv[2] || "Ubuntu-22.04";
const suffix = `${process.pid}-${Date.now().toString(36)}`;
const cwd = `/tmp/agentparty-cli-continuation-${suffix}`;
const workspace = `wsl+${distro}:${cwd}`;
const marker = `${cwd}/cli-launch.txt`;
const releaseMarker = `${cwd}/release`;
const fakeCli = `${cwd}/codex`;
const port = await freePort();
const app = createElectronE2eApp({
  root,
  workspace: path.join(os.tmpdir(), `agentparty-cli-wsl-bootstrap-${suffix}`),
  userData: path.join(os.tmpdir(), `agentparty-cli-wsl-userdata-${suffix}`),
  port,
});

const wsl = (args) => execFileSync("wsl.exe", ["-d", distro, "-e", ...args], { stdio: "inherit" });
const wslOutput = (args) => execFileSync("wsl.exe", ["-d", distro, "-e", ...args], { encoding: "utf8" }).trim();
const home = wslOutput(["sh", "-c", 'printf %s "$HOME"']);
const fakeLink = `${home}/.bun/bin/codex`;
let terminalPid;

try {
  wsl(["mkdir", "-p", cwd]);
  if (wslSucceeds(["test", "-e", fakeLink]) || wslSucceeds(["test", "-L", fakeLink])) {
    throw new Error(`Refusing to replace existing WSL CLI: ${fakeLink}`);
  }
  execFileSync("wsl.exe", ["-d", distro, "-e", "tee", fakeCli], {
    input: `#!/usr/bin/env bash\nif [[ "$1" == "resume" ]]; then printf '%s\\n' "$PWD" "$@" > ${marker}; while [[ ! -e ${releaseMarker} ]]; do sleep 0.1; done; fi\n`,
    stdio: ["pipe", "ignore", "inherit"],
  });
  wsl(["chmod", "+x", fakeCli]);
  wsl(["ln", "-s", fakeCli, fakeLink]);
  await app.prepare();
  await app.launch();
  const windows = (await app.get("/api/windows")).windows || [];
  if (!windows[0]?.id) throw new Error("No AgentParty window was created.");
  await app.post(`/api/windows/${encodeURIComponent(windows[0].id)}/workspace`, { workspacePath: workspace });
  await app.post("/api/qa/reset").catch(() => {});
  await app.post("/api/qa/seed", {
    party: "cli-wsl-handoff",
    members: [{ name: "native-wsl", role: "WSL CLI continuation QA", runtime: "codex", model: "GPT-5.6 Sol", autoReply: true }],
  });
  await app.post("/api/party/members/native-wsl/message", { text: "commit a WSL resumable mock turn" });
  const result = await waitForContinuation();
  assert(result.supported === true, "native WSL Codex member is supported");
  assert(result.host === "wsl", "API identifies the WSL host");
  assert(result.distro === distro, `API preserves distro (${result.distro})`);
  assert(result.cwd === cwd, `API returns distro-native cwd (${result.cwd})`);
  assert(result.command === `codex resume ${result.sessionId}`, "copyable command is native to the distro shell");
  const launched = await app.post("/api/party/members/native-wsl/cli-continuation", { action: "launch" });
  terminalPid = launched.terminalPid;
  assert(launched.launched === true && launched.terminalPid > 0, "default terminal starts a WSL process");
  await waitForMarker();
  const invocation = wslOutput(["cat", marker]).split(/\r?\n/u);
  assert(invocation[0] === cwd, `launched WSL CLI starts in native cwd (${invocation[0]})`);
  assert(invocation[1] === "resume" && invocation[2] === result.sessionId, `launched WSL CLI receives resume id (${invocation.slice(1).join(" ")})`);
  const owned = (await app.get("/api/party")).members.find((member) => member.name === "native-wsl");
  assert(owned?.status === "external_cli" && owned?.externalCli?.host === "wsl" && owned?.externalCli?.distro === distro, "WSL handoff disables the member and persists its host ownership");
  wsl(["touch", releaseMarker]);
  await waitForMember((member) => !member.externalCli && member.status === "opened");
  const resumed = await app.post("/api/party/members/native-wsl/message", { text: "message after WSL CLI exit" });
  assert(Boolean(resumed.member?.sessionId), "WSL member accepts messages again after terminal exit");
  console.log("CLI CONTINUATION WSL E2E PASSED");
} finally {
  await app.close().catch(() => undefined);
  app.kill();
  if (Number.isInteger(terminalPid) && terminalPid > 0) {
    try { execFileSync("taskkill", ["/PID", String(terminalPid), "/T", "/F"], { stdio: "ignore" }); } catch { /* already exited */ }
  }
  if (wslSucceeds(["test", "-L", fakeLink]) && wslOutput(["readlink", fakeLink]) === fakeCli) {
    try { wsl(["rm", "-f", fakeLink]); } catch { /* exact QA symlink */ }
  }
  if (cwd.startsWith("/tmp/agentparty-cli-continuation-")) {
    try { wsl(["rm", "-rf", cwd]); } catch { /* exact disposable QA directory */ }
  }
}

function wslSucceeds(args) {
  try {
    execFileSync("wsl.exe", ["-d", distro, "-e", ...args], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function waitForMarker() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (wslSucceeds(["test", "-f", marker])) return;
    await delay(150);
  }
  throw new Error("WSL CLI launch did not record its cwd and arguments");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`  ✓ ${message}`);
}

async function waitForContinuation() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = await app.post("/api/party/members/native-wsl/cli-continuation", { action: "inspect" });
    if (result.supported) return result;
    await delay(150);
  }
  throw new Error("WSL mock turn did not expose a resumable harness id");
}

async function waitForMember(predicate) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const member = (await app.get("/api/party")).members.find((entry) => entry.name === "native-wsl");
    if (member && predicate(member)) return member;
    await delay(150);
  }
  throw new Error("WSL member ownership did not update after terminal exit");
}

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
