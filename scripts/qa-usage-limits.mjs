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
import { qaTempDir } from "./lib/qaTemp.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const qaDir = qaTempDir();

const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };

async function loadModule(entry, name) {
  const out = path.join(qaDir, name);
  await build({ entryPoints: [path.join(projectRoot, entry)], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  return import(pathToFileURL(out).href);
}

// --- 1) pure logic --------------------------------------------------------
const U = await loadModule("src/shared/usageLimits.ts", "usage-limits.mjs");
const { mergeWindows, mergeProviderUsage, usageLevelColor, formatResetCountdown, toEpochMs, buildUsageView, providerOfRuntime, providerOfHarness, reconcileUsageTargets, restoreUsageSnapshot } = U;

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

const restored = restoreUsageSnapshot({
  claude: { provider: "claude", available: true, updatedAt: 900, windows: [
    { kind: "five_hour", utilization: 13, resetsAt: 2000 },
    { kind: "weekly", utilization: 48, resetsAt: 500 },
  ] },
  codex: { provider: "wrong-provider", updatedAt: 900, windows: [{ kind: "weekly", utilization: 23 }] },
}, 1000);
assert(restored.claude?.windows.length === 1 && restored.claude.windows[0].utilization === 13, "restart cache keeps valid windows and removes expired periods");
assert(!restored.codex, "restart cache rejects a provider-mismatched snapshot");

// provider mapping (runtime + harness → usage provider)
console.log("\nBackground usage poller — provider mapping:");
assert(providerOfRuntime("codex") === "codex", "codex runtime → codex");
assert(providerOfRuntime("claude-code") === "claude", "claude-code runtime → claude");
assert(providerOfRuntime("claude") === "claude", "claude runtime → claude");
assert(providerOfRuntime("cursor") === "cursor", "cursor runtime → cursor");
assert(providerOfRuntime("grok") === "grok", "grok runtime → grok");
assert(providerOfRuntime("mock") === undefined, "unknown runtime → no provider");
assert(providerOfHarness("codex") === "codex" && providerOfHarness("claude-code") === "claude" && providerOfHarness("cursor") === "cursor", "harness id → provider");

// cursor plan-usage mapping (GetCurrentPeriodUsage → monthly window)
const CU = await loadModule("src/core/cursorUsage.ts", "cursor-usage.mjs");
console.log("\nCursor plan usage mapping:");
const cursorWin = CU.cursorUsageWindow({ billingCycleEnd: "1779578902000", planUsage: { limit: 2000, remaining: 200, totalPercentUsed: 90 } });
assert(cursorWin?.kind === "monthly" && cursorWin.utilization === 90, "server percent wins → 90% monthly window");
assert(cursorWin?.resetsAt === 1779578902000, "billingCycleEnd (epoch ms string) becomes resetsAt");
const derived = CU.cursorUsageWindow({ planUsage: { limit: 1000, remaining: 250 } });
assert(derived?.utilization === 75, "no server percent → derived from limit-remaining (75%)");
assert(CU.cursorUsageWindow({ planUsage: {} }) === undefined, "no usable numbers → no window (never faked)");
assert(CU.cursorUsageWindow({}) === undefined, "missing planUsage → no window");

const GU = await loadModule("src/core/grokUsage.ts", "grok-usage.mjs");
console.log("\nGrok subscription usage mapping:");
const grokWin = GU.grokUsageWindow({ config: {
  creditUsagePercent: 14,
  currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-08-09T16:10:35Z", end: "2026-08-16T16:10:35Z" },
} });
assert(grokWin?.kind === "weekly" && grokWin.utilization === 14, "Grok credit percent becomes a weekly meter");
assert(grokWin?.resetsAt === Date.parse("2026-08-16T16:10:35Z"), "Grok period end becomes resetsAt");
assert(GU.grokUsageWindow({ config: { creditUsagePercent: 5 } }) === undefined, "Grok response without a known period is not fabricated");

// reconcileUsageTargets — the pure background-poller decision
console.log("\nBackground usage poller — reconcile decision:");
const R = (o) => reconcileUsageTargets({ backoffUntil: {}, now: 1000, ...o });
let d = R({ desired: ["claude", "codex"], liveProviders: [], running: [] });
assert(d.start.join() === "claude,codex" && d.dispose.length === 0, "desired providers with no session → start both");
d = R({ desired: ["claude"], liveProviders: ["claude"], running: [] });
assert(d.start.length === 0 && d.dispose.length === 0, "a live session for the provider → no background poller (reused)");
d = R({ desired: ["claude"], liveProviders: ["claude"], running: ["claude"] });
assert(d.dispose.join() === "claude" && d.start.length === 0, "session opened while bg poller ran → dispose the duplicate");
d = R({ desired: ["claude"], liveProviders: [], running: ["claude", "codex"] });
assert(d.dispose.join() === "codex" && d.start.length === 0, "provider no longer used (no members) → dispose its poller");
d = R({ desired: ["codex"], liveProviders: [], running: [], backoffUntil: { codex: 5000 }, now: 1000 });
assert(d.start.length === 0, "a backed-off provider is not restarted before its retry time");
d = R({ desired: ["codex"], liveProviders: [], running: [], backoffUntil: { codex: 5000 }, now: 6000 });
assert(d.start.join() === "codex", "past the backoff window → restart is allowed");
d = R({ desired: ["claude", "codex", "cursor", "grok"], liveProviders: [], running: [] });
assert(d.start.join() === "claude,codex,cursor,grok", "all titlebar providers resolve even with no party members");

// available derivation: reported windows are ground truth. Claude's proactive
// usage read can answer "not available for this auth mode" on the very account
// whose live rate_limit_events feed real meters — that report must not stamp
// N/A over the real data (the "사용량 정보를 읽을 수 없습니다 over 30%" bug).
const masked = mergeProviderUsage(
  { provider: "claude", available: true, windows: [{ kind: "five_hour", utilization: 30 }], updatedAt: 1 },
  { provider: "claude", available: false, windows: [], updatedAt: 2 },
);
assert(masked.available === true && masked.windows.length === 1, "an available:false report with no windows does NOT mask real windows");
const firstNa = mergeProviderUsage(undefined, { provider: "claude", available: false, windows: [], updatedAt: 1 });
assert(firstNa.available === false, "a first available:false report with no windows still reads N/A (honest for API-key auth)");
const windowsWin = mergeProviderUsage(
  { provider: "claude", available: false, windows: [], updatedAt: 1 },
  { provider: "claude", windows: [{ kind: "weekly", utilization: 14 }], updatedAt: 2 },
);
assert(windowsWin.available === true, "real windows arriving later flip available back to true");

// logged-out CLI (e.g. Cursor without `cursor-agent login`)
const outFirst = mergeProviderUsage(undefined, { provider: "cursor", windows: [], loggedOut: true, updatedAt: 1 });
assert(outFirst.loggedOut === true, "a logged-out empty report marks the provider loggedOut");
const outOverStale = mergeProviderUsage(
  { provider: "cursor", available: true, windows: [{ kind: "monthly", utilization: 40 }], updatedAt: 1 },
  { provider: "cursor", windows: [], loggedOut: true, updatedAt: 2 },
);
assert(outOverStale.loggedOut === true, "a mid-session logout overrides the stale meter kept by mergeWindows");
const backIn = mergeProviderUsage(outFirst, { provider: "cursor", windows: [{ kind: "monthly", utilization: 12 }], updatedAt: 3 });
assert(backIn.loggedOut === undefined, "real windows clear loggedOut (login happened)");
const outKept = mergeProviderUsage(outFirst, { provider: "cursor", windows: [], updatedAt: 4 });
assert(outKept.loggedOut === true, "an empty report without the flag (e.g. network error) keeps loggedOut");
const outRestored = restoreUsageSnapshot({ cursor: { provider: "cursor", windows: [], loggedOut: true, updatedAt: Date.now() } }, Date.now());
assert(outRestored.cursor?.loggedOut === true, "restart cache keeps the loggedOut state");

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
assert(view.pills.length === 4, "one pill per provider (claude · codex · cursor · grok)");
assert(view.pills[0].pctLabel === "63%" && view.pills[0].pctCol === "#c5835f", "claude pill shows 63% in brand color");
assert(view.pills[0].ring.includes("63%"), "claude ring conic-gradient reflects 63%");
assert(view.rows[0].sub === "3명 사용" && view.rows[1].sub === "2명 사용", "member counts shown per provider");
assert(view.rows[0].meters[0].right === "63% · 2시간 12분 후 리셋", "5-hour meter right label includes countdown");
assert(view.anyHigh === false && view.empty === false, "no window ≥75 → anyHigh false; has data → not empty");

// buildUsageView — high triggers border warning
const high = buildUsageView({ claude: { provider: "claude", available: true, updatedAt: now, windows: [{ kind: "five_hour", utilization: 82 }] } }, { claude: 1 }, now);
assert(high.anyHigh === true, "a window ≥75 sets anyHigh (pill warning border)");
assert(high.pills[0].pctCol === "var(--live)", "82% pill percent uses warning color");

// buildUsageView — unknown (no data yet)
const unknown = buildUsageView({}, { claude: 1 }, now);
assert(unknown.pills.length === 4 && unknown.pills.every((pill) => pill.pctLabel === "—"), "providers with no data → pill shows — (not 0%)");
assert(unknown.pills[0].ring === "var(--bg-4)", "unknown ring is a muted track, no fabricated fill");
assert(unknown.rows[0].meters[0].known === false && unknown.rows[0].meters[0].right === "불러오는 중…", "unknown meter reads loading, not a number");
assert(unknown.empty === true, "no window data anywhere → empty");

// buildUsageView — not applicable (API key)
const na = buildUsageView({ claude: { provider: "claude", available: false, updatedAt: now, windows: [] } }, { claude: 1 }, now);
assert(na.pills[0].pctLabel === "N/A", "available:false → N/A pill");
assert(na.rows[0].meters[0].right === "해당 없음 (API 키)", "available:false meter says 해당 없음");

// buildUsageView — logged-out CLI
const loggedOutView = buildUsageView(
  { cursor: { provider: "cursor", loggedOut: true, updatedAt: now, windows: [{ kind: "monthly", utilization: 40 }] } },
  { cursor: 1 },
  now,
);
const loggedOutPill = loggedOutView.pills.find((p) => p.key === "cursor");
const loggedOutRow = loggedOutView.rows.find((r) => r.key === "cursor");
assert(loggedOutPill.pctLabel === "로그아웃", "loggedOut → 로그아웃 pill (not — or a stale %)");
assert(loggedOutRow.meters[0].right === "로그아웃 상태 — CLI 로그인 필요", "loggedOut meter says 로그아웃 상태");
assert(loggedOutRow.meters[0].known === false && loggedOutRow.meters[0].pctWidth === "0%", "loggedOut hides the stale meter fill");

// buildUsageView — a provider reporting ONLY its weekly window must not pill "—"
const weeklyOnly = buildUsageView(
  { codex: { provider: "codex", available: true, updatedAt: now, windows: [{ kind: "weekly", utilization: 100 }] } },
  { codex: 1 },
  now,
);
assert(weeklyOnly.pills.find((pill) => pill.key === "codex").pctLabel === "100%", "pill falls back to the weekly window when 5-hour is absent");

// buildUsageView — cursor renders ONLY its monthly plan meter
const cursorView = buildUsageView(
  { cursor: { provider: "cursor", available: true, updatedAt: now, windows: [{ kind: "monthly", utilization: 42, resetsAt: now + 3 * 86400_000 }] } },
  { cursor: 1 },
  now,
);
const cursorRow = cursorView.rows.find((row) => row.key === "cursor");
assert(cursorRow.meters.length === 1 && cursorRow.meters[0].kind === "monthly", "cursor row shows one plan meter (no fake 5h/weekly rows)");
assert(cursorRow.meters[0].right.startsWith("42%"), "cursor plan meter shows the utilization");
assert(cursorView.pills.find((pill) => pill.key === "cursor").pctLabel === "42%", "cursor pill donut uses the monthly meter");

// buildUsageView — fully empty still shows every provider as loading
const empty = buildUsageView({}, {}, now);
assert(empty.pills.length === 4 && empty.rows.length === 4, "no data + no members → every provider still visible");

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
  let refreshed = 0;
  root.render(React.createElement(UsageLimitPill, { ...props, onOpenSettings: () => { settingsOpened++; }, onRefresh: () => { refreshed++; } }));
  return { getSettingsOpened: () => settingsOpened, getRefreshed: () => refreshed };
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
  var mounted = mount(window.document.getElementById("root"), { usage: renderSnapshot, membersByProvider: { claude: 3, codex: 2 } });
  await new Promise((r) => setTimeout(r, 120));
} catch (e) { crashed = e; }
assert(!crashed, `render did not throw${crashed ? `: ${crashed.stack || crashed}` : ""}`);

const root = window.document.getElementById("root");
assert(root.querySelectorAll(".usage-seg").length === 4, "pill renders one segment per provider");
assert(root.querySelectorAll(".usage-seg .wb-harness-icon").length === 4, "each pill segment carries its harness icon");
assert((root.textContent || "").includes("63%"), "pill shows the 5-hour percent");
assert(root.querySelector(".usage-pop") === null, "popover closed until clicked");

// open the popover
window.document.querySelector(".usage-pill").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await new Promise((r) => setTimeout(r, 60));
const pop = root.querySelector(".usage-pop");
assert(Boolean(pop), "clicking the pill opens the popover");
assert(root.querySelectorAll(".usage-meter").length === 6, "popover shows Claude/Codex windows plus Cursor and Grok meters (2+2+1+1)");
assert(root.querySelectorAll(".usage-row-header .wb-harness-icon").length === 4, "each popover row leads with its harness icon");
assert((pop?.textContent || "").includes("5시간 한도") && (pop?.textContent || "").includes("주간 한도"), "both window labels rendered");
assert((pop?.textContent || "").includes("2시간 12분 후 리셋"), "reset countdown rendered in the meter");
const refreshBtn = [...root.querySelectorAll(".usage-settings-btn")].find((button) => /새로고침/.test(button.textContent || ""));
assert(Boolean(refreshBtn), "popover includes a usage refresh button");
refreshBtn?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
assert(mounted.getRefreshed() === 1, "clicking refresh calls the usage refresh handler");

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
