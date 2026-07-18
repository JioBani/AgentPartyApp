/*
 * Network integration for the first-run bridge installer. It downloads the
 * official Windows release, requires GitHub's SHA-256 digest to match, extracts
 * into isolated userData, and deliberately stops before OAuth by pointing at a
 * missing explicit config. No provider/model request is made.
 */
import { build } from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = path.join(os.tmpdir(), `agentparty-subscription-install-${process.pid}`);
const fakeHome = path.join(temp, "home");
const storage = path.join(temp, "userData");
const out = path.join(temp, "service.cjs");

fs.rmSync(temp, { recursive: true, force: true });
fs.mkdirSync(fakeHome, { recursive: true });
fs.mkdirSync(storage, { recursive: true });
process.env.USERPROFILE = fakeHome;
process.env.HOME = fakeHome;
process.env.AGENTPARTY_USER_DATA = storage;
process.env.AGENTPARTY_SUBSCRIPTION_PROXY_CONFIG = path.join(temp, "intentionally-missing.yaml");

try {
  await build({
    entryPoints: [path.join(root, "src", "main", "subscriptionProxyService.ts")],
    bundle: true,
    format: "cjs",
    platform: "node",
    outfile: out,
    logLevel: "silent",
  });
  const { SubscriptionProxyService } = createRequire(import.meta.url)(out);
  const service = new SubscriptionProxyService({ storageDir: storage, packaged: false });
  const result = await service.login("claude");
  const executable = path.join(storage, "subscription-proxy", "bin", "cli-proxy-api.exe");
  assert(fs.existsSync(executable), "verified official bridge was installed into isolated app storage");
  assert(fs.statSync(executable).size > 1_000_000, "installed executable is non-empty");
  assert(result.status === "error" && result.detail.includes("configuration"), "test stopped before OAuth at the intentional config error");
  service.dispose();
  console.log("SUBSCRIPTION PROXY INSTALL QA PASSED");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

function assert(value, message) {
  if (!value) throw new Error(`Assertion failed: ${message}`);
  console.log(`  ok: ${message}`);
}
