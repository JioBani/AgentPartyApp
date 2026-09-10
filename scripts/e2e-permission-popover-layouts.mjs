/*
 * Full-process E2E: the rich Codex permission popover must stay visible and
 * reachable in every representative workbench shape.
 *
 * This intentionally checks paint hit-testing at the TOP of the menu. A plain
 * bounding box passed before the fix even though `.wb-composer` painted over
 * most of the menu; `elementsFromPoint` distinguishes a box that exists from a
 * surface the user can actually click.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ws = path.join(os.tmpdir(), "agentparty-permission-popover-layouts-ws");
const userData = path.join(os.tmpdir(), "agentparty-permission-popover-layouts-ud");
const outDir = process.env.AGENTPARTY_PERMISSION_POPOVER_OUT || os.tmpdir();
const failures = [];
const check = (condition, message) => {
  console.log(`  ${condition ? "✓" : "✗"} ${message}`);
  if (!condition) failures.push(message);
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function killTree(pid) {
  if (!pid) return;
  try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
}

async function main() {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const get = async (url) => {
    const response = await fetch(`${base}${url}`);
    if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`);
    return response.json();
  };
  const post = async (url, body = {}) => {
    const response = await fetch(`${base}${url}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(`POST ${url}: HTTP ${response.status} ${JSON.stringify(payload)}`);
    return payload;
  };
  const measure = async (selector, extra = {}) => post("/api/measure", { selector, limit: 20, ...extra });
  const first = async (selector, extra = {}) => (await measure(selector, extra)).elements[0];
  const waitForSelector = async (selector, timeoutMs = 4_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // `body` guarantees a successful measurement while the target is still
      // mounting, so an ordinary React settle does not become a noisy API 500.
      if ((await measure(`body, ${selector}`)).count > 1) return;
      await delay(80);
    }
    throw new Error(`Timed out waiting for '${selector}'`);
  };

  for (const directory of [ws, userData]) {
    try { fs.rmSync(directory, { recursive: true, force: true }); } catch {}
    fs.mkdirSync(directory, { recursive: true });
  }

  const child = spawn(process.env.ComSpec || "cmd.exe", ["/c", "npm", "run", "start"], {
    cwd: root,
    stdio: ["ignore", "ignore", "inherit"],
    windowsHide: true,
    env: {
      ...process.env,
      AGENTPARTY_QA: "1",
      AGENTPARTY_AUTOMATION_PORT: String(port),
      AGENTPARTY_USER_DATA: userData,
      AGENTPARTY_WINDOW_DISPLAY: "left",
    },
  });

  async function waitForApi() {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try { if ((await get("/api/health")).ok) return; } catch {}
      await delay(500);
    }
    throw new Error("AgentParty API never came up");
  }

  const panelFor = (layout, member) => layout.panels.find((panel) => panel.tabs.includes(member));
  const leaf = (panelId, weight = 1) => ({ type: "leaf", panelId, weight });
  const split = (id, dir, children) => ({ type: "split", id, dir, weight: 1, children });

  async function setScenario(scenario) {
    const bounds = await post("/api/qa/window/bounds", scenario.bounds);
    check(
      bounds.bounds?.width > 0 && bounds.bounds?.height > 0,
      `${scenario.label}: real window is ${bounds.bounds?.width}x${bounds.bounds?.height}`,
    );
    await post("/api/qa/open", { panels: scenario.panels });
    await delay(350);
    let layout = (await get("/api/party/layout")).layout;
    if (scenario.grid) {
      await post("/api/party/layout", { layout: { ...layout, grid: scenario.grid(layout, panelFor, leaf, split) } });
      await delay(350);
      layout = (await get("/api/party/layout")).layout;
    }
    return layout;
  }

  async function verifyOpenPopover(label, layout, member = "codey", changeContent = false) {
    const panel = panelFor(layout, member);
    if (!panel) throw new Error(`${label}: ${member} panel missing`);
    const panelSelector = `[data-panel-id="${panel.id}"]`;
    const triggerSelector = `${panelSelector} .wb-codex-perm-trigger`;
    await waitForSelector(triggerSelector);
    const opened = await post("/api/capture", {
      path: path.join(outDir, `permission-popover-${label}.png`),
      click: triggerSelector,
    });
    check(opened.clicked, `${label}: opened the real ${member === "codey" ? "Codex" : "Cursor"} permission control`);

    const menuSelector = ".wb-codex-perm-menu.is-floating";
    await waitForSelector(menuSelector);
    let menu = await first(menuSelector, { styles: ["position", "z-index", "overflow-y", "max-height"] });
    const trigger = await first(triggerSelector);
    const viewport = (await measure("body")).viewport;
    const composer = await first(`${panelSelector} .wb-composer`, { styles: ["overflow"] });
    const panelBox = await first(panelSelector, { styles: ["overflow"] });

    check(composer.styles.overflow === "hidden" && panelBox.styles.overflow === "hidden", `${label}: tested inside the clipping composer and panel`);
    const composerContainment = await measure(menuSelector, { within: `${panelSelector} .wb-composer` });
    const panelContainment = await measure(menuSelector, { within: panelSelector });
    check(!composerContainment.elements[0].withinAncestor, `${label}: menu is outside the composer DOM`);
    check(!panelContainment.elements[0].withinAncestor, `${label}: menu is outside the panel DOM`);
    check(menu.styles.position === "fixed" && Number(menu.styles["z-index"]) >= 1500, `${label}: menu owns the frontmost viewport layer`);

    const insideViewport = menu.box.top >= 5
      && menu.box.left >= 5
      && menu.box.right <= viewport.width - 5
      && menu.box.bottom <= viewport.height - 5;
    check(insideViewport, `${label}: whole menu is inside the ${viewport.width}x${viewport.height} viewport`);
    check(menu.box.bottom <= trigger.box.top + 1, `${label}: upward menu ends before the composer trigger`);

    // This is the user's exact failure point: the menu's top existed in layout
    // but another panel painted over it. Hit-test both ends, not just geometry.
    for (const [edge, y] of [["top", menu.box.top + 8], ["bottom", menu.box.bottom - 8]]) {
      const hit = await measure(menuSelector, { at: { x: menu.box.left + menu.box.width / 2, y } });
      check(hit.at?.matchesSelector, `${label}: ${edge} of the menu is painted and reachable`);
    }

    if (changeContent) {
      const preset = await post("/api/capture", { click: `${menuSelector} .wb-segment:nth-child(3)` });
      check(preset.clicked, `${label}: selected Full Access in the open popover`);
      await delay(300);
      menu = await first(menuSelector);
      check(menu.box.top >= 5 && menu.box.bottom <= viewport.height - 5, `${label}: warning-height change remains inside the viewport`);
      const hit = await measure(menuSelector, { at: { x: menu.box.left + 8, y: menu.box.top + 8 } });
      check(hit.at?.matchesSelector, `${label}: resized menu top remains reachable`);
    }

    await post("/api/capture", { click: triggerSelector });
    await delay(120);
    const closed = await measure(`body, ${menuSelector}`);
    check(closed.count === 1, `${label}: trigger closes the portalled menu`);
  }

  try {
    await waitForApi();
    const windowId = (await get("/api/windows")).windows?.[0]?.id;
    check(Boolean(windowId), "test window discovered");
    await post(`/api/windows/${encodeURIComponent(windowId)}/workspace`, { workspacePath: ws });
    await post("/api/qa/seed", {
      party: "permission-popover-layouts",
      members: [
        { name: "codey", role: "Codex permission popover", runtime: "codex", model: "gpt-5.4-mini", status: "idle" },
        { name: "cursory", role: "Cursor permission popover", runtime: "cursor", model: "Grok 4.5", status: "idle" },
        ...["tabmate", "left", "center", "right-top", "right-bottom", "top"].map((name) => ({ name, role: "layout filler", model: "sonnet", status: "idle" })),
      ],
    });
    await post("/api/navigation", { view: "workbench" });

    const scenarios = [
      {
        label: "single-panel-one-tab",
        bounds: { width: 1400, height: 900 },
        panels: [["codey"]],
      },
      {
        label: "narrow-four-columns",
        bounds: { width: 1100, height: 720 },
        panels: [["left"], ["codey"], ["right-top"], ["right-bottom"]],
      },
      {
        label: "vertical-codey-bottom",
        bounds: { width: 1100, height: 720 },
        panels: [["top"], ["codey"]],
        grid: (layout, find, makeLeaf, makeSplit) => makeSplit("vertical-root", "column", [
          makeLeaf(find(layout, "top").id),
          makeLeaf(find(layout, "codey").id),
        ]),
      },
      {
        label: "many-tabs-with-overflow",
        bounds: { width: 1100, height: 720 },
        panels: [["codey", "tabmate", "left", "center", "top"], ["right-top"], ["right-bottom"]],
      },
      {
        label: "reported-nested-two-tabs",
        bounds: { width: 1500, height: 900 },
        panels: [["codey", "tabmate"], ["center"], ["right-top"], ["right-bottom"]],
        grid: (layout, find, makeLeaf, makeSplit) => makeSplit("reported-root", "row", [
          makeLeaf(find(layout, "codey").id),
          makeLeaf(find(layout, "center").id),
          makeSplit("reported-right", "column", [
            makeLeaf(find(layout, "right-top").id),
            makeLeaf(find(layout, "right-bottom").id),
          ]),
        ]),
      },
      {
        label: "cursor-narrow-four-columns",
        member: "cursory",
        bounds: { width: 1100, height: 720 },
        panels: [["left"], ["cursory"], ["right-top"], ["right-bottom"]],
      },
    ];

    for (const [index, scenario] of scenarios.entries()) {
      const layout = await setScenario(scenario);
      await verifyOpenPopover(scenario.label, layout, scenario.member, index === scenarios.length - 2);
    }

    await post("/api/window/close");
  } catch (error) {
    failures.push(String(error?.stack || error));
    console.error(error);
  } finally {
    killTree(child.pid);
    await delay(400);
    for (const directory of [ws, userData]) {
      try { fs.rmSync(directory, { recursive: true, force: true }); } catch {}
    }
  }

  console.log("");
  if (failures.length) {
    console.log(`PERMISSION POPOVER LAYOUT E2E FAILED: ${failures.length}`);
    process.exit(1);
  }
  console.log("PERMISSION POPOVER LAYOUT E2E PASSED");
}

main();
