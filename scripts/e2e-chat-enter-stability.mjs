/*
 * Real-app regression for two intermittent chat flashes:
 *
 *  - a sleeping panel keeps its cached conversation visible while the durable
 *    transcript is refreshed, and
 *  - repeated bare-Enter sends retain the same workbench/party and composer
 *    focus.
 *
 * Uses mock harnesses, so it is offline and unbilled.
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createElectronE2eApp, delay, removePath } from "./lib/electron-e2e.mjs";
import { projectRoot, qaRunDir } from "./lib/qaTemp.mjs";

const run = qaRunDir("chat-enter-stability");
const workspace = path.join(run, "workspace");
const userData = path.join(run, "user-data");
const port = await freePort();
const app = createElectronE2eApp({ root: projectRoot, workspace, userData, port });
const SLEEPER_MARKER = "sleeping-panel-history-must-stay-visible";

let failures = 0;
function check(label, condition, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"} — ${label}${detail ? ` (${detail})` : ""}`);
  if (!condition) failures += 1;
}

try {
  await app.prepare();
  await app.launch();
  await app.post("/api/qa/reset", {}).catch(() => {});
  await app.post("/api/qa/seed", {
    party: "chat enter stability",
    members: [
      {
        name: "chatter",
        role: "repeated Enter sender",
        autoReply: false,
        status: "idle",
        blocks: [{ type: "assistant_text_delta", text: "chatter-ready" }],
      },
      {
        name: "sleeper",
        role: "background transcript refresh",
        autoReply: false,
        status: "idle",
        blocks: [{ type: "assistant_text_delta", text: SLEEPER_MARKER }],
      },
    ],
  });
  await app.post("/api/navigation", { view: "workbench" });
  await app.post("/api/qa/open", { panels: [["chatter"], ["sleeper"]] });
  await app.post("/api/settings", { composer: { sendKey: "enter", interruptOnSend: false } });
  await waitForText(SLEEPER_MARKER);

  const initialRoot = await app.post("/api/measure", {
    selector: ".wb-root",
    attributes: ["data-party-id", "data-layout-party"],
    limit: 1,
  });
  const initialParty = initialRoot.elements[0]?.attributes || {};
  let samples = 0;
  let missingHistorySamples = 0;
  let monitor = true;
  const watch = (async () => {
    while (monitor) {
      const transcript = await measure(
        '.wb-panel:has([data-drop-tab="sleeper"]) .wb-transcript',
      );
      samples += 1;
      if (!transcript.text.includes(SLEEPER_MARKER)) missingHistorySamples += 1;
      await delay(8);
    }
  })();

  let focusFailures = 0;
  let partyFailures = 0;
  try {
    for (let index = 0; index < 12; index += 1) {
      const marker = `enter-${index}`;
      await app.post("/api/qa/input", {
        selector: '.wb-panel:has([data-drop-tab="chatter"]) .wb-composer-editor',
        text: marker,
        key: "Enter",
      });
      if (index === 3) {
        await app.post("/api/party/members/sleeper/sleep", {});
      }
      const focused = await app.post("/api/qa/input", { text: `draft-${index}` });
      if (focused.kind !== "editable" || focused.draft !== `draft-${index}`) focusFailures += 1;
      const root = await app.post("/api/measure", {
        selector: ".wb-root",
        attributes: ["data-party-id", "data-layout-party"],
        limit: 1,
      });
      const attrs = root.elements[0]?.attributes || {};
      if (
        attrs["data-party-id"] !== initialParty["data-party-id"] ||
        attrs["data-layout-party"] !== initialParty["data-layout-party"]
      ) partyFailures += 1;
      await delay(35);
    }
    await delay(250);
  } finally {
    monitor = false;
    await watch;
  }

  check("background sleeping panel was sampled during Enter sends", samples >= 10, `${samples} samples`);
  check("sleeping panel never replaced history with a blank/loading frame", missingHistorySamples === 0, `${missingHistorySamples} missing`);
  check("bare Enter keeps composer focus", focusFailures === 0, `${focusFailures} failures`);
  check("bare Enter keeps the selected party and layout", partyFailures === 0, `${partyFailures} failures`);

  const listing = await app.get("/api/party");
  const sleeper = (listing.members || []).find((member) => member.name === "sleeper");
  check("the background member actually slept", sleeper?.status === "sleeping" && !sleeper.sessionId, sleeper?.status || "missing");
  const stored = await app.get("/api/party/members/sleeper/transcript");
  check("sleep preserved the durable transcript", (stored.blocks || []).some((block) => block.text === SLEEPER_MARKER));

  await app.close();
  await app.launch();
  await app.post("/api/navigation", { view: "workbench" });
  await app.post("/api/qa/open", { panels: [["chatter"], ["sleeper"]] });
  await waitForText(SLEEPER_MARKER);
  const restarted = await app.get("/api/party");
  const restartedSleeper = (restarted.members || []).find((member) => member.name === "sleeper");
  check("restart restores the same sleeping member and visible history", restartedSleeper?.status === "sleeping");
} finally {
  await app.close().catch(() => app.kill());
  await removePath(run).catch(() => {});
  if (fs.existsSync(run)) console.error(`retained E2E artifacts: ${run}`);
}

console.log(failures === 0 ? "\nChat Enter stability E2E: PASS" : `\nChat Enter stability E2E: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

async function waitForText(text) {
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    const transcript = await measureOptional(
      '.wb-panel:has([data-drop-tab="sleeper"]) .wb-transcript',
    );
    if (transcript?.text.includes(text)) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for transcript text '${text}'.`);
}

async function measure(selector) {
  const response = await fetch(`${app.baseUrl}/api/measure`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ selector, limit: 1 }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.detail || payload.error || `measure failed (${response.status})`);
  return payload.elements[0];
}

async function measureOptional(selector) {
  const response = await fetch(`${app.baseUrl}/api/measure`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ selector, limit: 1 }),
  });
  if (!response.ok) return undefined;
  const payload = await response.json();
  return payload.elements[0];
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
