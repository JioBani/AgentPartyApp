/*
 * Release-gate E2E: with the OPTIONAL mobile pipe left out of the build, the
 * real product still starts, the rest of the automation API works, and every
 * mobile route fails with the reason instead of pretending to be idle.
 *
 * Only meaningful on a machine without `@agentparty/protocol` — the pipe is in
 * the build otherwise, and this run reports that and stops rather than
 * asserting something it cannot observe.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { waitForLiveBaseUrl } from "./lib/discovery.mjs";
import { MOBILE_PIPE_PACKAGE, mobilePipeAvailable } from "./mobile-pipe.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ws = path.join(os.tmpdir(), `agentparty-pipe-absent-workspace-${process.pid}`);
const userData = path.join(os.tmpdir(), `agentparty-pipe-absent-user-data-${process.pid}`);
const failures = [];
const assert = (condition, message) => {
  console.log(`  ${condition ? "✓" : "✗"} ${message}`);
  if (!condition) failures.push(message);
};

async function main() {
  if (mobilePipeAvailable()) {
    console.log(`건너뜀: ${MOBILE_PIPE_PACKAGE}가 설치되어 있어 이 빌드에는 모바일 파이프가 들어 있습니다.`);
    console.log("파이프를 뺀 빌드에서만 검증할 수 있는 테스트입니다.");
    return;
  }

  await removePath(ws);
  await removePath(userData);
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  // Mobile ON, so a missing pipe cannot be confused with the feature simply
  // being disabled — the two produce different errors.
  fs.writeFileSync(
    path.join(userData, "settings.json"),
    JSON.stringify({ workspacePath: ws, mobile: { enabled: true } }, null, 2),
  );

  const launchedAt = Date.now();
  const child = spawn(process.execPath, [path.join(root, "scripts", "launch-electron.mjs"), "--workspace", ws], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, AGENTPARTY_USER_DATA: userData, AGENTPARTY_AUTOMATION_PORT: "" },
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  try {
    const base = await waitForLiveBaseUrl(ws, { since: launchedAt, timeoutMs: 60_000 });
    assert(true, "앱이 파이프 없이 기동했다");

    // The app is whole apart from the mobile link.
    for (const route of ["/api/spec", "/api/workspaces", "/api/party"]) {
      const response = await fetch(base + route);
      assert(response.ok, `${route} 정상 응답 (${response.status})`);
    }

    // Every mobile route says why, in a message a user can act on.
    for (const route of ["/api/mobile/status", "/api/mobile/settings", "/api/mobile/devices"]) {
      const response = await fetch(base + route);
      const body = await response.text();
      assert(!response.ok, `${route} 는 조용히 성공하지 않는다 (${response.status})`);
      assert(body.includes("모바일 파이프"), `${route} 응답이 이유를 말한다`);
    }

    // The precise cause belongs in the log, not only in the HTTP body.
    const logs = path.join(userData, "logs");
    const newest = fs.readdirSync(logs).sort().at(-1);
    const text = fs.readFileSync(path.join(logs, newest), "utf8");
    assert(text.includes("mobile link unavailable in this build"), "로그에 파이프 부재가 남는다");
  } finally {
    child.kill();
  }
}

async function removePath(target) {
  await fs.promises.rm(target, { recursive: true, force: true }).catch(() => {});
}

main()
  .then(() => {
    if (failures.length > 0) {
      console.error(`\n실패 ${failures.length}건`);
      process.exit(1);
    }
    console.log("\nPASS");
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
