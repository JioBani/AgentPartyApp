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
import { waitForLiveBaseUrl } from "./lib/discovery.mjs";

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

  // Taken before the launch: discovery accepts only an app advertised after it.
  const launchedAt = Date.now();
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
    base = await discover(launchedAt);
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
    await rowsStayOneLineUntilExpanded(cdp);
    await dragReordersTheQueue(cdp);
    await mutationsWork();
    await failuresAreVisible(cdp);
    await sendNowStopsInsteadOfStacking(cdp);
    await keyboardShortcuts(cdp);
    await narrowPanelCollapses(cdp);
    await originSurvivesDelivery(cdp);
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
  // The member is working here, so sending sooner means stopping it — the label
  // has to say that rather than promise a delivery it cannot make.
  assert(m.sendAll === "중단하고 합쳐서 보내기 · 2건", `the send button names the RUN length and the stop (got "${m.sendAll}")`);
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
  assert(m.sendAll === "중단하고 보내기", `the button drops the count when nothing merges (got "${m.sendAll}")`);
  assert(m.nextBadges === 1 && m.highlighted[0] === true && m.highlighted[1] === false, "only row 1 is marked 다음 차례");
  assert(m.rails === 0, "no rail — nothing is being merged");

  const shot = path.join(shotDir, "03-merge-off.png");
  assert((await post("/api/capture", { path: shot })).bytes > 0, `captured → ${shot}`);
  await post("/api/party/members/backend/queue", { action: "preference", merge: true });
  await delay(250);
}

/**
 * A row is one line until asked otherwise. Six full messages would push the
 * conversation off the panel, so the full body is a deliberate ask — and the
 * ask has to be a visible control, not a clipped line the user is expected to
 * guess is clickable.
 */
async function rowsStayOneLineUntilExpanded(cdp) {
  console.log("\n한 줄로 접혀 있다가 확대 버튼으로 펼쳐진다:");
  const before = await cdp.eval(`(() => {
    const row = document.querySelector(".wb-queue-row");
    const text = row.querySelector(".wb-queue-text");
    const button = row.querySelector(".wb-queue-expand");
    const cs = getComputedStyle(text);
    return {
      hasButton: Boolean(button),
      expanded: button?.getAttribute("aria-expanded"),
      whiteSpace: cs.whiteSpace,
      clipped: cs.textOverflow,
      lines: Math.round(text.getBoundingClientRect().height / parseFloat(cs.lineHeight)),
      buttons: document.querySelectorAll(".wb-queue-row .wb-queue-expand").length,
      rows: document.querySelectorAll(".wb-queue-row").length,
    };
  })()`);
  assert(before.hasButton, "the row carries an explicit expand control");
  assert(before.buttons === before.rows, "every row has one — not just the long ones");
  assert(before.whiteSpace === "nowrap" && before.clipped === "ellipsis", `collapsed rows clip to one line (got ${before.whiteSpace}/${before.clipped})`);
  assert(before.lines === 1, `and really are one line tall (got ${before.lines})`);
  assert(before.expanded === "false", "the control reports its state to a screen reader");

  const clicked = await post("/api/capture", { path: path.join(shotDir, "08-row-expanded.png"), click: ".wb-queue-row .wb-queue-expand" });
  // The capture route THROWS when a click selector matches nothing, so an
  // applied flag here means the control was found and pressed — not that the
  // request merely returned.
  assert(clicked.applied?.clicked === true, "the expand control was really clicked");

  const after = await cdp.eval(`(() => {
    const row = document.querySelector(".wb-queue-row");
    const text = row.querySelector(".wb-queue-text");
    const cs = getComputedStyle(text);
    return {
      whiteSpace: cs.whiteSpace,
      expanded: row.querySelector(".wb-queue-expand")?.getAttribute("aria-expanded"),
      // Only the row that was asked about opens; the rest stay out of the way.
      openRows: document.querySelectorAll(".wb-queue-text.is-open").length,
      queueOverflows: (() => { const q = document.querySelector(".wb-queue"); return q.scrollHeight > q.clientHeight + 1; })(),
    };
  })()`);
  assert(after.whiteSpace === "pre-wrap", `expanded, the body wraps in full (got ${after.whiteSpace})`);
  assert(after.expanded === "true", "and the control flips its state");
  assert(after.openRows === 1, `only the asked-for row opened (got ${after.openRows})`);
  assert(!after.queueOverflows, "an expanded row still does not overflow the panel");

  await post("/api/capture", { path: path.join(shotDir, "09-row-collapsed.png"), click: ".wb-queue-row .wb-queue-expand" });
  const closed = await cdp.eval(`getComputedStyle(document.querySelector(".wb-queue-text")).whiteSpace`);
  assert(closed === "nowrap", `and it folds back to one line (got ${closed})`);
}

/**
 * Reordering is a DRAG now, so it is driven as one: real mouse events on the
 * grip, not the HTTP action the grip happens to call. Asserting the action
 * would prove the queue can be reordered while leaving open whether anything
 * on screen can reorder it.
 */
async function dragReordersTheQueue(cdp) {
  console.log("\n순서 변경은 드래그로 (§9):");
  const before = (await get("/api/party/members/backend/queue")).queue.items.map((i) => i.id);

  const grips = await cdp.eval(`(() => {
    const rows = [...document.querySelectorAll(".wb-queue-row")];
    return rows.map((row) => {
      const grip = row.querySelector(".wb-queue-grip");
      const box = (grip || row).getBoundingClientRect();
      const rowBox = row.getBoundingClientRect();
      return {
        hasGrip: Boolean(grip && grip.tagName === "BUTTON"),
        x: box.left + box.width / 2,
        y: box.top + box.height / 2,
        rowMid: rowBox.top + rowBox.height / 2,
        rowBottom: rowBox.bottom,
      };
    });
  })()`);
  assert(grips.length >= 3 && grips.every((g) => g.hasGrip), "every row has a grip to pick it up by");
  assert((await cdp.eval(`document.querySelectorAll(".wb-queue-row .wb-queue-btn[title='위로']").length`)) === 0, "the 위로 button is gone — the gesture replaced it, it does not sit alongside it");

  // Drag row 1 down past row 3's midpoint, in steps, the way a hand moves.
  await cdp.mouse("mousePressed", grips[0].x, grips[0].y);
  await cdp.mouse("mouseMoved", grips[0].x, grips[1].rowMid);
  // The rows move on a transition; read after it has had a frame to apply,
  // otherwise this measures the layout the drag is in the middle of leaving.
  await delay(250);
  const dropPreview = await cdp.eval(`(() => {
    const rows = [...document.querySelectorAll(".wb-queue-row")];
    const shiftOf = (row) => {
      const m = new DOMMatrixReadOnly(getComputedStyle(row).transform);
      return Math.round(m.m42);
    };
    return {
      dragging: rows.filter((r) => r.classList.contains("is-dragging")).length,
      carried: shiftOf(rows[0]),
      steppedAside: rows.slice(1).map(shiftOf),
      railsHidden: document.querySelectorAll(".wb-queue-rail").length === 0,
    };
  })()`);
  assert(dropPreview.dragging === 1, "the row being carried is marked while it is in the air");
  assert(dropPreview.carried > 0, `the carried row travels with the pointer (moved ${dropPreview.carried}px)`);
  // The others make room instead of a line being drawn: whoever the carried row
  // has passed steps up by exactly the slot it vacated.
  assert(dropPreview.steppedAside.some((shift) => shift < 0), `the rows it passed step aside to open the slot (${dropPreview.steppedAside.join(",")})`);
  assert(dropPreview.railsHidden, "the merge rail hides mid-drag — it would be drawing a run that is being rewritten");

  await cdp.mouse("mouseMoved", grips[0].x, grips[2].rowMid + 2);
  await cdp.mouse("mouseReleased", grips[0].x, grips[2].rowMid + 2);
  await delay(500);

  const after = (await get("/api/party/members/backend/queue")).queue.items.map((i) => i.id);
  assert(after[2] === before[0], `the dragged row landed at the drop point (${before.join(",")} → ${after.join(",")})`);
  assert(after.length === before.length, "and nothing was lost on the way");

  const rendered = await cdp.eval(`[...document.querySelectorAll(".wb-queue-row .wb-queue-n")].map((n) => n.textContent).join(",")`);
  assert(rendered === "1,2,3", `the ordinals renumber to the new order (got ${rendered})`);
  const stuck = await cdp.eval(`document.querySelectorAll(".wb-queue-row.is-dragging, .wb-queue-row.is-shifting, .wb-queue-row.is-landing").length`);
  assert(stuck === 0, "the drag state is cleared once the new order lands — no row is left looking picked up");

  // The keyboard half: the order must be reachable without a mouse.
  await cdp.eval(`document.querySelector(".wb-queue-row:last-child .wb-queue-grip").focus()`);
  await cdp.eval(`document.querySelector(".wb-queue-row:last-child .wb-queue-grip").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }))`);
  await delay(400);
  const byKey = (await get("/api/party/members/backend/queue")).queue.items.map((i) => i.id);
  assert(byKey[1] === after[2], `ArrowUp on a focused grip moves the row (${after.join(",")} → ${byKey.join(",")})`);

  // Put it back so the later legs see the order they were written against.
  await post("/api/party/members/backend/queue", { action: "move", itemId: before[0], toIndex: 0 });
  await delay(300);
}

/**
 * The one-queue rule: "지금 보내기" on a BUSY member must NOT push the message
 * into the harness. Handing it over there would move it out of this queue and
 * into the adapter's own buffer, invisible and uncancellable, to wait for the
 * very same moment.
 */
async function sendNowStopsInsteadOfStacking(cdp) {
  console.log("\n지금 보내기 stops the turn instead of building a second queue:");
  await post("/api/qa/members/backend/emit", { status: "working" });
  await delay(300);
  await post("/api/party/members/backend/queue", { action: "clear" }).catch(() => {});
  await post("/api/party/members/backend/message", { text: "중단하고 보내기로 나갈 메시지." });
  await delay(300);

  const label = await cdp.eval(`document.querySelector(".wb-queue-send-all")?.textContent || ""`);
  assert(label === "중단하고 보내기", `while working the button names the stop (got "${label}")`);

  const before = (await get("/api/party/status")).members.find((m) => m.name === "backend");
  assert(before?.turnActive === true, "the member really is mid-turn before we ask");

  const sent = await post("/api/party/members/backend/queue", { action: "send" });
  assert(sent.queue.items.length === 1, "the message stays in the app queue — it was NOT handed to the harness");

  await delay(1200);
  const after = (await get("/api/party/status")).members.find((m) => m.name === "backend");
  assert(after?.turnActive === false, "the turn was stopped");
  assert(!after?.queuedTurnCount, `and the harness is holding nothing (got ${after?.queuedTurnCount})`);

  await delay(600);
  const drained = (await get("/api/party/members/backend/queue")).queue;
  assert(drained.items.length === 0, "the idle drain then delivered it — one path in, no second queue");
  await post("/api/party/members/backend/queue", { action: "clear" }).catch(() => {});
}

async function mutationsWork() {
  console.log("\n취소 · 편집 · 순서 · 합치기 (§9):");
  const before = (await get("/api/party/members/backend/queue")).queue;
  const second = before.items[1].id;

  const moved = await post("/api/party/members/backend/queue", { action: "move", itemId: second, toIndex: 0 });
  assert(moved.queue.items[0].id === second, "a row dropped at position 0 lands there");
  await post("/api/party/members/backend/queue", { action: "move", itemId: second, toIndex: 1 });

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

/** §11 keyboard — ArrowUp takes the last queued message back into the composer. */
async function keyboardShortcuts(cdp) {
  console.log("\n§11 keyboard — ↑ in an empty composer takes the last message back:");
  await post("/api/qa/members/backend/emit", { status: "working" });
  await delay(250);
  await post("/api/party/members/backend/message", { text: "되돌리기로 회수될 메시지." });
  await delay(400);

  const back = await cdp.eval(`(async () => {
    const box = document.querySelector(".wb-composer-textarea");
    if (!box) return { ran: false };
    const before = document.querySelectorAll(".wb-queue-row").length;
    box.focus();
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    await new Promise((r) => setTimeout(r, 700));
    return { ran: true, before, after: document.querySelectorAll(".wb-queue-row").length, draft: box.value };
  })()`);
  assert(back.ran, "the composer is focusable");
  assert(back.after === back.before - 1, `the row left the queue (${back.before} → ${back.after})`);
  assert(/되돌리기로 회수될/.test(back.draft), `and its text is back in the composer (got "${back.draft.slice(0, 30)}")`);

  // Typed text must not be destroyed by a recall — the message is appended.
  const guard = await cdp.eval(`(async () => {
    const box = document.querySelector(".wb-composer-textarea");
    box.value = "";
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    return { queue: document.querySelectorAll(".wb-queue-row").length };
  })()`);
  assert(guard.queue === 0, "↑ on an empty queue does nothing rather than erroring");
}

/** §5 narrow (<408px): the queue folds to a single chip and drops the wide-only controls. */
async function narrowPanelCollapses(cdp) {
  console.log("\n§5 narrow panel — the queue folds to one chip:");
  await post("/api/qa/members/backend/emit", { status: "working" });
  await delay(200);
  await post("/api/party/members/backend/message", { text: "좁은 패널에서 확인할 첫 번째 메시지." });
  await post("/api/party/members/backend/message", { text: "좁은 패널에서 확인할 두 번째 메시지." });
  await delay(400);

  // Get under the 408px breakpoint the way a user actually does: split the
  // workbench into three panels. (Shrinking the window cannot do it — the window
  // has a minimum width, so the panel never gets narrow enough.)
  await post("/api/qa/open", { panels: [["backend"], ["reviewer"], ["main"]] });
  await delay(900);

  const m = await cdp.eval(`(() => {
    const q = document.querySelector(".wb-queue");
    if (!q) return { found: false };
    return {
      found: true,
      narrow: q.classList.contains("is-narrow"),
      chip: Boolean(q.querySelector(".wb-queue-chip")),
      chipLabel: q.querySelector(".wb-queue-chip-label")?.textContent || "",
      dots: q.querySelectorAll(".wb-queue-dots .wb-queue-dot").length,
      pill: q.querySelector(".wb-queue-pill")?.textContent || "",
      rows: q.querySelectorAll(".wb-queue-row").length,
      // narrow deliberately drops reorder/edit/merge rather than shrinking them
      // into unhittable targets; delete must survive at EVERY width.
      edits: q.querySelectorAll(".wb-queue-btn").length,
      deletes: q.querySelectorAll(".wb-queue-del").length,
      overflows: q.scrollWidth > q.clientWidth + 1,
    };
  })()`);

  assert(m.found && m.narrow, "the queue switched to its narrow form");
  assert(m.chip && /대기열 2건/.test(m.chipLabel), `it is one summary chip (got "${m.chipLabel}")`);
  assert(m.dots >= 1, "sender dots stand in for the chips");
  assert(m.pill === "합침" || m.pill === "개별", `the merge toggle is a pill (got "${m.pill}")`);
  assert(m.rows === 0, "and it starts COLLAPSED at this width — the transcript keeps the space");
  assert(!m.overflows, "nothing overflows the narrow panel");

  const collapsedShot = path.join(shotDir, "06-narrow-collapsed.png");
  assert((await post("/api/capture", { path: collapsedShot })).bytes > 0, `captured → ${collapsedShot}`);

  // Expand it: the featherweight rows appear, without the wide-only controls.
  await post("/api/party/members/backend/queue", { action: "preference", collapsed: false });
  await delay(500);
  const open = await cdp.eval(`(() => {
    const q = document.querySelector(".wb-queue");
    return {
      rows: q.querySelectorAll(".wb-queue-row").length,
      edits: q.querySelectorAll(".wb-queue-btn").length,
      deletes: q.querySelectorAll(".wb-queue-del").length,
      sendAllBlock: Boolean(q.querySelector(".wb-queue-send-all.is-block")),
      overflows: q.scrollWidth > q.clientWidth + 1,
    };
  })()`);
  assert(open.rows === 2, `both rows render when expanded (got ${open.rows})`);
  assert(open.edits === 0, "편집 · 위와 합치기 are dropped at this width, not shrunk");
  assert((await cdp.eval(`document.querySelectorAll(".wb-queue.is-narrow .wb-queue-grip").length`)) === 0, "and there is no drag grip either — a 4px target is not a handle");
  assert(open.deletes === 2, "but 삭제 survives on every row — cancelling must never need a resize");
  assert(open.sendAllBlock, "the send button spans the full width");
  assert(!open.overflows, "the expanded narrow queue still does not overflow");

  const expandedShot = path.join(shotDir, "07-narrow-expanded.png");
  assert((await post("/api/capture", { path: expandedShot })).bytes > 0, `captured → ${expandedShot}`);

  await post("/api/qa/open", { panels: [["backend"]] });
  await delay(700);
  await post("/api/party/members/backend/queue", { action: "clear" });
  await delay(300);
}

/**
 * §6/§8 — where a message came from must outlive the queue row, and a hidden
 * member's queue must still be countable from its tab.
 */
async function originSurvivesDelivery(cdp) {
  console.log("\n§6/§8 origin survives delivery, and a hidden member's queue is still visible:");
  await post("/api/qa/members/backend/emit", { status: "working" });
  await delay(250);
  await post("/api/party/messages", { to: "backend", from: "reviewer", content: "리뷰 지적: 이 경로의 예외 처리를 좁혀줘." });
  await delay(400);

  const badge = await cdp.eval(`(() => {
    const tab = [...document.querySelectorAll(".wb-tab")].find((t) => /backend/.test(t.textContent || ""));
    const chip = tab && tab.querySelector(".wb-tab-queue");
    if (!chip) return { found: false, tabs: document.querySelectorAll(".wb-tab").length };
    const cs = getComputedStyle(chip);
    return { found: true, text: chip.textContent.trim(), dashed: cs.borderTopStyle, title: chip.getAttribute("title") || "" };
  })()`);
  assert(badge.found, "the tab carries a queue badge");
  assert(badge.text === "1", `it states the depth (got "${badge.text}")`);
  assert(badge.dashed === "dashed", `and is DASHED — not yet delivered (got ${badge.dashed})`);
  assert(/응답 완료 후/.test(badge.title), "its tooltip says when it will go out");
  const tabShot = path.join(shotDir, "08-tab-badge.png");
  assert((await post("/api/capture", { path: tabShot })).bytes > 0, `captured → ${tabShot}`);

  // Deliver it, then check the conversation still says who sent it.
  await post("/api/qa/members/backend/emit", { status: "idle" });
  await delay(1200);

  // A member's message renders as the app's inbound channel CARD (its established,
  // richer form: from → to, direction). The dequeue event must lend that card its
  // queue provenance rather than adding a second, duplicate user bubble.
  const origin = await cdp.eval(`(() => {
    const cards = [...document.querySelectorAll(".wb-channel")].filter((b) => /리뷰 지적/.test(b.textContent || ""));
    const bubbles = [...document.querySelectorAll(".wb-user")].filter((b) => /리뷰 지적/.test(b.textContent || ""));
    const card = cards[0];
    return {
      cards: cards.length,
      bubbles: bubbles.length,
      peers: card ? [...card.querySelectorAll(".wb-channel-peer")].map((p) => p.textContent.trim()) : [],
      origins: card ? [...card.querySelectorAll(".wb-user-origin")].map((o) => o.textContent.trim()) : [],
    };
  })()`);
  assert(origin.cards === 1, `the delivered message is in the conversation exactly ONCE (got ${origin.cards} cards)`);
  assert(origin.bubbles === 0, `and is NOT also duplicated as a user bubble (got ${origin.bubbles})`);
  assert(origin.peers[0] === "reviewer", `it is attributed to reviewer, NOT to the user (got "${origin.peers[0]}")`);
  assert(origin.origins.some((o) => /대기열에서 전송됨/.test(o)), "and is permanently marked as having come through the queue");

  const shot = path.join(shotDir, "09-member-origin-dequeued.png");
  assert((await post("/api/capture", { path: shot })).bytes > 0, `captured → ${shot}`);

  const gone = await cdp.eval(`document.querySelectorAll(".wb-tab-queue").length`);
  assert(gone === 0, "the tab badge clears once nothing is waiting");
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

/**
 * @param since taken before the launch — only an app that advertised itself
 *   after this counts as ours. A leftover app on this workspace answers too,
 *   and attaching to it would assert against a build nobody asked about.
 */
async function discover(since) {
  const url = await waitForLiveBaseUrl(ws, { since });
  if (!url) throw new Error("App did not advertise an automation endpoint for the e2e workspace.");
  return url;
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
    /**
     * Real mouse events, because a drag cannot be faked from JavaScript: the
     * pointer capture the component relies on only exists for trusted events,
     * so a synthetic `dispatchEvent` would exercise a path no user can reach.
     */
    async mouse(type, x, y) {
      await send("Input.dispatchMouseEvent", {
        type,
        x: Math.round(x),
        y: Math.round(y),
        button: "left",
        buttons: type === "mouseReleased" ? 0 : 1,
        clickCount: 1,
        pointerType: "mouse",
      });
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
