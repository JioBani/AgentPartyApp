/*
 * Regression coverage for Windows harness discovery. Run after `npm run build`.
 * These are the exact launcher shapes produced by the installers exposed in
 * the environment UI, rather than invented adapter stubs. Where
 * qa-claude-cli-detection.mjs proves shim resolution against fixtures, this
 * asserts against whatever is really installed on the machine, and covers Grok.
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
    // Which entrypoint is correct depends on the installed release (2.1.x ships
    // bin/claude.exe, older ones cli.js), so assert what the package declares
    // rather than pinning one layout.
    const declared = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code", "package.json"), "utf8")).bin;
    const expected = path.join(process.env.APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code", typeof declared === "string" ? declared : declared.claude);
    assert(claude?.command === expected, `the installed npm claude.cmd resolves to the entrypoint its package declares (${expected})`);
    assert(fs.existsSync(claude?.command || ""), "the resolved Claude entrypoint exists on this machine");
  } else {
    console.log("  - npm Claude shim is not installed on this machine; real-install assertion skipped");
  }

  // No npm package sits beside this path, so there is no entrypoint to hand to
  // Node — the shell is the remaining way to run a .cmd shim.
  const orphanCodexShim = path.join("C:\\tools", "codex.cmd");
  assert(resolveCodexExecutable(orphanCodexShim).shell === true, "a Codex .cmd shim with no resolvable entrypoint still goes through the shell");

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
