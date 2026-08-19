/* Product E2E for the Windows npm installation path: launch the real Electron
 * app, then drive the same AppController environment report used by the UI via
 * the local automation HTTP API. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElectronE2eApp, delay, removePath } from "./lib/electron-e2e.mjs";

if (process.platform !== "win32") {
  console.log("Claude npm-shim E2E: SKIP (Windows-specific regression)");
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The space also exercises quoting of the absolute npm `.cmd` path.
const base = path.join(os.tmpdir(), `agentparty cli e2e ${process.pid}`);
const workspace = path.join(base, "workspace");
const userData = path.join(base, "user-data");
const fakeHome = path.join(base, "home");
const fakeAppData = path.join(base, "AppData", "Roaming");
const npmBin = path.join(fakeAppData, "npm");
const shim = path.join(npmBin, "claude.cmd");
const cliJs = path.join(npmBin, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
const codexShim = path.join(npmBin, "codex.cmd");
const codexJs = path.join(npmBin, "node_modules", "@openai", "codex", "bin", "codex.js");
const port = 48600 + (process.pid % 500);

fs.mkdirSync(npmBin, { recursive: true });
fs.mkdirSync(fakeHome, { recursive: true });
fs.writeFileSync(shim, "@echo 9.9.9 (Claude Code)\r\n");
fs.mkdirSync(path.dirname(cliJs), { recursive: true });
fs.writeFileSync(cliJs, `
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('9.9.9 (Claude Code)');
} else if (args[0] === 'auth' && args[1] === 'status') {
  console.log(JSON.stringify({ loggedIn: true, authMethod: 'fixture' }));
} else {
  process.exitCode = 2;
}
`);
fs.writeFileSync(codexShim, "@echo codex-cli 9.9.9\r\n");
fs.mkdirSync(path.dirname(codexJs), { recursive: true });
fs.writeFileSync(codexJs, `
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('codex-cli 9.9.9');
} else if (args.includes('login') && args.includes('status')) {
  console.log('Logged in using fixture');
} else if (args.includes('app-server')) {
  process.stdin.setEncoding('utf8');
  let buffer = '';
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.method === 'initialize') {
        process.stdout.write(JSON.stringify({ id: message.id, result: { userAgent: 'fixture' } }) + '\\n');
      }
    }
  });
} else {
  process.exitCode = 2;
}
`);
fs.mkdirSync(path.join(fakeHome, ".codex"), { recursive: true });
fs.writeFileSync(path.join(fakeHome, ".codex", "auth.json"), "{}\n");

// Keep Node/npm available to the launcher while proving Claude is found from
// APPDATA rather than from this developer machine's PATH.
const cleanPath = (process.env.PATH || "").split(path.delimiter).filter((directory) =>
  !["claude.exe", "claude.cmd", "claude.bat", "codex.exe", "codex.cmd", "codex.bat"]
    .some((name) => fs.existsSync(path.join(directory, name))),
).join(path.delimiter);

const app = createElectronE2eApp({
  root,
  workspace,
  userData,
  port,
  env: { APPDATA: fakeAppData, USERPROFILE: fakeHome, HOME: fakeHome, CODEX_HOME: path.join(fakeHome, ".codex"), PATH: cleanPath, AGENTPARTY_E2E: "1" },
});

try {
  await app.prepare();
  await app.launch();
  const spec = await app.get("/api/spec");
  if (!spec.endpoints.includes("GET /api/environment")) throw new Error("environment endpoint is not registered");
  const report = await app.get("/api/environment?refresh=1");
  const claude = report.checks.find((check) => check.id === "harness.claude-code");
  if (!claude) throw new Error("Claude environment check is missing");
  if (path.resolve(claude.path || "") !== path.resolve(cliJs)) throw new Error(`wrong Claude path: ${claude.path}`);
  if (claude.status === "missing" || claude.status === "error") throw new Error(`npm shim was rejected: ${JSON.stringify(claude)}`);
  if (!String(claude.version || "").includes("9.9.9")) throw new Error(`npm shim was not executed: ${claude.version}`);
  for (const stage of ["workspace", "executable", "version", "runtime", "authentication"]) {
    const step = claude.steps?.find((candidate) => candidate.id === stage);
    if (step?.status !== "ok") throw new Error(`Claude ${stage} stage did not pass: ${JSON.stringify(step)}`);
  }
  const codex = report.checks.find((check) => check.id === "harness.codex");
  if (!codex) throw new Error("Codex environment check is missing");
  if (path.resolve(codex.path || "") !== path.resolve(codexShim)) throw new Error(`wrong Codex install path: ${codex.path}`);
  if (codex.status === "error") throw new Error(`Codex npm shim was rejected: ${JSON.stringify(codex)}`);
  if (!String(codex.version || "").includes("9.9.9")) throw new Error(`Codex npm shim was not executed: ${codex.version}`);
  for (const stage of ["workspace", "executable", "version", "authentication", "runtime"]) {
    const step = codex.steps?.find((candidate) => candidate.id === stage);
    if (step?.status !== "ok") throw new Error(`Codex ${stage} stage did not pass: ${JSON.stringify(step)}`);
  }

  // Drive the visible environment tab and prove the structured stages are
  // rendered, not merely present in the API payload.
  await app.post("/api/navigation", { view: "runtime", tab: "environment" });
  await delay(500);
  const measured = await waitForMeasure(app, {
    selector: '[data-env-check="harness.codex"] [data-env-step]',
    attributes: ["data-env-step", "data-status"],
  });
  if (!Array.isArray(measured.elements) || measured.elements.length < 5) {
    throw new Error(`Codex execution stages were not rendered: ${JSON.stringify(measured)}`);
  }

  // Remove the selected cwd after the app is running. The refreshed report must
  // stop at the workspace boundary and explain that cause for both harnesses.
  fs.rmSync(workspace, { recursive: true, force: true });
  const broken = await app.get("/api/environment?refresh=1");
  for (const checkId of ["harness.claude-code", "harness.codex"]) {
    const check = broken.checks.find((candidate) => candidate.id === checkId);
    const workspaceStep = check?.steps?.find((candidate) => candidate.id === "workspace");
    if (check?.status !== "error" || workspaceStep?.status !== "failed" || !workspaceStep.detail.includes("존재하지 않습니다")) {
      throw new Error(`${checkId} did not expose the missing-cwd failure: ${JSON.stringify(check)}`);
    }
  }
  await app.post("/api/capture", { click: '[data-env="refresh"]' });
  const failedStage = await waitForMeasure(app, {
    selector: '[data-env-check="harness.codex"] [data-env-step="workspace"]',
    attributes: ["data-status"],
  }, (result) => result.elements?.[0]?.attributes?.["data-status"] === "failed");
  if (failedStage.elements?.[0]?.attributes?.["data-status"] !== "failed") {
    throw new Error(`missing-cwd failure was not rendered: ${JSON.stringify(failedStage)}`);
  }
  console.log("CLI INSTALL DETECTION E2E PASSED");
  await app.close();
} catch (error) {
  app.kill();
  throw error;
} finally {
  await removePath(base).catch(() => {});
}

async function waitForMeasure(app, request, accept = () => true) {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const result = await app.post("/api/measure", request);
      if (accept(result)) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw lastError || new Error(`measure did not reach the expected state: ${JSON.stringify(request)}`);
}
