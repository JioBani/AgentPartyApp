#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { parseCsv } = require("./i18n-csv.cjs");

const root = path.resolve(__dirname, "..");
const input = path.resolve(root, process.argv[2] || "docs/user-facing-strings-excel.csv");
const rows = parseCsv(fs.readFileSync(input, "utf8"))
  .filter((row) => (
    (row.confidence === "high" && row.file.startsWith("src/renderer/") && row.kind !== "html-title")
    || /[\uac00-\ud7a3]/u.test(row.text)
  ))
  .sort((left, right) => left.id.localeCompare(right.id));
const rendererRows = rows.filter((row) => row.file.startsWith("src/renderer/"));
const nonRendererRows = rows.filter((row) => !row.file.startsWith("src/renderer/"));

function decodeJsxEntities(value) {
  return value
    .replaceAll("&apos;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function writeCatalog(selectedRows, output, exportName, typeName) {
  const messages = Object.fromEntries(selectedRows.map((row) => {
    const text = row.suggested_text_ko || row.text;
    return [row.id, row.kind === "jsx-text" ? decodeJsxEntities(text) : text];
  }));
  const body = `// Generated from ${path.relative(root, input).split(path.sep).join("/")}. Do not edit by hand.\n`
    + `export const ${exportName} = ${JSON.stringify(messages, null, 2)} as const;\n\n`
    + `export type ${typeName} = keyof typeof ${exportName};\n`;
  fs.writeFileSync(output, body, "utf8");
}

const rendererOutput = path.resolve(root, "src/renderer/i18n/auditKoMessages.ts");
const nonRendererOutput = path.resolve(root, "src/shared/nonRendererKoMessages.ts");
writeCatalog(rendererRows, rendererOutput, "auditKoMessages", "AuditMessageKey");
writeCatalog(nonRendererRows, nonRendererOutput, "nonRendererKoMessages", "NonRendererMessageKey");
console.log(`wrote ${rendererRows.length} renderer messages and ${nonRendererRows.length} non-renderer Korean messages`);
