/*
 * Usage-limit indicator test (offline, no Electron):
 *   1) Pure logic in src/shared/usageLimits.ts — window merge, level-color
 *      escalation, reset-countdown formatting, epoch normalization, and the full
 *      buildUsageView view model (known / unknown / N/A / empty states).
 *   2) A jsdom render of <UsageLimitPill> — pill segments paint, clicking opens
 *      the popover with 5-hour + weekly meters, and the ≥75% warning border.
 * Catches both selector regressions and component runtime crashes a typecheck
 * cannot. See docs/디자인 핸드오프/design_handoff_usage_limits.
 */
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const qaDir = path.join(projectRoot, "node_modules/.qa");
mkdirSync(qaDir, { recursive: true });

const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };

async function loadModule(entry, name) {
  const out = path.join(qaDir, name);
  await build({ entryPoints: [path.join(projectRoot, entry)], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  return import(pathToFileURL(out).href);
}

// --- 1) pure logic --------------------------------------------------------
const U = await loadModule("src/shared/usageLimits.ts", "usage-limits.mjs");
const { mergeWindows, mergeProviderUsage, usageLevelColor, formatResetCountdown, toEpochMs, buildUsageView } = U;

console.log("\nUsage-limit pure logic:");

// epoch normalization
assert(toEpochMs(1751907200) === 1751907200000, "toEpochMs promotes epoch seconds to ms");
assert(toEpochMs(1751907200000) === 1751907200000, "toEpochMs leaves epoch ms untouched");
assert(toEpochMs(0) === undefined && toEpochMs(undefined) === undefined, "toEpochMs rejects 0 / undefined (no fake reset)");

// level escalation
assert(usageLevelColor(50, "#c5835f") === "#c5835f", "pct<75 → brand color");
assert(usageLevelColor(74.9, "#c5835f") === "#c5835f", "74.9 still brand");
assert(usageLevelColor(75, "#c5835f") === "var(--live)", "75 → warning (--live)");
assert(usageLevelColor(90, "#c5835f") === "var(--danger)", "90 → critical (--danger)");
assert(usageLevelColor(undefined, "#c5835f") === "var(--text-3)", "unknown pct → muted, not brand");

// countdown
assert(formatResetCountdown(2 * 3600_000 + 12 * 60_000, 0) === "2시간 12분", "countdown shows top-two units (h+m)");
assert(formatResetCountdown((4 * 86400 + 6 * 3600) * 1000, 0) === "4일 6시간", "countdown shows d+h for multi-day");
assert(formatResetCountdown(1000, 5000) === "곧", "already-elapsed reset → 곧");
assert(formatResetCountdown(undefined, 0) === undefined, "no reset → undefined");

// merge by kind (preserve unreported window)
const merged = mergeProviderUsage(
  { provider: "claude", windows: [{ kind: "five_hour", utilization: 10 }, { kind: "weekly", utilization: 40 }], updatedAt: 1 },
  { provider: "claude", windows: [{ kind: "five_hour", utilization: 63 }], updatedAt: 2 },
);
assert(merged.windows.find((w) => w.kind === "five_hour").utilization === 63, "merge updates the reported window");
assert(merged.windows.find((w) => w.kind === "weekly").utilization === 40, "merge preserves the unreported weekly window");
assert(mergeWindows(undefined, [{ kind: "weekly", utilization: 5 }]).length === 1, "mergeWindows tolerates no prior state");

// buildUsageView — normal
const now = 1_000_000_000_000;
const snapshot = {
  claude: { provider: "claude", available: true, updatedAt: now, windows: [
    { kind: "five_hour", utilization: 63, resetsAt: now + (2 * 3600 + 12 * 60) * 1000 },
    { kind: "weekly", utilization: 41, resetsAt: now + (4 * 86400 + 6 * 3600) * 1000 },
  ] },
  codex: { provider: "codex", available: true, updatedAt: now, windows: [
    { kind: "five_hour", utilization: 24 },
    { kind: "weekly", utilization: 17 },
  ] },
};
const view = buildUsageView(snapshot, { claude: 3, codex: 2 }, now);
assert(view.pills.length === 2, "two provider pills built");
assert(view.pills[0].pctLabel === "63%" && view.pills[0].pctCol === "#c5835f", "claude pill shows 63% in brand color");
assert(view.pills[0].ring.includes("63%"), "claude ring conic-gradient reflects 63%");
assert(view.rows[0].sub === "3명 사용" && view.rows[1].sub === "2명 사용", "member counts shown per provider");
assert(view.rows[0].meters[0].right === "63% · 2시간 12분 후 리셋", "5-hour meter right label includes countdown");
assert(view.anyHigh === false && view.empty === false, "no window ≥75 → anyHigh false; has data → not empty");

// buildUsageView — high triggers border warning
const high = buildUsageView({ claude: { provider: "claude", available: true, updatedAt: now, windows: [{ kind: "five_hour", utilization: 82 }] } }, { claude: 1 }, now);
assert(high.anyHigh === true, "a window ≥75 sets anyHigh (pill warning border)");
assert(high.pills[0].pctCol === "var(--live)", "82% pill percent uses warning color");

// buildUsageView — unknown (member, no data yet)
const unknown = buildUsageView({}, { claude: 1 }, now);
assert(unknown.pills.length === 1 && unknown.pills[0].pctLabel === "—", "member with no data → pill shows — (not 0%)");
assert(unknown.pills[0].ring === "var(--bg-4)", "unknown ring is a muted track, no fabricated fill");
assert(unknown.rows[0].meters[0].known === false && unknown.rows[0].meters[0].right === "불러오는 중…", "unknown meter reads loading, not a number");
assert(unknown.empty === true, "no window data anywhere → empty");

// buildUsageView — not applicable (API key)
const na = buildUsageView({ claude: { provider: "claude", available: false, updatedAt: now, windows: [] } }, { claude: 1 }, now);
assert(na.pills[0].pctLabel === "N/A", "available:false → N/A pill");
assert(na.rows[0].meters[0].right === "해당 없음 (API 키)", "available:false meter says 해당 없음");

// buildUsageView — fully empty
assert(buildUsageView({}, {}, now).pills.length === 0, "no data + no members → no pill at all");

// --- 2) jsdom render of <UsageLimitPill> ----------------------------------
const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
const { window } = dom;
for (const [k, v] of Object.entries({
  window,
  document: window.document,
  HTMLElement: window.HTMLElement,
  navigator: window.navigator,
  MouseEvent: window.MouseEvent,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 0),
  cancelAnimationFrame: clearTimeout,
})) {
  try { Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true }); } catch { /* read-only */ }
}

const entry = `
import React from "react";
import { createRoot } from "react-dom/client";
import { UsageLimitPill } from "../workbench/UsageLimitPill";
export function mount(el, props) {
  const root = createRoot(el);
  let settingsOpened = 0;
  root.render(React.createElement(UsageLimitPill, { ...props, onOpenSettings: () => { settingsOpened++; } }));
  return { getSettingsOpened: () => settingsOpened };
}
`;
const result = await build({
  stdin: { contents: entry, resolveDir: path.join(projectRoot, "src/renderer/qa"), loader: "tsx" },
  bundle: true, format: "esm", platform: "browser", jsx: "automatic",
  loader: { ".css": "empty" }, define: { "process.env.NODE_ENV": '"development"' }, write: false,
});
const bundlePath = path.join(qaDir, "usagePillEntry.mjs");
writeFileSync(bundlePath, result.outputFiles[0].text);
const { mount } = await import(pathToFileURL(bundlePath).href);

console.log("\nUsageLimitPill render:");
// The component computes countdowns against the real Date.now(), so anchor the
// render fixture's resets to real time (the pure-logic block above already
// verified the fake-clock math).
const realNow = Date.now();
const renderSnapshot = {
  claude: { provider: "claude", available: true, updatedAt: realNow, windows: [
    { kind: "five_hour", utilization: 63, resetsAt: realNow + (2 * 3600 + 12 * 60) * 1000 },
    { kind: "weekly", utilization: 41, resetsAt: realNow + (4 * 86400 + 6 * 3600) * 1000 },
  ] },
  codex: { provider: "codex", available: true, updatedAt: realNow, windows: [
    { kind: "five_hour", utilization: 24 },
    { kind: "weekly", utilization: 17 },
  ] },
};
let crashed = null;
try {
  mount(window.document.getElementById("root"), { usage: renderSnapshot, membersByProvider: { claude: 3, codex: 2 } });
  await new Promise((r) => setTimeout(r, 120));
} catch (e) { crashed = e; }
assert(!crashed, `render did not throw${crashed ? `: ${crashed.stack || crashed}` : ""}`);

const root = window.document.getElementById("root");
assert(root.querySelectorAll(".usage-seg").length === 2, "pill renders one segment per provider");
assert((root.textContent || "").includes("63%"), "pill shows the 5-hour percent");
assert(root.querySelector(".usage-pop") === null, "popover closed until clicked");

// open the popover
window.document.querySelector(".usage-pill").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await new Promise((r) => setTimeout(r, 60));
const pop = root.querySelector(".usage-pop");
assert(Boolean(pop), "clicking the pill opens the popover");
assert(root.querySelectorAll(".usage-meter").length === 4, "popover shows 5h + weekly meter per provider (2×2)");
assert((pop?.textContent || "").includes("5시간 한도") && (pop?.textContent || "").includes("주간 한도"), "both window labels rendered");
assert((pop?.textContent || "").includes("2시간 12분 후 리셋"), "reset countdown rendered in the meter");

// warning border when high (fresh container — avoid double-rooting #root)
const highHost = window.document.createElement("div");
window.document.body.appendChild(highHost);
try {
  mount(highHost, { usage: { claude: { provider: "claude", available: true, updatedAt: now, windows: [{ kind: "five_hour", utilization: 82 }] } }, membersByProvider: { claude: 1 } });
  await new Promise((r) => setTimeout(r, 80));
} catch (e) { crashed = e; }
const pill = highHost.querySelector(".usage-pill");
assert(Boolean(pill) && /--live/.test(pill.getAttribute("style") || ""), "≥75% usage paints the warning border (--live)");

console.log("");
if (failures.length) { console.log(`USAGE LIMITS TEST FAILED: ${failures.length}`); process.exit(1); }
console.log("USAGE LIMITS TEST PASSED");
// Mounted components keep a 30s setInterval alive; exit explicitly so the run ends.
process.exit(0);
