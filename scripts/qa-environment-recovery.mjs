/*
 * Regression coverage for Windows harness discovery. Run after `npm run build`.
 * These are the exact launcher shapes produced by the installers exposed in
 * the environment UI, rather than invented adapter stubs.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { resolveHostClaudeCli } = require("../dist/core/claudeCli.js");
const { resolveCodexExecutable } = require("../dist/core/codexExec.js");
const { grokCliInstalledPath } = require("../dist/core/grokAgentCli.js");

const failures = [];
function assert(condition, message) {
  console.log(`  ${condition ? "✓" : "✗"} ${message}`);
  if (!condition) failures.push(message);
}

if (process.platform === "win32") {
  const npmClaudeShim = path.join(process.env.APPDATA || "", "npm", "claude.cmd");
  if (fs.existsSync(npmClaudeShim)) {
    const claude = resolveHostClaudeCli(npmClaudeShim);
    assert(claude?.command.toLowerCase().endsWith("claude-code\\bin\\claude.exe"), "npm claude.cmd resolves to the SDK-spawnable native binary");
    assert(fs.existsSync(claude?.command || ""), "resolved Claude native binary exists");
  } else {
    console.log("  - npm Claude shim is not installed on this machine; real-install assertion skipped");
  }

  const explicitCodexShim = path.join("C:\\tools", "codex.cmd");
  assert(resolveCodexExecutable(explicitCodexShim).shell === true, "an explicit Codex .cmd path is launched through the Windows shell");

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentparty-env-qa-"));
  const oldPath = process.env.PATH;
  const oldPathExt = process.env.PATHEXT;
  const oldUserProfile = process.env.USERPROFILE;
  const oldLocalAppData = process.env.LOCALAPPDATA;
  try {
    const grok = path.join(temp, "grok.exe");
    fs.writeFileSync(grok, "fixture");
    process.env.PATH = temp;
    process.env.PATHEXT = ".EXE;.CMD";
    process.env.USERPROFILE = temp;
    process.env.LOCALAPPDATA = temp;
    assert(grokCliInstalledPath()?.toLowerCase() === grok.toLowerCase(), "Grok installed only on PATH is reported as installed");
    assert(grokCliInstalledPath(path.join(temp, "missing-grok.exe")) === undefined, "an invalid explicit Grok path does not silently fall back to another install");
  } finally {
    process.env.PATH = oldPath;
    process.env.PATHEXT = oldPathExt;
    process.env.USERPROFILE = oldUserProfile;
    process.env.LOCALAPPDATA = oldLocalAppData;
    fs.rmSync(temp, { recursive: true, force: true });
  }
} else {
  console.log("  - Windows launcher assertions skipped on this platform");
}

if (failures.length) {
  console.error(`\n${failures.length} environment recovery assertion(s) failed.`);
  process.exit(1);
}
console.log("\nEnvironment recovery QA passed.");
