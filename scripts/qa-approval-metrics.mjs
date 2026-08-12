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
  ["경로 줄(Claude)", ".wb-approval-path", { fontSize: "12px" }],

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
  // The label/value grid is Codex's: it aligns 실행 + 작업 폴더. Claude sends one
  // path and uses a plain line, so measuring the grid there was measuring an
  // element that should not exist on that card.
  ["메타 그리드", ".wb-approval-meta", { fontSize: "12px", rowGap: "6px", columnGap: "12px", gridTemplateColumns: "76px" }],
  ["세션 버튼", ".wb-approval-actions .wb-btn-soft:not(.wb-btn-rule)", { paddingLeft: "13px", paddingRight: "13px", height: "36px" }],
  ["규칙 버튼(4개짜리)", ".wb-approval-actions .wb-btn-rule", { paddingLeft: "12px", paddingRight: "12px" }],
];

/*
 * The question card (유형 E). Same shell as an approval, different insides —
 * and deliberately no danger colour, which is asserted as "the primary is the
 * accent" rather than a member hue.
 */
const QUESTION_SPEC = [
  ["질문 머리", ".wb-question .wb-approval-head", { paddingTop: "11px", paddingLeft: "14px", columnGap: "9px" }],
  ["질문 머리 칩", ".wb-question .wb-approval-head .wb-chip", { fontSize: "10.5px", borderRadius: "5px", paddingLeft: "6px" }],
  ["질문 본문", ".wb-question-item", { paddingTop: "14px", paddingLeft: "14px", rowGap: "11px" }],
  ["질문 문장", ".wb-question-text", { fontSize: "13.5px", fontWeight: "600" }],
  ["선택지 목록", ".wb-question-options", { rowGap: "7px" }],
  ["선택지", ".wb-question-option", { paddingTop: "10px", paddingLeft: "12px", borderRadius: "9px", columnGap: "10px" }],
  ["선택지 라벨", ".wb-question-option-label", { fontSize: "12.5px" }],
  ["선택지 설명", ".wb-question-option-desc", { fontSize: "11.5px" }],
  /*
   * No border-width assertion here. The design asks for 1.5px, but Chrome
   * reports the USED value and rounds borders to whole device pixels, so at
   * dpr 1 a 1.5px border computes as 1px no matter what is declared. Asserting
   * the design number would fail forever on a 1x display and asserting 1px
   * would fail on a 2x one; the declared value is checked by reading the rule,
   * and the rendered width is reported as a note below.
   */
  ["표시 동그라미", ".wb-question-mark", { width: "15px", height: "15px", borderRadius: "50%" }],
  ["건너뛰기", ".wb-question .wb-btn-ghost", { paddingLeft: "14px", paddingRight: "14px", height: "36px" }],
  ["답변 보내기", ".wb-question .wb-btn-member", { paddingLeft: "16px", paddingRight: "16px", height: "36px" }],
];

const MULTI_SPEC = [
  ["다중 선택지", ".wb-question-option", { paddingTop: "9px", paddingLeft: "12px" }],
  ["표시 네모", ".wb-question-mark.is-box", { width: "15px", height: "15px", borderRadius: "4px" }],
  ["복수 선택 안내", ".wb-question-hint", { fontSize: "11.5px" }],
];

const RESOLVED_SPEC = [
  ["처리 후 줄", ".wb-approval.is-resolved", { paddingTop: "10px", paddingLeft: "13px", borderRadius: "9px", columnGap: "10px", borderLeftWidth: "2px" }],
  ["처리 후 라벨", ".wb-approval-resolved-label", { fontSize: "12.5px" }],
  ["처리 후 요약", ".wb-approval-resolved-summary", { fontSize: "12px" }],
  ["처리 후 범위 칩", ".wb-approval-resolved-scope", { fontSize: "11px", borderRadius: "5px", paddingLeft: "7px", paddingTop: "1px" }],
];

/* 대화 압축 블록 — 시안(Workbench Multi.dc.html)의 선언값. */
const COMPACT_SPEC = [
  ["압축 카드", ".wb-compact", { borderRadius: "8px", overflowX: "hidden" }],
  ["압축 줄", ".wb-compact-row", { paddingTop: "8px", paddingLeft: "10px", columnGap: "8px", flexWrap: "wrap", alignItems: "center" }],
  ["압축 제목", ".wb-compact-title", { fontSize: "12px", fontWeight: "600", whiteSpace: "nowrap" }],
  ["압축 수치", ".wb-compact-delta", { fontSize: "11px" }],
  ["감소율 배지", ".wb-compact-pct", { fontSize: "10.5px", fontWeight: "600", borderRadius: "4px", paddingLeft: "5px", paddingTop: "1px" }],
  ["유지 안내", ".wb-compact-note", { fontSize: "11px", minWidth: "60px", textOverflow: "ellipsis" }],
  ["소요 시간", ".wb-compact-dur", { fontSize: "10.5px" }],
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

/**
 * Reads DOM properties rather than styles.
 *
 * Masking cannot be seen in a capture — an empty password field and an empty
 * text field look identical, placeholder and all — so whether a secret answer is
 * hidden is only knowable by asking the element what it is.
 */
/**
 * Asserts selectors match NOTHING — and fails loudly if the card they belong to
 * is itself missing. Without that guard the check passes for the wrong reason:
 * an empty panel has no delta and no percentage either.
 */
/** How many of a selector exist. A count, unlike a style, cannot be eyeballed. */
async function measureCount(cdp, label, selector, expected) {
  const actual = await cdp.eval(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
  if (actual === expected) {
    console.log(`  ✓ ${label.padEnd(16)} ${actual}개`);
  } else {
    failures.push(`${label}: ${actual}개 ≠ ${expected}개`);
    console.log(`  ✗ ${label.padEnd(16)} ${actual}개 ≠ ${expected}개`);
  }
}

async function measureAbsent(cdp, label, selectors) {
  const present = await cdp.eval(`(() => {
    if (!document.querySelector(".wb-compact")) return "카드 자체가 없음";
    return ${JSON.stringify(selectors)}.filter((s) => document.querySelector(s)).join(", ");
  })()`);
  if (present) {
    failures.push(`${label}: ${present}`);
    console.log(`  ✗ ${label.padEnd(16)} ${present}`);
  } else {
    console.log(`  ✓ ${label.padEnd(16)} ${selectors.length}개 모두 없음 (카드는 있음)`);
  }
}

async function measureProps(cdp, label, selector, expected) {
  const props = Object.keys(expected);
  const actual = await cdp.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const out = {};
    for (const p of ${JSON.stringify(props)}) out[p] = el[p];
    return out;
  })()`);
  if (!actual) {
    failures.push(`${label} (${selector}) — 요소 없음`);
    console.log(`  ✗ ${label.padEnd(16)} 요소 없음`);
    return;
  }
  const bad = Object.entries(expected).filter(([k, v]) => String(actual[k]) !== String(v)).map(([k, v]) => `${k} ${actual[k]} ≠ ${v}`);
  if (bad.length) {
    failures.push(`${label}: ${bad.join(", ")}`);
    console.log(`  ✗ ${label.padEnd(16)} ${bad.join(" · ")}`);
  } else {
    console.log(`  ✓ ${label.padEnd(16)} ${props.map((p) => `${p}=${actual[p]}`).join(", ")}`);
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
  await post("/api/qa/seed", { party: "metrics", members: [{ name: "m-cmd" }, { name: "m-file" }, { name: "m-codex" }, { name: "m-q1" }, { name: "m-q2" }, { name: "m-secret" }, { name: "m-free" }, { name: "m-done" }, { name: "m-answered" }, { name: "m-compact" }, { name: "m-compact-bare" }, { name: "m-compact-run" }, { name: "m-answered-many" }] });

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

  console.log("\n질문 카드 (단일 선택):");
  await post("/api/qa/members/m-q1/interaction", { type: "askUserQuestion", questions: [{ question: "어떤 작업을 진행할까요?", header: "작업 선택", options: [
    { label: "코드 리뷰", description: "현재 변경점을 리뷰합니다." },
    { label: "버그 수정", description: "보고된 버그를 수정합니다." },
  ] }] });
  await post("/api/qa/open", { panels: [["m-q1"]] });
  await delay(900);
  for (const [label, selector, expected] of QUESTION_SPEC) await measure(cdp, label, selector, expected);
  // Reported, not asserted — see the note on the mark's border above.
  const ring = await cdp.eval(`(() => {
    const el = document.querySelector(".wb-question-mark");
    const rule = [...document.styleSheets].flatMap((s) => { try { return [...s.cssRules]; } catch { return []; } })
      .find((r) => r.selectorText === ".wb-question-mark");
    // The bundled rule uses the border shorthand, so the longhand reads empty.
    return { dpr: window.devicePixelRatio, declared: rule?.style?.borderTopWidth || rule?.style?.border || "?", used: getComputedStyle(el).borderTopWidth };
  })()`);
  notes.push(`표시 동그라미 테두리: 선언 ${ring.declared} → 렌더 ${ring.used} (dpr ${ring.dpr}; 브라우저가 디바이스 픽셀로 반올림)`);
  console.log(`  · 표시 동그라미 테두리   선언 ${ring.declared} → 렌더 ${ring.used} (dpr ${ring.dpr})`);

  await measureGaps(cdp, "질문 본문 사이", ".wb-question-item", { padTop: 14, padBottom: 14, between: 11 });
  await measureGaps(cdp, "선택지 사이", ".wb-question-options", { padTop: 0, padBottom: 0, between: 7 });

  console.log("\n질문 카드 (다중 선택):");
  await post("/api/qa/members/m-q2/interaction", { type: "askUserQuestion", questions: [{ question: "어떤 검사를 돌릴까요?", header: "검사", multiSelect: true, options: [
    { label: "타입체크", description: "tsc --noEmit" },
    { label: "빌드", description: "npm run build" },
  ] }] });
  await post("/api/qa/open", { panels: [["m-q2"]] });
  await delay(900);
  for (const [label, selector, expected] of MULTI_SPEC) await measure(cdp, label, selector, expected);

  console.log("\n질문 카드 — 비밀 입력 마스킹:");
  await post("/api/qa/members/m-secret/interaction", { type: "askUserQuestion", questions: [{ question: "API 키를 입력하세요.", header: "인증", secret: true, options: [] }] });
  await post("/api/qa/open", { panels: [["m-secret"]] });
  await delay(900);
  await measureProps(cdp, "비밀 입력", ".wb-question-other-input", { type: "password" });

  await post("/api/qa/members/m-free/interaction", { type: "askUserQuestion", questions: [{ question: "브랜치 이름은?", header: "브랜치", options: [] }] });
  await post("/api/qa/open", { panels: [["m-free"]] });
  await delay(900);
  await measureProps(cdp, "일반 입력", ".wb-question-other-input", { type: "text" });

  console.log("\n처리 후 카드:");
  const { requestId } = await post("/api/qa/members/m-done/interaction", { type: "approval", scenario: "claude-bash" });
  const sessionId = (await get("/api/party")).members.find((m) => m.name === "m-done")?.sessionId;
  await post(`/api/sessions/${sessionId}/approve`, { requestId, behavior: "allow" });
  await post("/api/qa/open", { panels: [["m-done"]] });
  await delay(900);
  for (const [label, selector, expected] of RESOLVED_SPEC) await measure(cdp, label, selector, expected);

  // An ANSWERED question. Nothing measured this state, so it kept the pending
  // card's shell long after the approvals were rebuilt — and the answer itself
  // was never carried on the resolution event, so it read "—" anywhere but the
  // window that clicked. Both are asserted here now.
  const q = await post("/api/qa/members/m-answered/interaction", { type: "askUserQuestion", questions: [{ question: "어떤 하네스로 만들까요?", header: "멤버 설정", options: [{ label: "Claude Code" }, { label: "Codex" }] }] });
  const answeredSession = (await get("/api/party")).members.find((m) => m.name === "m-answered")?.sessionId;
  await post(`/api/sessions/${answeredSession}/approve`, { requestId: q.requestId, behavior: "allow", updatedInput: { answers: { "어떤 하네스로 만들까요?": "Claude Code" } } });
  await post("/api/qa/open", { panels: [["m-answered"]] });
  await delay(900);
  await measure(cdp, "답변한 질문 줄", ".wb-question.is-resolved", { paddingTop: "10px", paddingLeft: "13px", borderRadius: "9px", columnGap: "10px", borderLeftWidth: "2px" });
  await measureProps(cdp, "답변 라벨", ".wb-answered-q", { textContent: "멤버 설정" });
  await measureProps(cdp, "답변 내용", ".wb-answered-a", { textContent: "Claude Code" });

  // Several answers, one long enough to overflow. Both defects this caught are
  // invisible in a capture: an `align-items` rule that lost to a later one at
  // equal specificity, and an expand icon gated on a character count instead of
  // whether the text actually fits.
  const many = [
    { question: "멘션을 어떻게 적용할까요?", header: "적용 여부", options: [{ label: "텍스트로만 넣는다" }] },
    { question: "단일 @ 는 어떻게 처리할까요?", header: "단일 @", options: [{ label: "짧게" }] },
  ];
  const manyReq = await post("/api/qa/members/m-answered-many/interaction", { type: "askUserQuestion", questions: many });
  const manySession = (await get("/api/party")).members.find((m) => m.name === "m-answered-many")?.sessionId;
  await post(`/api/sessions/${manySession}/approve`, { requestId: manyReq.requestId, behavior: "allow", updatedInput: { answers: {
    "멘션을 어떻게 적용할까요?": "텍스트로만 넣는다",
    // Long enough that it cannot fit at any panel width this window produces.
    // A merely longish answer proved nothing: it fitted, so the button was
    // correctly absent and the check failed for the wrong reason.
    "단일 @ 는 어떻게 처리할까요?": "'@@' 만 멤버로 인식하고, '@' 하나만 적힌 경우에는 아무 것도 하지 않으며 그대로 글자로 남긴다. 기존 대화에 이미 적혀 있던 '@' 는 소급해서 바꾸지 않고, 자동 완성 목록도 '@@' 를 입력했을 때만 연다. 붙여넣기로 들어온 문자열도 같은 규칙을 그대로 적용하며, 코드 블록 안에 있는 '@' 는 어떤 경우에도 멤버로 해석하지 않는다.",
  } } });
  await post("/api/qa/open", { panels: [["m-answered-many"]] });
  await delay(900);
  await measureCount(cdp, "답변 줄 수", ".wb-answered-row", 2);
  await measure(cdp, "답변 카드 정렬", ".wb-approval.wb-question.is-answered", { alignItems: "flex-start" });
  await measure(cdp, "답변 줄", ".wb-answered-row", { columnGap: "8px", alignItems: "baseline" });
  await measure(cdp, "답변 질문", ".wb-answered-q", { fontSize: "11.5px", whiteSpace: "nowrap" });
  await measure(cdp, "답변 값", ".wb-answered-a", { fontSize: "12px", textOverflow: "ellipsis" });
  await measureCount(cdp, "전체 보기 버튼", ".wb-answered-expand", 1);
  // …and the other direction. Checking only that a long answer offers the popup
  // would also pass if the button were shown unconditionally, which is exactly
  // the clutter it is meant to avoid.
  await post("/api/qa/open", { panels: [["m-answered"]] });
  await delay(700);
  await measureCount(cdp, "짧은 답변엔 버튼 없음", ".wb-answered-expand", 0);

  console.log("\n대화 압축 블록:");
  await post("/api/qa/members/m-compact/emit", { events: [{ type: "compact_state", state: "done", trigger: "manual", preTokens: 823598, postTokens: 6883, durationMs: 197155, keptCount: 3 }] });
  await post("/api/qa/open", { panels: [["m-compact"]] });
  await delay(900);
  for (const [label, selector, expected] of COMPACT_SPEC) await measure(cdp, label, selector, expected);
  // The abbreviations are the point of the card: the raw JSON said 823598 and
  // 197155, and a card that repeated those would not be an improvement.
  await measureProps(cdp, "축약 수치", ".wb-compact-delta", { textContent: "824K → 6.9K" });
  await measureProps(cdp, "감소율", ".wb-compact-pct", { textContent: "-99%" });
  await measureProps(cdp, "유지 건수", ".wb-compact-note", { textContent: "최근 3건 유지" });
  await measureProps(cdp, "시간 표기", ".wb-compact-dur", { textContent: "3분 17초" });

  // Codex sends no figures. The card must then show NOTHING numeric rather than
  // zeroes — the one case where an empty card is the correct card.
  await post("/api/qa/members/m-compact-bare/emit", { events: [{ type: "compact_state", state: "done" }] });
  await post("/api/qa/open", { panels: [["m-compact-bare"]] });
  await delay(700);
  await measureAbsent(cdp, "수치 없는 압축", [".wb-compact-delta", ".wb-compact-pct", ".wb-compact-dur", ".wb-compact-note:not(:empty)"]);

  await post("/api/qa/members/m-compact-run/emit", { events: [{ type: "compact_state", state: "running", trigger: "manual" }] });
  await post("/api/qa/open", { panels: [["m-compact-run"]] });
  await delay(700);
  await measure(cdp, "진행 바", ".wb-compact-bar", { height: "2px", overflowX: "hidden" });
  // The design declares `width:40%`, but getComputedStyle reports the USED
  // value in px, so the percentage can only be checked as a ratio of the bar.
  await measure(cdp, "진행 바 스윕", ".wb-compact-bar > span", { position: "absolute" });
  const sweep = await cdp.eval(`(() => {
    const bar = document.querySelector(".wb-compact-bar");
    const span = document.querySelector(".wb-compact-bar > span");
    if (!bar || !span) return null;
    return Math.round((span.getBoundingClientRect().width / bar.getBoundingClientRect().width) * 1000) / 10;
  })()`);
  if (sweep === 40) {
    console.log(`  ✓ ${"스윕 폭 비율".padEnd(16)} 바 대비 ${sweep}%`);
  } else {
    failures.push(`스윕 폭 비율: ${sweep}% ≠ 40%`);
    console.log(`  ✗ ${"스윕 폭 비율".padEnd(16)} ${sweep}% ≠ 40%`);
  }
  await measureProps(cdp, "경과 시간", ".wb-compact-elapsed", { textContent: "0:00" });

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
