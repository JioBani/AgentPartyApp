/**
 * Walks the whole guide deck in a RUNNING app and checks, per slide:
 *
 *  1. the slide staged — the modal / wizard / menu it is about actually opened
 *     (`GuideSnapshot.steps`); a failure paints `.guide-stage-error` on the stage,
 *  2. its subject exists on the stage, and where — printed as the exact `spot`
 *     literal for `GUIDE_SLIDES`, in percent of the 1440x942 stage,
 *  3. the caption does not sit on that subject, measured in window pixels.
 *
 * The slide catalog says its spotlights must be measured rather than eyeballed.
 * This is what measures them. Re-run it after any workbench layout change and
 * paste the printed `spot` values back into `src/shared/guide.ts`.
 *
 * Usage: node scripts/qa-guide-slides.mjs <automationApiPort>
 *   (the port a running app prints as `automation api started`)
 */

const port = process.argv[2];
if (!port) {
  console.error("usage: node scripts/qa-guide-slides.mjs <automationApiPort>");
  process.exit(2);
}
const base = `http://127.0.0.1:${port}`;

/**
 * What each slide is ABOUT, as a selector inside the stage.
 *
 * Index-aligned with `GUIDE_SLIDES`. `pick` chooses among multiple matches:
 * "first" (default), "all" (their union), "last", "last2".
 */
const TARGETS = [
  { selector: ".set-section", note: "구독 섹션" },
  { selector: ".set-auth-url", note: "인증 주소줄" },
  { selector: ".set-row-stack", note: "Claude 카드" },
  { selector: ".screen-actions .ghost-btn", note: "작업공간 버튼" },
  { selector: ".wb-new-party-modal", note: "새 파티 모달" },
  { selector: ".wb-member-row", note: "main 멤버 줄" },
  { selector: ".wb-wizard", note: "멤버 마법사" },
  { selector: ".wb-model-list", note: "모델 목록" },
  { selector: ".wb-wizard", note: "권한 단계" },
  { selector: ".wb-tabstrip", note: "탭 스트립" },
  { selector: ".wb-composer", note: "입력창" },
  { selector: ".wb-composer", note: "Stop" },
  { selector: ".wb-tool", note: "툴 블록", pick: "all" },
  { selector: ".wb-approval", note: "승인 카드" },
  { selector: ".wb-tool", note: "적용된 수정", pick: "last2" },
  { selector: ".wb-queue", note: "메시지 큐" },
  { selector: ".wb-panel:last-child", note: "오른쪽 패널" },
  { selector: ".wb-panel:first-child .wb-channel", note: "main 채널", pick: "all" },
  { selector: ".wb-panel:last-child .wb-channel", note: "reviewer 채널", pick: "all" },
  { selector: ".wb-member-row", note: "impl 줄", pick: "last" },
  { selector: ".wb-party-gate-modal", note: "파티 게이트 모달" },
  { selector: ".wb-gate", note: "차단 기록" },
  { selector: ".wb-dd-menu", note: "권한 메뉴" },
  { selector: ".wb-detail-section", note: "추론 강도" },
  { selector: ".mcp-list", note: "MCP 서버 목록" },
  { selector: ".wb-header-menu", note: "⋯ 메뉴" },
  { selector: ".wb-ctx-menu", note: "우클릭 메뉴" },
  { selector: ".set-tabs", note: "런타임 탭" },
  { selector: ".wb-compact-dialog", note: "압축 창" },
  { selector: ".usage-pill", note: "한도 알약" },
];

async function req(path, body, method = "POST") {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: method === "POST" ? JSON.stringify(body || {}) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${path} ${res.status}: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text);
}

const winBox = async (selector) => {
  const out = await req("/api/measure", { selector });
  return (out.elements || [])[0]?.box || null;
};

const overlapPx = (a, b) => {
  if (!a || !b) {
    return -1;
  }
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? Math.round(w * h) : 0;
};

const pct = (value) => Number(String(value).replace("%", ""));
const round2 = (value) => Math.round(value * 100) / 100;
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function chosen(elements, pick) {
  if (pick === "all") return elements;
  if (pick === "last") return elements.slice(-1);
  if (pick === "last2") return elements.slice(-2);
  return elements.slice(0, 1);
}

await req("/api/guide/open");
await settle(1800);

const info = await req("/api/guide", null, "GET");
let bad = 0;

for (let index = 0; index < info.slideCount; index += 1) {
  await req("/api/guide/slide", { index });
  // The stage remounts the whole app and then runs the slide's steps.
  await settle(1700);
  const meta = await req("/api/guide", null, "GET");
  const head = `${String(index).padStart(2)} ${String(meta.slideId).padEnd(17)}`;

  const failed = await req("/api/measure", { selector: ".guide-stage-error" }).catch(() => ({ elements: [] }));
  if ((failed.elements || []).length) {
    bad += 1;
    console.log(`${head} STAGE-FAIL ${(failed.elements[0].text || "").slice(0, 160)}`);
    continue;
  }

  const target = TARGETS[index];
  if (!target) {
    bad += 1;
    console.log(`${head} NO TARGET — 이 슬라이드가 무엇을 가리키는지 이 스크립트에 없습니다.`);
    continue;
  }

  try {
    const out = await req("/api/guide/stage/measure", { selector: target.selector });
    const picked = chosen(out.elements, target.pick);
    const left = Math.min(...picked.map((e) => pct(e.spot.left)));
    const top = Math.min(...picked.map((e) => pct(e.spot.top)));
    const right = Math.max(...picked.map((e) => pct(e.spot.left) + pct(e.spot.width)));
    const bottom = Math.max(...picked.map((e) => pct(e.spot.top) + pct(e.spot.height)));
    const covered = overlapPx(await winBox(".guide-spot"), await winBox(".guide-caption"));
    if (covered !== 0) {
      bad += 1;
    }
    console.log(
      `${head} ${target.note.padEnd(16)} n=${out.count} overlap=${covered}px²  `
      + `spot: { left: "${round2(left)}%", top: "${round2(top)}%", width: "${round2(right - left)}%", height: "${round2(bottom - top)}%" },`,
    );
  } catch (error) {
    bad += 1;
    console.log(`${head} ${target.note.padEnd(16)} MISS  ${String(error.message).slice(0, 140)}`);
  }
}

console.log(bad === 0
  ? "\nOK — 모든 슬라이드가 연출되었고, 링에 대상이 있으며, 캡션이 대상을 가리지 않습니다."
  : `\n${bad}개 슬라이드에 문제가 있습니다.`);
process.exit(bad === 0 ? 0 : 1);
