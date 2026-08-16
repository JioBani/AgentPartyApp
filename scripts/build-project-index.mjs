/*
 * Builds `index.html` for the screens project — the page it opens on.
 *
 * A project full of loose HTML files has nothing to show when you open it: the
 * files are all there and the project still reads as empty. This is the contact
 * sheet: every captured screen, grouped, with its name and what it shows, each
 * one a link into the real page.
 *
 * Entries come from the pages' own `@dsCard` markers, so the index cannot list
 * a screen that is not there or miss one that is.
 *
 * Run after link-design-project.mjs:
 *   node scripts/build-project-index.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT_DIR = path.join(root, "build", "design-project");
const dsArg = process.argv.indexOf("--ds");
const DS_SLUG = dsArg > 0
  ? process.argv[dsArg + 1]
  : process.env.DESIGN_SYSTEM_SLUG
  || "agentparty-design-system-as-built-18fbdba3-0e2b-4008-9606-4c6b11063246";

const SECTIONS = [
  { dir: "workbench", title: "Workbench", note: "멤버를 탭으로 열고 패널을 나눠 여러 세션을 한 화면에서 다루는 기본 화면." },
  { dir: "screens", title: "Screens", note: "런타임 설정(탭별) · 토큰 사용량 · 세션 · 인증 · 자동화." },
  { dir: "modals", title: "Modals", note: "모델·추론을 고르는 Runtime, 압축 대화상자, 게이트, 멤버 만들기, 명령 팔레트." },
  { dir: "transcript", title: "Transcript", note: "대화를 이루는 블록들 — 사용자 메시지, 모델 답변, 도구 실행, 계획." },
  { dir: "cards", title: "상태 카드", note: "승인·질문·압축·환경 카드가 실제로 받는 상태들. 전부 실제 하네스 기록에서 나온 페이로드." },
];

function pages(dir) {
  const full = path.join(PROJECT_DIR, dir);
  if (!fs.existsSync(full)) return [];
  return fs.readdirSync(full).filter((name) => name.endsWith(".html")).sort();
}

function cardOf(relative) {
  const head = fs.readFileSync(path.join(PROJECT_DIR, relative), "utf8").slice(0, 400);
  const marker = head.match(/^<!--\s*@dsCard\s+([^>]*?)-->/);
  const attributes = {};
  if (marker) {
    for (const [, key, value] of marker[1].matchAll(/(\w+)="([^"]*)"/g)) attributes[key] = value;
  }
  return attributes;
}

function main() {
  const sizes = fs.existsSync(path.join(PROJECT_DIR, "_sizes.json"))
    ? JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, "_sizes.json"), "utf8"))
    : {};

  let total = 0;
  const sections = SECTIONS.map((section) => {
    const entries = pages(section.dir).map((name) => {
      const relative = `${section.dir}/${name}`;
      const card = cardOf(relative);
      total += 1;
      return `      <a class="ix-item" href="${relative}">
        <span class="ix-name">${card.name || name.replace(/\.html$/, "")}</span>
        <span class="ix-sub">${card.subtitle || ""}</span>
        <span class="ix-size">${sizes[relative] || ""}</span>
      </a>`;
    });
    if (entries.length === 0) return "";
    return `  <section class="ix-section">
    <h2 class="ix-title">${section.title} <span class="ix-count">${entries.length}</span></h2>
    <p class="ix-note">${section.note}</p>
    <div class="ix-grid">
${entries.join("\n")}
    </div>
  </section>`;
  }).filter(Boolean);

  const html = `<!DOCTYPE html>
<html lang="ko" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentParty Desktop — 화면</title>
<link rel="stylesheet" href="_ds/${DS_SLUG}/foundations/tokens.css">
<link rel="stylesheet" href="_ds/${DS_SLUG}/app/design-system.css">
<link rel="stylesheet" href="_ds/${DS_SLUG}/app/styles.css">
<style>
  body { margin: 0; padding: 32px 36px 56px; background: var(--bg-0); color: var(--text-0); font-family: var(--font-sans); }
  .ix-head { margin: 0 0 30px; }
  .ix-head h1 { margin: 0 0 8px; font-size: 21px; }
  .ix-head p { margin: 0; font-size: 12.5px; color: var(--text-2); max-width: 74ch; line-height: 1.6; }
  .ix-head code { font-family: var(--font-mono); font-size: 11.5px; color: var(--text-1); }
  .ix-section { margin: 0 0 30px; }
  .ix-title { margin: 0 0 4px; font-size: 12px; font-weight: 700; letter-spacing: .6px; text-transform: uppercase; color: var(--text-2); }
  .ix-count { display: inline-flex; align-items: center; height: 16px; padding: 0 6px; margin-left: 6px; border-radius: var(--radius-badge); background: var(--bg-3); border: var(--border-width) solid var(--border-subtle); color: var(--text-3); font-size: 10px; }
  .ix-note { margin: 0 0 12px; font-size: 12px; color: var(--text-3); max-width: 74ch; }
  .ix-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(248px, 1fr)); gap: 10px; }
  .ix-item { display: flex; flex-direction: column; gap: 3px; padding: 12px 14px; background: var(--bg-2); border: var(--border-width) solid var(--border-subtle); border-radius: var(--radius-card); text-decoration: none; }
  .ix-item:hover { border-color: var(--accent-bd); background: var(--accent-dim); }
  .ix-name { font-size: 13px; font-weight: 600; color: var(--text-0); }
  .ix-sub { font-size: 11.5px; color: var(--text-2); }
  .ix-size { font-family: var(--font-mono); font-size: 10px; color: var(--text-3); }
</style>
</head>
<body>
  <header class="ix-head">
    <h1>AgentParty Desktop</h1>
    <p>실행 중인 앱에서 그대로 떠온 화면 ${total}장. 스타일은 자기 사본이 아니라
    <code>_ds/${DS_SLUG}</code> 의 디자인 시스템을 링크하므로, 시스템의 토큰이 바뀌면 이
    화면들도 함께 바뀝니다. 다시 그린 것이 아니라 <b>as built</b> 입니다.</p>
  </header>
${sections.join("\n")}
</body>
</html>
`;

  fs.writeFileSync(path.join(PROJECT_DIR, "index.html"), html);
  console.log(`index.html → ${total} screens across ${sections.length} sections`);
}

main();
