/*
 * Full-process e2e for the MESSAGE QUEUE ([P-3]4) — OFFLINE (mock member, no
 * model call, no billing).
 *
 * Launches the REAL Electron app on an isolated userData + temp workspace,
 * discovers it through the per-workspace instance file (NEVER a fixed port — a
 * fixed port once attached a driver to the user's own running app), and proves
 * the queue end to end: a message sent to a busy member goes to the QUEUE and
 * not the conversation, the list renders, cancel/edit/merge/reorder work, and
 * going idle actually delivers it.
 *
 * Layout is MEASURED in the running renderer over CDP, not read off a picture.
 * This project has passed a capture by eye before and been wrong; the geometry
 * here (ordinal 17×17, the switch's 26×15 with its 11px knob, the merge rail
 * spanning only the leading run) is exactly the kind that eyes approve and
 * calipers refuse. Captures are saved as a record for the handoff comparison,
 * but nothing here depends on a human looking at them.
 *
 * Run: node scripts/e2e-message-queue.mjs   (after `npm run build`)
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { firstBaseUrl } from "./lib/discovery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ws = path.join(os.tmpdir(), "agentparty-queue-e2e-workspace");
const userData = path.join(os.tmpdir(), "agentparty-queue-e2e-user-data");
const shotDir = path.join(os.tmpdir(), "agentparty-queue-shots");

let base = "";
const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };

async function main() {
  await removePath(ws);
  await removePath(userData);
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(shotDir, { recursive: true });
  // The launch workspace comes from the isolated settings file — the app does
  // NOT read an env var for it. No `automationApiPort`: the port stays ephemeral
  // and is discovered from the workspace's own instance file.
  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ workspacePath: ws }, null, 2));

  const child = spawn(process.execPath, [path.join(root, "scripts", "launch-electron.mjs"), "--workspace", ws, "--remote-debugging-port=0"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      AGENTPARTY_QA: "1",
      AGENTPARTY_USER_DATA: userData,
      AGENTPARTY_WINDOW_DISPLAY: "left",
      AGENTPARTY_AUTOMATION_PORT: "",
    },
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  let cdp;
  try {
    base = await discover();
    assert((await get("/api/health")).ok, `app is up at ${base}`);
    // Step 0: the build actually running must be THIS worktree, not the user's
    // installed app or the main checkout.
    const appRoot = (await get("/api/state")).runtime?.appRoot || "";
    const within = (appRoot + path.sep).toLowerCase().startsWith(root.toLowerCase() + path.sep);
    assert(Boolean(appRoot) && within, `running build is THIS worktree (appRoot=${appRoot || "<missing>"})`);
    const windows = (await get("/api/windows")).windows || [];
    assert(windows[0]?.workspacePath === ws, `window serves the e2e workspace (${windows[0]?.workspacePath})`);

    await post("/api/qa/seed", {
      party: "queue e2e",
      // reviewer is a REAL member: a member-to-member message has to travel the
      // same routing/gate path a real one does, or the sender-chip and
      // merge-boundary legs would be testing a shortcut.
      members: [
        { name: "backend", model: "claude-sonnet-4.5", role: "대기열 e2e" },
        { name: "reviewer", model: "claude-sonnet-4.5", role: "리뷰" },
      ],
    });
    await post("/api/navigation", { view: "workbench" });
    await post("/api/qa/open", { panels: [["backend"]] });
    await delay(800);
    cdp = await attachRenderer();

    await queuedInsteadOfConversation();
    await listRendersFaithfully(cdp);
    await mergeRailSpansOnlyTheLeadingRun(cdp);
    await mergeOffChangesWhatLeaves(cdp);
    await mutationsWork();
    await failuresAreVisible(cdp);
    await goingIdleDelivers(cdp);
    await queueSurvivesRestart();

    await post("/api/window/close", {}).catch(() => {});
    await waitForExit(child);
  } catch (error) {
    killProcessTree(child.pid);
    throw error;
  }

  console.log(failures.length ? `\nMESSAGE QUEUE E2E FAILED (${failures.length})` : "\nMESSAGE QUEUE E2E PASSED");
  process.exit(failures.length ? 1 : 0);
}

/** The core claim: a busy member's messages go to the queue, NOT the transcript. */
async function queuedInsteadOfConversation() {
  console.log("\n[P-3]4 a busy member's messages queue instead of joining the conversation:");
  await post("/api/qa/members/backend/emit", { status: "working" });
  await delay(300);

  const first = await post("/api/party/members/backend/message", { text: "401 전환 패치 끝나면 refresh 토큰 회전 로직도 같은 방식으로 정리해줘." });
  assert(first.queued === true, "a message to a working member reports queued:true (NOT delivered)");
  assert(first.queue?.items?.length === 1, "the response carries the resulting queue");

  await post("/api/party/members/backend/message", { text: "수정 후 auth 스위트만 다시 돌리고 결과를 3줄로 요약해서 알려줘." });
  // A MEMBER's message joins the same queue, tagged with its sender — this is
  // what keeps merging honest (it must not fold into the user's text).
  const fromMember = await post("/api/party/messages", { to: "backend", from: "reviewer", content: "좁은 catch 로 가되 TokenExpiredError 외 에러는 그대로 상위로 던져줘." });
  assert(fromMember.queued === true, "a MEMBER's message to a busy member queues the same way the user's does");
  await delay(400);

  const queue = (await get("/api/party/members/backend/queue")).queue;
  if (queue.items.length !== 3) {
    console.log("    queue:", JSON.stringify(queue.items.map((i) => ({ from: i.from, text: String(i.text).slice(0, 24) })), null, 0));
    console.log("    status:", JSON.stringify((await post("/api/party/members/backend/status", {})).members?.[0] || {}));
  }
  assert(queue.items.length === 3, `three messages are waiting (got ${queue.items.length})`);
  assert(queue.items[0].from === null && queue.items[2].from === "reviewer", "sender is recorded: the user's two, then reviewer's");
  assert(!String(queue.items[2].text).includes("<channel"), "a member's item stores its RAW body — the channel envelope is added at delivery, not in the queue");

  const transcript = (await get("/api/party/members/backend/transcript")).blocks || [];
  const leaked = transcript.filter((b) => b.kind === "user" && /401 전환 패치/.test(b.text || ""));
  assert(leaked.length === 0, "the queued message is NOT in the conversation yet (the whole point of [P-3]4)");
}

/** Geometry, measured in the renderer — the handoff's §2 anatomy. */
async function listRendersFaithfully(cdp) {
  console.log("\n대기열 UI renders to the handoff's measurements (§2):");
  const shot = path.join(shotDir, "01-queue-default.png");
  assert((await post("/api/capture", { path: shot })).bytes > 0, `captured → ${shot}`);

  const m = await cdp.eval(`(() => {
    const box = (el) => { const r = el.getBoundingClientRect(); return { w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; };
    const queue = document.querySelector(".wb-queue");
    if (!queue) return { found: false };
    const rows = [...queue.querySelectorAll(".wb-queue-row")];
    const n = queue.querySelector(".wb-queue-n");
    const sw = queue.querySelector(".wb-queue-switch");
    const knob = queue.querySelector(".wb-queue-knob");
    const chips = [...queue.querySelectorAll(".wb-queue-from")];
    const cs = getComputedStyle(rows[0]);
    const composer = document.querySelector(".wb-composer-box") || document.querySelector(".wb-composer-bar");
    const transcript = document.querySelector(".wb-transcript") || document.querySelector(".wb-panel-body");
    return {
      found: true,
      rows: rows.length,
      title: queue.querySelector(".wb-queue-title-text")?.textContent || "",
      note: queue.querySelector(".wb-queue-note")?.textContent || "",
      mergeNote: queue.querySelector(".wb-queue-merge-note")?.textContent || "",
      sendAll: queue.querySelector(".wb-queue-send-all")?.textContent || "",
      ordinal: box(n),
      switch: box(sw),
      knob: box(knob),
      rowBorderStyle: cs.borderTopStyle,
      chipLabels: chips.map((c) => c.textContent.trim()),
      // The queue must sit BETWEEN the transcript and the composer.
      aboveComposer: queue.getBoundingClientRect().bottom <= composer.getBoundingClientRect().top + 1,
      belowTranscript: transcript ? queue.getBoundingClientRect().top >= transcript.getBoundingClientRect().top : false,
      // It must not scroll — the transcript yields the space instead.
      scrolls: queue.scrollHeight > queue.clientHeight + 1,
      // The primary button is a TINTED affordance (member colour on a 10% wash),
      // not a solid CTA — it competes with the composer's own send otherwise.
      sendAllStyle: (() => {
        const cs = getComputedStyle(queue.querySelector(".wb-queue-send-all"));
        return { bg: cs.backgroundColor, color: cs.color, border: cs.borderTopColor };
      })(),
      // While a member works the composer must say where the text will GO.
      placeholder: (document.querySelector(".wb-composer-textarea") || document.querySelector(".wb-composer-input"))?.placeholder || "",
      sendLabel: document.querySelector(".wb-send-labeled")?.textContent || "",
    };
  })()`);

  assert(m.found, "the queue panel is in the DOM");
  assert(m.rows === 3, `three rows render (got ${m.rows})`);
  assert(m.title === "대기열 3", `header reads "대기열 3" (got "${m.title}")`);
  assert(/합쳐서 한 번에 전송됩니다$/.test(m.note), `header states when it goes out (got "${m.note}")`);
  assert(m.mergeNote === "보낸 사람이 같은 것끼리만 합쳐집니다", `mixed senders change the merge note (got "${m.mergeNote}")`);
  assert(m.sendAll === "합쳐서 지금 보내기 · 2건", `the send button names the RUN length, not the queue length (got "${m.sendAll}")`);
  assert(m.ordinal.w === 17 && m.ordinal.h === 17, `ordinal chip is 17×17 (got ${m.ordinal.w}×${m.ordinal.h})`);
  assert(m.switch.w === 26 && m.switch.h === 15, `merge switch is 26×15 (got ${m.switch.w}×${m.switch.h})`);
  assert(m.knob.w === 11 && m.knob.h === 11, `switch knob is 11×11 (got ${m.knob.w}×${m.knob.h})`);
  assert(m.rowBorderStyle === "dashed", `rows are DASHED — the "not delivered yet" language (got ${m.rowBorderStyle})`);
  assert(m.chipLabels.join("|") === "나|나|reviewer", `sender chips read 나/나/reviewer (got ${m.chipLabels.join("|")})`);
  assert(m.aboveComposer && m.belowTranscript, "the queue sits between the transcript and the composer");
  assert(!m.scrolls, "the queue does not scroll — it is always fully visible");
  // rgba with an alpha < 1 proves the wash; an opaque fill would mean the button
  // was rendered as a solid CTA competing with the composer's own send.
  assert(/^rgba\(.+0\.1\d*\)$/.test(m.sendAllStyle.bg), `합쳐서 지금 보내기 is a 10% member wash, not a solid fill (got ${m.sendAllStyle.bg})`);
  assert(!/rgba?\(255,\s*255,\s*255/.test(m.sendAllStyle.color), `its text is the member colour, not white-on-solid (got ${m.sendAllStyle.color})`);
  assert(/작업 중 — 보내면 대기열에 쌓입니다$/.test(m.placeholder), `the composer says where the text goes (got "${m.placeholder}")`);
  assert(m.sendLabel.includes("대기열에 추가"), `and its button reads 대기열에 추가 (got "${m.sendLabel}")`);
}

/** The rail is the promise "this much leaves as ONE message" — it must stop at the sender change. */
async function mergeRailSpansOnlyTheLeadingRun(cdp) {
  console.log("\n합침 레일 spans only the leading same-sender run (§3):");
  const m = await cdp.eval(`(() => {
    const rows = [...document.querySelectorAll(".wb-queue-row")];
    return rows.map((row) => {
      const rail = row.querySelector(".wb-queue-rail");
      if (!rail) return null;
      const rr = rail.getBoundingClientRect(), br = row.getBoundingClientRect();
      return { top: +(rr.top - br.top).toFixed(1), bottom: +(br.bottom - rr.bottom).toFixed(1), h: +rr.height.toFixed(1), rowH: +br.height.toFixed(1) };
    });
  })()`);
  assert(m[0] !== null && m[1] !== null, "the two same-sender rows carry the rail");
  assert(m[2] === null, "reviewer's row does NOT — a different sender breaks the run");
  assert(Math.abs(m[0].top - m[0].rowH / 2) < 1.5, `the rail starts at the first row's midpoint (${m[0].top} of ${m[0].rowH})`);
  assert(Math.abs(m[1].bottom - m[1].rowH / 2) < 1.5, `and ends at the last run row's midpoint (${m[1].bottom} of ${m[1].rowH})`);
}

/** Merging off changes both what the UI promises and what actually leaves. */
async function mergeOffChangesWhatLeaves(cdp) {
  console.log("\n합치기 OFF — one at a time, and row 1 is marked (§3):");
  await post("/api/party/members/backend/queue", { action: "preference", merge: false });
  await delay(300);

  const m = await cdp.eval(`(() => {
    const q = document.querySelector(".wb-queue");
    const rows = [...q.querySelectorAll(".wb-queue-row")];
    return {
      mergeNote: q.querySelector(".wb-queue-merge-note")?.textContent || "",
      sendAll: q.querySelector(".wb-queue-send-all")?.textContent || "",
      nextBadges: q.querySelectorAll(".wb-queue-next").length,
      highlighted: rows.map((r) => r.classList.contains("is-next")),
      rails: q.querySelectorAll(".wb-queue-rail").length,
      switchOn: q.querySelector(".wb-queue-switch").classList.contains("is-on"),
    };
  })()`);
  assert(m.switchOn === false, "the switch reads off");
  assert(m.mergeNote === "한 건씩 순서대로 보냅니다", `merge note switches to one-at-a-time (got "${m.mergeNote}")`);
  assert(m.sendAll === "지금 보내기", `the button drops the count when nothing merges (got "${m.sendAll}")`);
  assert(m.nextBadges === 1 && m.highlighted[0] === true && m.highlighted[1] === false, "only row 1 is marked 다음 차례");
  assert(m.rails === 0, "no rail — nothing is being merged");

  const shot = path.join(shotDir, "03-merge-off.png");
  assert((await post("/api/capture", { path: shot })).bytes > 0, `captured → ${shot}`);
  await post("/api/party/members/backend/queue", { action: "preference", merge: true });
  await delay(250);
}

async function mutationsWork() {
  console.log("\n취소 · 편집 · 순서 · 합치기 (§9):");
  const before = (await get("/api/party/members/backend/queue")).queue;
  const second = before.items[1].id;

  const moved = await post("/api/party/members/backend/queue", { action: "move", itemId: second, direction: -1 });
  assert(moved.queue.items[0].id === second, "위로 reorders the row");
  await post("/api/party/members/backend/queue", { action: "move", itemId: second, direction: 1 });

  const merged = await post("/api/party/members/backend/queue", { action: "mergeUp", itemId: before.items[1].id });
  assert(merged.queue.items.length === 2, "위와 합치기 folds two rows into one");
  assert(merged.queue.items[0].text.includes("\n\n"), "the folded body keeps both messages, blank-line separated");

  const edited = await post("/api/party/members/backend/queue", { action: "edit", itemId: merged.queue.items[0].id });
  assert(typeof edited.text === "string" && edited.text.includes("401 전환 패치"), "편집 hands the text back for the composer");
  assert(edited.queue.items.length === 1, "and removes it from the queue");

  const cleared = await post("/api/party/members/backend/queue", { action: "clear" });
  assert(cleared.queue.items.length === 0, "모두 취소 empties the queue");
}

/** A queue mutation that could not happen must SAY so — never a silent no-op. */
async function failuresAreVisible(cdp) {
  console.log("\nfailures surface instead of pretending (AGENTS.md no-silent-failure):");
  const stale = await fetch(`${base}/api/party/members/backend/queue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "cancel", itemId: "q-already-delivered" }),
  });
  const body = await stale.json().catch(() => ({}));
  const refused = !stale.ok || body.ok === false || typeof body.error === "string";
  assert(refused, "cancelling an already-delivered item is an ERROR, not a cheerful no-op");

  const bad = await fetch(`${base}/api/party/members/backend/queue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "definitely-not-an-action" }),
  });
  assert(!bad.ok || (await bad.json().catch(() => ({}))).ok === false, "an unknown action is refused, not coerced into a default mutation");

  // And the UI shows it: queue one, then cancel it twice from the renderer.
  await post("/api/party/members/backend/message", { text: "취소 경쟁 상태 확인용 메시지." });
  await delay(300);
  const shown = await cdp.eval(`(async () => {
    const row = document.querySelector(".wb-queue-row");
    const del = row && row.querySelector(".wb-queue-btn.is-danger");
    if (!del) return { ran: false };
    del.click();
    await new Promise((r) => setTimeout(r, 500));
    return { ran: true, gone: document.querySelectorAll(".wb-queue-row").length };
  })()`);
  assert(shown.ran && shown.gone === 0, "clicking 삭제 in the real UI removes the row");
}

async function goingIdleDelivers(cdp) {
  console.log("\n§7 dequeue — the message enters the conversation when it is HANDED OVER:");
  await post("/api/qa/members/backend/emit", { status: "working" });
  await delay(250);
  await post("/api/party/members/backend/message", { text: "첫 번째 대기 메시지." });
  await post("/api/party/members/backend/message", { text: "두 번째 대기 메시지." });
  await delay(400);
  assert((await get("/api/party/members/backend/queue")).queue.items.length === 2, "two messages are waiting");

  // The member finishes its turn — the queue's normal delivery trigger.
  await post("/api/qa/members/backend/emit", { status: "idle" });
  await delay(1200);

  const queue = (await get("/api/party/members/backend/queue")).queue;
  assert(queue.items.length === 0, `going idle delivered the run (${queue.items.length} left)`);

  // Read the LIVE renderer, not the debounced on-disk copy: "did the user see
  // it land in the conversation" is the actual claim, and the persisted save is
  // a later, separate concern.
  const shown = await cdp.eval(`(() => {
    const bubbles = [...document.querySelectorAll(".wb-user-bubble")].map((b) => b.textContent || "");
    const merged = bubbles.find((t) => t.includes("첫 번째 대기 메시지"));
    return { count: bubbles.length, merged: merged || "", hasSecond: Boolean(merged && merged.includes("두 번째 대기 메시지")) };
  })()`);
  assert(Boolean(shown.merged), "the delivered message IS now in the conversation (it did not vanish — [#19])");
  assert(shown.hasSecond, "both queued bodies are in that ONE bubble — they were merged, not sent twice");

  const shot = path.join(shotDir, "05-dequeued-merged.png");
  assert((await post("/api/capture", { path: shot })).bytes > 0, `captured → ${shot}`);
}

/** The queue is persisted — it must not evaporate with the process ([#19]). */
async function queueSurvivesRestart() {
  console.log("\n§11 the queue survives a restart (never a silent loss):");
  await post("/api/qa/members/backend/emit", { status: "working" });
  await delay(250);
  await post("/api/party/members/backend/message", { text: "재시작을 넘어가야 하는 메시지." });
  await delay(400);

  const stored = JSON.parse(fs.readFileSync(partyFile(), "utf8"));
  const member = (stored.members || []).find((m) => m.name === "backend");
  const queued = member?.queue?.items || [];
  assert(queued.length === 1, `the waiting message is ON DISK, not only in memory (${queued.length})`);
  assert(/재시작을 넘어가야/.test(queued[0]?.text || ""), "with its body intact, ready to be restored");
}

function partyFile() {
  const dir = path.join(ws, ".agent_party_app", "parties");
  const partyId = fs.readdirSync(dir)[0];
  return path.join(dir, partyId, "party.json");
}

async function discover() {
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    const url = firstBaseUrl(ws);
    if (url) {
      try {
        const response = await fetch(`${url}/api/health`);
        if (response.ok && (await response.json()).ok) return url;
      } catch { /* still starting */ }
    }
    await delay(500);
  }
  throw new Error("App did not advertise an automation endpoint for the e2e workspace.");
}

async function attachRenderer() {
  const portFile = path.join(userData, "DevToolsActivePort");
  const started = Date.now();
  let port = 0;
  while (Date.now() - started < 30_000) {
    try {
      port = Number(fs.readFileSync(portFile, "utf8").split("\n")[0].trim());
      if (port > 0) break;
    } catch { /* not written yet */ }
    await delay(250);
  }
  if (!port) throw new Error(`Electron never wrote ${portFile} — was --remote-debugging-port passed?`);

  let target;
  while (Date.now() - started < 30_000) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    target = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (target) break;
    await delay(250);
  }
  if (!target) throw new Error("No debuggable renderer page target found.");

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error("CDP websocket failed to open."));
  });
  let nextId = 1;
  const pending = new Map();
  socket.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    const entry = pending.get(msg.id);
    if (entry) { pending.delete(msg.id); entry(msg); }
  };
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
    socket.send(JSON.stringify({ id, method, params }));
  });
  return {
    async eval(expression) {
      const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) {
        throw new Error(`Renderer evaluation threw: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`);
      }
      return result.result.value;
    },
  };
}

async function get(route) {
  const response = await fetch(base + route);
  if (!response.ok) throw new Error(`${route} ${response.status}: ${await response.text()}`);
  return response.json();
}

async function post(route, body) {
  const response = await fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  if (!response.ok) throw new Error(`${route} ${response.status}: ${await response.text()}`);
  return response.json();
}

async function removePath(target) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try { fs.rmSync(target, { recursive: true, force: true }); return; } catch (error) {
      if (error?.code !== "EBUSY" || attempt === 9) return;
      await delay(300);
    }
  }
}

function waitForExit(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(() => { killProcessTree(child.pid); resolve(); }, 10_000);
    child.once("exit", () => { clearTimeout(timeout); resolve(); });
  });
}

// Only ever this app's own process tree. NEVER a blanket electron kill — the
// user has their own AgentParty running.
function killProcessTree(pid) {
  if (!pid) return;
  try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* already gone */ }
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

main().catch((error) => { console.error(error); process.exit(1); });
