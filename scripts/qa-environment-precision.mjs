/* Focused regression checks for host/path/error precision in 환경 reports. */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { classifyWslProbeFailure, redactEnvironmentCommandPart } = require("../dist/main/environmentService.js");
const { formatEnvironmentReport } = require("../dist/shared/environment.js");

const failures = [];
function assert(condition, message) {
  console.log(`  ${condition ? "✓" : "✗"} ${message}`);
  if (!condition) failures.push(message);
}

assert(
  classifyWslProbeFailure({ ok: false, stdout: "", stderr: "", failureKind: "timeout", error: "timed out" }) === "timeout",
  "a WSL timeout stays timeout instead of becoming tool missing",
);
assert(
  classifyWslProbeFailure({ ok: false, stdout: "", stderr: "AGENTPARTY_NODE_NOT_FOUND", failureKind: "exit", code: 44 }, "AGENTPARTY_NODE_NOT_FOUND") === "not-found",
  "only the explicit Node marker is classified as not-found",
);
assert(
  classifyWslProbeFailure({ ok: false, stdout: "", stderr: "permission denied", failureKind: "exit", code: 126 }, "AGENTPARTY_NODE_NOT_FOUND") === "exit",
  "an unrelated WSL exit is not mislabeled as Node missing",
);
assert(redactEnvironmentCommandPart("secret-value", "--api-key") === "[redacted]", "command diagnostics redact a value after a sensitive flag");
assert(redactEnvironmentCommandPart('api_key="secret-value"', "-c").includes("[redacted]"), "command diagnostics redact embedded secret assignments");

const report = formatEnvironmentReport({
  checkedAt: "2026-08-20T00:00:00.000Z",
  checks: [{
    id: "wsl.Ubuntu.codex",
    group: "wsl",
    label: "Ubuntu · Codex",
    status: "error",
    detail: "app-server 초기화 실패",
    host: { kind: "wsl", distro: "Ubuntu", label: "WSL · Ubuntu", workspace: "/work/app" },
    steps: [{
      id: "runtime",
      label: "app-server 초기화",
      status: "failed",
      detail: "응답 시간 초과",
      cwd: "/work/app",
      command: "codex app-server",
      failureKind: "timeout",
    }, {
      id: "state",
      label: "상태 저장소",
      status: "ok",
      detail: "진단용 저장소 준비됨",
      path: "/home/dev/.agent_party_app/codex-sqlite/environment-test",
    }],
  }],
});
assert(report.includes("host: WSL · Ubuntu · /work/app"), "plain-text report names the execution host and workspace");
assert(report.includes("cwd: /work/app"), "plain-text report preserves the failing cwd");
assert(report.includes("path: /home/dev/.agent_party_app/codex-sqlite/environment-test"), "plain-text report separates an inspected path from process cwd");
assert(report.includes("command: codex app-server"), "plain-text report preserves the command boundary");
assert(report.includes("failure: timeout"), "plain-text report preserves the failure kind");

if (failures.length) {
  console.error(`\n${failures.length} environment precision assertion(s) failed.`);
  process.exit(1);
}
console.log("\nEnvironment precision QA passed.");
