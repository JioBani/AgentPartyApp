/*
 * Product E2E for live transcript continuity while switching parties.
 *
 * This deliberately does not use /api/qa/.../emit or MockHarnessSession. The
 * real app starts CodexAdapter, which spawns fake-codex-appserver.mjs as its CLI
 * child. Delayed JSON-RPC deltas enter through that child's stdout and traverse
 * the production parser, SessionManager, IPC broadcast, and renderer reducer.
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElectronE2eApp, delay, removePath } from "./lib/electron-e2e.mjs";
import { qaRunDir } from "./lib/qaTemp.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runRoot = qaRunDir("cli-stream-party-switch");
const workspace = path.join(runRoot, "workspace");
const userData = path.join(runRoot, "userdata");
const streamTrace = path.join(runRoot, "cli-stream.jsonl");
const failures = [];
const LAST_MARKER = "MOCK_CLI_FINAL_RESPONSE";

function assert(condition, message) {
  console.log(`  ${condition ? "ok" : "FAIL"}: ${message}`);
  if (!condition) failures.push(message);
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitFor(probe, matches, label, attempts = 200) {
  let value;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      value = await probe();
      if (matches(value)) return value;
    } catch {
      // Renderer/API is crossing an expected asynchronous boundary.
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}. Last value: ${JSON.stringify(value)}`);
}

async function main() {
  const port = await freePort();
  const app = createElectronE2eApp({
    root,
    workspace,
    userData,
    port,
    env: {
      AGENTPARTY_CODEX_BIN: process.execPath,
      AGENTPARTY_CODEX_ARGS: JSON.stringify([path.join(root, "scripts", "fake-codex-appserver.mjs")]),
      AGENTPARTY_FAKE_CODEX_STREAM_OUT: streamTrace,
      AGENTPARTY_FAKE_CODEX_STREAM_CHUNKS: "24",
      AGENTPARTY_FAKE_CODEX_STREAM_INTERVAL_MS: "100",
    },
  });
  const { get, post } = app;
  let keepEvidence = true;

  const query = (windowId) => `?window=${encodeURIComponent(windowId)}`;
  const measureText = async (windowId, selector) => {
    const measured = await post(`/api/measure${query(windowId)}`, { selector, limit: 50 });
    return (measured.texts || []).join("\n");
  };
  const activePartyId = async (windowId) => {
    const measured = await post(`/api/measure${query(windowId)}`, {
      selector: ".wb-root",
      limit: 1,
      attributes: ["data-party-id", "data-layout-party"],
    });
    const attrs = measured.elements?.[0]?.attributes || {};
    return attrs["data-party-id"] || attrs["data-layout-party"] || "";
  };
  const clickParty = async (windowId, partyId) => {
    await post(`/api/qa/pointer${query(windowId)}`, {
      steps: [{ selector: `.wb-party-row[data-party-id="${partyId}"]`, action: "click" }],
      delayMs: 0,
    });
    await waitFor(() => activePartyId(windowId), (value) => value === partyId, `party ${partyId} to render`);
  };
  const openWorker = async (windowId) => {
    await post(`/api/qa/open${query(windowId)}`, { panels: [["worker"]] });
    await waitFor(
      () => measureText(windowId, ".wb-tab.is-active .wb-tab-name"),
      (text) => text.includes("worker"),
      "worker tab to open",
    );
  };
  const assistantText = (windowId) => measureText(windowId, ".wb-assistant .wb-assistant-body");
  const traceRows = () => {
    if (!fs.existsSync(streamTrace)) return [];
    return fs.readFileSync(streamTrace, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  };

  await app.prepare();
  try {
    await app.launch();
    const firstWindow = (await get("/api/windows")).windows?.[0]?.id;
    assert(Boolean(firstWindow), "the isolated real Electron app opened a window");
    const appRoot = (await get("/api/health")).runtime?.appRoot || "";
    assert((path.resolve(appRoot) + path.sep).toLowerCase().startsWith((root + path.sep).toLowerCase()), "the running app comes from this worktree");

    await post("/api/settings", {
      workspacePath: workspace,
      selectedHarnessId: "codex",
      harnessDefaults: {
        codex: {
          model: "fake-5.5",
          effort: "medium",
          codexPolicy: { sandbox: "read-only", approval: "never", guardian: false },
        },
      },
    });

    const createdA = await post(`/api/parties${query(firstWindow)}`, { name: "STREAM-A", location: workspace });
    const partyA = createdA.currentPartyId;
    await post(`/api/party/members${query(firstWindow)}`, {
      partyId: partyA,
      name: "worker",
      requirement: "Deterministic CLI stdout streaming probe.",
      runtime: "codex",
      model: "fake-5.5",
      location: workspace,
    });
    const member = await waitFor(
      async () => (await get(`/api/party${query(firstWindow)}`)).members?.find((entry) => entry.name === "worker"),
      (entry) => Boolean(entry?.sessionId),
      "worker's real Codex session",
    );
    assert(Boolean(member?.sessionId) && !String(member.sessionId).startsWith("mock-"), `worker uses a production Codex session (${member?.sessionId || "missing"})`);

    const createdB = await post(`/api/parties${query(firstWindow)}`, { name: "STREAM-B", location: workspace });
    const partyB = createdB.currentPartyId;
    await clickParty(firstWindow, partyA);
    await openWorker(firstWindow);

    // Reproduce the narrowest ownership race: release the process first, then
    // leave the party while the user-send path is waking/resuming the member.
    // Do not await the HTTP send before clicking; the UI's send handler is also
    // fire-and-forget, so navigation can win this race in ordinary use.
    await post(`/api/party/members/worker/sleep${query(firstWindow)}`, {});
    await waitFor(
      async () => (await get(`/api/party${query(firstWindow)}`)).members?.find((entry) => entry.name === "worker"),
      (entry) => entry?.status === "sleeping" && !entry?.sessionId,
      "worker to release its CLI process",
    );
    // Let the renderer's closed-session disk refresh settle before a new
    // session is created. Otherwise that in-flight read can accidentally return
    // the new session's later blocks and mask the stale-cache defect.
    await delay(2_500);
    const sendInFlight = post(`/api/party/members/worker/message${query(firstWindow)}`, { text: "KIND=stream reproduce party switch" });
    await clickParty(firstWindow, partyB);
    await sendInFlight;
    await waitFor(traceRows, (rows) => rows.length >= 1, "the first CLI stdout delta while party A is inactive");
    assert(await activePartyId(firstWindow) === partyB, "the first resumed CLI delta arrived while the original window showed party B");

    // Cross party boundaries several times while stdout is still flowing. The
    // final switch leaves A inactive until every chunk has been emitted.
    await clickParty(firstWindow, partyB);
    await waitFor(traceRows, (rows) => rows.length >= 7, "seven CLI stdout chunks while party A is inactive");
    await clickParty(firstWindow, partyA);
    await waitFor(
      () => measureText(firstWindow, ".wb-assistant"),
      (text) => text.includes("MOCK_CLI_STREAM_00"),
      "mid-stream output to render after returning to A",
    );
    await clickParty(firstWindow, partyB);
    const completedTrace = await waitFor(traceRows, (rows) => rows.length === 24, "all mocked CLI stdout chunks");
    assert(completedTrace.every((row, index) => row.index === index), "the child process emitted all stdout chunks in order");

    // Match the real failure's terminal boundary. Five minutes later the idle
    // sweeper performs this same operation while the original window is still
    // showing B: the live log is evicted, and only the persisted transcript
    // remains authoritative.
    await delay(300);
    const slept = await post("/api/party/members/worker/sleep", {}, { "x-agentparty-party": partyA });
    assert(slept.member?.status === "sleeping" && !slept.member?.sessionId, "worker sleeps after completing while its party is inactive");
    await delay(500);

    await clickParty(firstWindow, partyA);
    await openWorker(firstWindow);

    const persisted = await get(`/api/party/members/worker/transcript${query(firstWindow)}`);
    const persistedText = JSON.stringify(persisted.blocks || []);
    assert(persistedText.includes(LAST_MARKER), "the main-process transcript contains the final CLI chunk");
    const originalText = await assistantText(firstWindow).catch(() => "");

    const second = await post("/api/windows", { workspacePath: workspace, partyId: partyA });
    await post(`/api/navigation${query(second.id)}`, { view: "workbench" });
    await openWorker(second.id);
    const secondText = await waitFor(
      () => assistantText(second.id),
      (text) => text.includes(LAST_MARKER),
      "the persisted final response in a newly opened window",
    );

    await post(`/api/capture${query(firstWindow)}`, { path: path.join(runRoot, "original-window.png") });
    await post(`/api/capture${query(second.id)}`, { path: path.join(runRoot, "new-window.png") });

    assert(originalText.includes(LAST_MARKER), "the original window shows the completed response after returning");
    assert(secondText.includes(LAST_MARKER), "the new window shows the completed response from disk");

    await post(`/api/window/close${query(second.id)}`, {}).catch(() => {});
    await app.close();
    keepEvidence = failures.length > 0;
  } catch (error) {
    app.kill();
    throw error;
  } finally {
    app.kill();
    if (keepEvidence) {
      console.error(`E2E evidence retained at ${runRoot}`);
    } else {
      await removePath(runRoot);
    }
  }

  console.log(failures.length ? `\nCLI STREAM PARTY SWITCH E2E FAILED (${failures.length})` : "\nCLI STREAM PARTY SWITCH E2E PASSED");
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
