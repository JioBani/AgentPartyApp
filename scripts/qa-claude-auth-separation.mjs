import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { safeAuthStatus } = require("../dist/core/claudeNativeAuth.js");
const { ClaudeAdapter } = require("../dist/core/claudeAdapter.js");
const { bridgeCredentialIsUsable } = require("../dist/main/subscriptionProxyService.js");
const { getAuthState, withClaudeNativeAuth, withSubscriptionProxyAuth } = require("../dist/main/authService.js");
const { accountIsConnected } = require("../dist/shared/guideAuth.js");
const { deriveMemberStatus } = require("../dist/shared/memberDisplayStatus.js");

const failures = [];
function assert(condition, message) {
  console.log(`  ${condition ? "✓" : "✗"} ${message}`);
  if (!condition) failures.push(message);
}

const parsed = safeAuthStatus(JSON.stringify({ loggedIn: false, authMethod: "none", apiProvider: "firstParty", accessToken: "must-not-escape" }));
assert(parsed?.loggedIn === false && !Object.hasOwn(parsed, "accessToken"), "native status parser whitelists fields and drops credentials");
assert(bridgeCredentialIsUsable({ access_token: "secret", refresh_token: "secret", expired: false, disabled: false }), "complete active bridge OAuth metadata is usable");
assert(bridgeCredentialIsUsable({ accessToken: "secret", refreshToken: "secret", expired: false, disabled: false }), "camelCase bridge OAuth metadata is also recognized");
assert(!bridgeCredentialIsUsable({ access_token: "secret", expired: false }), "a bridge model list cannot hide an incomplete OAuth credential");

const native = {
  status: "auth_required",
  authenticated: false,
  checkedAt: new Date().toISOString(),
  host: { kind: "windows", label: "Windows" },
  workspace: "C:\\work",
  executable: "C:\\tools\\claude.exe",
  command: "C:\\tools\\claude.exe auth status",
  loginCommand: "C:\\tools\\claude.exe",
  detail: "Windows native login required",
};
const base = withClaudeNativeAuth(getAuthState(), native);
const bridgeMissing = withSubscriptionProxyAuth(base, {
  ok: true,
  baseUrl: "http://127.0.0.1:8317/v1",
  codex: { available: false, models: [], loginCommand: "codex-login", credential: { status: "missing", detail: "missing" } },
  claude: { available: true, models: ["claude-test"], loginCommand: "claude-login", credential: { status: "invalid", detail: "incomplete" } },
});
assert(bridgeMissing.find((item) => item.id === "claude-native")?.status === "invalid", "native Claude login has its own invalid card");
assert(bridgeMissing.find((item) => item.id === "claude")?.status === "invalid", "model discovery alone does not mark the bridge connected");
assert(bridgeMissing.find((item) => item.id === "claude-native")?.host === "Windows", "native card names its execution host");

const bridgeReady = withSubscriptionProxyAuth(base, {
  ok: true,
  baseUrl: "http://127.0.0.1:8317/v1",
  codex: { available: false, models: [], loginCommand: "codex-login", credential: { status: "missing", detail: "missing" } },
  claude: { available: true, models: ["claude-test"], loginCommand: "claude-login", credential: { status: "ready", detail: "ready" } },
});
const readyBridge = bridgeReady.find((item) => item.id === "claude");
assert(readyBridge?.authenticated === true && readyBridge.action?.label === "다시 연결", "connected bridge still exposes an explicit reauthentication action");
assert(accountIsConnected(readyBridge), "a reauthentication action does not make a proven healthy account look disconnected");

let sdkCalled = false;
const events = [];
const adapter = new ClaudeAdapter({
  id: "auth-preflight",
  cwd: os.tmpdir(),
  model: "sonnet",
  effort: "high",
  permissionMode: "default",
  safeMode: false,
  debugEnabled: false,
  storageDir: path.join(os.tmpdir(), "agentparty-auth-preflight"),
  customModelRoutes: [],
  routerBaseUrl: "http://127.0.0.1:1",
  routerAuthToken: "",
  nativeAuthProbe: async () => ({ ...native, workspace: os.tmpdir() }),
  sdkLoader: async () => {
    sdkCalled = true;
    throw new Error("SDK must not load before auth preflight");
  },
});
adapter.on("event", (event) => events.push(event));
adapter.start();
await new Promise((resolve) => setTimeout(resolve, 80));
assert(!sdkCalled, "native auth preflight blocks before loading the provider SDK");
assert(events.some((event) => event.type === "status" && event.status === "auth_required"), "preflight emits auth_required");
assert(deriveMemberStatus({ stored: "running", hasLiveSession: true, busy: false, pendingApproval: false, stalled: false, authRequired: true }) === "auth-required", "member list exposes auth-required instead of idle");

if (failures.length) {
  console.error(`\n${failures.length} Claude auth separation assertion(s) failed.`);
  process.exit(1);
}
console.log("\nClaude auth separation QA passed.");
