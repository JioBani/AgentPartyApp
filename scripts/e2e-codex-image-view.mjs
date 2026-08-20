/*
 * Full-process e2e for the two image-display intents:
 * - AgentParty attach-image MCP: immediately show the user.
 * - Codex native imageView: keep inspection evidence collapsed until opened.
 *
 * Codex reports its built-in image viewer as an `imageView` item, which the
 * adapter turns into an `image_view` tool carrying the path and picture. The
 * picture belongs inside that disclosure, unlike the explicit attach-image MCP
 * which normalizes to a dedicated transcript image block.
 *
 * This drives the REAL app and the REAL production function: the result payload
 * injected here is built by `imageContentResult` from dist, the exact call
 * `codexAdapter` makes for an `imageView` item. So a regression in either half —
 * the payload the adapter produces, or the transcript's rendering of it — fails
 * this test. Offline: no model call, and no dependency on coaxing a live Codex
 * turn into using its image viewer.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ws = path.join(os.tmpdir(), "agentparty-codex-image-ws");
const userData = path.join(os.tmpdir(), "agentparty-codex-image-ud");
const port = Number(process.env.AGENTPARTY_CODEX_IMAGE_PORT || "") || 48963;
const base = `http://127.0.0.1:${port}`;
const outDir = process.env.AGENTPARTY_CODEX_IMAGE_OUT || os.tmpdir();
const failures = [];
const assert = (c, m) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) failures.push(m); };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(u) { const r = await fetch(`${base}${u}`); return r.json(); }
async function post(u, b) { const r = await fetch(`${base}${u}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) }); return r.json(); }
async function waitForApi() { for (let i = 0; i < 120; i++) { try { if ((await getJson("/api/health")).ok) return true; } catch {} await delay(500); } throw new Error("API never came up"); }
function killTree(pid) { if (!pid) return; try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch {} }

/** A real 4x4 PNG on disk — the file the "Codex" member will view. */
function writeSamplePng(target) {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAHElEQVQI12P4//8/w38GIAXDIBKE0DHxgljNBAAO9TXL0Y4OHwAAAABJRU5ErkJggg==",
    "base64",
  );
  fs.writeFileSync(target, png);
  return png.byteLength;
}

/** The `image_view` tool event exactly as codexAdapter emits it on completion. */
function imageViewEvent(imageContentResult, filePath) {
  return {
    type: "tool_call",
    id: "codex-image-view-1",
    name: "image_view",
    input: { path: filePath },
    status: "completed",
    result: imageContentResult(filePath),
    source: "image",
  };
}

async function main() {
  for (const p of [ws, userData]) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }
  fs.mkdirSync(ws, { recursive: true });

  // The production helper, from the built output — not a copy of its logic.
  const { imageContentResult } = await import(pathToFileURL(path.join(root, "dist", "core", "imageFile.js")).href);
  assert(typeof imageContentResult === "function", "loaded imageContentResult from dist/core/imageFile.js");

  const imagePath = path.join(ws, "codex-viewed.png");
  const pngBytes = writeSamplePng(imagePath);

  // --- the payload the adapter builds -----------------------------------
  const payload = imageContentResult(imagePath);
  assert(Array.isArray(payload) && payload[0]?.type === "image", "a readable image becomes an image content block");
  assert(payload[0]?.mimeType === "image/png", `the media type comes from the file (${payload[0]?.mimeType})`);
  assert(typeof payload[0]?.data === "string" && payload[0].data.length > 0, `the block carries the bytes (${pngBytes} B on disk)`);
  // Failures must SAY so — an empty result reproduces the bug being fixed.
  const missing = imageContentResult(path.join(ws, "no-such-file.png"));
  assert(typeof missing === "string" && /No such file/i.test(missing), `a missing file returns a stated reason (${String(missing).slice(0, 48)}…)`);
  fs.writeFileSync(path.join(ws, "notes.txt"), "not an image");
  const notImage = imageContentResult(path.join(ws, "notes.txt"));
  assert(typeof notImage === "string" && /not a supported image/i.test(notImage),
    `a real file that is not an image returns a stated reason (${String(notImage).slice(0, 56)}…)`);
  assert(imageContentResult("") === undefined, "an empty path adds no result at all");

  // `--workspace` so the window OPENS on the scratch folder. Switching it after
  // launch is not enough: party state lives inside the workspace, so the window
  // would first load the real project's parties — and a QA seed would land in
  // the developer's own store. Passed at launch, this run never touches it.
  const child = spawn(process.env.ComSpec || "cmd.exe", ["/c", "npm", "run", "start", "--", "--workspace", ws], {
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
    const opened = (await getJson("/api/state")).workspace?.path || "";
    assert(opened.replace(/\\/g, "/").toLowerCase() === ws.replace(/\\/g, "/").toLowerCase(),
      `window opened on the scratch workspace (${opened})`);

    // `runtime: "codex"` — the member must really be on the Codex harness, both
    // because this bug is Codex-specific and because the beta rejects a Codex
    // model paired with the default claude-code runtime.
    const seed = await post("/api/qa/seed", { party: "codex-image", members: [{ name: "viewer", role: "views images", runtime: "codex", model: "gpt-5.4", status: "idle" }] });
    assert(seed?.ok === true && (seed.created || []).includes("viewer"), `qa seed created 'viewer' (${JSON.stringify(seed).slice(0, 200)})`);
    await post("/api/navigation", { view: "workbench" });
    const openedPanels = await post("/api/qa/open", { panels: [["viewer"]] });
    assert(openedPanels?.ok !== false, `qa open accepted the panel (${JSON.stringify(openedPanels).slice(0, 160)})`);
    await delay(1200);
    // Fail here rather than measuring an empty transcript later: every assertion
    // below is meaningless if the member's panel never opened.
    const panel = await post("/api/measure", { selector: ".wb-panel-title, .wb-tab-name", limit: 20 });
    assert(panel.ok && (panel.texts || []).some((t) => t.includes("viewer")), `the 'viewer' panel is open (${(panel.texts || []).join(", ") || "no panels"})`);

    // AgentParty's attach-image MCP exists specifically to show the USER a
    // picture. It is normalized to kind:"image" (not a tool box) and must keep
    // its immediate display behavior while native inspection becomes lazy.
    const attachedFile = "mcp-attached.png";
    fs.mkdirSync(path.join(ws, ".agent_party_app", "images"), { recursive: true });
    fs.copyFileSync(imagePath, path.join(ws, ".agent_party_app", "images", attachedFile));
    await post("/api/qa/members/viewer/emit", {
      events: [{
        type: "tool_call",
        id: "agentparty-attach-image-1",
        name: "mcp__agentparty-app__attach-image",
        input: { path: imagePath, caption: "MCP visible image" },
        status: "completed",
        result: { ok: true, file: attachedFile, mediaType: "image/png", bytes: pngBytes },
        source: "agentparty-app",
      }],
    });
    await delay(500);
    const mcpImage = await post("/api/measure", { selector: ".wb-attached-image img.wb-msg-image", limit: 5, attributes: ["src"] });
    assert(mcpImage.ok && mcpImage.count === 1, "AgentParty attach-image MCP remains immediately visible");

    // --- native image_view is inspection evidence, so it stays lazy -------
    await post("/api/qa/members/viewer/emit", { events: [imageViewEvent(imageContentResult, imagePath)] });
    await delay(900);

    const nativeTool = await post("/api/measure", { selector: "details.wb-tool", limit: 5, attributes: ["open"] });
    assert(nativeTool.ok && nativeTool.count === 1 && !nativeTool.elements?.[0]?.attributes?.open,
      "native image_view remains a collapsed tool");
    assert((nativeTool.texts || []).some((text) => text.includes("codex-viewed.png")),
      "the collapsed summary still names the inspected file");
    const nativeBeforeOpen = await post("/api/measure", { selector: "img.wb-tool-image", limit: 5 });
    assert(Number(nativeBeforeOpen.count || 0) === 0, "native image_view mounts no image before disclosure opens");

    const shot = path.join(outDir, "codex-image-view-open.png");
    const openedNative = await post("/api/capture", { path: shot, click: "details.wb-tool > summary" });
    assert(openedNative.applied?.clicked === true, "native image_view opens through the real UI");
    await delay(500);
    const nativeAfterOpen = await post("/api/measure", { selector: "details.wb-tool[open] img.wb-tool-image", limit: 5, attributes: ["src"] });
    assert(nativeAfterOpen.ok && nativeAfterOpen.count === 1, "opening native image_view mounts the picture on demand");
    const rendered = nativeAfterOpen.elements?.[0];
    assert((rendered?.box?.width || 0) > 0 && (rendered?.box?.height || 0) > 0,
      `the image has real layout size (${rendered?.box?.width}x${rendered?.box?.height})`);
    assert(/^data:image\/png;base64,/.test(String(rendered?.attributes?.src || "")), "the <img> carries the decoded PNG");
    await post("/api/capture", { path: shot, click: "details.wb-tool[open] > summary" });
    await delay(300);

    // An exec that internally called view_image follows the same lazy boundary.
    await post("/api/qa/members/viewer/emit", {
      events: [{
        type: "tool_call",
        id: "codex-exec-image-1",
        name: "exec",
        input: { command: "tools.view_image(...)" },
        status: "completed",
        result: [{ type: "text", text: imagePath }, ...imageContentResult(imagePath)],
        source: "codex",
      }],
    });
    await delay(700);

    const collapsedExec = await post("/api/measure", { selector: "details.wb-tool", limit: 5, attributes: ["open"] });
    assert(collapsedExec.ok && collapsedExec.count === 2 && collapsedExec.elements?.every((element) => !element.attributes?.open),
      "an ordinary image-bearing exec is collapsed by default");
    const beforeOpen = await post("/api/measure", { selector: "img.wb-tool-image", limit: 5 });
    assert(Number(beforeOpen.count || 0) === 0, "collapsed native and exec tools mount no image elements");

    const lazyShot = path.join(outDir, "codex-exec-image-open.png");
    const openedExec = await post("/api/capture", { path: lazyShot, click: ".wb-transcript > details.wb-tool:last-of-type > summary" });
    assert(openedExec.applied?.clicked === true, "the ordinary tool disclosure opens through the real UI");
    await delay(500);
    const afterOpen = await post("/api/measure", { selector: "details.wb-tool[open] img.wb-tool-image", limit: 5, attributes: ["src"] });
    assert(afterOpen.ok && afterOpen.count === 1, "opening the disclosure mounts its image on demand");

    // --- a failure is visible, not silent --------------------------------
    await post("/api/qa/members/viewer/emit", {
      events: [{ ...imageViewEvent(imageContentResult, path.join(ws, "gone.png")), id: "codex-image-view-2" }],
    });
    await delay(700);
    // No picture to show → it stays an ordinary tool box, carrying the reason.
    const failedText = await post("/api/measure", { selector: ".wb-tool", limit: 10 });
    assert(failedText.ok && (failedText.texts || []).some((t) => /이미지를 표시하지 못했습니다/.test(t)),
      "an unreadable path shows the reason in the transcript instead of an empty box");

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
  if (failures.length) { console.log(`CODEX IMAGE VIEW E2E FAILED: ${failures.length}`); process.exit(1); }
  console.log("CODEX IMAGE VIEW E2E PASSED (AgentParty MCP immediate + native inspection lazy + stated failures)");
  process.exit(0);
}

main();
