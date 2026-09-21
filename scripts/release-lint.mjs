#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const RELEASE_MANIFEST = "release-manifest.json";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function invariant(value, message) {
  if (!value) throw new Error(message);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function releaseInfo(root) {
  const pkg = readJson(path.join(root, "package.json"));
  const version = pkg.version;
  const prerelease = /-(?:alpha|beta|rc)\./.test(version);
  return {
    pkg,
    version,
    tag: `v${version}`,
    feed: prerelease ? "beta.yml" : "latest.yml",
    prerelease,
  };
}

export function expectedReleaseAssets(root = scriptRoot) {
  const { version, feed } = releaseInfo(root);
  return [
    {
      key: "installer",
      localName: `AgentParty Setup ${version}.exe`,
      publicName: `AgentParty-Setup-${version}.exe`,
    },
    {
      key: "blockmap",
      localName: `AgentParty Setup ${version}.exe.blockmap`,
      publicName: `AgentParty-Setup-${version}.exe.blockmap`,
    },
    {
      key: "portable",
      localName: `AgentParty ${version}.exe`,
      publicName: `AgentParty-${version}.exe`,
    },
    { key: "feed", localName: feed, publicName: feed },
  ].map((asset) => ({ ...asset, file: path.join(root, "release", asset.localName) }));
}

export function sourceFingerprint(root = scriptRoot) {
  const tracked = git(root, ["ls-files", "-z"])
    .split("\0")
    .filter(Boolean)
    .sort();
  const hash = createHash("sha256");
  for (const relative of tracked) {
    const file = path.join(root, relative);
    invariant(fs.existsSync(file), `Tracked release input is missing: ${relative}`);
    hash.update(relative.replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(fs.readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function hashFile(file, algorithm, encoding) {
  const hash = createHash(algorithm);
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest(encoding);
}

function yamlScalar(text, key) {
  const match = new RegExp(`^${key}:\\s*(.+?)\\s*$`, "m").exec(text);
  if (!match) return null;
  return match[1].replace(/^["']|["']$/g, "");
}

export async function inspectReleaseArtifacts(root = scriptRoot) {
  const { version, feed } = releaseInfo(root);
  const assets = expectedReleaseAssets(root);
  for (const asset of assets) {
    invariant(fs.existsSync(asset.file), `Missing release artifact: release/${asset.localName}`);
    invariant(fs.statSync(asset.file).size > 0, `Empty release artifact: release/${asset.localName}`);
  }

  const installer = assets.find((asset) => asset.key === "installer");
  const feedAsset = assets.find((asset) => asset.key === "feed");
  const feedText = fs.readFileSync(feedAsset.file, "utf8");
  const feedVersion = yamlScalar(feedText, "version");
  const feedPath = yamlScalar(feedText, "path");
  const feedSha512 = yamlScalar(feedText, "sha512");
  invariant(feedVersion === version, `${feed} version is ${feedVersion ?? "missing"}; expected ${version}`);
  invariant(feedPath === installer.publicName, `${feed} path is ${feedPath ?? "missing"}; expected ${installer.publicName}`);
  const installerSha512 = await hashFile(installer.file, "sha512", "base64");
  invariant(feedSha512 === installerSha512, `${feed} SHA-512 does not match the installer`);

  const records = [];
  for (const asset of assets) {
    records.push({
      key: asset.key,
      localName: asset.localName,
      publicName: asset.publicName,
      size: fs.statSync(asset.file).size,
      sha256: await hashFile(asset.file, "sha256", "hex"),
    });
  }
  return { version, feed, assets: records };
}

export function lintReleaseSource(root = scriptRoot, options = {}) {
  const { pkg, version } = releaseInfo(root);
  invariant(/^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/.test(version), `Invalid release version: ${version}`);

  const lock = readJson(path.join(root, "package-lock.json"));
  invariant(lock.version === version, `package-lock.json version ${lock.version} does not match ${version}`);
  invariant(lock.packages?.[""]?.version === version, `package-lock root version does not match ${version}`);

  const publish = Array.isArray(pkg.build?.publish) ? pkg.build.publish[0] : pkg.build?.publish;
  invariant(publish?.provider === "github", "build.publish.provider must be github");
  invariant(publish?.owner === "JioBani" && publish?.repo === "AgentParty-releases", "build.publish must target JioBani/AgentParty-releases");
  invariant(publish?.releaseType === "draft", "build.publish.releaseType must remain draft");
  const targets = (pkg.build?.win?.target ?? []).map((target) => typeof target === "string" ? target : target.target);
  invariant(targets.includes("nsis") && targets.includes("portable"), "Windows release must include nsis and portable targets");

  if (options.requireReleaseBranch !== false) {
    const branch = git(root, ["branch", "--show-current"]);
    invariant(branch === `release/v${version}`, `Release branch must be release/v${version}; found ${branch || "detached HEAD"}`);
  }

  if (options.checkWorkingTree !== false) {
    const changed = new Set([
      ...git(root, ["diff", "--name-only"]).split(/\r?\n/),
      ...git(root, ["diff", "--cached", "--name-only"]).split(/\r?\n/),
      ...git(root, ["ls-files", "--others", "--exclude-standard"]).split(/\r?\n/),
    ].filter(Boolean));
    const allowed = new Set(["package.json", "package-lock.json"]);
    const unexpected = [...changed].filter((file) => !allowed.has(file.replaceAll("\\", "/")));
    invariant(unexpected.length === 0, `Release worktree has unexpected changes: ${unexpected.join(", ")}`);
  }

  return { version, status: "source ok" };
}

export async function writeReleaseManifest(root = scriptRoot) {
  const inspected = await inspectReleaseArtifacts(root);
  const manifest = {
    schemaVersion: 1,
    version: inspected.version,
    sourceFingerprint: sourceFingerprint(root),
    createdAt: new Date().toISOString(),
    assets: inspected.assets,
  };
  const file = path.join(root, "release", RELEASE_MANIFEST);
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

export async function lintReleaseArtifacts(root = scriptRoot) {
  const inspected = await inspectReleaseArtifacts(root);
  const manifestFile = path.join(root, "release", RELEASE_MANIFEST);
  invariant(fs.existsSync(manifestFile), `Missing release/${RELEASE_MANIFEST}; run npm run package:win`);
  const manifest = readJson(manifestFile);
  invariant(manifest.schemaVersion === 1, `Unsupported release manifest schema: ${manifest.schemaVersion}`);
  invariant(manifest.version === inspected.version, `Release manifest version ${manifest.version} does not match ${inspected.version}`);
  invariant(manifest.sourceFingerprint === sourceFingerprint(root), "Packaged artifacts were built from different tracked source contents");
  for (const actual of inspected.assets) {
    const recorded = manifest.assets?.find((asset) => asset.key === actual.key);
    invariant(recorded, `Release manifest is missing ${actual.key}`);
    invariant(recorded.publicName === actual.publicName, `Release manifest name mismatch for ${actual.key}`);
    invariant(recorded.size === actual.size, `Release artifact size changed after packaging: ${actual.localName}`);
    invariant(recorded.sha256 === actual.sha256, `Release artifact content changed after packaging: ${actual.localName}`);
  }
  return { ...inspected, manifest };
}

export function lintPublishState(root = scriptRoot) {
  const { tag } = releaseInfo(root);
  const status = git(root, ["status", "--porcelain", "--untracked-files=no"]);
  invariant(status === "", "Tracked files changed after packaging; commit the release version before publishing");
  const head = git(root, ["rev-parse", "HEAD"]);
  const tagCommit = git(root, ["rev-parse", `${tag}^{commit}`]);
  const originMaster = git(root, ["rev-parse", "origin/master"]);
  invariant(tagCommit === head, `${tag} does not point to release HEAD`);
  invariant(originMaster === head, "origin/master does not point to release HEAD; push source before publishing artifacts");
  return { tag, head, status: "publish state ok" };
}

async function main() {
  const artifacts = process.argv.includes("--artifacts") || process.argv.includes("--publish-state");
  const publishState = process.argv.includes("--publish-state");
  const source = lintReleaseSource(scriptRoot, { checkWorkingTree: !publishState });
  console.log(`release:lint source OK (${source.version})`);
  if (artifacts) {
    const result = await lintReleaseArtifacts(scriptRoot);
    console.log(`release:lint artifacts OK (${result.assets.length} files, source fingerprint matched)`);
  }
  if (publishState) {
    const result = lintPublishState(scriptRoot);
    console.log(`release:lint publish state OK (${result.tag} at ${result.head.slice(0, 7)})`);
  }
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    console.error(`release:lint FAILED — ${error.message}`);
    process.exit(1);
  });
}
