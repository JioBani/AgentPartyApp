/*
 * Frontend QA driver. Seeds the running app with a full mock party (no model
 * calls) via the QA API, navigates to the Workbench, and captures a screenshot.
 *
 * Prereq: the app must be running with QA enabled — `npm run start:qa`.
 * Usage:   node scripts/qa-frontend.mjs            (seed + capture)
 *          node scripts/qa-frontend.mjs --reset    (tear down mock members)
 */
const BASE = process.env.QA_BASE || "http://127.0.0.1:47831";

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${path} → ${res.status}: ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

const asst = (text) => ({ type: "assistant_text_delta", text });
const reason = (text) => ({ type: "reasoning_delta", text });
const tool = (name, input, result) => ({ type: "tool_call", id: `t-${name}-${Math.random().toString(16).slice(2, 6)}`, name, status: "completed", input, result });
const approval = (toolName, description, command) => ({ type: "approval_request", requestId: `a-${Math.random().toString(16).slice(2, 6)}`, toolName, description, input: { command } });

const SCENARIO = {
  party: "Refactor Auth",
  members: [
    {
      name: "backend", model: "claude-sonnet-4.5", role: "API 토큰/인증", status: "working",
      blocks: [
        reason("token lifecycle 를 따라가며 500 의 원인을 추적"),
        asst("추적 결과, verifyRefresh() 가 TokenExpiredError 를 던지는데 가드보다 먼저 발생해 500 으로 표면화됩니다. 401 + 재인증 힌트로 변환하는 게 맞습니다."),
        tool("read_file", { path: "src/auth/refresh.ts" }, "48 export async function verifyRefresh(t){\n49   const p = jwt.verify(t, REFRESH_SECRET)"),
      ],
    },
    {
      name: "frontend", model: "claude-sonnet-4.5", role: "로그인 UI", status: "idle",
      blocks: [asst("backend 의 401 contract 가 확정될 때까지 로그인 플로우 수정을 대기 중입니다.")],
    },
    {
      name: "reviewer", model: "o4-mini", role: "코드 리뷰", status: "idle",
      blocks: [
        asst("src/auth 디프를 리뷰 중입니다. catch 범위가 너무 넓어 다른 예외를 삼킬 위험이 있어 좁은 패치를 권장합니다."),
        approval("apply_patch", "src/auth/refresh.ts 의 catch 를 좁히는 패치를 적용합니다.", "git apply auth-narrow.patch"),
      ],
    },
    {
      name: "tester", model: "gpt-5", role: "회귀 테스트", status: "working",
      blocks: [asst("regression suite 를 실행하는 중입니다. 인증 관련 케이스부터 확인합니다.")],
    },
    {
      name: "db-migrate", model: "deepseek-v3.2", role: "마이그레이션", status: "idle",
      blocks: [asst("토큰 테이블 마이그레이션을 스테이징했고 승인 대기 상태입니다.")],
    },
    { name: "docs", model: "claude-haiku-4", role: "문서화", status: "idle" },
  ],
};

async function main() {
  if (process.argv.includes("--reset")) {
    const reset = await post("/api/qa/reset");
    console.log(`Reset. Remaining members: ${reset.members?.map((m) => m.name).join(", ") || "(none)"}`);
    return;
  }
  await post("/api/qa/reset").catch(() => {});
  const seeded = await post("/api/qa/seed", SCENARIO);
  console.log(`Seeded party '${SCENARIO.party}' with: ${seeded.created.join(", ")}`);
  await post("/api/navigation", { view: "workbench" });
  // Arrange into three watch slots: backend|frontend share a panel (tabs),
  // reviewer|tester another, db-migrate alone.
  await post("/api/qa/open", { panels: [["backend", "frontend"], ["reviewer", "tester"], ["db-migrate"]] });
  await new Promise((r) => setTimeout(r, 600));
  const shot = await post("/api/capture", {});
  console.log(`Captured: ${shot.path} (${shot.width}x${shot.height}, ${shot.bytes} bytes)`);
  console.log("\nNow drive the UI manually: click a member to open it, split a panel,");
  console.log("drag a tab across panels, open the model pill, type in a composer (auto-reply on).");
}

main().catch((error) => {
  console.error("QA driver failed:", error.message);
  console.error("Is the app running with QA enabled? Use: npm run start:qa");
  process.exit(1);
});
