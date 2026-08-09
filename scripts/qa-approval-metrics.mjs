/*
 * Approval card METRICS — measured, not eyeballed.
 *
 * Screenshots prove a card renders; they do not prove it renders at the spacing
 * the design asked for. 2px of padding is invisible in a capture and obvious in
 * the product, so this attaches to the running renderer over the Chrome
 * DevTools Protocol and compares `getComputedStyle` against the values declared
 * in the design ("Approval Cards.dc.html" in the Claude Design project).
 *
 * Every expectation below is a number copied FROM that file, not a preference.
 *
 * Run: node scripts/qa-approval-metrics.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ws = path.resolve(os.tmpdir(), "agentparty-b18-metrics-ws");
const userData = path.resolve(os.tmpdir(), "agentparty-b18-metrics-ud");
const port = 49241;
const base = `http://127.0.0.1:${port}`;

const failures = [];
const notes = [];
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The design's declared values, per selector. `px` compares a computed length;
 * `text` compares an exact computed string.
 *
 * Sources are the inline styles on the corresponding element in the .dc.html.
 */
const SPEC = [
  ["카드", ".wb-approval", { borderRadius: "12px", borderTopWidth: "1px" }],

  ["머리", ".wb-approval-head", { paddingTop: "11px", paddingRight: "14px", paddingBottom: "11px", paddingLeft: "14px", columnGap: "9px", borderBottomWidth: "1px" }],
  ["머리 제목", ".wb-approval-head strong", { fontSize: "13px" }],
  ["도구 칩", ".wb-approval-head .wb-chip", { fontSize: "10.5px", borderRadius: "5px", paddingTop: "1px", paddingLeft: "6px" }],
  ["하네스·모델", ".wb-approval-origin", { fontSize: "11px" }],

  ["본문", ".wb-approval-body", { paddingTop: "14px", paddingRight: "14px", paddingBottom: "14px", paddingLeft: "14px", rowGap: "12px" }],
  ["설명", ".wb-approval-desc", { fontSize: "13px" }],
  ["명령 블록", ".wb-approval-cmd", { borderRadius: "8px", paddingTop: "10px", paddingLeft: "12px", fontSize: "12.5px" }],
  ["메타 그리드", ".wb-approval-meta", { fontSize: "12px", rowGap: "6px", columnGap: "12px", gridTemplateColumns: "76px" }],

  ["바닥", ".wb-approval-actions", { paddingTop: "12px", paddingRight: "14px", paddingBottom: "12px", paddingLeft: "14px", columnGap: "8px", borderTopWidth: "1px" }],
  ["버튼", ".wb-approval-actions .wb-btn", { height: "36px", borderRadius: "8px", fontSize: "12.5px" }],
  ["주 버튼", ".wb-approval-actions .wb-btn-member", { paddingLeft: "16px", paddingRight: "16px" }],
  ["거부 버튼", ".wb-approval-actions .wb-btn-ghost", { paddingLeft: "14px", paddingRight: "14px" }],
  ["규칙 버튼", ".wb-approval-actions .wb-btn-rule", { paddingLeft: "12px", paddingRight: "12px" }],
  ["규칙 문구", ".wb-btn-rule-hint", { fontSize: "10px" }],
];

/** Cards that must exist for the above selectors to be measurable. */
const DIFF_SPEC = [
  ["diff 상자", ".wb-approval-diff", { borderRadius: "8px", fontSize: "12.5px" }],
  ["diff 줄", ".wb-approval-diff-line", { paddingTop: "5px", paddingLeft: "12px", columnGap: "9px" }],
  ["파일 줄", ".wb-approval-file", { columnGap: "8px", fontSize: "12.5px" }],
  ["파일 종류 배지", ".wb-approval-file-kind", { fontSize: "10px", borderRadius: "4px", paddingLeft: "5px" }],
];

/*
 * Codex-only. `.wb-btn-soft` also matches the rule button (which is 12px by
 * design), and querySelector takes the first match — so on a Claude card this
 * silently measured the wrong control. Exclude it explicitly.
 */
const CODEX_SPEC = [
  ["세션 버튼", ".wb-approval-actions .wb-btn-soft:not(.wb-btn-rule)", { paddingLeft: "13px", paddingRight: "13px", height: "36px" }],
  ["규칙 버튼(4개짜리)", ".wb-approval-actions .wb-btn-rule", { paddingLeft: "12px", paddingRight: "12px" }],
];

const RESOLVED_SPEC = [
  ["처리 후 줄", ".wb-approval.is-resolved", { paddingTop: "10px", paddingLeft: "13px", borderRadius: "9px", columnGap: "10px", borderLeftWidth: "2px" }],
  ["처리 후 라벨", ".wb-approval-resolved-label", { fontSize: "12.5px" }],
  ["처리 후 요약", ".wb-approval-resolved-summary", { fontSize: "12px" }],
  ["처리 후 범위 칩", ".wb-approval-resolved-scope", { fontSize: "11px", borderRadius: "5px", paddingLeft: "7px", paddingTop: "1px" }],
];

const post = async (route, body) => {
  const r = await fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  if (!r.ok) throw new Error(`${route} ${r.status}: ${await r.text()}`);
  return r.json();
};
const get = async (route) => {
  const r = await fetch(base + route);
  if (!r.ok) throw new Error(`${route} ${r.status}`);
  return r.json();
};

fs.rmSync(ws, { recursive: true, force: true });
fs.rmSync(userData, { recursive: true, force: true });
fs.mkdirSync(ws, { recursive: true });
fs.mkdirSync(userData, { recursive: true });
fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ workspacePath: ws, automationApiPort: port }, null, 2));

const child = spawn(process.execPath, [path.join(root, "scripts", "launch-electron.mjs"), "--remote-debugging-port=0"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
  env: { ...process.env, AGENTPARTY_QA: "1", AGENTPARTY_AUTOMATION_PORT: String(port), AGENTPARTY_USER_DATA: userData, AGENTPARTY_WINDOW_DISPLAY: "left" },
});
child.stderr.on("data", () => {});

async function attachRenderer() {
  const portFile = path.join(userData, "DevToolsActivePort");
  const started = Date.now();
  let cdpPort = 0;
  while (Date.now() - started < 40000) {
    try {
      cdpPort = Number(fs.readFileSync(portFile, "utf8").split("\n")[0].trim());
      if (cdpPort > 0) break;
    } catch { /* not written yet */ }
    await delay(250);
  }
  if (!cdpPort) throw new Error(`Electron never wrote ${portFile}.`);
  let target;
  while (Date.now() - started < 40000) {
    const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
    target = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (target) break;
    await delay(250);
  }
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error("CDP open failed")); });
  let nextId = 1;
  const pending = new Map();
  socket.onmessage = (e) => { const m = JSON.parse(e.data); const p = pending.get(m.id); if (p) { pending.delete(m.id); p(m); } };
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
    socket.send(JSON.stringify({ id, method, params }));
  });
  return {
    async eval(expression) {
      const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    },
    close() { socket.close(); },
  };
}

/**
 * Measures the RENDERED vertical gap between every pair of adjacent children in
 * a container, and the padding between the container edge and its first/last
 * child.
 *
 * The per-property checks above only see spacing someone remembered to declare.
 * A wrapper element with no gap of its own collapses two rows together and
 * every declared value still matches — which is exactly how the file row ended
 * up flush against its diff. This walks what is actually on screen instead.
 */
async function measureGaps(cdp, label, containerSelector, expected) {
  const gaps = await cdp.eval(`(() => {
    const box = document.querySelector(${JSON.stringify(containerSelector)});
    if (!box) return null;
    const kids = [...box.children].filter((el) => el.getClientRects().length > 0);
    const cs = getComputedStyle(box);
    const boxRect = box.getBoundingClientRect();
    const rects = kids.map((el) => ({ cls: el.className || el.tagName.toLowerCase(), r: el.getBoundingClientRect() }));
    const out = { padTop: 0, padBottom: 0, between: [] };
    if (rects.length) {
      out.padTop = Math.round((rects[0].r.top - boxRect.top - parseFloat(cs.borderTopWidth)) * 10) / 10;
      out.padBottom = Math.round((boxRect.bottom - rects[rects.length - 1].r.bottom - parseFloat(cs.borderBottomWidth)) * 10) / 10;
    }
    for (let i = 1; i < rects.length; i += 1) {
      out.between.push({
        from: String(rects[i - 1].cls).split(" ")[0],
        to: String(rects[i].cls).split(" ")[0],
        gap: Math.round((rects[i].r.top - rects[i - 1].r.bottom) * 10) / 10,
      });
    }
    return out;
  })()`);
  if (!gaps) {
    failures.push(`${label} (${containerSelector}) — 요소 없음`);
    console.log(`  ✗ ${label.padEnd(16)} 요소 없음`);
    return;
  }
  const bad = [];
  if (expected.padTop !== undefined && gaps.padTop !== expected.padTop) bad.push(`위 여백 ${gaps.padTop} ≠ ${expected.padTop}`);
  if (expected.padBottom !== undefined && gaps.padBottom !== expected.padBottom) bad.push(`아래 여백 ${gaps.padBottom} ≠ ${expected.padBottom}`);
  for (const pair of gaps.between) {
    if (expected.between !== undefined && pair.gap !== expected.between) {
      bad.push(`${pair.from}→${pair.to} ${pair.gap} ≠ ${expected.between}`);
    }
  }
  if (bad.length) {
    failures.push(`${label}: ${bad.join(", ")}`);
    console.log(`  ✗ ${label.padEnd(16)} ${bad.join(" · ")}`);
  } else {
    console.log(`  ✓ ${label.padEnd(16)} 여백 ${gaps.padTop}/${gaps.padBottom}, 사이 ${gaps.between.length}곳 모두 ${expected.between ?? "-"}px`);
  }
}

/** Reads the computed values for one selector, or reports it missing. */
async function measure(cdp, label, selector, expected) {
  const props = Object.keys(expected);
  const actual = await cdp.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const cs = getComputedStyle(el);
    const out = {};
    for (const p of ${JSON.stringify(props)}) out[p] = cs[p];
    return out;
  })()`);
  if (!actual) {
    failures.push(`${label} (${selector}) — NOT RENDERED, so nothing could be measured`);
    console.log(`  ✗ ${label.padEnd(16)} 요소 없음 (${selector})`);
    return;
  }
  const bad = [];
  for (const [prop, want] of Object.entries(expected)) {
    const got = String(actual[prop]);
    // grid-template-columns computes to used pixel values; compare the first track.
    const ok = prop === "gridTemplateColumns" ? got.startsWith(want) : got === want;
    if (!ok) bad.push(`${prop} ${got} ≠ ${want}`);
  }
  if (bad.length) {
    failures.push(`${label}: ${bad.join(", ")}`);
    console.log(`  ✗ ${label.padEnd(16)} ${bad.join(" · ")}`);
  } else {
    console.log(`  ✓ ${label.padEnd(16)} ${props.length}개 값 일치`);
  }
}

async function main() {
  const started = Date.now();
  while (Date.now() - started < 90000) {
    try { if ((await get("/api/health")).ok) break; } catch { /* booting */ }
    await delay(500);
  }
  const windows = (await get("/api/windows")).windows || [];
  await post(`/api/windows/${windows[0].id}/workspace`, { workspacePath: ws });
  await post("/api/qa/reset").catch(() => {});
  await post("/api/qa/seed", { party: "metrics", members: [{ name: "m-cmd" }, { name: "m-file" }, { name: "m-codex" }, { name: "m-done" }] });

  const cdp = await attachRenderer();

  console.log("\n명령 승인 카드 — 시안 선언값 대조:");
  await post("/api/qa/members/m-cmd/interaction", { type: "approval", scenario: "claude-bash" });
  await post("/api/qa/open", { panels: [["m-cmd"]] });
  await delay(900);
  for (const [label, selector, expected] of SPEC) await measure(cdp, label, selector, expected);
  await measureGaps(cdp, "명령카드 본문", ".wb-approval-body", { padTop: 14, padBottom: 14, between: 12 });
  await measureGaps(cdp, "명령카드 바닥", ".wb-approval-actions", { padTop: 12, padBottom: 12 });

  console.log("\n파일 변경 카드:");
  await post("/api/qa/members/m-file/interaction", { type: "approval", scenario: "claude-file-edit" });
  await post("/api/qa/open", { panels: [["m-file"]] });
  await delay(900);
  for (const [label, selector, expected] of DIFF_SPEC) await measure(cdp, label, selector, expected);
  // The gap the wrapper used to swallow: file row → its diff.
  await measureGaps(cdp, "파일카드 본문", ".wb-approval-body", { padTop: 14, padBottom: 14, between: 12 });
  await measureGaps(cdp, "diff 줄 사이", ".wb-approval-diff", { padTop: 0, padBottom: 0, between: 0 });

  console.log("\nCodex 카드 (버튼 4개):");
  await post("/api/qa/members/m-codex/interaction", { type: "approval", scenario: "codex-command-once" });
  await post("/api/qa/open", { panels: [["m-codex"]] });
  await delay(900);
  for (const [label, selector, expected] of CODEX_SPEC) await measure(cdp, label, selector, expected);
  await measureGaps(cdp, "Codex 본문", ".wb-approval-body", { padTop: 14, padBottom: 14, between: 12 });

  console.log("\n처리 후 카드:");
  const { requestId } = await post("/api/qa/members/m-done/interaction", { type: "approval", scenario: "claude-bash" });
  const sessionId = (await get("/api/party")).members.find((m) => m.name === "m-done")?.sessionId;
  await post(`/api/sessions/${sessionId}/approve`, { requestId, behavior: "allow" });
  await post("/api/qa/open", { panels: [["m-done"]] });
  await delay(900);
  for (const [label, selector, expected] of RESOLVED_SPEC) await measure(cdp, label, selector, expected);

  cdp.close();
  console.log(`\n${failures.length ? `FAILED (${failures.length})` : "PASSED"} — 시안 대비 실측`);
  failures.forEach((f) => console.log(`  ✗ ${f}`));
  notes.forEach((n) => console.log(`  · ${n}`));
  await post("/api/window/close", {}).catch(() => {});
}

main()
  .then(() => setTimeout(() => process.exit(failures.length ? 1 : 0), 800))
  .catch(async (error) => {
    console.error(`metrics failed: ${error?.message || error}`);
    try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* gone */ }
    process.exit(1);
  });
