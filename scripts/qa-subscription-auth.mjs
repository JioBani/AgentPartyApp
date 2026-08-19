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

const { codexCliAuthenticatedFrom, withCodexCliAuth, withSubscriptionProxyAuth } = await import(`${pathToFileURL(out).href}?v=${Date.now()}`);
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
const provider = (available, models = []) => ({
  available,
  models,
  loginCommand: "redacted",
  credential: {
    status: available ? "ready" : "missing",
    detail: available ? "complete active OAuth metadata" : "missing OAuth metadata",
  },
});
const status = (overrides = {}) => ({
  ok: true,
  baseUrl: "http://127.0.0.1:8317/v1",
  service: { status: "ready", managed: true },
  codex: provider(true, ["gpt-5.4-mini"]),
  claude: provider(false),
  ...overrides,
});

const ready = withSubscriptionProxyAuth(base, status());
assert(ready.length === 4, "Authentication exposes Claude bridge, native Codex, Codex bridge, and OpenRouter providers");
assert(ready.filter((item) => item.kind === "subscription").length === 3, "native and bridge authentication are visible as separate accounts");
assert(ready.find((item) => item.id === "openrouter")?.kind === "apiKey", "OpenRouter uses API-key authentication");
assert(!ready.some((item) => item.id.startsWith("cross-")), "internal cross-route accounts are not exposed as extra rows");
assert(ready.find((item) => item.id === "codex")?.description === "native", "native Codex card is preserved instead of replaced by bridge state");
assert(ready.find((item) => item.id === "codex-bridge")?.status === "available", "Codex bridge has its own status row");
assert(ready.find((item) => item.id === "codex-bridge")?.label === "Claude Code용 GPT 연결", "Codex bridge card names the workflow it serves");
assert(
  ready.find((item) => item.id === "codex-bridge")?.detail === "Claude Code 하네스에서 GPT 모델을 사용할 때만 필요합니다. Codex 하네스의 로그인과는 별도입니다.",
  "Codex bridge card explains that native Codex login is separate",
);
assert(ready.find((item) => item.id === "codex-bridge")?.action?.label === "다시 연결", "connected bridge keeps an explicit reauthentication action");
assert(ready.find((item) => item.id === "claude")?.action?.provider === "claude", "Claude row owns the shared Claude login action");

const nativeSignedOut = withCodexCliAuth(base, { authenticated: false });
assert(nativeSignedOut.find((item) => item.id === "codex")?.status === "invalid", "native Codex signed-out state is visible");
const nativeSignedIn = withCodexCliAuth(nativeSignedOut, { authenticated: true });
assert(nativeSignedIn.find((item) => item.id === "codex")?.status === "available", "native Codex signed-in state is restored independently");
assert(codexCliAuthenticatedFrom("Not authenticated") === false, "negative login status is not mistaken for the word authenticated");
assert(codexCliAuthenticatedFrom("Logged in using ChatGPT") === true, "ChatGPT CLI login status is recognized");

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
assert(failed.find((item) => item.id === "claude")?.status === "network_error", "Claude bridge failure is visible");
assert(failed.find((item) => item.id === "codex-bridge")?.status === "network_error", "Codex bridge failure is visible");
assert(failed.find((item) => item.id === "codex")?.status === "available", "bridge failure does not falsify native Codex login state");

console.log("SUBSCRIPTION AUTH QA PASSED");

function assert(value, message) {
  if (!value) throw new Error(`Assertion failed: ${message}`);
  console.log(`  ok: ${message}`);
}
