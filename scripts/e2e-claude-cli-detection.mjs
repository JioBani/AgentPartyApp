/* Product E2E for the Windows npm installation path: launch the real Electron
 * app, then drive the same AppController environment report used by the UI via
 * the local automation HTTP API. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElectronE2eApp } from "./lib/electron-e2e.mjs";

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
fs.writeFileSync(cliJs, "console.log('9.9.9 (Claude Code)');\n");
fs.writeFileSync(codexShim, "@echo codex-cli 9.9.9\r\n");
fs.mkdirSync(path.dirname(codexJs), { recursive: true });
fs.writeFileSync(codexJs, "console.log('codex-cli 9.9.9');\n");
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
  const codex = report.checks.find((check) => check.id === "harness.codex");
  if (!codex) throw new Error("Codex environment check is missing");
  if (path.resolve(codex.path || "") !== path.resolve(codexShim)) throw new Error(`wrong Codex install path: ${codex.path}`);
  if (codex.status === "error") throw new Error(`Codex npm shim was rejected: ${JSON.stringify(codex)}`);
  if (!String(codex.version || "").includes("9.9.9")) throw new Error(`Codex npm shim was not executed: ${codex.version}`);
  console.log("CLI INSTALL DETECTION E2E PASSED");
  await app.close();
} catch (error) {
  app.kill();
  throw error;
}
