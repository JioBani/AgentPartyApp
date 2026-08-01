/*
 * [#17] Which conversation does a restart resume?
 *
 * ClaudeAdapter passes `resume: this.resumeSessionId` when it constructs a
 * query, so every restart makes a claim about WHICH conversation continues.
 * Two restarts exist and they mean opposite things:
 *
 *   restart(true)  — reload but CONTINUE the current conversation.
 *   restart(false) — hard restart: begin a NEW, empty conversation.
 *
 * This drives the real adapter against a fake SDK that records the `resume`
 * option of every query it is asked to build, and asserts each restart resumes
 * what it claims to. The failure it locks: before the first turn the adapter has
 * no session id of its own, and both restarts then fell back to an id that is no
 * longer the right target — so a harness/model swap made before the first turn
 * tried to resume a conversation that did not apply, and the user got an error.
 */
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const assert = (c, m) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) failures.push(m); };
const outDir = path.join(projectRoot, "node_modules/.qa"); mkdirSync(outDir, { recursive: true });

const built = await build({
  entryPoints: [path.join(projectRoot, "src/core/claudeAdapter.ts")],
  bundle: true, format: "esm", platform: "node", write: false,
  external: ["electron", "@anthropic-ai/claude-agent-sdk"],
});
const file = path.join(outDir, "claude-adapter-resume.mjs");
writeFileSync(file, built.outputFiles[0].text);
const { ClaudeAdapter } = await import(pathToFileURL(file).href);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A query that stays open and, when told to, reports a harness session id the
 * way a real init message does — that is what gives the adapter a conversation
 * of its own to continue.
 */
function makeSdk(resumes, { announceSessionId } = {}) {
  let emit;
  const pending = [];
  const next = () => new Promise((resolve) => { emit = resolve; });
  const sdk = {
    query: (input) => {
      resumes.push(input?.options?.resume ?? null);
      if (announceSessionId) {
        pending.push({ type: "system", subtype: "init", session_id: announceSessionId(resumes.length) });
      }
      return {
        async interrupt() {},
        close() {},
        async setModel() {},
        async applyFlagSettings() {},
        async *[Symbol.asyncIterator]() {
          while (true) {
            while (pending.length) { yield pending.shift(); }
            await next();
          }
        },
        supportedCommands: async () => [],
        supportedModels: async () => [],
        mcpServerStatus: async () => ({}),
      };
    },
    createSdkMcpServer: () => ({}),
    tool: () => ({}),
  };
  return { sdk, flush: () => emit && emit() };
}

function makeAdapter(resumes, options = {}, sdkOptions = {}) {
  const { sdk } = makeSdk(resumes, sdkOptions);
  return new ClaudeAdapter({
    id: `s-resume-${resumes.length}-${Math.round(performance.now())}`,
    cwd: os.tmpdir(),
    model: "sonnet",
    effort: "medium",
    permissionMode: "default",
    storageDir: path.join(outDir, "resume-store"),
    sdkLoader: async () => sdk,
    ...options,
  });
}

// --- 1. A fresh member has nothing to continue ----------------------------
console.log("\nfresh member, no turn yet:");
{
  const resumes = [];
  const adapter = makeAdapter(resumes);
  adapter.start();
  await sleep(120);
  assert(resumes[0] == null, "first start resumes nothing");
  adapter.setThinking("enabled", 4000); // → restart(true)
  await sleep(120);
  assert(resumes[1] == null, "a thinking change before the first turn still resumes nothing");
  adapter.dispose();
}

// --- 2. A member restored from a persisted thread --------------------------
console.log("\nmember resumed from a persisted thread, no turn yet:");
{
  const resumes = [];
  const adapter = makeAdapter(resumes, { resumeSessionId: "thread-X" });
  adapter.start();
  await sleep(120);
  assert(resumes[0] === "thread-X", "first start resumes the persisted thread");
  adapter.setThinking("enabled", 4000); // → restart(true): CONTINUE
  await sleep(120);
  assert(resumes[1] === "thread-X", "a thinking change keeps continuing that same thread");

  // A cross-backend model change explicitly starts a NEW session — the adapter
  // itself says "cross-backend resume is not supported". Resuming the old
  // thread on the other backend is exactly the error users saw.
  adapter.dispose();
}

// --- 3. [#17] The harness names a session before any turn commits ----------
// The query reports a session id the moment it opens, but the harness does not
// persist that conversation until a turn completes. Adopting it as a resume
// target is what made "create a member, then immediately change a setting"
// resume a conversation that does not exist.
console.log("\nharness announced a session id but no turn has been sent:");
{
  const resumes = [];
  const adapter = makeAdapter(resumes, {}, { announceSessionId: () => "uncommitted-A" });
  adapter.start();
  await sleep(150);
  assert(adapter.getSnapshot().sessionId === "uncommitted-A", "the harness announced a session id at start");
  assert(adapter.getSnapshot().turnCount === 0, "...but no turn has been committed");
  adapter.setThinking("enabled", 4000); // → restart(true)
  await sleep(150);
  assert(resumes.length === 2, `the setting change rebuilt the query (resumes: ${JSON.stringify(resumes)})`);
  assert(resumes[1] == null, "a setting change before the first turn starts fresh — it does not resume the uncommitted session");
  adapter.dispose();
}

// The same moment for a member that WAS legitimately continuing a thread: with
// nothing committed this run, the thread it came in on is still the right
// target — it must not be dropped.
console.log("\nsame moment, but the member was resuming a real thread:");
{
  const resumes = [];
  const adapter = makeAdapter(resumes, { resumeSessionId: "thread-X" }, { announceSessionId: () => "uncommitted-A" });
  adapter.start();
  await sleep(150);
  adapter.setThinking("enabled", 4000); // → restart(true)
  await sleep(150);
  assert(resumes.length === 2, `the setting change rebuilt the query (resumes: ${JSON.stringify(resumes)})`);
  assert(resumes[1] === "thread-X", "it keeps continuing the thread it came in on, not the uncommitted one");
  adapter.dispose();
}

// --- 4. Once a turn commits, a soft restart continues THAT conversation -----
console.log("\nmember with a turn-committed conversation:");
{
  const resumes = [];
  const adapter = makeAdapter(resumes, { resumeSessionId: "thread-X" }, { announceSessionId: () => "live-A" });
  adapter.start();
  await sleep(150);
  assert(adapter.getSnapshot().sessionId === "live-A", "the harness reported a live conversation id");
  adapter.sendUserTurn("hello"); // commits the conversation
  await sleep(60);
  assert(adapter.getSnapshot().turnCount === 1, "a turn was committed");
  adapter.setThinking("enabled", 4000); // → restart(true)
  await sleep(150);
  assert(resumes[1] === "live-A", "a soft restart continues the LIVE conversation, not the start-time thread");
  adapter.dispose();
}

console.log(failures.length ? `\n${failures.length} FAILED` : "\nall passed");
process.exit(failures.length ? 1 : 0);
