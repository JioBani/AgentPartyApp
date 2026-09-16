/*
 * Product E2E for transcript follow behavior.
 *
 * The real Electron app starts CodexAdapter, which spawns the deterministic
 * fake CLI as its child. Its delayed stdout notifications traverse the normal
 * parser, SessionManager, IPC broadcast, renderer reducer, and visible chat.
 * No normalized transcript event is injected through a QA-only route.
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createElectronE2eApp, delay, removePath } from "./lib/electron-e2e.mjs";
import { projectRoot, qaRunDir } from "./lib/qaTemp.mjs";

const run = qaRunDir("chat-auto-scroll");
const workspace = path.join(run, "workspace");
const userData = path.join(run, "user-data");
const streamTrace = path.join(run, "cli-stream.jsonl");
const port = await freePort();
const app = createElectronE2eApp({
  root: projectRoot,
  workspace,
  userData,
  port,
  env: {
    AGENTPARTY_CODEX_BIN: process.execPath,
    AGENTPARTY_CODEX_ARGS: JSON.stringify([path.join(projectRoot, "scripts", "fake-codex-appserver.mjs")]),
    AGENTPARTY_FAKE_CODEX_STREAM_OUT: streamTrace,
    AGENTPARTY_FAKE_CODEX_STREAM_CHUNKS: "24",
    AGENTPARTY_FAKE_CODEX_STREAM_INTERVAL_MS: "70",
  },
});
const selector = '.wb-panel:has([data-drop-tab="worker"]) .wb-transcript';
let failures = 0;
let completed = false;

function check(label, condition, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"} — ${label}${detail ? ` (${detail})` : ""}`);
  if (!condition) failures += 1;
}

try {
  await app.prepare();
  await app.launch();
  const windowId = (await app.get("/api/windows")).windows?.[0]?.id;
  check("the isolated real Electron app opened a window", Boolean(windowId));
  const query = `?window=${encodeURIComponent(windowId)}`;

  await app.post("/api/settings", {
    workspacePath: workspace,
    selectedHarnessId: "codex",
    composer: { sendKey: "enter", interruptOnSend: false },
    harnessDefaults: {
      codex: {
        model: "fake-5.5",
        effort: "medium",
        codexPolicy: { sandbox: "read-only", approval: "never", guardian: false },
      },
    },
  });
  const created = await app.post(`/api/parties${query}`, { name: "CHAT-SCROLL", location: workspace });
  const partyId = created.currentPartyId;
  await app.post(`/api/party/members${query}`, {
    partyId,
    name: "worker",
    requirement: "Deterministic CLI stdout scroll probe.",
    runtime: "codex",
    model: "fake-5.5",
    location: workspace,
  });
  const member = await waitFor(
    async () => (await app.get(`/api/party${query}`)).members?.find((entry) => entry.name === "worker"),
    (entry) => Boolean(entry?.sessionId),
    "worker production Codex session",
  );
  check(
    "the member uses the production Codex adapter",
    Boolean(member?.sessionId) && !String(member.sessionId).startsWith("mock-"),
    `session=${member?.sessionId || "missing"}`,
  );

  await app.post(`/api/navigation${query}`, { view: "workbench" });
  await app.post(`/api/qa/open${query}`, { panels: [["worker"]] });
  await waitForText(".wb-tab.is-active .wb-tab-name", "worker", query);

  await sendFromComposer("KIND=stream BUILD_LONG_TRANSCRIPT", query);
  await waitForText(".wb-assistant-body", "MOCK_CLI_STREAM_06", query);
  const initial = await waitForScroll((value) => value.range > 100 && value.distance < 48, "initial transcript bottom pin", query);
  check("live CLI output makes the transcript overflow", initial.range > 100, `range=${initial.range}`);
  check("a followed transcript stays at its latest output", initial.distance < 48, `distance=${initial.distance}`);

  await waitFor(() => traceRows(), (rows) => rows.length === 24, "all delayed CLI stdout chunks");
  await waitForText(".wb-assistant-body", "MOCK_CLI_FINAL_RESPONSE", query);
  await waitForScroll((value) => value.distance < 48, "completed response bottom pin", query);

  // Move after the long response has settled. This reproduces the reported
  // state directly: a user is reading older content, then sends a new turn.
  await delay(200);
  await app.post(`/api/qa/pointer${query}`, {
    steps: [{ selector, action: "click" }],
    delayMs: 0,
  });
  await scrollTo(0, query);
  await delay(100);
  const reading = await waitForScroll((value) => value.top <= 3, "older reading position", query);
  check("the transcript is deliberately unpinned before sending", reading.top <= 3, `top=${reading.top}`);

  await sendFromComposer("KIND=delayedApproval OWN_MESSAGE_REENABLES_BOTTOM_FOLLOW", query);
  await waitForText(".wb-user", "OWN_MESSAGE_REENABLES_BOTTOM_FOLLOW", query);
  const afterSend = await waitForScroll((value) => value.distance < 48, "own message to restore bottom following", query);
  check("sending a message scrolls the chat to the new turn", afterSend.distance < 48, `distance=${afterSend.distance}`);

  // The fake CLI answers in a later task, proving follow intent remains latched
  // for a genuinely delayed response rather than just a same-frame DOM update.
  await waitForText(".wb-codex-approval", "git status", query);
  const followed = await waitForScroll((value) => value.distance < 48, "delayed CLI response while following", query);
  check("a delayed CLI response continues following the bottom", followed.distance < 48, `distance=${followed.distance}`);
  completed = failures === 0;
} finally {
  await app.close().catch(() => app.kill());
  app.kill();
  await delay(500);
  if (completed) await removePath(run).catch(() => {});
  if (fs.existsSync(run)) console.error(`retained E2E artifacts: ${run}`);
}

console.log(failures === 0 ? "\nChat auto-scroll E2E: PASS" : `\nChat auto-scroll E2E: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

async function sendFromComposer(text, query) {
  await app.post(`/api/qa/input${query}`, {
    selector: '.wb-panel:has([data-drop-tab="worker"]) .wb-composer-editor',
    text,
    key: "Enter",
  });
}

async function scrollMetrics(query, scroll) {
  const measured = await app.post(`/api/measure${query}`, {
    selector,
    limit: 1,
    ...(scroll === undefined ? {} : { scroll: { selector, to: scroll } }),
  });
  const element = measured.elements?.[0];
  if (!element) throw new Error("Transcript measurement returned no element.");
  const top = Number(element.scroll?.top || 0);
  const height = Number(element.scroll?.height || 0);
  const viewport = Number(element.box?.height || 0);
  return {
    top,
    range: Math.max(0, height - viewport),
    distance: Math.max(0, height - viewport - top),
  };
}

async function scrollTo(top, query) {
  return scrollMetrics(query, top);
}

async function waitForScroll(predicate, label, query) {
  return waitFor(() => scrollMetrics(query), predicate, label);
}

async function waitForText(target, marker, query) {
  return waitFor(
    async () => {
      const measured = await app.post(`/api/measure${query}`, { selector: target, limit: 100 });
      return (measured.texts || []).join("\n");
    },
    (text) => text.includes(marker),
    `'${marker}' in ${target}`,
  );
}

async function waitFor(probe, predicate, label) {
  let last;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      last = await probe();
      if (predicate(last)) return last;
    } catch {
      // The app is crossing an expected async boundary.
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}. Last value: ${JSON.stringify(last)}`);
}

function traceRows() {
  if (!fs.existsSync(streamTrace)) return [];
  return fs.readFileSync(streamTrace, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const assigned = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(assigned));
    });
  });
}
