/*
 * Full-process e2e for the usage-limit indicator — offline (mock member, no
 * model). Launches the REAL app on an isolated userData + temp workspace and
 * proves, in the actual app path, that provider rate-limit usage injected over
 * `POST /api/qa/usage` is aggregated per provider (merging separate window
 * reports), served by `GET /api/usage`, and pushed to the window so the titlebar
 * pill paints. The renderer's always-visible Claude/Codex empty state is locked
 * by qa-usage-limits; this full-process test captures the real window for visual
 * review and verifies the injected data path end to end.
 */
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElectronE2eApp, delay } from "./lib/electron-e2e.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ws = path.join(os.tmpdir(), "ap-usage-e2e-ws");
const userData = path.join(os.tmpdir(), "ap-usage-e2e-ud");
const port = Number(process.env.AGENTPARTY_USAGE_PORT || "") || 48951;
const failures = [];
const assert = (c, m) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) failures.push(m); };
const app = createElectronE2eApp({ root, workspace: ws, userData, port });
const { get, post } = app;

async function main() {
  await app.prepare();
  try {
    await app.launch();

    // Seed one member to exercise member counts; the pill itself shows both
    // providers even when no provider has members or data.
    await post("/api/qa/reset").catch(() => {});
    await post("/api/qa/seed", { party: "usage", members: [{ name: "worker", role: "r" }] });

    // Empty until the first report: the API never fabricates 0%; the renderer
    // still shows Claude/Codex as loading from the shared view model.
    let usage = (await get("/api/usage")).usage;
    assert(!usage.claude && !usage.codex, "no usage reported yet → empty snapshot (not 0%)");

    // Inject the 5-hour window, then the weekly window SEPARATELY — proving the
    // merge keeps both (real providers report one window at a time).
    const soon = Date.now() + 2 * 3600_000 + 12 * 60_000;
    await post("/api/qa/usage", { provider: "claude", available: true, windows: [{ kind: "five_hour", utilization: 63, resetsAt: soon }] });
    await post("/api/qa/usage", { provider: "claude", windows: [{ kind: "weekly", utilization: 41, resetsAt: Date.now() + 4 * 86400_000 }] });
    await post("/api/qa/usage", { provider: "codex", available: true, windows: [{ kind: "five_hour", utilization: 24 }, { kind: "weekly", utilization: 17 }] });

    usage = (await get("/api/usage")).usage;
    assert(usage.claude?.windows?.length === 2, "claude snapshot merged 5-hour + weekly (separate reports preserved)");
    assert(usage.claude.windows.find((w) => w.kind === "five_hour")?.utilization === 63, "claude 5-hour utilization served");
    assert(usage.claude.windows.find((w) => w.kind === "weekly")?.utilization === 41, "claude weekly utilization served");
    assert(usage.codex?.windows?.length === 2, "codex snapshot has both windows");
    assert(usage.codex.windows.find((w) => w.kind === "five_hour")?.utilization === 24, "codex primary→5-hour utilization served");

    // Updating one window replaces only that window (merge by kind).
    await post("/api/qa/usage", { provider: "claude", windows: [{ kind: "five_hour", utilization: 88 }] });
    usage = (await get("/api/usage")).usage;
    assert(usage.claude.windows.find((w) => w.kind === "five_hour")?.utilization === 88, "re-report updates the 5-hour window");
    assert(usage.claude.windows.find((w) => w.kind === "weekly")?.utilization === 41, "re-report leaves weekly untouched");

    // Let the push settle in the renderer before the screenshot.
    await delay(1500);
    // Capture the titlebar pill + popover for visual reference (not asserted).
    const shot = path.join(os.tmpdir(), "usage-limits.png");
    const cap = await post("/api/capture", { path: shot });
    assert(cap.ok, `captured titlebar usage pill → ${cap.path || shot}`);

    // --- Source-change purge regression (active-source dedupe) -------------
    // Until now QA injection stamped no sourceId, so any seed of Claude or
    // Codex member "won" the active-source slot and its session id was tracked.
    // Closing the only member for a provider must clear the snapshot — that's
    // the "stale rate limit" bug the dedupe fix targets. E2E mode suppresses
    // background polling, so with no foreground session the snapshot is empty.
    await post("/api/qa/usage", { provider: "claude", windows: [{ kind: "five_hour", utilization: 12 }] });
    usage = (await get("/api/usage")).usage;
    assert(usage.claude?.windows?.find((w) => w.kind === "five_hour")?.utilization === 12, "before close: injected 12% on the five-hour window is reflected");

    // The seeded "worker" is the only Claude session. Closing it should
    // release the active-source slot and purge the snapshot.
    await post("/api/party/members/worker/close").catch(() => {});
    usage = (await get("/api/usage")).usage;
    assert(!usage.claude, "after closing the only Claude member: snapshot purged (no stale data)");

    // Re-open the snapshot via QA (the qa source id always passes the filter)
    // — proves the dedupe doesn't lock QA out, only non-active foreground sources.
    await post("/api/qa/usage", { provider: "claude", windows: [{ kind: "five_hour", utilization: 9 }] });
    usage = (await get("/api/usage")).usage;
    assert(usage.claude?.windows?.find((w) => w.kind === "five_hour")?.utilization === 9, "QA bypass re-publishes the snapshot after the purge");

    // Final cleanup: drop the lingering snapshot before we tear down.
    await post("/api/qa/reset").catch(() => {});

    await app.close();
  } catch (error) {
    app.kill();
    throw error;
  }

  console.log("");
  if (failures.length) { console.log(`USAGE LIMITS E2E FAILED: ${failures.length}`); process.exit(1); }
  console.log("USAGE LIMITS E2E PASSED (inject → merge → GET /api/usage → titlebar pill, in the real app)");
}

main().catch((e) => { console.error(e); process.exit(1); });
