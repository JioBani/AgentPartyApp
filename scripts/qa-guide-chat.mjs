import { parseGuideSlideMarkers, resolveGuideModel } from "../dist/shared/guideChat.js";
import { buildGuidePrimer } from "../dist/shared/guidePrimer.js";
import { resolveGuideKnowledgeDir } from "../dist/main/guideKnowledge.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
function assert(condition, message) {
  if (!condition) {
    failures.push(message);
    console.log(`  ✗ ${message}`);
  } else {
    console.log(`  ✓ ${message}`);
  }
}

const parts = parseGuideSlideMarkers("여긴 [[slide:2]] 이고 [[slide:99]] 는 없음", 10);
assert(parts.some((part) => part.kind === "slide" && part.index === 2), "in-range marker is a button");
assert(parts.some((part) => part.kind === "invalid" && part.index === 99), "out-of-range marker is invalid, not dropped");

const primer = buildGuidePrimer({ knowledgeDir: "C:/guide/knowledge", language: "ko", kind: "chatbot" });
assert(primer.includes("C:/guide/knowledge"), "primer names the knowledge folder");
assert(primer.includes("index.md"), "primer tells the model to read index.md");
assert(!/파티가 무엇인지|Message Gate 가 무엇을/.test(primer), "primer does not summarize the md");
assert(primer.includes("문제 해결"), "primer hands live-app questions to 문제 해결");
assert(!primer.includes("GUIDE-MD-CANARY-7F3A"), "primer does not contain the knowledge-file canary");
const costMd = fs.readFileSync(path.join(root, "guide", "knowledge", "cost.md"), "utf8");
assert(costMd.includes("GUIDE-MD-CANARY-7F3A"), "cost.md holds the verification canary");
assert(/검증용/.test(costMd), "canary is labelled 검증용 so it is not a product fact");

const slidePrimer = buildGuidePrimer({
  knowledgeDir: "C:/guide/knowledge",
  language: "ko",
  kind: "slide",
  viewing: { index: 4, title: "멤버끼리 메시지", scene: "여러 상태" },
});
assert(slidePrimer.includes("slide 4"), "slide primer names the current slide");

assert(resolveGuideModel({ harnessId: "claude-code", language: "ko" }).model.includes("opus-5"), "Claude default is Opus 5");
assert(resolveGuideModel({ harnessId: "codex", language: "ko" }).model.includes("5.6"), "Codex default is GPT-5.6 Sol");
let missing = "";
try {
  resolveGuideModel({ harnessId: "cursor", language: "ko" });
} catch (error) {
  missing = String(error.message);
}
assert(/기본 모델이 없습니다/.test(missing), "Cursor has no silent default model");

const devDir = resolveGuideKnowledgeDir({ packaged: false, appPath: root });
assert(fs.existsSync(path.join(devDir, "index.md")), `dev knowledge resolves to ${devDir}`);
const packaged = resolveGuideKnowledgeDir({ packaged: true, resourcesPath: "C:/resources", appPath: root });
assert(packaged.replaceAll("\\", "/").endsWith("guide/knowledge"), "packaged path is extraResources guide/knowledge");

if (failures.length) {
  console.error(`FAILED ${failures.length}\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("OK");
