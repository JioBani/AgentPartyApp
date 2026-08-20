/* Real Electron E2E for 환경 host/path/stage diagnostics. No model calls. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElectronE2eApp } from "./lib/electron-e2e.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspace = path.join(os.tmpdir(), "agentparty-environment-precision-ws");
const userData = path.join(os.tmpdir(), "agentparty-environment-precision-ud");
const capture = path.join(os.tmpdir(), "agentparty-environment-precision.png");
const port = Number(process.env.AGENTPARTY_ENVIRONMENT_E2E_PORT || "") || 48974;
const app = createElectronE2eApp({ root, workspace, userData, port });
const failures = [];

function assert(condition, message) {
  console.log(`  ${condition ? "✓" : "✗"} ${message}`);
  if (!condition) failures.push(message);
}

try {
  await app.prepare();
  await app.launch();
  const spec = await app.get("/api/spec");
  assert(spec.endpoints.includes("GET /api/environment"), "environment report is exposed through the automation API");

  const report = await app.get("/api/environment?refresh=1");
  const codex = report.checks.find((check) => check.id === "harness.codex");
  const claude = report.checks.find((check) => check.id === "harness.claude-code");
  assert(report.checks.every((check) => check.host?.kind === "windows"), "local-workspace checks identify Windows as the execution host");
  assert(report.checks.every((check) => check.host?.workspace === workspace), "local-workspace checks name the exact workspace");
  assert(claude?.steps?.find((step) => step.id === "version")?.command, "Claude version step exposes the exact command");
  assert(claude?.steps?.find((step) => step.id === "version")?.cwd === workspace, "Claude version step exposes the exact cwd");
  assert(codex?.steps?.find((step) => step.id === "state")?.path?.startsWith(userData), "Codex uses an isolated, stable diagnostic SQLite location");
  assert(codex?.steps?.find((step) => step.id === "runtime")?.command?.includes("app-server"), "Codex runtime step exposes the app-server boundary");

  if (process.env.AGENTPARTY_E2E_INCLUDE_WSL === "1") {
    const withWsl = await app.get("/api/environment?refresh=1&wsl=1");
    const wslChecks = withWsl.checks.filter((check) => check.group === "wsl");
    assert(wslChecks.length > 0, "explicit WSL probe returns host-specific checks");
    assert(wslChecks.filter((check) => check.id !== "wsl.available").every((check) => check.host?.kind === "wsl"), "WSL checks name their concrete execution host");
    const timeoutSteps = wslChecks.flatMap((check) => check.steps || []).filter((step) => step.failureKind === "timeout");
    assert(timeoutSteps.every((step) => step.cwd && step.command), "WSL timeouts preserve the exact cwd and command");
    assert(wslChecks.filter((check) => check.steps?.some((step) => step.failureKind === "timeout")).every((check) => check.status === "error"), "WSL timeouts are errors, never tool-missing results");
  }

  await app.post("/api/navigation", { view: "runtime", tab: "environment" });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const captured = await app.post("/api/capture", { path: capture });
  assert(captured.ok && fs.existsSync(capture), "real 환경 screen renders and can be captured");

  if (failures.length) throw new Error(`${failures.length} environment E2E assertion(s) failed`);
  console.log(`\nENVIRONMENT PRECISION E2E PASSED → ${capture}`);
} finally {
  await app.close().catch(() => app.kill());
}
