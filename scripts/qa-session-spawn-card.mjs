/*
 * Session start card — the raw spawn command must never reach the user feed.
 *
 * A member starting up used to land in the conversation as
 * `spawned: C:\Program Files\nodejs\node.exe … app-server -c mcp_servers.…`:
 * the executable path, every CLI argument, the party MCP wiring with its
 * automation URL and local port, the party/member ids, the auth-store setting.
 * A structured `session_spawn` event and its card replaced that line.
 *
 * This locks the replacement down on both axes:
 *   1) leakage   — no adapter emits the command any more, a failure reason is
 *                  classified rather than quoted, and a transcript persisted
 *                  BEFORE this change cannot draw its old raw line on restore.
 *   2) semantics — one card per attempt through starting → running/failed,
 *                  restart/resume/reconnect across all four harnesses, and
 *                  ordinary log/tool blocks never promoted into a card.
 * No Electron, no model — pure logic over the shared fold + the adapter sources.
 */
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { qaTempDir } from "./lib/qaTemp.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const assert = (c, m) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) failures.push(m); };
const outDir = qaTempDir();

async function load(entry, name) {
  const r = await build({ entryPoints: [path.join(projectRoot, entry)], bundle: true, format: "esm", platform: "node", write: false, external: ["electron"] });
  const file = path.join(outDir, name);
  writeFileSync(file, r.outputFiles[0].text);
  return import(pathToFileURL(file).href);
}

const { applyEvents, normalizeTranscriptBlocks } = await load("src/shared/transcriptEvents.ts", "spawn-transcript-events.mjs");
const { shortCwd, spawnFailureSummary, isLegacySpawnLine, redactSpawnText } = await load("src/shared/sessionSpawn.ts", "spawn-facts.mjs");

const SID = "s1";
const fold = (state, events) => applyEvents(state, SID, events);
const blocks = (state) => state[SID] || [];
const cards = (state) => blocks(state).filter((b) => b.kind === "sessionSpawn");
/** Every string a user could read off these blocks — body text and card fields. */
const surface = (state) => JSON.stringify(blocks(state));

// The real thing, from the report: the Codex app-server command line.
const RAW_COMMAND = [
  "C:\\Program Files\\nodejs\\node.exe",
  "C:\\Users\\Dev\\AppData\\Local\\Programs\\codex\\app-server",
  "-c", "mcp_servers.agentparty-app.command=\"C:\\Program Files\\nodejs\\node.exe\"",
  "-c", "mcp_servers.agentparty-app.env.AGENTPARTY_AUTOMATION_BASE_URL=\"http://127.0.0.1:51733\"",
  "-c", "mcp_servers.agentparty-app.env.AGENTPARTY_PARTY=\"party-1787322541208-e5ed0d23516e9\"",
  "-c", "mcp_servers.agentparty-app.env.AGENTPARTY_MEMBER=\"session-spawn-card\"",
  "-c", "preferred_auth_method=\"chatgpt\"",
].join(" ");

const SECRETS = [
  "node.exe",
  "app-server",
  "mcp_servers",
  "127.0.0.1",
  "51733",
  "party-1787322541208",
  "preferred_auth_method",
  "C:\\\\Users",
];
const clean = (text, what) => {
  const leaked = SECRETS.filter((needle) => text.includes(needle));
  assert(leaked.length === 0, `${what} — no spawn plumbing on the feed${leaked.length ? ` (leaked: ${leaked.join(", ")})` : ""}`);
};

// ============ 1) adapters no longer emit the command ============
console.log("\nadapters (source-level):");
{
  const sources = {
    "claudeAdapter": readFileSync(path.join(projectRoot, "src/core/claudeAdapter.ts"), "utf8"),
    "codexAdapter": readFileSync(path.join(projectRoot, "src/core/codexAdapter.ts"), "utf8"),
    "grokAdapter": readFileSync(path.join(projectRoot, "src/core/grokAdapter.ts"), "utf8"),
    "cursorAdapter": readFileSync(path.join(projectRoot, "src/core/cursorAdapter.ts"), "utf8"),
  };
  for (const [name, source] of Object.entries(sources)) {
    assert(!/status:\s*"spawn(ed|ing)"/.test(source), `${name} emits no spawn STATUS line`);
  }
  // The one that carried the whole command line, specifically.
  assert(!/detail:\s*\[resolved\.command/.test(sources.codexAdapter), "codexAdapter no longer ships the joined command as detail");
  assert(/emitSessionSpawn\("running"\)/.test(sources.codexAdapter), "codexAdapter reports the start structurally instead");
  for (const name of ["claudeAdapter", "codexAdapter", "grokAdapter"]) {
    assert(/emitSessionSpawn\("failed"/.test(sources[name]), `${name} closes the card on a failed start`);
  }
  // Raw detail still exists where it belongs: the per-session debug log.
  assert(/this\.log\("spawn_sdk_query"/.test(sources.claudeAdapter), "the raw spawn detail is still logged for debugging (separate surface)");
}

// ============ 2) the live fold ============
console.log("\nsession_spawn fold:");
{
  let state = fold({}, [{ type: "session_spawn", state: "starting", harness: "codex", model: "gpt-5.4-codex", host: "windows", cwd: "…/AgentPartyApp" }]);
  assert(cards(state).length === 1 && cards(state)[0].state === "starting", "a start opens exactly one card");

  state = fold(state, [{ type: "session_spawn", state: "running", harness: "codex", model: "gpt-5.4-codex" }]);
  assert(cards(state).length === 1, "reaching 'running' updates that card — it does not add one");
  assert(cards(state)[0].state === "running", "the card moved to running");
  assert(cards(state)[0].cwd === "…/AgentPartyApp", "facts from the opening event survive a terminal event that omits them");

  // Restart: a second attempt is a second card, in order.
  state = fold(state, [{ type: "session_spawn", state: "starting", harness: "codex" }, { type: "session_spawn", state: "running", harness: "codex" }]);
  assert(cards(state).length === 2, "a restart gets its OWN card rather than mutating the first");

  // A failure that arrives with no card open (reconnect to a dead session).
  let orphan = fold({}, [{ type: "session_spawn", state: "failed", harness: "grok", reason: "하네스 실행 파일을 찾지 못했습니다. 설치 상태를 확인하세요.", retryable: false }]);
  assert(cards(orphan).length === 1 && cards(orphan)[0].state === "failed", "a terminal-only report still draws one card");
  assert(cards(orphan)[0].retryable === false, "the card says whether retrying is worth it");

  // Repeated liveness reports must not stack.
  orphan = fold(orphan, [{ type: "session_spawn", state: "failed", harness: "grok", reason: "하네스 실행 파일을 찾지 못했습니다. 설치 상태를 확인하세요." }]);
  assert(cards(orphan).length === 1, "a repeated terminal report refreshes the card instead of duplicating it");

  // A failed start reports WHY, never WITH WHAT.
  clean(surface(orphan), "failed card");
}

// ============ 3) no route back to the raw line ============
console.log("\nleakage:");
{
  // An older engine (or a replayed fixture) still emitting the legacy status.
  const legacyEvent = fold({}, [{ type: "status", status: "spawned", detail: RAW_COMMAND }]);
  assert(cards(legacyEvent).length === 1, "a legacy spawn STATUS folds into the card");
  assert(!blocks(legacyEvent).some((b) => b.kind === "status"), "…and leaves no status line behind");
  clean(surface(legacyEvent), "legacy spawn event");

  // A transcript persisted before this change, replayed by a restore.
  const persisted = [
    { id: "1", kind: "user", text: "안녕" },
    { id: "2", kind: "status", text: `spawned: ${RAW_COMMAND}` },
    { id: "3", kind: "assistant", text: "네" },
  ];
  const restored = normalizeTranscriptBlocks(persisted);
  assert(restored.find((b) => b.id === "2")?.kind === "sessionSpawn", "a restored raw spawn line is rewritten into the card");
  assert(restored.length === 3 && restored[0].kind === "user" && restored[2].kind === "assistant", "the rest of the restored history is untouched");
  clean(JSON.stringify(restored), "restored transcript");

  // Ordinary blocks are NOT session cards, however command-like they look.
  const ordinary = normalizeTranscriptBlocks([
    { id: "a", kind: "status", text: "turn complete - $0.01 in" },
    { id: "b", kind: "tool", name: "Bash", input: { command: RAW_COMMAND } },
    { id: "c", kind: "user", text: `spawned: something the user typed` },
    { id: "d", kind: "status", text: "model: claude-opus-5" },
  ]);
  assert(ordinary.every((b) => b.kind !== "sessionSpawn"), "an ordinary status/tool/user block is never promoted into a session card");
  assert(!isLegacySpawnLine("model: claude-opus-5") && !isLegacySpawnLine("turn complete"), "only the statuses that carried spawn plumbing qualify");
  assert(isLegacySpawnLine("spawning: codex"), "…and both of them do");
}

// ============ 4) the redaction helpers ============
console.log("\nredaction:");
{
  assert(shortCwd("C:\\Users\\Dev\\Project\\AgentPartyApp\\src") === "…/AgentPartyApp/src", "a long path shortens to its last two segments");
  assert(shortCwd("/home/dev/projects/app") === "…/projects/app", "POSIX paths shorten the same way");
  assert(!shortCwd("C:\\Users\\Dev\\Project\\AgentPartyApp").includes("Users"), "the parent chain does not survive shortening");
  assert(shortCwd("") === "" && shortCwd(undefined) === "", "an unknown cwd is simply absent");

  const enoent = spawnFailureSummary(Object.assign(new Error(`spawn ${RAW_COMMAND} ENOENT`), { code: "ENOENT" }));
  assert(!enoent.reason.includes("node.exe") && enoent.retryable === false, "a spawn error is classified, and the command it quoted is dropped");
  const exited = spawnFailureSummary(new Error("Codex app-server exited with code 1."));
  assert(/코드 1/.test(exited.reason) && exited.retryable === true, "an exit code survives as a number, not as output");
  const unknown = spawnFailureSummary(new Error(RAW_COMMAND));
  assert(!unknown.reason.includes("mcp_servers"), "an unrecognized error falls back to a generic line rather than showing itself");

  clean(redactSpawnText(RAW_COMMAND), "defense-in-depth scrubber");
}

console.log(failures.length ? `\n${failures.length} FAILED` : "\nall passed");
process.exit(failures.length ? 1 : 0);
