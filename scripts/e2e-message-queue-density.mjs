/* Real-app geometry and interaction QA for the wide message queue card. */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseline = process.env.AGENTPARTY_QUEUE_DENSITY_BASELINE === "1";
const workspace = path.join(os.tmpdir(), "agentparty-queue-density-ws");
const userData = path.join(os.tmpdir(), "agentparty-queue-density-ud");
const evidenceDir = path.join(root, ".tmp", "message-queue-density", baseline ? "before" : "after");
const evidenceFile = path.join(evidenceDir, "measurements.json");
const port = Number(process.env.AGENTPARTY_QUEUE_DENSITY_PORT || 48977);
const baseUrl = `http://127.0.0.1:${port}`;
const failures = [];
const measurements = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (condition, message) => {
  console.log(`  ${condition ? "PASS" : "FAIL"} ${message}`);
  if (!condition) failures.push(message);
};

async function request(method, route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload;
  try { payload = await response.json(); } catch { payload = {}; }
  return { status: response.status, payload };
}

async function waitForApi() {
  for (let i = 0; i < 120; i += 1) {
    try { if ((await request("GET", "/api/health")).payload?.ok) return; } catch {}
    await delay(500);
  }
  throw new Error("Automation API did not start");
}

async function measure(selector, extra = {}) {
  const response = await request("POST", "/api/measure", { selector, limit: 100, ...extra });
  if (response.status !== 200) throw new Error(`measure ${selector}: ${response.payload?.error || response.status}`);
  return response.payload;
}

async function queue() {
  return (await request("GET", "/api/party/members/backend/queue")).payload.queue;
}

async function visibleGuideOffers() {
  const result = await measure("[data-guide-offer], body", { attributes: ["data-guide-offer"] });
  return result.elements.filter((item) => item.attributes?.["data-guide-offer"] !== null && item.box.width > 0 && item.box.height > 0);
}

async function dismissGuideOffer() {
  const before = await visibleGuideOffers();
  if (before.length) {
    const clicked = await request("POST", "/api/capture", { click: "[data-guide-offer] .ghost-btn" });
    assert(clicked.payload?.clicked === true, "guide offer dismiss control was clicked");
    await delay(150);
  }
  assert((await visibleGuideOffers()).length === 0, "guide/intentional overlay is absent before queue evidence");
}

async function setViewport(requested) {
  const response = await request("POST", "/api/qa/window/bounds", requested);
  assert(response.status === 200, `requested window ${requested.width}x${requested.height}`);
  const actual = (await measure("body")).viewport;
  assert(actual.width > 0 && actual.height > 0, `actual viewport is ${actual.width}x${actual.height}`);
  return { requested, actual, label: `${Math.round(actual.width)}x${Math.round(actual.height)}` };
}

function overlaps(a, b) {
  return Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1
    && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
}

async function auditRows(viewport, state) {
  const rows = await measure(".wb-queue-row", { attributes: ["data-queue-index"], containedBy: ".wb-queue-list" });
  assert(rows.elements.every((item) => item.containedBy?.fully), `${state}: queue cards stay inside the list`);
  assert(!rows.elements.some((item) => item.scrollable.horizontal), `${state}: cards have no horizontal overflow`);
  const rowMetrics = [];
  let allContained = true;
  let controlOverlap = false;
  for (const row of rows.elements) {
    const index = Number(row.attributes?.["data-queue-index"]);
    const cardSelector = `.wb-queue-row[data-queue-index="${index}"]`;
    const bodyResult = await measure(`${cardSelector} > .wb-queue-text`, { containedBy: cardSelector });
    const identityResult = await measure(`${cardSelector} .wb-queue-from`, { containedBy: cardSelector });
    const headerResult = baseline ? null : await measure(`${cardSelector} > [data-queue-header]`, { containedBy: cardSelector });
    const controlsResult = await measure(`${cardSelector} button`, { containedBy: cardSelector });
    const body = bodyResult.elements[0]?.box;
    const identity = identityResult.elements[0]?.box;
    const header = headerResult?.elements[0]?.box;
    allContained = allContained
      && bodyResult.elements[0]?.containedBy?.fully
      && identityResult.elements[0]?.containedBy?.fully
      && (!headerResult || headerResult.elements[0]?.containedBy?.fully)
      && controlsResult.elements.every((item) => item.containedBy?.fully);
    controlOverlap = controlOverlap || controlsResult.elements.some((left, buttonIndex) => controlsResult.elements.slice(buttonIndex + 1).some((right) => overlaps(left.box, right.box)));
    const leftInset = body.left - row.box.left;
    const rightInset = row.box.right - body.right;
    const closing = row.box.bottom - body.bottom;
    const widthRatio = body.width / Math.max(1, row.box.width - 16);
    rowMetrics.push({
      index,
      row: row.box,
      body,
      identity,
      header,
      leftInset,
      rightInset,
      closing,
      widthRatio,
      bodyBelowHeader: header ? body.top >= header.bottom - 1 : false,
      identityInHeader: header ? identity.top >= header.top - 1 && identity.bottom <= header.bottom + 1 : false,
    });
  }
  assert(rowMetrics.length === rows.count, `${state}: every card has one message body`);
  assert(allContained, `${state}: bodies, identities, headers, and controls stay inside their own card`);
  assert(!controlOverlap, `${state}: visible controls do not overlap`);
  measurements.push({ state, requested: viewport.requested, actual: rows.viewport, rows: rowMetrics });

  if (baseline) {
    assert(rowMetrics.some((metric) => metric.leftInset >= 80), `${state}: baseline reproduces the reserved vertical identity column`);
  } else {
    assert(rowMetrics.every((metric) => metric.header), `${state}: every card has one compact header`);
    assert(rowMetrics.every((metric) => metric.leftInset >= 6 && metric.leftInset <= 10), `${state}: body begins on the card content inset (${rowMetrics.map((m) => m.leftInset.toFixed(1)).join(", ")}px)`);
    assert(rowMetrics.every((metric) => metric.rightInset >= 6 && metric.rightInset <= 10), `${state}: body ends on the card content inset (${rowMetrics.map((m) => m.rightInset.toFixed(1)).join(", ")}px)`);
    assert(rowMetrics.every((metric) => metric.widthRatio >= 0.98), `${state}: body uses the full available width below the header`);
    assert(rowMetrics.every((metric) => metric.closing >= 5 && metric.closing <= 9), `${state}: card closing gutter is preserved`);
    assert(rowMetrics.every((metric) => metric.bodyBelowHeader), `${state}: body does not overlap the compact header`);
    assert(rowMetrics.every((metric) => metric.identityInHeader), `${state}: member identity is contained by the compact header only`);
  }
}

async function capture(viewport, state, theme) {
  assert((await visibleGuideOffers()).length === 0, "guide overlay remains absent before screenshot");
  const file = path.join(evidenceDir, `${viewport.label}-${state}-${theme}.png`);
  const result = await request("POST", "/api/capture", { path: file, theme });
  assert(result.status === 200 && result.payload?.bytes > 1000 && fs.existsSync(file), `${path.basename(file)} saved`);
}

async function seedMultiQueue() {
  await request("POST", "/api/party/members/backend/queue", { action: "clear" });
  await request("POST", "/api/qa/members/backend/emit", { status: "working" });
  const messages = [
    "첫 번째 일반 메시지입니다. compact header 아래 본문은 카드 전체 폭을 사용해야 합니다.",
    "긴 한영 혼합 본문: renderer layout must keep the complete available width 아래에서 사용하며 very-long-token-without-a-natural-break-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ 도 카드 밖으로 넘치면 안 됩니다.\n둘째 줄에서도 member identity 열을 다시 예약하지 않습니다.",
  ];
  for (const text of messages) await request("POST", "/api/party/members/backend/message", { text });
  await request("POST", "/api/party/messages", { to: "backend", from: "reviewer", content: "reviewer가 보낸 다른 멤버 메시지 — badge와 identity 색상을 보존합니다." });
  await request("POST", "/api/party/messages", { to: "backend", from: "docs", content: "docs sender: another mixed 한국어/English body for wrapping and order." });
  await request("POST", "/api/party/members/backend/queue", { action: "preference", merge: false, collapsed: false });
  await delay(500);
  return messages;
}

async function assertQueueSemantics(expectedCount) {
  const state = await queue();
  const rows = await measure(".wb-queue-row", { attributes: ["class", "data-queue-index"] });
  const ordinals = await measure(".wb-queue-row .wb-queue-n");
  const identities = await measure(".wb-queue-row .wb-queue-from");
  const grips = await measure(".wb-queue-row .wb-queue-grip", { attributes: ["aria-label"] });
  const badge = await measure(".wb-tab-queue");
  assert(state.items.length === expectedCount && rows.count === expectedCount, `API and DOM both show ${expectedCount} queued messages`);
  assert(ordinals.texts.join(",") === Array.from({ length: expectedCount }, (_, i) => String(i + 1)).join(","), "queue order and ordinals agree");
  assert(identities.texts.some((text) => /reviewer/.test(text)) && identities.texts.some((text) => /docs/.test(text)), "different member identities render as badges");
  assert(rows.elements.filter((row) => /is-next/.test(row.attributes?.class || "")).length === 1, "exactly one non-merged row is selected as next");
  assert(grips.count === expectedCount && grips.elements.every((item) => item.attributes?.["aria-label"]), "every multi-queue row keeps an accessible drag handle");
  assert(badge.texts.some((text) => text.trim() === String(expectedCount)), "member tab queue badge keeps the count");
}

async function exerciseInteractions(viewport) {
  const beforeDrag = await queue();
  const dragged = await request("POST", "/api/qa/pointer", { steps: [
    { selector: '.wb-queue-row[data-queue-index="0"] .wb-queue-grip', action: "down" },
    { selector: '.wb-queue-row[data-queue-index="2"] .wb-queue-grip', action: "move" },
    { selector: '.wb-queue-row[data-queue-index="2"] .wb-queue-grip', action: "up" },
  ], delayMs: 120 });
  assert(dragged.status === 200 && dragged.payload?.steps?.length === 3, "drag handle accepts a real pointer sequence in the rendered UI");
  await delay(800);
  const afterDrag = await queue();
  const movedTo = afterDrag.items.findIndex((item) => item.id === beforeDrag.items[0]?.id);
  assert(movedTo === 2, `drag handle pointer operation changes queue order (first item moved to ${movedTo})`);

  const beforeEdit = afterDrag.items.length;
  const edit = await request("POST", "/api/capture", { click: '.wb-queue-row [data-queue-action="edit"], .wb-queue-row .wb-queue-btn:nth-last-child(2)' });
  assert(edit.payload?.clicked === true, "edit control is clickable in the rendered card");
  await delay(350);
  const afterEdit = await queue();
  const draft = await request("POST", "/api/qa/input", { selector: ".wb-composer-textarea" });
  assert(afterEdit.items.length === beforeEdit - 1, "edit removes exactly one item from the queue");
  assert(String(draft.payload?.value || "").length > 10, "edit returns the message body to the visible composer");
  for (const theme of ["light", "dark"]) await capture(viewport, "edit-in-composer", theme);
  await request("POST", "/api/party/members/backend/message", { text: String(draft.payload?.value || "edited message restored") });
  await delay(250);

  const beforeRemove = (await queue()).items.length;
  const remove = await request("POST", "/api/capture", { click: '.wb-queue-row:last-child [data-queue-action="remove"], .wb-queue-row:last-child .wb-queue-btn.is-danger' });
  assert(remove.payload?.clicked === true, "remove control is clickable in the rendered card");
  await delay(300);
  assert((await queue()).items.length === beforeRemove - 1, "remove deletes exactly one queued item");
}

function killTree(pid) {
  try { if (pid) execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
}

fs.rmSync(workspace, { recursive: true, force: true });
fs.rmSync(userData, { recursive: true, force: true });
fs.rmSync(evidenceDir, { recursive: true, force: true });
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(userData, { recursive: true });
fs.mkdirSync(evidenceDir, { recursive: true });
fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ workspacePath: workspace }, null, 2));

const child = spawn(process.execPath, [path.join(root, "scripts", "launch-electron.mjs"), "--workspace", workspace], {
  cwd: root,
  stdio: ["ignore", "ignore", "inherit"],
  windowsHide: true,
  env: { ...process.env, AGENTPARTY_QA: "1", AGENTPARTY_ALLOW_MULTI_INSTANCE: "1", AGENTPARTY_AUTOMATION_PORT: String(port), AGENTPARTY_USER_DATA: userData },
});

let appRoot = "";
let appPid = child.pid;
const widthClamp = [];
try {
  await waitForApi();
  await dismissGuideOffer();
  const state = await request("GET", "/api/state");
  appRoot = String(state.payload?.runtime?.appRoot || "");
  assert((appRoot + path.sep).toLowerCase().startsWith(root.toLowerCase() + path.sep), `real app runs this worktree (${appRoot})`);
  try { appPid = Number(execFileSync("powershell", ["-NoProfile", "-Command", `(Get-NetTCPConnection -State Listen -LocalPort ${port} | Select-Object -First 1 -ExpandProperty OwningProcess)`], { encoding: "utf8" }).trim()) || child.pid; } catch {}
  await request("POST", "/api/qa/seed", { party: "queue density", members: [
    { name: "backend", model: "claude-sonnet-4.5", role: "queue density target" },
    { name: "reviewer", model: "claude-sonnet-4.5", role: "review sender" },
    { name: "docs", model: "claude-sonnet-4.5", role: "docs sender" },
  ] });
  await request("POST", "/api/navigation", { view: "workbench" });
  await request("POST", "/api/qa/open", { panels: [["backend"]] });
  await delay(700);
  const seededMessages = await seedMultiQueue();

  for (const requested of [{ width: 1440, height: 900 }, { width: 760, height: 720 }]) {
    const viewport = await setViewport(requested);
    widthClamp.push(viewport);
    await assertQueueSemantics(4);
    const expandSelector = baseline
      ? '.wb-queue-row[data-queue-index="1"] .wb-queue-btn'
      : '.wb-queue-row[data-queue-index="1"] [data-queue-action="expand"]';
    await request("POST", "/api/capture", { click: expandSelector });
    await delay(150);
    await auditRows(viewport, "multi-expanded-long");
    for (const theme of ["light", "dark"]) await capture(viewport, "multi-expanded-long", theme);
    await request("POST", "/api/capture", { click: expandSelector });
  }

  if (!baseline) await exerciseInteractions(widthClamp.at(-1));

  await request("POST", "/api/party/members/backend/queue", { action: "clear" });
  await request("POST", "/api/party/members/backend/message", { text: seededMessages[1] });
  await delay(350);
  for (const viewport of widthClamp) {
    await setViewport(viewport.requested);
    await auditRows(viewport, "single-long");
    for (const theme of ["light", "dark"]) await capture(viewport, "single-long", theme);
  }
} catch (error) {
  failures.push(String(error?.stack || error));
  console.error(error);
} finally {
  fs.writeFileSync(evidenceFile, JSON.stringify({ baseline, appPid, baseUrl, appRoot, widthClamp, failures, measurements }, null, 2));
  console.log(`EVIDENCE pid=${appPid} baseUrl=${baseUrl} appRoot=${appRoot}`);
  console.log(`EVIDENCE measurements=${evidenceFile} screenshots=${evidenceDir}`);
  await request("POST", "/api/window/close", {}).catch(() => {});
  killTree(child.pid);
  await delay(250);
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(userData, { recursive: true, force: true });
}

if (failures.length && !baseline) process.exit(1);
console.log(`${baseline ? "message queue density baseline captured" : "message queue density E2E passed"}; failures=${failures.length}`);
