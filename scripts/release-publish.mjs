#!/usr/bin/env node
// 공개 릴리스 한 방 배포.
//
// 토큰은 릴리스 저장소의 .env(커밋 금지, 이미 gitignore)에서 읽는다.
// 절차: 패키징 → 공개 저장소 업로드 → 릴리스 게시(본문 UTF-8) → 자산 200 확인.
// 자세한 설명은 docs/RELEASE_FAST.md.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const ENV_FILE =
  process.env.AGENTPARTY_RELEASE_ENV ??
  "C:/Project/AgentParty-releases/.env";

function tokenFromEnvFile(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new Error(`릴리스 토큰 파일을 열 수 없습니다: ${file}`);
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(GITHUB|GH_TOKEN|GITHUB_TOKEN)\s*=\s*(.+?)\s*$/.exec(line);
    if (m) return m[2].replace(/^["']|["']$/g, "");
  }
  throw new Error(`${file} 안에 GITHUB= 토큰 줄이 없습니다.`);
}

const version = JSON.parse(readFileSync("package.json", "utf8")).version;
const tag = `v${version}`;
const notesArg = process.argv.indexOf("--notes");
const notes =
  notesArg > -1 ? process.argv[notesArg + 1] : `AgentParty ${version}`;
const skipBuild = process.argv.includes("--skip-build");

const token = tokenFromEnvFile(ENV_FILE);
const env = { ...process.env, GH_TOKEN: token };
const OWNER = "JioBani";
const REPO = "AgentParty-releases";

function run(cmd, args) {
  execFileSync(cmd, args, { stdio: "inherit", env, shell: process.platform === "win32" });
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json; charset=utf-8",
    },
    body: body ? Buffer.from(JSON.stringify(body), "utf8") : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

if (!skipBuild) run("npm", ["run", "build"]);
// draft 릴리스로 올라간다(package.json build.publish.releaseType).
run("npx", ["electron-builder", "--win", "--x64", "--publish", "always"]);

const base = `https://api.github.com/repos/${OWNER}/${REPO}`;
const releases = await api("GET", `${base}/releases?per_page=100`);
const draft = releases.find((r) => r.tag_name === tag);
if (!draft) throw new Error(`${tag} 릴리스를 찾지 못했습니다.`);

// 본문은 앱의 업데이트 대화상자와 설정 → 버전 탭에 그대로 렌더링된다.
const published = await api("PATCH", `${base}/releases/${draft.id}`, {
  name: tag,
  body: notes,
  draft: false,
  prerelease: /-(alpha|beta|rc)\./.test(version),
});

// 익명 다운로드 경로가 실제로 열려 있는지 확인한다.
const feed = published.prerelease ? "beta.yml" : "latest.yml";
const required = [feed, `AgentParty-Setup-${version}.exe`];
const checks = [];
for (const name of required) {
  const url = `https://github.com/${OWNER}/${REPO}/releases/download/${tag}/${encodeURIComponent(name)}`;
  const res = await fetch(url, { redirect: "follow" });
  checks.push(`${res.status} ${name}`);
  if (!res.ok) throw new Error(`공개 다운로드 실패: ${name} → ${res.status}`);
}

console.log(`published ${tag} ${published.html_url}`);
console.log(checks.join("\n"));
console.log("본문 확인:", JSON.stringify(published.body));
