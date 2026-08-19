#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const { parseCsv } = require("./i18n-csv.cjs");

const root = path.resolve(__dirname, "..");
const write = process.argv.includes("--write");
const rows = parseCsv(fs.readFileSync(path.join(root, "docs/user-facing-strings-excel.csv"), "utf8"))
  .filter((row) => row.suggested_text_ko && isGuideSource(row.file));

function isGuideSource(file) {
  return file.startsWith("guide/knowledge/")
    || file.startsWith("src/renderer/guide/")
    || file.startsWith("src/shared/guide")
    || file.startsWith("src/main/guide");
}

function clean(value) {
  return value.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function markdownText(line) {
  return clean(line
    .replace(/^#{1,6}\s+/, "")
    .replace(/^(?:[-*>]\s+|\|\s?)/, "")
    .replace(/\|/g, " "));
}

function distance(left, right) {
  const a = [...left];
  const b = [...right];
  const previous = Array.from({ length: b.length + 1 }, (_value, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[b.length] / Math.max(1, a.length, b.length);
}

function splitTableSuggestion(originalCells, suggestion) {
  const tokens = suggestion.split(/\s+/).filter(Boolean);
  const memo = new Map();
  function best(cellIndex, tokenIndex) {
    const key = `${cellIndex}:${tokenIndex}`;
    if (memo.has(key)) return memo.get(key);
    if (cellIndex === originalCells.length) return tokenIndex === tokens.length ? { cost: 0, parts: [] } : undefined;
    const cellsLeft = originalCells.length - cellIndex - 1;
    let answer;
    for (let end = tokenIndex + 1; end <= tokens.length - cellsLeft; end += 1) {
      const part = tokens.slice(tokenIndex, end).join(" ");
      const tail = best(cellIndex + 1, end);
      if (!tail) continue;
      const candidate = { cost: distance(clean(originalCells[cellIndex]), clean(part)) + tail.cost, parts: [part, ...tail.parts] };
      if (!answer || candidate.cost < answer.cost) answer = candidate;
    }
    memo.set(key, answer);
    return answer;
  }
  const result = best(0, 0);
  if (!result) throw new Error(`Could not preserve Markdown table columns for: ${suggestion}`);
  return result.parts;
}

function applyMarkdown(fileRows) {
  const absolute = path.join(root, fileRows[0].file);
  const source = fs.readFileSync(absolute, "utf8");
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  const changes = [];
  for (const row of fileRows) {
    const expected = clean(row.text);
    const suggested = clean(row.suggested_text_ko);
    const malformedBold = row.suggested_text_ko.startsWith("**") ? `*${row.suggested_text_ko}` : undefined;
    let index = malformedBold ? lines.findIndex((line) => line.includes(malformedBold)) : -1;
    if (index >= 0) {
      const before = lines[index];
      lines[index] = before.replace(malformedBold, row.suggested_text_ko);
      changes.push({ id: row.id, file: row.file, line: index + 1, before, after: lines[index] });
      continue;
    }
    index = lines.findIndex((line) => line.includes(row.suggested_text_ko));
    if (index >= 0) continue;
    index = lines.findIndex((line) => markdownText(line) === expected);
    if (index < 0) index = lines.findIndex((line) => markdownText(line) === suggested);
    if (index < 0) throw new Error(`${row.id}: Markdown source not found in ${row.file}`);
    if (markdownText(lines[index]) === suggested) continue;
    const before = lines[index];
    const legacyBold = row.text.startsWith("*") && !row.text.startsWith("**") && before.includes(`*${row.text}`)
      ? `*${row.text}`
      : undefined;
    if (legacyBold) {
      lines[index] = before.replace(legacyBold, row.suggested_text_ko);
    } else if (before.includes(row.text)) {
      lines[index] = before.replace(row.text, row.suggested_text_ko);
    } else if (before.includes("|")) {
      const cells = before.split("|").map((cell) => cell.trim()).filter(Boolean);
      const replacements = splitTableSuggestion(cells, row.suggested_text_ko);
      lines[index] = `| ${replacements.join(" | ")} |`;
    } else {
      throw new Error(`${row.id}: unsupported Markdown shape in ${row.file}:${index + 1}`);
    }
    changes.push({ id: row.id, file: row.file, line: index + 1, before, after: lines[index] });
  }
  if (write && changes.length) fs.writeFileSync(absolute, lines.join(newline), "utf8");
  return changes;
}

function isModuleSpecifier(node) {
  return (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent)) && node.parent.moduleSpecifier === node;
}

function templateText(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    for (const span of node.templateSpans) value += "${…}" + span.literal.text;
    return value;
  }
  if (ts.isJsxText(node)) return node.text;
  return "";
}

function escapeTemplate(value) {
  return value.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

function replacementFor(node, suggestion, sourceFile) {
  if (ts.isStringLiteral(node)) return JSON.stringify(suggestion);
  if (ts.isNoSubstitutionTemplateLiteral(node)) return `\`${escapeTemplate(suggestion)}\``;
  if (ts.isJsxText(node)) return suggestion.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const parts = suggestion.split("${…}");
  if (parts.length !== node.templateSpans.length + 1) {
    throw new Error(`Template placeholder count changed at ${sourceFile.fileName}:${sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
  }
  let value = "`";
  for (let index = 0; index < node.templateSpans.length; index += 1) {
    value += `${escapeTemplate(parts[index])}\${${node.templateSpans[index].expression.getText(sourceFile)}}`;
  }
  return `${value}${escapeTemplate(parts.at(-1))}\``;
}

function applyTypeScript(fileRows) {
  const relative = fileRows[0].file;
  const absolute = path.join(root, relative);
  const source = fs.readFileSync(absolute, "utf8");
  const sourceFile = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, relative.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const candidates = [];
  function visit(node) {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node) || ts.isJsxText(node)) && !isModuleSpecifier(node)) {
      candidates.push({ node, text: clean(templateText(node)), line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1 });
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  const used = new Set();
  const edits = [];
  const skipped = [];
  for (const row of fileRows) {
    if (source.includes(row.id)) {
      skipped.push(row.id);
      continue;
    }
    const original = clean(row.text);
    const suggested = clean(row.suggested_text_ko);
    const matches = candidates
      .map((candidate, index) => ({ ...candidate, index }))
      .filter((candidate) => !used.has(candidate.index) && (candidate.text === original || candidate.text === suggested))
      .sort((left, right) => Math.abs(left.line - Number(row.line)) - Math.abs(right.line - Number(row.line)));
    const match = matches[0];
    if (!match) throw new Error(`${row.id}: TypeScript source not found in ${relative}`);
    used.add(match.index);
    if (match.text === suggested) continue;
    edits.push({
      id: row.id,
      file: relative,
      line: match.line,
      start: match.node.getStart(sourceFile),
      end: match.node.getEnd(),
      replacement: replacementFor(match.node, row.suggested_text_ko, sourceFile),
    });
  }
  let output = source;
  for (const edit of [...edits].sort((left, right) => right.start - left.start)) {
    output = output.slice(0, edit.start) + edit.replacement + output.slice(edit.end);
  }
  if (write && edits.length) fs.writeFileSync(absolute, output, "utf8");
  return { edits, skipped };
}

const byFile = new Map();
for (const row of rows) {
  if (!byFile.has(row.file)) byFile.set(row.file, []);
  byFile.get(row.file).push(row);
}

const markdownChanges = [];
const typeScriptChanges = [];
let localizedCallSites = 0;
for (const fileRows of byFile.values()) {
  fileRows.sort((left, right) => Number(left.line) - Number(right.line));
  if (fileRows[0].kind === "markdown") markdownChanges.push(...applyMarkdown(fileRows));
  else {
    const result = applyTypeScript(fileRows);
    typeScriptChanges.push(...result.edits);
    localizedCallSites += result.skipped.length;
  }
}

console.log(JSON.stringify({
  mode: write ? "write" : "dry-run",
  reviewed: rows.length,
  markdownChanges: markdownChanges.length,
  typeScriptChanges: typeScriptChanges.length,
  alreadyLocalizedCallSites: localizedCallSites,
  markdownTableChanges: markdownChanges.filter((change) => change.before.includes("|")).map((change) => change),
}, null, 2));
