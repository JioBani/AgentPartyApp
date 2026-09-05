/*
 * Full-process e2e for the transcript text zoom (Ctrl+wheel feature). The wheel
 * gesture cannot be synthesized over the automation API, so this exercises the
 * SAME path the gesture drives: the `transcriptFontScale` setting. Proves it
 * round-trips + clamps over HTTP, that a change PUSHES to an open window live
 * (settings:update broadcast), and captures the transcript at 100% and 180% so
 * the zoom is visible for review (only `.wb-transcript` scales — the chrome does
 * not). Offline (mock member with a seeded assistant block).
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ws = path.join(os.tmpdir(), "agentparty-font-zoom-ws");
const userData = path.join(os.tmpdir(), "agentparty-font-zoom-ud");
const port = Number(process.env.AGENTPARTY_FONT_ZOOM_PORT || "") || 48951;
const base = `http://127.0.0.1:${port}`;
const outDir = process.env.AGENTPARTY_FONT_ZOOM_OUT || os.tmpdir();
const failures = [];
const assert = (c, m) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) failures.push(m); };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const asst = (text) => ({ type: "assistant_text_delta", text });

async function getJson(u) { const r = await fetch(`${base}${u}`); return r.json(); }
async function post(u, b) { const r = await fetch(`${base}${u}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) }); return r.json(); }
async function waitForApi() { for (let i = 0; i < 120; i++) { try { if ((await getJson("/api/health")).ok) return true; } catch {} await delay(500); } throw new Error("API never came up"); }
function killTree(pid) { if (!pid) return; try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch {} }

async function main() {
  for (const p of [ws, userData]) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }
  fs.mkdirSync(ws, { recursive: true });

  const child = spawn(process.env.ComSpec || "cmd.exe", ["/c", "npm", "run", "start"], {
    cwd: root, stdio: ["ignore", "ignore", "inherit"], windowsHide: true,
    env: {
      ...process.env,
      AGENTPARTY_QA: "1",
      AGENTPARTY_AUTOMATION_PORT: String(port),
      AGENTPARTY_USER_DATA: userData,
      AGENTPARTY_WINDOW_DISPLAY: "left",
    },
  });

  try {
    await waitForApi();
    const windowId = (await getJson("/api/windows")).windows?.[0]?.id;
    assert(Boolean(windowId), "test window discovered");
    await post(`/api/windows/${encodeURIComponent(windowId)}/workspace`, { workspacePath: ws });

    // Seed a party + a mock member with a visible assistant block.
    await post("/api/qa/seed", {
      party: "zoom",
      members: [{ name: "reader", role: "reads", model: "sonnet", status: "idle", blocks: [asst("이 문장은 글씨 크기 확대를 확인하기 위한 트랜스크립트 텍스트입니다.")] }],
    });
    await post("/api/navigation", { view: "workbench" });
    await post("/api/qa/open", { panels: [["reader"]] });
    await delay(800);
    // Direct fixture injection is intentional: this E2E validates rendering,
    // not a party-member action that has an AgentParty MCP tool.
    await post("/api/qa/members/reader/emit", { events: [{
      type: "tool_call", id: "running-tool", name: "Shell", status: "started", input: { command: "echo sharp text" },
    }] });
    await delay(250);

    // Default is 100%.
    const start = (await getJson("/api/state")).settings?.transcriptFontScale;
    assert(start === 1, `default transcriptFontScale is 1 (got ${start})`);
    const shot100 = path.join(outDir, "font-zoom-100.png");
    assert((await post("/api/capture", { path: shot100 })).ok, `captured transcript @100% → ${shot100}`);
    const baseScale = await post("/api/measure", { selector: ".wb-transcript-scale", styles: ["transform", "zoom"], limit: 1 });
    assert(baseScale.elements[0].styles.transform === "none", "100% transcript has no compositor transform");

    // Set the user's actual 110% over HTTP; the open window updates live.
    await post("/api/settings", { transcriptFontScale: 1.1 });
    await delay(700);
    const at110 = (await getJson("/api/state")).settings?.transcriptFontScale;
    assert(at110 === 1.1, `transcriptFontScale round-tripped to 1.1 (got ${at110})`);
    const liveScale = await post("/api/measure", { selector: ".wb-transcript-scale", styles: ["transform", "zoom"], limit: 1 });
    assert(liveScale.elements[0].styles.transform === "none", "110% transcript still has no compositor transform");
    assert(Number(liveScale.elements[0].styles.zoom) === 1.1, `110% transcript uses sharp layout zoom (got ${liveScale.elements[0].styles.zoom})`);
    const rootScale = await post("/api/measure", { selector: "html", attributes: ["data-transcript-font-scaled"], limit: 1 });
    assert(rootScale.elements[0].attributes["data-transcript-font-scaled"] === "", "custom-scale performance guard is active");
    const runningGlyph = await post("/api/measure", { selector: ".wb-tool-check.is-running svg", styles: ["animation-play-state"], limit: 1 });
    assert(runningGlyph.elements[0].styles["animation-play-state"] === "paused", "decorative transcript animation is paused under layout zoom");
    const shot110 = path.join(outDir, "font-zoom-110.png");
    assert((await post("/api/capture", { path: shot110 })).ok, `captured sharp transcript @110% → ${shot110}`);

    // Clamp: out-of-range values are pinned to [0.6, 2.0].
    await post("/api/settings", { transcriptFontScale: 99 });
    assert((await getJson("/api/state")).settings?.transcriptFontScale === 2.0, "over-max clamps to 2.0");
    await post("/api/settings", { transcriptFontScale: 0.1 });
    assert((await getJson("/api/state")).settings?.transcriptFontScale === 0.6, "under-min clamps to 0.6");

    await post("/api/window/close", {});
  } catch (error) {
    console.error(error);
    failures.push(String(error?.message || error));
  } finally {
    killTree(child.pid);
    await delay(500);
    for (const p of [ws, userData]) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }
  }

  console.log("");
  if (failures.length) { console.log(`FONT ZOOM E2E FAILED: ${failures.length}`); process.exit(1); }
  console.log("FONT ZOOM E2E PASSED (sharp layout zoom + performance guard + round-trip/clamp; 100%/110% captured)");
  process.exit(0);
}

main();
