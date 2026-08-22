#!/usr/bin/env node
/*
 * Static inventory of strings that can reach an AgentParty user.
 *
 * This is deliberately an audit, not a source rewriter. High-confidence rows are
 * strings attached directly to JSX or stored in the guide/catalog. Medium rows
 * are human-readable literals in renderer and backend presentation paths; they
 * need a person to confirm whether they are UI, log-only, or raw diagnostics.
 */
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const { parseCsv } = require("./i18n-csv.cjs");

const root = path.resolve(process.argv[2] || process.cwd());
const output = path.resolve(root, process.argv[3] || "docs/user-facing-strings-excel.csv");

const SOURCE_ROOTS = ["src/renderer", "src/shared", "src/core", "src/main", "src/preload"];

/**
 * Directories whose strings never reach a user.
 *
 * `src/renderer/preview` is the design mockup page — a developer surface that is
 * built but never linked from the app. Its captions describe the states being
 * reviewed ("최근 목록의 마지막 항목은 시작할 수 없는 배포판"), and putting them
 * in the product's translation inventory would ask a translator to localize
 * notes to ourselves.
 *
 * `src/renderer/studio` is the design system and app mockup — the same kind of
 * surface for the same reason: its own vite document, never linked from the app,
 * and its text IS the design documentation ("좁은 폭은 기능을 빼는 것이 아니라
 * 같은 블록을 다시 흐르게 한다"). The components it MOUNTS are the shipping ones,
 * so their strings are still audited where they live.
 */
const SKIP_DIRS = ["src/renderer/preview", "src/renderer/studio"];
const GUIDE_ROOT = "guide/knowledge";
const CATALOG_FILE = "src/shared/modelCatalog.json";

const UI_ATTRIBUTE_NAMES = new Set([
  "alt", "aria-label", "caption", "description", "detail", "emptyText", "error",
  "help", "hint", "label", "message", "note", "placeholder", "recovery", "subtitle",
  "summary", "text", "title", "tooltip",
]);

const CATALOG_TEXT_KEYS = new Set([
  "description", "displayName", "label", "name", "note", "reason", "summary",
  "unavailableReason",
]);

const SKIP_JSX_ATTRIBUTES = new Set([
  "className", "data-testid", "data-view", "href", "id", "key", "role", "style",
]);

const BACKEND_PRESENTATION_FILES = new Set([
  "src/core/claudeAdapter.ts",
  "src/core/codexAdapter.ts",
  "src/core/cursorAdapter.ts",
  "src/core/grokAdapter.ts",
  "src/main/authService.ts",
  "src/main/environmentService.ts",
  "src/main/sessionManager.ts",
  "src/shared/appUpdate.ts",
  "src/shared/codexApproval.ts",
  "src/shared/codexDiagnostics.ts",
  "src/shared/diagnostics.ts",
  "src/shared/guide.ts",
  "src/shared/memberDisplayStatus.ts",
  "src/shared/messageGate.ts",
  "src/shared/partyPrimer.ts",
  "src/shared/transcriptEvents.ts",
  "src/shared/usageLimits.ts",
]);

const GENERATED_I18N_FILES = new Set([
  "src/renderer/i18n/auditKoMessages.ts",
  "src/renderer/i18n/messages.ts",
  "src/shared/nonRendererKoMessages.ts",
]);

const rows = [];

function posix(file) {
  return file.split(path.sep).join("/");
}

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function clean(value) {
  return value.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function hasHumanText(value) {
  if (!value || value.length < 2) return false;
  if (/[\uac00-\ud7a3]/u.test(value)) return true;
  if (/[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(value)) return true;
  return /^(Apply|Cancel|Close|Cost|Default|Full Access|Inherit|Members|Message Gate|On|Off|Parties|Read Only|Runtime|Send|Stop|Workbench)$/i.test(value);
}

function obviousCode(value) {
  if (!value) return true;
  if (/^(?:[.#]|--|[a-z]+:\/\/)/i.test(value)) return true;
  if (/^[a-z0-9_.:/-]+$/i.test(value) && !hasHumanText(value)) return true;
  if (/(?:var\(--|rgba?\(|linear-gradient\(|minmax\(|repeat\(|\b\d+(?:\.\d+)?(?:px|fr)\b)/i.test(value)) return true;
  if (/^(?:const|let|var|function|return|import|export)\b/m.test(value) && /[;{}()]/.test(value)) return true;
  if (/^(?:M|m)\d+(?:[ .,-]?\d+)+(?:[A-Za-z]\d+(?:[ .,-]?\d+)*)+$/.test(value)) return true;
  if (/^(?:var\(|linear-gradient\(|repeat\(|minmax\(|rgba?\()/i.test(value)) return true;
  return false;
}

function templateText(node, sourceFile) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    for (const span of node.templateSpans) value += "${…}" + span.literal.text;
    return value;
  }
  if (ts.isJsxText(node)) return node.text;
  return node.getText(sourceFile);
}

function nearestJsxAttribute(node) {
  let current = node.parent;
  while (current) {
    if (ts.isJsxAttribute(current)) return current;
    if (ts.isJsxElement(current) || ts.isJsxSelfClosingElement(current)) return undefined;
    current = current.parent;
  }
  return undefined;
}

function isModuleSpecifier(node) {
  return (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent))
    && node.parent.moduleSpecifier === node;
}

function add(row) {
  const text = clean(row.text);
  if (!text || obviousCode(text)) return;
  rows.push({ ...row, text });
}

function auditTypeScript(relativeFile) {
  if (GENERATED_I18N_FILES.has(relativeFile)) return;
  const absolute = path.join(root, relativeFile);
  const source = fs.readFileSync(absolute, "utf8");
  const sourceFile = ts.createSourceFile(
    relativeFile,
    source,
    ts.ScriptTarget.Latest,
    true,
    relativeFile.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const renderer = relativeFile.startsWith("src/renderer/");
  const backendPresentation = BACKEND_PRESENTATION_FILES.has(relativeFile);

  function visit(node) {
    const literal = ts.isStringLiteral(node)
      || ts.isNoSubstitutionTemplateLiteral(node)
      || ts.isTemplateExpression(node)
      || ts.isJsxText(node);
    if (literal && !isModuleSpecifier(node)) {
      const text = templateText(node, sourceFile);
      const attribute = nearestJsxAttribute(node);
      const attributeName = attribute?.name.getText(sourceFile);
      const jsxText = ts.isJsxText(node);
      const directUi = jsxText || Boolean(attributeName && UI_ATTRIBUTE_NAMES.has(attributeName));
      const skippedAttribute = Boolean(attributeName && SKIP_JSX_ATTRIBUTES.has(attributeName));

      if (directUi && !skippedAttribute && hasHumanText(text)) {
        add({
          surface: "renderer-ui",
          confidence: "high",
          kind: jsxText ? "jsx-text" : `jsx-${attributeName}`,
          file: relativeFile,
          line: lineOf(sourceFile, node),
          text,
        });
      } else if (renderer && !skippedAttribute && hasHumanText(text)) {
        add({
          surface: "renderer-candidate",
          confidence: "medium",
          kind: ts.isTemplateExpression(node) ? "template" : "literal",
          file: relativeFile,
          line: lineOf(sourceFile, node),
          text,
        });
      } else if ((backendPresentation || /[\uac00-\ud7a3]/u.test(text)) && hasHumanText(text)) {
        add({
          surface: relativeFile.startsWith("src/shared/")
            ? "shared-presentation"
            : relativeFile.startsWith("src/renderer/")
              ? "renderer-candidate"
              : "backend-message",
          confidence: "medium",
          kind: ts.isTemplateExpression(node) ? "template" : "literal",
          file: relativeFile,
          line: lineOf(sourceFile, node),
          text,
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

function walk(relativeDir) {
  const absoluteDir = path.join(root, relativeDir);
  if (!fs.existsSync(absoluteDir)) return [];
  const found = [];
  for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
    const relative = posix(path.join(relativeDir, entry.name));
    if (entry.isDirectory()) {
      if (SKIP_DIRS.includes(relative)) continue;
      found.push(...walk(relative));
    }
    else if (/\.tsx?$/.test(entry.name)) found.push(relative);
  }
  return found;
}

function auditGuideMarkdown() {
  for (const relativeFile of walkMarkdown(GUIDE_ROOT)) {
    const lines = fs.readFileSync(path.join(root, relativeFile), "utf8").split(/\r?\n/);
    let inFence = false;
    for (let index = 0; index < lines.length; index += 1) {
      const original = lines[index];
      if (/^```/.test(original.trim())) {
        inFence = !inFence;
        continue;
      }
      const text = original
        .replace(/^#{1,6}\s+/, "")
        .replace(/^(?:[-*>]\s+|\|\s?)/, "")
        .replace(/\|/g, " ")
        .trim();
      if (!inFence && hasHumanText(text)) {
        add({ surface: "guide-knowledge", confidence: "high", kind: "markdown", file: relativeFile, line: index + 1, text });
      }
    }
  }
}

function walkMarkdown(relativeDir) {
  const absoluteDir = path.join(root, relativeDir);
  if (!fs.existsSync(absoluteDir)) return [];
  const found = [];
  for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
    const relative = posix(path.join(relativeDir, entry.name));
    if (entry.isDirectory()) found.push(...walkMarkdown(relative));
    else if (entry.name.endsWith(".md")) found.push(relative);
  }
  return found;
}

function auditCatalog() {
  const absolute = path.join(root, CATALOG_FILE);
  if (!fs.existsSync(absolute)) return;
  const source = fs.readFileSync(absolute, "utf8");
  const parsed = JSON.parse(source);
  let searchFrom = 0;
  function visit(value, key, pointer) {
    if (typeof value === "string" && CATALOG_TEXT_KEYS.has(key) && hasHumanText(value)) {
      const encoded = JSON.stringify(value);
      const offset = source.indexOf(encoded, searchFrom);
      if (offset >= 0) searchFrom = offset + encoded.length;
      const line = offset >= 0 ? source.slice(0, offset).split("\n").length : 1;
      add({ surface: "model-catalog", confidence: "high", kind: `json-${key}`, file: CATALOG_FILE, line, text: value, pointer });
      return;
    }
    if (Array.isArray(value)) value.forEach((item, index) => visit(item, String(index), `${pointer}/${index}`));
    else if (value && typeof value === "object") {
      for (const [childKey, child] of Object.entries(value)) visit(child, childKey, `${pointer}/${childKey}`);
    }
  }
  visit(parsed, "", "");
}

function auditHtml() {
  const htmlFiles = [];
  function collect(relativeDir) {
    const absoluteDir = path.join(root, relativeDir);
    if (!fs.existsSync(absoluteDir)) return;
    for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
      const relative = posix(path.join(relativeDir, entry.name));
      if (entry.isDirectory()) {
        if (SKIP_DIRS.includes(relative)) continue;
        collect(relative);
      }
      else if (entry.name.endsWith(".html")) htmlFiles.push(relative);
    }
  }
  collect("src/renderer");
  for (const relativeFile of htmlFiles) {
    const source = fs.readFileSync(path.join(root, relativeFile), "utf8");
    for (const match of source.matchAll(/<title>([^<]+)<\/title>/gi)) {
      const line = source.slice(0, match.index).split("\n").length;
      add({ surface: "renderer-html", confidence: "high", kind: "html-title", file: relativeFile, line, text: match[1] });
    }
  }
}

for (const sourceRoot of SOURCE_ROOTS) {
  for (const file of walk(sourceRoot)) auditTypeScript(file);
}
auditGuideMarkdown();
auditCatalog();
auditHtml();

rows.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.text.localeCompare(b.text));
const seen = new Set();
const unique = rows.filter((row) => {
  const key = `${row.surface}\0${row.file}\0${row.line}\0${row.text}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

function csv(value) {
  const text = value == null ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function stableKey(row) {
  return [row.kind, row.file, row.pointer || "", row.text].join("\0");
}

const existingSource = fs.existsSync(output) ? fs.readFileSync(output, "utf8") : "";
const existingRows = existingSource ? parseCsv(existingSource) : [];
const existingHeaders = existingSource
  ? existingSource.replace(/^\uFEFF/, "").slice(0, existingSource.indexOf("\n")).match(/"([^"]+)"/g)?.map((value) => value.slice(1, -1)) || []
  : [];
const existingQueues = new Map();
const suggestedQueues = new Map();
for (const row of existingRows) {
  const key = stableKey(row);
  if (!existingQueues.has(key)) existingQueues.set(key, []);
  existingQueues.get(key).push(row);
  if (row.suggested_text_ko) {
    const suggestedKey = stableKey({ ...row, text: row.suggested_text_ko });
    if (!suggestedQueues.has(suggestedKey)) suggestedQueues.set(suggestedKey, []);
    suggestedQueues.get(suggestedKey).push(row);
  }
}
let nextId = existingRows.reduce((max, row) => Math.max(max, Number.parseInt(row.id?.replace(/^STR-/, ""), 10) || 0), 0) + 1;
const matchedIds = new Set();
function takeUnmatched(queue, key) {
  const candidates = queue.get(key) || [];
  while (candidates.length && matchedIds.has(candidates[0].id)) candidates.shift();
  return candidates.shift();
}
const audited = unique.map((row) => {
  const key = stableKey(row);
  let previous = takeUnmatched(existingQueues, key) || takeUnmatched(suggestedQueues, key);
  let correctedLegacyMarkdown = false;
  if (!previous && row.kind === "markdown" && row.text.startsWith("**")) {
    previous = takeUnmatched(existingQueues, stableKey({ ...row, text: row.text.slice(1) }));
    correctedLegacyMarkdown = Boolean(previous);
  }
  const id = previous?.id || `STR-${String(nextId++).padStart(4, "0")}`;
  matchedIds.add(id);
  return { ...previous, ...row, text: correctedLegacyMarkdown ? row.text : previous?.text || row.text, id };
});
// Extracted call sites no longer contain their original literal. Retain their
// stable catalog rows so copy editing and generated IDs never break.
const retained = existingRows.filter((row) => !matchedIds.has(row.id));
const outputRows = [...retained, ...audited].sort((left, right) => left.id.localeCompare(right.id));
const requiredHeader = ["id", "surface", "confidence", "kind", "file", "line", "pointer", "text"];
const header = [...requiredHeader, ...existingHeaders.filter((name) => !requiredHeader.includes(name))];
const lines = [header.map(csv).join(",")];
outputRows.forEach((row) => {
  lines.push(header.map((name) => csv(row[name] || "")).join(","));
});

fs.mkdirSync(path.dirname(output), { recursive: true });
// Excel on Korean Windows otherwise guesses CP949 and renders UTF-8 Korean as
// mojibake. The BOM is intentional and remains valid UTF-8 for other readers.
fs.writeFileSync(output, `\uFEFF${lines.join("\r\n")}\r\n`, "utf8");

const counts = unique.reduce((all, row) => {
  all[row.surface] = (all[row.surface] || 0) + 1;
  return all;
}, {});
const existingIds = new Set(existingRows.map((row) => row.id));
console.log(JSON.stringify({ output, total: outputRows.length, audited: unique.length, retained: retained.length, added: audited.filter((row) => !existingIds.has(row.id)).length, counts }, null, 2));
