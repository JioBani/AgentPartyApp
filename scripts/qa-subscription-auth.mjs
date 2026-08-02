import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { qaTempDir } from "./lib/qaTemp.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(qaTempDir(), "subscription-auth.mjs");
await build({
  entryPoints: [path.join(root, "src", "main", "authService.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: out,
  logLevel: "silent",
});

const { withSubscriptionProxyAuth } = await import(`${pathToFileURL(out).href}?v=${Date.now()}`);
const base = [{
  id: "claude",
  label: "Claude",
  kind: "subscription",
  status: "available",
  description: "native",
}, {
  id: "codex",
  label: "Codex",
  kind: "subscription",
  status: "available",
  description: "native",
}, {
  id: "openrouter",
  label: "OpenRouter",
  kind: "apiKey",
  status: "missing",
  description: "optional",
}];
const provider = (available, models = []) => ({ available, models, loginCommand: "redacted" });
const status = (overrides = {}) => ({
  ok: true,
  baseUrl: "http://127.0.0.1:8317/v1",
  service: { status: "ready", managed: true },
  codex: provider(true, ["gpt-5.4-mini"]),
  claude: provider(false),
  ...overrides,
});

const ready = withSubscriptionProxyAuth(base, status());
assert(ready.length === 3, "Authentication exposes exactly Claude, Codex, and OpenRouter providers");
assert(ready.filter((item) => item.kind === "subscription").length === 2, "Claude and Codex use subscription authentication");
assert(ready.find((item) => item.id === "openrouter")?.kind === "apiKey", "OpenRouter uses API-key authentication");
assert(!ready.some((item) => item.id.startsWith("cross-")), "internal cross-route accounts are not exposed as extra rows");
assert(ready.find((item) => item.id === "codex")?.status === "available", "Codex row reflects persisted OAuth for both harnesses");
assert(!ready.find((item) => item.id === "codex")?.action, "connected account has no redundant login action");
assert(ready.find((item) => item.id === "claude")?.action?.provider === "claude", "Claude row owns the shared Claude login action");

const pending = withSubscriptionProxyAuth(base, status({
  authentication: { claude: { status: "pending", detail: "approve" } },
}));
assert(pending.find((item) => item.id === "claude")?.status === "pending", "browser approval remains visibly pending on the Claude row");

const failed = withSubscriptionProxyAuth(base, status({
  ok: false,
  service: { status: "error", managed: false, detail: "bridge missing" },
  codex: provider(false),
  claude: provider(false),
}));
assert(failed.filter((item) => item.kind === "subscription").every((item) => item.status === "network_error"), "bridge failures are surfaced on both subscription rows without fallback");

console.log("SUBSCRIPTION AUTH QA PASSED");

function assert(value, message) {
  if (!value) throw new Error(`Assertion failed: ${message}`);
  console.log(`  ok: ${message}`);
}
