/* Real Electron renderer QA for Codex inline directives. The seeded event is
 * only a transcript fixture; clicks and geometry use the live app/API. */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { firstBaseUrl } from "./lib/discovery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const qaRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentparty-codex-directives-"));
const ws = path.join(qaRoot, "workspace");
const userData = path.join(qaRoot, "user-data");
const shotDir = path.join(qaRoot, "shots");
for (const dir of [ws, userData, shotDir]) fs.mkdirSync(dir);
fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ workspacePath: ws }));

const filename = "01_임강현_이력서_포트폴리오.pdf";
const filePath = path.join(ws, filename);
fs.writeFileSync(filePath, "%PDF-1.4\n% QA fixture\n");
const suggestion = "제출 전에 이력서와 공고를 대조해줘.";
const answer = [
  "제출 파일을 준비했습니다.",
  "",
  `- 이력서·포트폴리오: :codex-file-citation{path="${filePath}" purpose="output"}`,
  "- 자기소개서: :codex-file-citation{path=02_자기소개서.pdf purpose=output}",
  "",
  "다음 작업을 이어갈 수 있습니다.",
  "",
  `- :codex-followup[최종 제출 점검]{prompt="${suggestion}"}`,
].join("\n");
const failures = [];
const ok = (condition, message) => {
  console.log(`${condition ? "ok" : "FAIL"} ${message}`);
  if (!condition) failures.push(message);
};
let base = "";

const child = spawn(process.env.ComSpec || "cmd.exe", ["/c", "npm", "run", "start"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
  env: { ...process.env, AGENTPARTY_QA: "1", AGENTPARTY_ALLOW_MULTI_INSTANCE: "1", AGENTPARTY_USER_DATA: userData, AGENTPARTY_AUTOMATION_PORT: "" },
});
child.stderr.on("data", (chunk) => process.stderr.write(chunk));

try {
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    base = firstBaseUrl(ws) || "";
    if (base) {
      try { if ((await get("/api/health")).ok) break; } catch { /* starting */ }
    }
    await delay(500);
  }
  if (!base) throw new Error("QA app did not start");
  const appRoot = (await get("/api/state")).runtime?.appRoot || "";
  ok((appRoot + path.sep).toLowerCase().startsWith(root.toLowerCase() + path.sep), `running this worktree: ${appRoot}`);
  const windows = (await get("/api/windows")).windows || [];
  ok(windows[0]?.workspacePath?.toLowerCase() === ws.toLowerCase(), "isolated QA workspace");

  await post("/api/qa/seed", { party: "Codex directive QA", members: [{ name: "codex-qa", runtime: "codex", model: "gpt-5.4-mini", autoReply: false, blocks: [{ type: "assistant_text_delta", text: answer }, { type: "turn_complete", result: "ok" }] }] });
  await post("/api/navigation", { view: "workbench" });
  await post("/api/qa/open", { panels: [["codex-qa"]] });
  await delay(700);

  for (const width of [720, 1280]) {
    await post("/api/qa/window/bounds", { width, height: width === 720 ? 720 : 880 });
    for (const theme of ["light", "dark"]) {
      const themeId = `agentparty-${theme}`;
      await post("/api/appearance/theme", { theme: themeId });
      ok((await get("/api/appearance/theme")).applied === themeId, `theme applied: ${themeId}`);
      await delay(250);
      const shot = path.join(shotDir, `${width}-${theme}.png`);
      const capture = await post("/api/capture", { path: shot });
      ok(capture.bytes > 0, `captured ${width}px ${theme} UI`);
      const citations = await post("/api/measure", { selector: ".wb-md-citation", containedBy: ".wb-panel", limit: 5 });
      ok(citations.count === 2 && citations.elements.every((item) => item.containedBy?.fully), `${width}px ${theme}: file controls are inside panel`);
      const followups = await post("/api/measure", { selector: ".wb-md-followup", containedBy: ".wb-panel", limit: 5 });
      ok(followups.count === 1 && followups.elements[0].containedBy?.fully, `${width}px ${theme}: follow-up action is inside panel`);
      const body = await post("/api/measure", { selector: ".wb-assistant-body", limit: 5 });
      ok(!body.elements[0].scrollable.horizontal, `${width}px ${theme}: no horizontal overflow in answer`);
    }
  }
  const labels = await post("/api/measure", { selector: ".wb-md-citation a, .wb-md-followup", limit: 5 });
  ok(labels.texts.includes(filename) && labels.texts.includes("최종 제출 점검"), "controls have readable labels");
  const click = await post("/api/capture", { click: ".wb-md-followup", path: path.join(shotDir, "followup-sent.png") });
  ok(click.applied?.clicked === true, "follow-up clicked in real app");
  await delay(500);
  const sent = await post("/api/measure", { selector: ".wb-user-bubble", limit: 5 });
  ok(sent.texts.some((text) => text.includes(suggestion)), "follow-up uses existing member send workflow");
  await post("/api/window/close", {}).catch(() => {});
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(10_000)]);
} finally {
  if (child.exitCode === null && child.pid) {
    try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* already stopped */ }
  }
}

console.log(`Screenshots: ${shotDir}`);
console.log(failures.length ? `CODEX DIRECTIVE E2E FAILED (${failures.length})` : "CODEX DIRECTIVE E2E PASSED");
process.exitCode = failures.length ? 1 : 0;

async function get(route) {
  const response = await fetch(base + route);
  if (!response.ok) throw new Error(`${route} ${response.status}: ${await response.text()}`);
  return response.json();
}
async function post(route, body) {
  const response = await fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${route} ${response.status}: ${await response.text()}`);
  return response.json();
}
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
