#!/usr/bin/env node
/**
 * Publishes src/shared/modelCatalog.json to the public release repo, where every
 * installed app fetches it (see src/main/remoteModelCatalog.ts). This is THE way
 * a catalog change reaches users without an app release:
 *
 *   1. edit src/shared/modelCatalog.json
 *   2. npm run catalog:publish
 *
 * The source repo stays the single source of truth — this script only copies.
 * It validates before uploading (same structural rules the app enforces), so a
 * broken payload fails HERE, not on every user's machine. Auth reuses the Git
 * Credential Manager token the release flow already uses; no new secrets.
 *
 * Design doc: docs/기획 노트 — 원격 모델 카탈로그.md
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OWNER = "JioBani";
const REPO = "AgentParty-releases";
const REMOTE_PATH = "modelCatalog.json";
const BRANCH = "main";
const SCHEMA_VERSION = 1;
const PROVIDERS = new Set(["anthropic", "openai", "openrouter", "cursor", "deepseek", "xai"]);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceFile = path.join(root, "src", "shared", "modelCatalog.json");

function fail(message) {
  console.error(`catalog:publish FAILED — ${message}`);
  process.exit(1);
}

// --- validate (mirrors validateModelCatalogPayload in src/shared/modelCatalog.ts)
const raw = fs.readFileSync(sourceFile, "utf8");
let payload;
try {
  payload = JSON.parse(raw);
} catch (error) {
  fail(`invalid JSON: ${error.message}`);
}
if (payload.schemaVersion !== SCHEMA_VERSION) {
  fail(`schemaVersion must be ${SCHEMA_VERSION}, got ${JSON.stringify(payload.schemaVersion)}`);
}
if (!Array.isArray(payload.models) || payload.models.length === 0) {
  fail("models must be a non-empty array");
}
const seen = new Set();
for (const [index, model] of payload.models.entries()) {
  const where = `models[${index}]${model && model.id ? ` (${model.id})` : ""}`;
  if (!model || typeof model !== "object") fail(`${where} is not an object`);
  if (typeof model.id !== "string" || !model.id.trim()) fail(`${where} is missing a string id`);
  if (typeof model.label !== "string" || !model.label.trim()) fail(`${where} is missing a string label`);
  if (!PROVIDERS.has(model.provider)) fail(`${where} has unknown provider ${JSON.stringify(model.provider)}`);
  if (typeof model.subscription !== "boolean") fail(`${where} is missing the boolean subscription flag`);
  const key = model.id.toLowerCase();
  if (seen.has(key)) fail(`duplicate model id ${model.id}`);
  seen.add(key);
}

// --- token from Git Credential Manager (same auth as the release flow)
let token;
try {
  const filled = execFileSync("git", ["credential", "fill"], { input: "protocol=https\nhost=github.com\n\n", encoding: "utf8" });
  token = filled.split("\n").find((line) => line.startsWith("password="))?.slice("password=".length);
} catch (error) {
  fail(`could not read the GitHub token from Git Credential Manager: ${error.message}`);
}
if (!token) {
  fail("Git Credential Manager returned no password for github.com");
}

const api = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${REMOTE_PATH}`;
const headers = {
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "User-Agent": "agentparty-catalog-publish",
};

// --- read the current remote sha (required by the contents API for updates)
const current = await fetch(`${api}?ref=${BRANCH}`, { headers });
let sha;
if (current.ok) {
  const body = await current.json();
  sha = body.sha;
  const remoteContent = Buffer.from(body.content || "", "base64").toString("utf8");
  if (remoteContent === raw) {
    console.log(`catalog:publish — remote is already up to date (${payload.models.length} models). Nothing to do.`);
    process.exit(0);
  }
} else if (current.status !== 404) {
  fail(`could not read the remote file: HTTP ${current.status}`);
}

// --- upload
const message = `catalog: publish modelCatalog.json (${payload.models.length} models, schema v${SCHEMA_VERSION})`;
const response = await fetch(api, {
  method: "PUT",
  headers,
  body: JSON.stringify({ message, branch: BRANCH, content: Buffer.from(raw).toString("base64"), ...(sha ? { sha } : {}) }),
});
if (!response.ok) {
  const body = await response.text();
  fail(`upload rejected: HTTP ${response.status} ${body.slice(0, 300)}`);
}
const result = await response.json();
console.log(`catalog:publish — published ${payload.models.length} models to ${OWNER}/${REPO}@${BRANCH} (${result.commit.sha.slice(0, 7)})`);
console.log("Users pick it up within ~5 minutes (raw CDN cache) on their next catalog poll or app start.");
