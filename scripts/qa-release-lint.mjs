#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  lintReleaseArtifacts,
  lintReleaseSource,
  writeReleaseManifest,
} from "./release-lint.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentparty-release-lint-"));

function write(relative, content) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function git(...args) {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

async function rejectsWith(action, pattern, label) {
  await assert.rejects(action, pattern);
  console.log(`  ok: ${label}`);
}

try {
  const version = "1.2.3";
  write("package.json", JSON.stringify({
    name: "release-lint-fixture",
    version,
    build: {
      win: { target: ["nsis", "portable"] },
      publish: [{ provider: "github", owner: "JioBani", repo: "AgentParty-releases", releaseType: "draft" }],
    },
  }, null, 2));
  write("package-lock.json", JSON.stringify({ version, packages: { "": { version } } }, null, 2));
  write("app.txt", "tracked release input\n");
  git("init");
  git("config", "user.email", "qa@agentparty.local");
  git("config", "user.name", "AgentParty QA");
  git("add", ".");
  git("commit", "-m", "fixture");

  const installer = Buffer.from("fixture installer");
  const publicInstaller = `AgentParty-Setup-${version}.exe`;
  write(`release/AgentParty Setup ${version}.exe`, installer);
  write(`release/AgentParty Setup ${version}.exe.blockmap`, "fixture blockmap");
  write(`release/AgentParty ${version}.exe`, "fixture portable");
  write("release/latest.yml", [
    `version: ${version}`,
    `path: ${publicInstaller}`,
    `sha512: ${createHash("sha512").update(installer).digest("base64")}`,
    "",
  ].join("\n"));

  const source = lintReleaseSource(root, { requireReleaseBranch: false, checkWorkingTree: false });
  assert.equal(source.version, version);
  console.log("  ok: source version, lockfile, targets, and publish destination are deterministic");

  await writeReleaseManifest(root);
  const artifacts = await lintReleaseArtifacts(root);
  assert.equal(artifacts.assets.length, 4);
  console.log("  ok: four release assets, update feed hash, and source fingerprint match");

  write("app.txt", "changed after packaging\n");
  await rejectsWith(
    () => lintReleaseArtifacts(root),
    /different tracked source contents/,
    "source changes after packaging invalidate the artifacts",
  );
  git("checkout", "--", "app.txt");

  write(`release/AgentParty Setup ${version}.exe`, "corrupted installer");
  await rejectsWith(
    () => lintReleaseArtifacts(root),
    /SHA-512 does not match/,
    "installer changes invalidate the update feed",
  );

  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  lock.version = "1.2.2";
  write("package-lock.json", JSON.stringify(lock, null, 2));
  assert.throws(
    () => lintReleaseSource(root, { requireReleaseBranch: false, checkWorkingTree: false }),
    /does not match/,
  );
  console.log("  ok: package and lockfile version drift is rejected");

  console.log("RELEASE LINT QA PASSED");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
