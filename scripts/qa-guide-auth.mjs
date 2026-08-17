import { accountIsConnected, hasConnectedAccount } from "../dist/shared/guideAuth.js";

const failures = [];
function assert(condition, message) {
  if (!condition) {
    failures.push(message);
    console.log(`  ✗ ${message}`);
  } else {
    console.log(`  ✓ ${message}`);
  }
}

const lyingClaude = {
  id: "claude",
  label: "Claude",
  kind: "subscription",
  status: "available",
  description: "",
  detail: "AgentParty delegates subscription auth to the local Claude Code harness.",
};
const connectedClaude = {
  ...lyingClaude,
  detail: "Claude Code subscription bridge is connected.",
};
const loginAction = {
  ...lyingClaude,
  status: "missing",
  action: { type: "subscriptionOAuth", provider: "claude", label: "구독 연결" },
};
const key = {
  id: "openrouter",
  label: "OpenRouter",
  kind: "apiKey",
  status: "configured",
  description: "",
};

assert(!accountIsConnected(lyingClaude), "CLI-present Claude is not connected (B-03)");
assert(accountIsConnected(connectedClaude), "bridge-connected Claude is connected");
assert(!accountIsConnected(loginAction), "login-action card is not connected");
assert(accountIsConnected(key), "configured API key is connected");
assert(!hasConnectedAccount([lyingClaude, loginAction]), "a list of liars is not enough");
assert(hasConnectedAccount([lyingClaude, key]), "one real key is enough");

if (failures.length) {
  console.error(`FAILED ${failures.length}`);
  process.exit(1);
}
console.log("OK");
