/*
 * Portability lint for the mobile pipe (06-플랫폼-매트릭스 §검증 방법).
 *
 * The design promise is that `src/main/mobile/**` runs unchanged on Windows,
 * macOS and Linux, and that a WSL workspace needs no special case because the
 * pipe lives in the Windows-side main process and talks to `AppController`.
 * That promise decays silently the first time someone adds a platform branch,
 * so it is checked mechanically instead of by review.
 *
 * Banning Electron imports is the same guarantee from the other direction: the
 * pipe takes its OS services through injected dependencies, which is what keeps
 * it testable (and bundleable) without an Electron runtime.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pipeRoot = path.join(projectRoot, "src/main/mobile");

/** Each rule reports the first capture group as the offending snippet. */
const RULES = [
  {
    id: "platform-branch",
    pattern: /(process\.platform\s*[=!]==?\s*["'][a-z0-9]+["']|["'][a-z0-9]+["']\s*[=!]==?\s*process\.platform)/g,
    reason: "platform equality branch — isolate OS differences behind an injected interface (06 §원칙 1)",
  },
  {
    id: "os-command",
    pattern: /(require\(\s*["']node:child_process["']\s*\)|require\(\s*["']child_process["']\s*\)|from\s+["'](?:node:)?child_process["'])/g,
    reason: "shelling out is OS-specific — the pipe must not run OS commands (06 §검증 방법)",
  },
  {
    id: "electron-import",
    pattern: /(from\s+["']electron["']|require\(\s*["']electron["']\s*\))/g,
    reason: "Electron dependency — take OS services through MobileGatewayDeps so the pipe stays testable off-Electron",
  },
  {
    id: "os-specific-env",
    pattern: /process\.env\.(USERPROFILE|APPDATA|LOCALAPPDATA|HOMEDRIVE|HOMEPATH|ProgramData)\b/g,
    reason: "Windows-only environment variable — the identity/trust store path arrives as MobileGatewayDeps.userDataPath",
  },
  {
    id: "path-flavor",
    pattern: /path\.(win32|posix)\b/g,
    reason: "pinned path flavour — use the platform-neutral node:path API and treat workspace paths as opaque strings",
  },
];

function sourceFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...sourceFiles(full));
    } else if (entry.endsWith(".ts")) {
      found.push(full);
    }
  }
  return found;
}

/** Strips line and block comments so a rule name inside a doc comment is not a hit. */
function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const violations = [];
const files = sourceFiles(pipeRoot);

for (const file of files) {
  const code = withoutComments(readFileSync(file, "utf8"));
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    let match;
    while ((match = rule.pattern.exec(code))) {
      const line = code.slice(0, match.index).split("\n").length;
      violations.push({ file: path.relative(projectRoot, file), line, rule: rule.id, snippet: match[1], reason: rule.reason });
    }
  }
}

console.log(`Mobile pipe portability lint — ${files.length} file(s) under src/main/mobile:`);
if (files.length === 0) {
  console.log("  ✗ no source files found; the lint would pass vacuously");
  process.exit(1);
}
for (const rule of RULES) {
  const hits = violations.filter((violation) => violation.rule === rule.id);
  console.log(`  ${hits.length === 0 ? "✓" : "✗"} ${rule.id}: ${hits.length} violation(s)`);
  for (const hit of hits) {
    console.log(`      ${hit.file}:${hit.line}  ${hit.snippet.trim()}`);
    console.log(`      → ${hit.reason}`);
  }
}

console.log(violations.length ? `\nFAILED (${violations.length})` : "\nAll assertions passed");
process.exit(violations.length ? 1 : 0);
