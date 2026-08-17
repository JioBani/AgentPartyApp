import assert from "node:assert/strict";
import { cliContinuationArgv, cliContinuationTarget, formatCliContinuationCommand } from "../dist/shared/cliContinuation.js";
import { cliContinuationSpawnSpec } from "../dist/main/cliContinuationLauncher.js";

const sessionId = "019f-test-session";

const claude = cliContinuationTarget({ runtime: "claude-code", model: "claude-opus-5[1m]", harnessSessionId: sessionId });
assert.equal(claude.supported, true);
assert.deepEqual(cliContinuationArgv(claude.target, { kind: "local" }), ["claude", "--resume", sessionId]);

const codex = cliContinuationTarget({ runtime: "codex", model: "GPT-5.6 Sol", harnessSessionId: sessionId });
assert.equal(codex.supported, true);
assert.equal(formatCliContinuationCommand(cliContinuationArgv(codex.target, { kind: "local" }), "powershell"), `codex resume ${sessionId}`);

const cursorWsl = cliContinuationTarget({ runtime: "cursor", model: "Grok 4.5 Cursor", harnessSessionId: sessionId });
assert.equal(cursorWsl.supported, true);
assert.deepEqual(cliContinuationArgv(cursorWsl.target, { kind: "wsl", distro: "Ubuntu-22.04" }), ["agent", "--resume", sessionId]);

const grokWsl = cliContinuationTarget({ runtime: "grok", model: "Grok 4.5 xAI", harnessSessionId: sessionId });
assert.equal(grokWsl.supported, true);
const wslSpec = cliContinuationSpawnSpec({
  target: grokWsl.target,
  location: { host: { kind: "wsl", distro: "Ubuntu-22.04" }, path: "/home/dev/project with space" },
});
assert.equal(wslSpec.command, "wsl.exe");
assert.deepEqual(wslSpec.args.slice(0, 6), ["-d", "Ubuntu-22.04", "--cd", "/home/dev/project with space", "-e", "bash"]);
assert.equal(wslSpec.args.at(-1), `exec grok --resume ${sessionId}`);

const localSpec = cliContinuationSpawnSpec({
  target: claude.target,
  location: { host: { kind: "local" }, path: "C:\\Project\\O'Brien App" },
});
assert.equal(localSpec.command, "powershell.exe");
assert.match(localSpec.args.at(-1), /Set-Location -LiteralPath 'C:\\Project\\O''Brien App'/);
assert.match(localSpec.args.at(-1), /& 'claude' '--resume' '019f-test-session'/);

for (const [runtime, model] of [
  ["claude-code", "GPT-5.6 Sol"],
  ["codex", "claude-opus-5[1m]"],
  ["cursor", "Grok 4.5 xAI"],
]) {
  const result = cliContinuationTarget({ runtime, model, harnessSessionId: sessionId });
  assert.equal(result.supported, false, `${runtime}/${model} must be rejected`);
  assert.match(result.reason, /교차 하네스/);
}

const router = cliContinuationTarget({ runtime: "claude-code", model: "Kimi K3", harnessSessionId: sessionId });
assert.equal(router.supported, false);
assert.match(router.reason, /외부 라우터/);

const empty = cliContinuationTarget({ runtime: "codex", model: "GPT-5.6 Sol" });
assert.equal(empty.supported, false);
assert.match(empty.reason, /한 턴 이상/);

console.log("qa-cli-continuation: ok");
