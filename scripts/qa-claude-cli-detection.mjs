/* Windows npm installs Claude Code as claude.cmd. Keep discovery and probing
 * covered separately from product E2E so a regression points at the boundary
 * that broke. */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { qaRunDir } from "./lib/qaTemp.mjs";

const failures = [];
const assert = (condition, message) => {
  console.log(`  ${condition ? "PASS" : "FAIL"} ${message}`);
  if (!condition) failures.push(message);
};

if (process.platform !== "win32") {
  console.log("Claude npm-shim detection: SKIP (Windows-specific regression)");
  process.exit(0);
}

const root = path.resolve(import.meta.dirname, "..");
const temp = qaRunDir("claude-cli-detection");
const fakeHome = path.join(temp, "home");
const fakeAppData = path.join(temp, "AppData", "Roaming");
const npmBin = path.join(fakeAppData, "npm");
const shim = path.join(npmBin, "claude.cmd");
const cliJs = path.join(npmBin, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
const codexShim = path.join(npmBin, "codex.cmd");
const codexJs = path.join(npmBin, "node_modules", "@openai", "codex", "bin", "codex.js");
fs.mkdirSync(npmBin, { recursive: true });
fs.mkdirSync(fakeHome, { recursive: true });
fs.writeFileSync(shim, "@echo 9.9.9 (Claude Code)\r\n");
fs.mkdirSync(path.dirname(cliJs), { recursive: true });
fs.writeFileSync(cliJs, "console.log('9.9.9 (Claude Code)');\n");
fs.writeFileSync(codexShim, "@echo codex-cli 9.9.9\r\n");
fs.mkdirSync(path.dirname(codexJs), { recursive: true });
fs.writeFileSync(codexJs, "console.log('codex-cli 9.9.9');\n");

const result = await build({
  entryPoints: [path.join(root, "src", "core", "claudeCli.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
});
const bundle = path.join(temp, "claude-cli.mjs");
fs.writeFileSync(bundle, result.outputFiles[0].text);

const original = { PATH: process.env.PATH, APPDATA: process.env.APPDATA, USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
try {
  process.env.PATH = "";
  process.env.APPDATA = fakeAppData;
  process.env.USERPROFILE = fakeHome;
  process.env.HOME = fakeHome;
  const cli = await import(pathToFileURL(bundle).href);
  const resolved = cli.resolveHostClaudeCli();
  assert(resolved?.command === cliJs, "resolves npm's claude.cmd to its SDK-spawnable cli.js outside PATH");
  assert(resolved?.source === "wellKnown", "reports the standard npm prefix as a well-known install");

  const codexResult = await build({
    entryPoints: [path.join(root, "src", "core", "codexExec.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  const codexBundle = path.join(temp, "codex-exec.mjs");
  fs.writeFileSync(codexBundle, codexResult.outputFiles[0].text);
  const codex = await import(pathToFileURL(codexBundle).href);
  const codexCommand = codex.codexExecutable();
  const codexSpawn = codex.resolveCodexExecutable(codexCommand);
  assert(codexCommand === codexShim, "finds npm's codex.cmd outside PATH");
  assert(codexSpawn.shell === false, "keeps an absolute codex.cmd path out of the shell");
  assert(codexSpawn.argsPrefix[0] === codexJs, "resolves npm's codex.cmd to its JavaScript entrypoint");
} finally {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}

console.log(failures.length ? `CLI INSTALL DETECTION FAILED (${failures.length})` : "CLI INSTALL DETECTION PASSED");
process.exit(failures.length ? 1 : 0);
