#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  expectedReleaseAssets,
  lintPublishState,
  lintReleaseArtifacts,
  lintReleaseSource,
} from "./release-lint.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = process.env.AGENTPARTY_RELEASE_ENV ?? "C:/Project/AgentParty-releases/.env";
const OWNER = "JioBani";
const REPO = "AgentParty-releases";
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;
const UPLOADS = `https://uploads.github.com/repos/${OWNER}/${REPO}`;

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function tokenFromEnvFile(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new Error(`Release token file is unavailable: ${file}`);
  }
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(GITHUB|GH_TOKEN|GITHUB_TOKEN)\s*=\s*(.+?)\s*$/.exec(line);
    if (match) return match[2].replace(/^["']|["']$/g, "");
  }
  throw new Error(`${file} has no GITHUB, GH_TOKEN, or GITHUB_TOKEN entry`);
}

const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const version = pkg.version;
const tag = `v${version}`;
const prerelease = /-(?:alpha|beta|rc)\./.test(version);
const feed = prerelease ? "beta.yml" : "latest.yml";
const notes = argument("--notes") ?? `AgentParty ${version}`;
const publishExisting = process.argv.includes("--publish-existing");
const skipBuild = process.argv.includes("--skip-build");
if (publishExisting && skipBuild) throw new Error("Use either --publish-existing or legacy --skip-build, not both");

const token = tokenFromEnvFile(ENV_FILE);
const authHeaders = {
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "user-agent": "agentparty-release-publish",
};

function run(command, args) {
  const executable = process.platform === "win32" ? `${command}.cmd` : command;
  execFileSync(executable, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, GH_TOKEN: token },
  });
}

async function api(method, url, body) {
  const response = await fetch(url, {
    method,
    headers: {
      ...authHeaders,
      ...(body ? { "content-type": "application/json; charset=utf-8" } : {}),
    },
    body: body ? Buffer.from(JSON.stringify(body), "utf8") : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${url} -> ${response.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function findRelease() {
  const releases = await api("GET", `${API}/releases?per_page=100`);
  return releases.find((release) => release.tag_name === tag) ?? null;
}

async function ensureReleaseRepositoryTag() {
  const refName = `refs/tags/${tag}`;
  const refs = await api("GET", `${API}/git/matching-refs/tags/${encodeURIComponent(tag)}`);
  if (refs.some((ref) => ref.ref === refName)) return;

  // A release created without a real tag can be published under an
  // `untagged-*` fallback, which makes every expected updater URL return 404.
  // Pin the release repository's current default-branch commit before a draft
  // exists so GitHub never has to synthesize or later detach the release tag.
  const repository = await api("GET", API);
  const commit = await api("GET", `${API}/commits/${encodeURIComponent(repository.default_branch)}`);
  await api("POST", `${API}/git/refs`, { ref: refName, sha: commit.sha });
  console.log(`created release repository tag ${tag} at ${commit.sha.slice(0, 12)}`);
}

async function createOrReuseDraft() {
  const existing = await findRelease();
  if (existing && !existing.draft) throw new Error(`${tag} is already public; never replace assets for a published version`);
  if (existing) return existing;
  return api("POST", `${API}/releases`, {
    tag_name: tag,
    name: tag,
    body: notes,
    draft: true,
    prerelease,
  });
}

async function uploadAsset(release, asset) {
  const duplicate = release.assets?.find((remote) => remote.name === asset.publicName);
  if (duplicate) await api("DELETE", `${API}/releases/assets/${duplicate.id}`);
  const size = statSync(asset.file).size;
  const response = await fetch(`${UPLOADS}/releases/${release.id}/assets?name=${encodeURIComponent(asset.publicName)}`, {
    method: "POST",
    headers: {
      ...authHeaders,
      "content-type": "application/octet-stream",
      "content-length": String(size),
    },
    body: createReadStream(asset.file),
    duplex: "half",
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Upload ${asset.publicName} -> ${response.status} ${text.slice(0, 300)}`);
  const uploaded = JSON.parse(text);
  if (uploaded.state !== "uploaded" || uploaded.size !== size) {
    throw new Error(`Upload verification failed for ${asset.publicName}`);
  }
  console.log(`uploaded ${asset.publicName} (${size} bytes)`);
}

function normalizeBody(value) {
  return String(value ?? "").replace(/\r\n/g, "\n").trimEnd();
}

async function verifyDraft(release, assets) {
  const current = await api("GET", `${API}/releases/${release.id}`);
  if (!current.draft) throw new Error(`${tag} left draft state before validation completed`);
  if (normalizeBody(current.body) !== normalizeBody(notes)) throw new Error("GitHub release notes differ from the UTF-8 source");
  const expectedNames = new Set(assets.map((asset) => asset.publicName));
  const unexpectedNames = current.assets.filter((asset) => !expectedNames.has(asset.name));
  if (unexpectedNames.length > 0 || current.assets.length !== assets.length) {
    throw new Error(`Draft assets differ from the required four files: ${current.assets.map((asset) => asset.name).join(", ")}`);
  }
  for (const asset of assets) {
    const remote = current.assets.find((candidate) => candidate.name === asset.publicName);
    if (!remote || remote.state !== "uploaded") throw new Error(`Draft is missing uploaded asset ${asset.publicName}`);
    if (remote.size !== statSync(asset.file).size) throw new Error(`Remote size mismatch for ${asset.publicName}`);
  }
  return current;
}

async function anonymousHead(url, attempts = 6) {
  let lastStatus = 0;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await fetch(url, { method: "HEAD", redirect: "follow" });
    lastStatus = response.status;
    if (response.ok) return response.status;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Anonymous download failed after ${attempts} attempts: ${url} -> ${lastStatus}`);
}

lintReleaseSource(root, { checkWorkingTree: !publishExisting });
let assets = expectedReleaseAssets(root);
let draft;

await ensureReleaseRepositoryTag();

if (publishExisting) {
  await lintReleaseArtifacts(root);
  lintPublishState(root);
  draft = await createOrReuseDraft();
  for (const remote of draft.assets ?? []) await api("DELETE", `${API}/releases/assets/${remote.id}`);
  draft = { ...draft, assets: [] };
  for (const asset of assets) await uploadAsset(draft, asset);
} else {
  if (skipBuild) {
    console.warn("--skip-build is legacy: it still repackages with electron-builder. Use --publish-existing after npm run release:prepare.");
  } else {
    run("npm", ["run", "build"]);
  }
  run("npx", ["electron-builder", "--win", "--x64", "--publish", "always"]);
  if (!existsSync(path.join(root, "release", feed))) throw new Error(`Missing release/${feed}`);
  draft = await findRelease();
  if (!draft) throw new Error(`Could not find draft release ${tag}`);
}

await api("PATCH", `${API}/releases/${draft.id}`, {
  name: tag,
  body: notes,
  draft: true,
  prerelease,
});
draft = await verifyDraft(draft, assets);
let published = await api("PATCH", `${API}/releases/${draft.id}`, {
  name: tag,
  body: notes,
  draft: false,
  prerelease,
  // A recalled higher SemVer release can coexist while its replacement is
  // verified. Explicitly point GitHub's latest endpoint (and updater) at the
  // newly published stable release, even if its version number is lower.
  make_latest: prerelease ? "false" : "true",
});

// GitHub can occasionally detach a newly published release onto an
// `untagged-*` fallback even though the requested ref already exists. Repair
// the association before testing public updater URLs: otherwise every asset
// is uploaded successfully but users receive 404s at the canonical tag path.
if (published.tag_name !== tag) {
  console.warn(`GitHub published ${tag} as ${published.tag_name}; repairing the release tag association.`);
  published = await api("PATCH", `${API}/releases/${draft.id}`, {
    tag_name: tag,
    name: tag,
    body: notes,
    draft: false,
    prerelease,
    make_latest: prerelease ? "false" : "true",
  });
}
if (published.tag_name !== tag) {
  throw new Error(`Published release tag is ${published.tag_name}, expected ${tag}`);
}

const checks = [];
for (const asset of assets) {
  const url = `https://github.com/${OWNER}/${REPO}/releases/download/${tag}/${encodeURIComponent(asset.publicName)}`;
  checks.push(`${await anonymousHead(url)} ${asset.publicName}`);
}

if (!prerelease) {
  const response = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`, {
    headers: { "user-agent": "agentparty-release-public-check" },
  });
  if (!response.ok) throw new Error(`Anonymous latest-release check failed: ${response.status}`);
  const latest = await response.json();
  if (latest.tag_name !== tag || latest.draft || latest.prerelease) {
    throw new Error(`Latest public stable release is ${latest.tag_name}, expected ${tag}`);
  }
}

console.log(`published ${tag} ${published.html_url}`);
console.log(checks.join("\n"));
console.log("release notes verified:", JSON.stringify(published.body));
