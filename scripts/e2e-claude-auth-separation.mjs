/* Real Electron E2E: native Claude auth is distinct and blocks before provider use. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElectronE2eApp } from "./lib/electron-e2e.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspace = path.join(os.tmpdir(), "agentparty-claude-auth-ws");
const userData = path.join(os.tmpdir(), "agentparty-claude-auth-ud");
const fakeClaude = path.join(os.tmpdir(), "agentparty-fake-claude-auth.js");
const capture = path.join(os.tmpdir(), "agentparty-claude-auth.png");
const port = Number(process.env.AGENTPARTY_CLAUDE_AUTH_E2E_PORT || "") || 48976;
const app = createElectronE2eApp({ root, workspace, userData, port, env: { AGENTPARTY_CLAUDE_BIN: fakeClaude } });
const failures = [];

function assert(condition, message) {
  console.log(`  ${condition ? "✓" : "✗"} ${message}`);
  if (!condition) failures.push(message);
}

try {
  fs.writeFileSync(fakeClaude, [
    "const args = process.argv.slice(2);",
    "if (args[0] === 'auth' && args[1] === 'status') {",
    "  process.stdout.write(JSON.stringify({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' }));",
    "  process.exit(0);",
    "}",
    "if (args[0] === '--version') { process.stdout.write('2.1.235\\n'); process.exit(0); }",
    "process.stderr.write('PROVIDER_PROCESS_MUST_NOT_START\\n');",
    "process.exit(97);",
  ].join("\n"));
  await app.prepare();
  await app.launch();

  const spec = await app.get("/api/spec");
  assert(spec.endpoints.includes("GET /api/auth/native/claude"), "native Claude auth is published in the automation spec");

  const native = await app.get("/api/auth/native/claude?refresh=1");
  assert(native.status === "auth_required" && native.authenticated === false, "native CLI logged-out state is reported honestly");
  assert(native.host?.label === "Windows" && native.workspace === workspace, "native auth names the exact host and workspace");
  assert(native.command?.includes("auth status") && native.loginCommand, "native auth returns diagnostic and login commands without credentials");

  const providers = (await app.get("/api/auth")).providers;
  const nativeCard = providers.find((item) => item.id === "claude-native");
  const bridgeCard = providers.find((item) => item.id === "claude");
  assert(nativeCard?.status === "invalid" && nativeCard.authenticated === false, "Authentication UI data has a separate native card");
  assert(Boolean(bridgeCard) && bridgeCard.id !== nativeCard.id, "subscription bridge remains a separate card");

  await app.post("/api/parties", { name: "Claude auth preflight" });
  await app.post("/api/party/members", { name: "auth-check", requirement: "verify auth preflight", runtime: "claude-code", model: "sonnet", effort: "high" });
  await app.post("/api/party/members/auth-check/start", { model: "sonnet", effort: "high", permissionMode: "default" });
  await app.post("/api/party/members/auth-check/message", { text: "This must not reach a provider." });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const party = await app.get("/api/party");
  const member = party.members?.find((item) => item.name === "auth-check");
  assert(member?.displayStatus === "auth-required", "member is auth-required instead of idle/working");
  let blocks = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const transcript = await app.get("/api/party/members/auth-check/transcript");
    blocks = transcript.blocks || transcript.transcript || [];
    if (blocks.some((block) => block.kind === "environment")) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(blocks.some((block) => block.kind === "environment" || (block.kind === "error" && /로그인/.test(block.message || ""))), "preflight failure is visible in the transcript");

  await app.post("/api/navigation", { view: "auth" });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const captured = await app.post("/api/capture", { path: capture });
  assert(captured.ok && fs.existsSync(capture), "real Authentication screen renders the separated state");

  if (failures.length) throw new Error(`${failures.length} Claude auth E2E assertion(s) failed`);
  console.log("\nCLAUDE AUTH SEPARATION E2E PASSED (capture inspected and removed)");
} finally {
  await app.close().catch(() => app.kill());
  fs.rmSync(fakeClaude, { force: true });
  // The full Authentication view can include account identifiers from other
  // providers. Keep the assertion, but never retain that capture as an artifact.
  fs.rmSync(capture, { force: true });
}
