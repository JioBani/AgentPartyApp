#!/usr/bin/env node
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { parseCsv } = require("./i18n-csv.cjs");

const root = path.resolve(__dirname, "..");
const sourceRows = parseCsv(fs.readFileSync(path.join(root, "docs/user-facing-strings-excel.csv"), "utf8"))
  .filter((row) => (
    (row.confidence === "high" && row.file.startsWith("src/renderer/") && row.kind !== "html-title")
    || /[\uac00-\ud7a3]/u.test(row.text)
  ));
const catalogSources = [
  "src/renderer/i18n/auditKoMessages.ts",
  "src/shared/nonRendererKoMessages.ts",
].map((file) => fs.readFileSync(path.join(root, file), "utf8"));
const catalogIds = new Set(catalogSources.flatMap((source) => [...source.matchAll(/"(STR-\d{4})":/g)].map((match) => match[1])));
const usedIds = new Set();
for (const file of walk(path.join(root, "src/renderer"))) {
  if (!file.endsWith(".tsx")) continue;
  const source = fs.readFileSync(file, "utf8");
  for (const match of source.matchAll(/STR-\d{4}/g)) usedIds.add(match[0]);
}

const missingCatalogRows = sourceRows.filter((row) => !catalogIds.has(row.id));
const missingUsedIds = [...usedIds].filter((id) => !catalogIds.has(id));
if (missingCatalogRows.length || missingUsedIds.length) {
  throw new Error(`catalog mismatch: ${missingCatalogRows.length} CSV rows and ${missingUsedIds.length} used ids are missing`);
}

const postAudit = path.join(os.tmpdir(), `agentparty-i18n-audit-${process.pid}.csv`);
try {
  execFileSync(process.execPath, [path.join(root, "scripts/audit-user-facing-strings.cjs"), root, postAudit], { stdio: "ignore" });
  const freshRows = parseCsv(fs.readFileSync(postAudit, "utf8"));
  const directUi = freshRows.filter((row) =>
    row.confidence === "high" && row.file.startsWith("src/renderer/") && !row.file.startsWith("src/renderer/i18n/"),
  );
  if (directUi.length) throw new Error(`renderer still contains ${directUi.length} direct UI strings: ${directUi.map((row) => `${row.file}:${row.line}`).join(", ")}`);
  const sourceSignatures = new Set(sourceRows.flatMap((row) => [
    signature(row),
    row.suggested_text_ko ? signature({ ...row, text: row.suggested_text_ko }) : undefined,
  ].filter(Boolean)));
  const missingKorean = freshRows.filter((row) =>
    /[\uac00-\ud7a3]/u.test(row.text)
    && !sourceSignatures.has(signature(row)),
  );
  if (missingKorean.length) {
    throw new Error(`source inventory is missing ${missingKorean.length} Korean strings: ${missingKorean.slice(0, 20).map((row) => `${row.file}:${row.line}`).join(", ")}`);
  }
} finally {
  fs.rmSync(postAudit, { force: true });
}

console.log(`i18n catalog OK: ${catalogIds.size} catalog keys, ${usedIds.size} keys used by renderer, all audited Korean source strings inventoried`);

function signature(row) {
  return [row.kind, row.file, row.pointer || "", row.text].join("\0");
}

function walk(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(target));
    else files.push(target);
  }
  return files;
}
