/*
 * Sets up a RUNNING QA app for hands-on review of this session's three changes:
 * font picker, Codex `image_view` rendering, and link handling.
 *
 * Not a test — it asserts nothing and leaves the app open. It only builds the
 * fixture a person needs in front of them: real sample files on disk (png, pdf,
 * md, html, txt, json), a transcript full of links grouped by what each SHOULD
 * do, and both the success and failure form of an image view.
 *
 * Point it at an app that is already running:
 *   node scripts/qa-manual-session.mjs [port]
 * The workspace it writes into is whatever that app has open, so launch it with
 * `--workspace <scratch>` first — never against a real project.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.argv[2] || process.env.AGENTPARTY_AUTOMATION_PORT || "48960");
const base = `http://127.0.0.1:${port}`;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(u) { const r = await fetch(`${base}${u}`); return r.json(); }
async function post(u, b) {
  const r = await fetch(`${base}${u}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) });
  return r.json();
}
async function waitForApi() {
  for (let i = 0; i < 60; i++) {
    try { if ((await getJson("/api/health")).ok) return; } catch {}
    await delay(500);
  }
  throw new Error(`No AgentParty automation API on ${base}. Launch the app first.`);
}

/**
 * A minimal but VALID one-page PDF.
 *
 * Written by hand rather than pulled from a fixture because the xref offsets
 * must match the actual bytes — a PDF with stale offsets opens as "damaged" in
 * some viewers and fine in others, which would make a QA result depend on which
 * app the reviewer has installed.
 */
function samplePdf(title) {
  const objects = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 320 120]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>",
    null, // content stream, built below
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
  ];
  const stream = `BT /F1 16 Tf 24 64 Td (${title}) Tj ET`;
  objects[3] = `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`;

  let body = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefAt = body.length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    xref += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  return `${body}${xref}trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefAt}\n%%EOF\n`;
}

/** The sample files, written into the app's open workspace. */
function writeSamples(dir) {
  const files = path.join(dir, "samples");
  fs.mkdirSync(files, { recursive: true });
  fs.writeFileSync(path.join(files, "sample.pdf"), samplePdf("AgentParty QA - sample PDF"));
  fs.writeFileSync(path.join(files, "sample.md"), "# 샘플 마크다운\n\nQA 확인용 파일입니다.\n\n- 항목 1\n- 항목 2\n");
  fs.writeFileSync(
    path.join(files, "sample.html"),
    "<!doctype html><meta charset=utf-8><title>QA 샘플</title><h1>AgentParty QA</h1><p>브라우저에서 열렸다면 성공입니다.</p>\n",
  );
  fs.writeFileSync(path.join(files, "sample.txt"), "AgentParty QA 확인용 텍스트 파일입니다.\n");
  fs.writeFileSync(path.join(files, "sample.json"), JSON.stringify({ app: "AgentParty", purpose: "QA sample" }, null, 2));
  // Must be REVEALED, never run — the point of the executable policy.
  fs.writeFileSync(path.join(files, "danger.ps1"), 'Write-Output "이 스크립트는 실행되면 안 됩니다"\n');
  // A type the machine may well have no handler for → reveal in the file manager.
  fs.writeFileSync(path.join(files, "sample.agentparty-unknown"), "확장자가 등록되지 않은 파일입니다.\n");
  return files;
}

const asst = (text) => ({ type: "assistant_text_delta", text });

/** One `image_view` tool event, exactly as codexAdapter emits it on completion. */
function imageViewEvent(imageContentResult, id, filePath) {
  return {
    type: "tool_call",
    id,
    name: "image_view",
    input: { path: filePath },
    status: "completed",
    result: imageContentResult(filePath),
    source: "image",
  };
}

async function main() {
  await waitForApi();
  const state = await getJson("/api/state");
  const workspace = state.workspace?.path || "";
  if (!workspace) {
    throw new Error("The app reported no workspace.");
  }
  if (path.resolve(workspace).toLowerCase() === path.resolve(root).toLowerCase()) {
    throw new Error(`Refusing to seed into the real project workspace (${workspace}). Relaunch the app with --workspace <scratch>.`);
  }
  console.log(`workspace: ${workspace}`);

  const files = writeSamples(workspace);
  console.log(`samples:   ${files}`);

  const { imageContentResult } = await import(pathToFileURL(path.join(root, "dist", "core", "imageFile.js")).href);

  // A member on the Codex harness — `image_view` is a Codex item, and the beta
  // rejects a Codex model paired with the default claude-code runtime.
  await post("/api/qa/seed", {
    party: "확인",
    members: [{ name: "데모", role: "QA 확인용", runtime: "codex", model: "gpt-5.4", status: "idle" }],
  });
  await post("/api/navigation", { view: "workbench" });
  await post("/api/qa/open", { panels: [["데모"]] });
  await delay(900);

  // A real screenshot of this very window, so the image case shows something
  // recognisable instead of a synthetic swatch.
  const shot = path.join(files, "sample.png");
  await post("/api/capture", { path: shot.replace(/\\/g, "/") });

  const link = (label, target) => `- [${label}](${target})`;
  const web = [
    link("https 링크 (example.com)", "https://example.com"),
    link("스킴 없음 (example.com)", "example.com"),
    link("www 만 (www.example.com/pricing)", "www.example.com/pricing"),
    link("mailto", "mailto:someone@example.com"),
  ].join("\n");
  const local = [
    link("PNG 파일", "./samples/sample.png"),
    link("PDF 파일", "./samples/sample.pdf"),
    link("HTML 파일", "./samples/sample.html"),
    link("Markdown 파일", "./samples/sample.md"),
    link("텍스트 파일", "./samples/sample.txt"),
    link("JSON 파일", "./samples/sample.json"),
    link("`./` 없는 상대 경로", "samples/sample.txt"),
    link("절대 경로", path.join(files, "sample.md").replace(/\\/g, "/")),
  ].join("\n");
  const guarded = [
    link("PowerShell 스크립트 (실행되면 안 됨 — 위치만 표시)", "./samples/danger.ps1"),
    link("등록된 기본 앱이 없는 확장자 (위치 표시)", "./samples/sample.agentparty-unknown"),
    link("없는 파일 (오류 표시)", "./samples/없는파일.pdf"),
  ].join("\n");

  await post("/api/qa/members/데모/emit", {
    events: [
      asst([
        "## 확인 1 — 링크는 기본 앱으로",
        "",
        "**아래 4개는 눌렀을 때 앱 밖(기본 브라우저·메일 앱)에서 열려야 합니다.** 앱 안에 창이 뜨거나 이 화면이 바뀌면 실패입니다.",
        "",
        web,
        "",
        "**아래 로컬 파일 링크는 각 파일의 기본 앱에서 열려야 합니다.** 상대 경로는 이 창의 작업공간 기준으로 풉니다.",
        "",
        local,
        "",
        "**아래 3개는 열리면 안 되는 경우입니다.**",
        "스크립트는 실행하지 않고 파일 관리자에서 위치만 표시, 기본 앱이 없는 확장자도 위치 표시, 없는 파일은 오류 알림이 떠야 합니다.",
        "",
        guarded,
        "",
        "## 확인 2 — Codex 가 연 이미지",
        "",
        "아래 `image_view` 상자는 **접혀 있지 않고 그림이 바로 보여야** 합니다. 두 번째 상자는 없는 파일이라 사유 문장이 보여야 합니다.",
        "",
      ].join("\n")),
    ],
  });
  await delay(400);

  await post("/api/qa/members/데모/emit", {
    events: [
      imageViewEvent(imageContentResult, "qa-image-ok", shot),
      imageViewEvent(imageContentResult, "qa-image-missing", path.join(files, "없는파일.png")),
    ],
  });
  await delay(400);

  await post("/api/qa/members/데모/emit", {
    events: [
      asst([
        "",
        "## 확인 3 — 글꼴",
        "",
        "왼쪽 톱니바퀴(**설정**) → **글꼴** 카드에서 확인하세요.",
        "",
        "- UI 글꼴 / 코드 글꼴을 눌러 목록을 열고, 검색창에 `고딕`·`맑은`·`consol` 을 쳐 보세요.",
        "- 목록의 각 줄이 **그 글꼴로** 그려지는지.",
        "- 코드 글꼴 목록에 비고정폭(맑은 고딕 등)이 안 나오는지.",
        "- 고른 뒤 이 화면 전체가 즉시 바뀌는지.",
        "",
      ].join("\n")),
    ],
  });

  console.log("\nready — 앱 창에서 확인하세요.");
  console.log(`  1) 링크: 웹 4개(브라우저·메일) · 로컬 파일 8개(기본 앱) · 막아야 하는 3개`);
  console.log(`  2) 이미지: image_view 상자 두 개 (성공 1 · 실패 1)`);
  console.log(`  3) 글꼴: 설정(톱니바퀴) → 글꼴`);
  console.log(`\n샘플 파일: ${files}`);
}

main().catch((error) => { console.error(String(error?.message || error)); process.exit(1); });
