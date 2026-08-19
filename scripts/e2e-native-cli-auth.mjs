/*
 * Real-process E2E for Authentication's native CLI / cross-harness split.
 * The Windows buttons execute the real installed CLIs; no provider prompt is
 * sent, so this proves auth/runtime readiness without consuming model tokens.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElectronE2eApp, delay } from "./lib/electron-e2e.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspace = path.join(os.tmpdir(), "agentparty-native-auth-ws");
const userData = path.join(os.tmpdir(), "agentparty-native-auth-ud");
const shotDir = path.join(os.tmpdir(), "agentparty-native-auth-shots");
const port = Number(process.env.AGENTPARTY_NATIVE_AUTH_E2E_PORT || "") || 48979;
const app = createElectronE2eApp({ root, workspace, userData, port });
const failures = [];

function assert(condition, message) {
  console.log(`  ${condition ? "✓" : "✗"} ${message}`);
  if (!condition) failures.push(message);
}

async function providers() {
  return (await app.get("/api/auth")).providers || [];
}

async function waitForTest(id, timeoutMs = 90_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const card = (await providers()).find((item) => item.id === id);
    if (card?.test?.status === "complete") return card;
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${id} CLI test result.`);
}

async function followProgress(provider, host, onInFlight, timeoutMs = 90_000) {
  const started = Date.now();
  const snapshots = [];
  const signatures = new Set();
  while (Date.now() - started < timeoutMs) {
    const { progress } = await app.get(`/api/auth/native/${provider}/progress?host=${host}`);
    if (progress) {
      const signature = `${progress.phase}:${progress.check.steps.map((step) => `${step.id}=${step.status}`).join(",")}`;
      if (!signatures.has(signature)) {
        signatures.add(signature);
        snapshots.push(progress);
      }
      if (progress.phase !== "complete" && onInFlight) {
        await onInFlight(progress);
        onInFlight = undefined;
      }
      if (progress.phase === "complete") return snapshots;
    }
    await delay(20);
  }
  throw new Error(`Timed out following ${provider}:${host} CLI progress.`);
}

try {
  fs.rmSync(shotDir, { recursive: true, force: true });
  fs.mkdirSync(shotDir, { recursive: true });
  await app.prepare();
  await app.launch();

  const spec = await app.get("/api/spec");
  assert(spec.endpoints.includes("POST /api/auth/native/:provider/test"), "native CLI test is published in the automation spec");
  assert(spec.endpoints.includes("GET /api/auth/native/:provider/progress"), "native CLI progress is published in the automation spec");

  const initial = await providers();
  const native = initial.filter((item) => item.action?.type === "nativeCliTest");
  assert(
    native.map((item) => item.id).join(",") === "claude-native,claude-native-wsl,codex,codex-wsl,cursor,cursor-wsl,grok,grok-wsl",
    "Authentication returns one Windows/WSL pair for every CLI subscription",
  );
  assert(native.every((item) => item.surface === "native-cli"), "all eight native rows belong to the CLI subscription surface");
  assert(native.filter((item) => item.action.host === "wsl").every((item) => item.status === "unknown"), "WSL stays 확인 필요 before an explicit test");

  const proxies = initial.filter((item) => item.surface === "cross-harness");
  assert(proxies.map((item) => item.label).join(",") === "Claude,Codex", "cross-harness rows are named Claude and Codex");
  assert(initial.slice(-2).every((item) => item.surface === "cross-harness"), "cross-harness rows are last in the provider list");

  await app.post("/api/navigation", { view: "auth" });
  await delay(600);
  const before = path.join(shotDir, "auth-layout.png");
  assert((await app.post("/api/capture", { path: before })).bytes > 0 && fs.existsSync(before), "real Authentication screen captured");
  for (const provider of ["claude", "codex", "cursor", "grok"]) {
    assert((await app.post("/api/capture", { selector: `[data-native-provider="${provider}"]` })).bytes > 0, `${provider} renders as one grouped Windows/WSL card`);
  }
  const crossHarnessShot = path.join(shotDir, "cross-harness.png");
  assert((await app.post("/api/capture", {
    path: crossHarnessShot,
    selector: '[data-auth-section="cross-harness"]',
    scrollSelector: ".program-scroll",
    scrollY: "bottom",
  })).bytes > 0, "교차 하네스 연결 section renders at the bottom of the real UI");
  await app.post("/api/capture", { scrollSelector: ".program-scroll", scrollY: 0 });

  // Product UI path: click the button, then observe the controller-broadcast
  // result through the public API rather than calling an internal helper.
  await app.post("/api/capture", { click: '[data-auth-test="codex:windows"]' });
  const progressShot = path.join(shotDir, "auth-progress.png");
  const codexProgress = await followProgress("codex", "windows", async () => {
    await app.post("/api/capture", { path: progressShot, selector: '[data-auth-provider="codex"]' });
  });
  const inFlight = codexProgress.find((progress) => progress.phase !== "complete");
  assert(Boolean(inFlight), "Codex exposes an in-flight progress snapshot before completion");
  assert(
    inFlight?.check.steps.length === 6 && inFlight.check.steps.some((step) => step.status === "pending" || step.status === "running"),
    "the full Codex plan starts visible with unfinished rows unchecked",
  );
  assert(codexProgress.length >= 2, "Codex progress changes as real probe boundaries complete");
  assert(fs.existsSync(progressShot) && fs.statSync(progressShot).size > 0, "real UI progress frame captured before completion");
  const codex = await waitForTest("codex");
  assert(codex.test.steps.some((step) => step.id === "executable"), "Codex UI test reports executable discovery");
  assert(codex.test.steps.some((step) => step.id === "version"), "Codex UI test reports version execution");
  assert(codex.test.steps.some((step) => step.id === "authentication"), "Codex UI test reaches or explicitly skips authentication");
  const codexFailure = codex.test.steps.find((step) => step.status === "failed");
  assert(!codexFailure || Boolean(codexFailure.label && codexFailure.detail && codexFailure.failureKind), "Codex failure names its exact stage and reason");

  // HTTP path uses the same AppController method and executes the other CLI.
  const claude = await app.post("/api/auth/native/claude/test", { host: "windows" });
  assert(claude.provider === "claude" && claude.host === "windows", "Claude native test returns the requested execution host");
  assert(claude.check.steps?.some((step) => step.id === "authentication"), "Claude test reaches or explicitly skips authentication");
  const claudeCard = claude.auth.find((item) => item.id === "claude-native");
  assert(Boolean(claudeCard?.test?.steps?.length), "HTTP result updates the same detailed card rendered by the UI");

  for (const provider of ["cursor", "grok"]) {
    const result = await app.post(`/api/auth/native/${provider}/test`, { host: "windows" });
    assert(result.provider === provider && result.host === "windows", `${provider} Windows test uses the shared native CLI contract`);
    const failed = result.check.steps?.find((step) => step.status === "failed");
    assert(
      result.check.steps?.some((step) => step.id === "authentication") || Boolean(failed?.failureKind && failed?.detail),
      `${provider} Windows test reaches authentication or identifies the earlier failed stage`,
    );
    const authCommand = result.check.steps?.find((step) => step.id === "authentication")?.command || "";
    if (provider === "cursor") assert(authCommand.includes("status") || Boolean(failed), "Cursor verifies the CLI status command");
    if (provider === "grok") assert(authCommand.includes("models") || Boolean(failed), "Grok lets the official CLI verify its own credential");
  }

  if (process.env.AGENTPARTY_E2E_INCLUDE_WSL === "1") {
    for (const provider of ["claude", "codex", "cursor", "grok"]) {
      const wsl = await app.post(`/api/auth/native/${provider}/test`, { host: "wsl" });
      assert(wsl.host === "wsl", `${provider} WSL test executes the WSL path`);
      assert(wsl.check.steps?.[0]?.id === "distribution", `${provider} WSL test starts with explicit distribution discovery`);
      const failed = wsl.check.steps?.find((step) => step.status === "failed");
      assert(wsl.ok || Boolean(failed?.failureKind && failed?.detail), `${provider} WSL success is proven or its first failed boundary is explicit`);
    }
  }

  const after = path.join(shotDir, "auth-tested.png");
  assert((await app.post("/api/capture", { path: after })).bytes > 0 && fs.existsSync(after), "tested Authentication state captured");

  if (failures.length) throw new Error(`${failures.length} native-auth E2E assertion(s) failed.`);
  console.log(`\nNATIVE CLI AUTH E2E PASSED → ${shotDir}`);
} finally {
  await app.close().catch(() => app.kill());
}
