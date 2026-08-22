/*
 * Builds the COMPONENT half of the design system: one card per component with
 * every variant side by side, plus its `.prompt.md`.
 *
 * Same principle as the screen capture — the app is driven into each state and
 * the rendered DOM is lifted — but the unit is a component and its variants
 * rather than a screenshot of a screen. What makes that possible is `context`:
 * a specimen is lifted with only the ancestor the app's CSS needs (a tab inside
 * `.wb-tabstrip`), not the whole shell, so several specimens sit in one card at
 * their natural size.
 *
 * Scenes are set up once and every variant that names them is lifted while the
 * app sits in that state, so the app is driven ~10 times, not once per variant.
 *
 * Run (after `npm run build` and `build-design-bundle.mjs`):
 *   node scripts/capture-design-components.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { page } from "./build-design-bundle.mjs";
import { COMPONENTS } from "./design-components.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE_DIR = path.join(root, "build", "design-bundle");
const runId = String(Date.now());
const ws = path.join(os.tmpdir(), `agentparty-dscomp-ws-${runId}`);
const userData = path.join(os.tmpdir(), `agentparty-dscomp-ud-${runId}`);
const port = Number(process.env.DESIGN_COMPONENTS_PORT || 39441);
const base = `http://127.0.0.1:${port}`;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const post = async (route, body) => {
  const r = await fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${route} ${r.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text || "{}");
};
const get = async (route) => {
  const r = await fetch(base + route);
  if (!r.ok) throw new Error(`${route} ${r.status}`);
  return r.json();
};

fs.mkdirSync(ws, { recursive: true });
fs.mkdirSync(userData, { recursive: true });
fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ workspacePath: ws, automationApiPort: port }, null, 2));
const child = spawn(process.execPath, [path.join(root, "scripts", "launch-electron.mjs"), "--remote-debugging-port=0"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
  env: { ...process.env, AGENTPARTY_QA: "1", AGENTPARTY_AUTOMATION_PORT: String(port), AGENTPARTY_USER_DATA: userData, AGENTPARTY_WINDOW_DISPLAY: "left" },
});
child.stderr.on("data", () => {});

async function attachRenderer() {
  const portFile = path.join(userData, "DevToolsActivePort");
  const started = Date.now();
  let cdpPort = 0;
  while (Date.now() - started < 60000) {
    try {
      cdpPort = Number(fs.readFileSync(portFile, "utf8").split("\n")[0].trim());
      if (cdpPort > 0) break;
    } catch { /* not written yet */ }
    await delay(250);
  }
  if (!cdpPort) throw new Error(`Electron never wrote ${portFile}.`);
  let target;
  while (Date.now() - started < 60000) {
    const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
    target = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (target) break;
    await delay(250);
  }
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error("CDP open failed")); });
  let nextId = 1;
  const pending = new Map();
  socket.onmessage = (e) => { const m = JSON.parse(e.data); const p = pending.get(m.id); if (p) { pending.delete(m.id); p(m); } };
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
    socket.send(JSON.stringify({ id, method, params }));
  });
  return {
    async eval(expression) {
      const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    },
    close() { socket.close(); },
  };
}

/**
 * Lifts one specimen: the matched element, re-wrapped in stripped clones of its
 * ancestors up to (and including) `context`.
 *
 * Stopping at `context` rather than at the document is what keeps a specimen
 * card-sized: the app shell is a viewport-tall flex column, so a chain that
 * reaches it turns a 28px pill into a 900px card.
 */
const LIFT = `(function lift(selector, context, height, width, nodeStyle) {
  const el = document.querySelector(selector);
  if (!el) return null;
  const stop = context ? el.closest(context) : el;
  if (!stop) return null;
  let node = el.cloneNode(true);
  node.querySelectorAll("[contenteditable]").forEach((n) => n.removeAttribute("contenteditable"));
  // Placement is not the component. A dropdown menu is position:absolute, so the
  // parent it is lifted inside measures 0 and the specimen comes out empty.
  // nodeStyle lets a variant neutralise the placement and show the thing itself.
  if (nodeStyle) { node.setAttribute("style", (node.getAttribute("style") || "") + ";" + nodeStyle); }
  let current = el;
  while (current !== stop) {
    current = current.parentElement;
    if (!current) return null;
    const wrapper = document.createElement(current.tagName.toLowerCase());
    for (const attribute of ["class", "style", "data-theme", "data-panel-id", "role"]) {
      const value = current.getAttribute(attribute);
      if (value !== null) wrapper.setAttribute(attribute, value);
    }
    wrapper.appendChild(node);
    // A specimen inherits the width it happened to have in the app, which for a
    // tab strip means "share the panel" — so a tab specimen came out squeezed,
    // its name ellipsised and its badge wrapped onto two lines. Naming the width
    // gives the specimen the room the component really gets.
    if (width) { wrapper.style.width = width; }
    if (height) { wrapper.style.height = height; }
    else { wrapper.style.height = "auto"; wrapper.style.minHeight = "0"; wrapper.style.overflow = "visible"; }
    node = wrapper;
  }
  return node.outerHTML;
})`;

/** The states the app is driven into; every variant names one. */
const SCENES = {
  async workbench() {
    await post("/api/navigation", { view: "workbench" });
    await post("/api/qa/open", { panels: [["impl", "luna"]] });
    await delay(900);
  },
  async unread() {
    // An unread count needs a message ARRIVING at a member whose tab is not
    // active — the badge counts what you have not looked at.
    await post("/api/qa/open", { panels: [["impl", "luna"]] });
    await post("/api/party/members/luna/message", { text: "리뷰 의견 남겼어요" }).catch(() => {});
    await delay(900);
  },
  async queue() {
    await post("/api/qa/members/queue-demo/emit", { status: "working" });
    await delay(300);
    await post("/api/party/members/queue-demo/message", { text: "리뷰 끝나면 이어서 부탁해" }).catch(() => {});
    await post("/api/party/members/queue-demo/message", { text: "릴리스 노트 초안도 같이" }).catch(() => {});
    await post("/api/qa/open", { panels: [["queue-demo"]] });
    await delay(1100);
  },
  async approval() {
    await post("/api/qa/members/approver/interaction", { type: "approval", scenario: "claude-bash" }).catch(async () => {
      await post("/api/qa/members/approver/emit", { status: "approval" });
    });
    await post("/api/qa/open", { panels: [["approver"]] });
    await delay(1100);
  },
  async "settings-general"() {
    await post("/api/navigation", { view: "runtime", tab: "general" });
    await delay(800);
  },
  async "settings-harness"() {
    await post("/api/navigation", { view: "runtime", tab: "harness" });
    await delay(800);
  },
  async "modal-runtime"() {
    await post("/api/navigation", { view: "workbench" });
    await post("/api/qa/open", { panels: [["impl"]] });
    await delay(600);
    await post("/api/capture", { click: ".wb-model-pill" });
    await delay(900);
  },
  async "menu-open"() {
    // Back to the workbench first: scenes run grouped, so this one can follow a
    // settings scene, where there is no composer to open a dropdown in.
    await post("/api/capture", { click: ".wb-modal-head .wb-icon-btn" }).catch(() => {});
    await post("/api/navigation", { view: "workbench" });
    await post("/api/qa/open", { panels: [["impl"]] });
    await delay(800);
    await post("/api/capture", { click: ".wb-composer .wb-dd-trigger" });
    await delay(700);
  },
};

/** Gallery scenes: one member of the QA card gallery, opened in the panel. */
async function galleryScene(member, windowId, galleryPartyId) {
  // The workbench is where a transcript card renders; a gallery scene reached
  // from a settings scene would otherwise lift nothing.
  await post("/api/navigation", { view: "workbench" });
  await post(`/api/parties/${galleryPartyId}/select?window=${encodeURIComponent(windowId)}`, {});
  // The renderer drops a layout request naming members its CURRENT party does
  // not have, so the party switch has to land BEFORE the open — otherwise the
  // first gallery scene silently opens nothing (later ones work, because the
  // party is already selected by then).
  await delay(600);
  await post("/api/qa/open", { panels: [[member]] });
  await delay(1100);
}

function specimenHtml(label, html) {
  return `<div class="ds-specimen">
  <p class="ds-specimen-label">${label}</p>
  <div class="ds-specimen-body">${html}</div>
</div>`;
}

async function main() {
  await waitForApi();
  const appRoot = (await get("/api/state")).runtime?.appRoot || "";
  if (!(appRoot + path.sep).toLowerCase().startsWith(root.toLowerCase() + path.sep)) {
    throw new Error(`the running build is not this worktree (appRoot=${appRoot})`);
  }
  if (!fs.existsSync(path.join(BUNDLE_DIR, "foundations", "tokens.css"))) {
    throw new Error("run scripts/build-design-bundle.mjs first.");
  }
  const cdp = await attachRenderer();

  await post("/api/qa/seed", {
    party: "디자인 미러",
    members: [
      { name: "impl", runtime: "claude-code", model: "claude-sonnet-4.5", role: "구현 담당" },
      { name: "luna", runtime: "codex", model: "gpt-5.4-mini", role: "리뷰 담당" },
      { name: "queue-demo", runtime: "claude-code", model: "claude-sonnet-4.5", role: "대기열" },
      { name: "approver", runtime: "claude-code", model: "claude-sonnet-4.5", role: "승인 대기" },
    ],
  });
  await post("/api/qa/members/impl/emit", {
    events: [
      { type: "queue_dequeued", count: 1, text: '@luna 이 "C:/Project/AgentPartyApp/src/main.ts" 빌드 실패 같이 봐줘' },
      { type: "assistant_text_delta", text: "빌드 로그부터 확인했습니다.\n\n## 원인\n\n`moduleResolution` 이 `bundler` 인데 이 패키지는 `node16` 을 기대합니다.\n\n```ts\n{ \"compilerOptions\": { \"moduleResolution\": \"node16\" } }\n```\n" },
      { type: "tool_call", id: "c-bash", name: "Bash", status: "completed", input: { command: "npm run build" }, result: "✓ built in 3.41s", exitCode: 0, durationMs: 3410, cwd: "C:/Project/AgentPartyApp" },
      { type: "plan", steps: [
        { step: "tsconfig 조정", status: "completed" },
        { step: "빌드 재실행", status: "inProgress" },
        { step: "실패한 테스트만 재실행", status: "pending" },
      ] },
      { type: "status", status: "idle", contextTokens: 118_400, contextWindow: 200_000, at: new Date().toISOString() },
    ],
  });
  await post("/api/qa/members/impl/subagents", { scenario: "claude-test-shards" });
  await post("/api/qa/usage", { provider: "claude", windows: [{ kind: "five_hour", utilization: 42 }, { kind: "weekly", utilization: 61 }] }).catch(() => {});
  await delay(1200);

  const windowId = (await get("/api/windows")).windows?.[0]?.id;
  const gallery = await post("/api/qa/design-gallery", {});
  const galleryPartyId = (await get("/api/party")).parties?.find((party) => party.name === gallery.party)?.id;
  const mirrorPartyId = (await get("/api/party")).parties?.find((party) => party.name === "디자인 미러")?.id;
  if (!galleryPartyId || !mirrorPartyId) throw new Error("could not resolve both parties — scenes cannot be staged.");

  // Group the work by scene so the app is driven once per state.
  const wanted = new Map();
  for (const component of COMPONENTS) {
    for (const variant of component.variants) {
      if (!wanted.has(variant.scene)) wanted.set(variant.scene, []);
      wanted.get(variant.scene).push({ component: component.id, variant });
    }
  }

  const lifted = new Map();
  for (const [scene, entries] of wanted) {
    try {
      if (scene.startsWith("gallery:")) {
        await galleryScene(scene.slice("gallery:".length), windowId, galleryPartyId);
      } else {
        await post(`/api/parties/${mirrorPartyId}/select?window=${encodeURIComponent(windowId)}`, {});
        await delay(500);
        await SCENES[scene]();
      }
    } catch (error) {
      problems.push(`scene '${scene}' could not be staged: ${String(error.message).slice(0, 120)}`);
      continue;
    }
    for (const { component, variant } of entries) {
      const html = await cdp.eval(`${LIFT}(${JSON.stringify(variant.selector)}, ${JSON.stringify(variant.context || "")}, ${JSON.stringify(variant.height || "")}, ${JSON.stringify(variant.width || "")}, ${JSON.stringify(variant.nodeStyle || "")})`);
      if (!html) {
        problems.push(`${component} / ${variant.label}: '${variant.selector}' matched nothing in scene '${scene}'`);
        continue;
      }
      lifted.set(`${component}::${variant.label}`, html);
    }
    console.log(`  scene ${scene.padEnd(20)} ${entries.length} specimen(s)`);
  }

  cdp.close();
  await post("/api/window/close", {}).catch(() => {});

  // Compose the cards.
  let written = 0;
  for (const component of COMPONENTS) {
    const specimens = component.variants
      .map((variant) => {
        const html = lifted.get(`${component.id}::${variant.label}`);
        return html ? specimenHtml(variant.label, html) : null;
      })
      .filter(Boolean);
    if (specimens.length === 0) {
      problems.push(`${component.id}: no variant could be captured — card not written`);
      continue;
    }
    if (specimens.length < component.variants.length) {
      problems.push(`${component.id}: ${component.variants.length - specimens.length} of ${component.variants.length} variants missing from the card`);
    }
    const dir = path.join(BUNDLE_DIR, "components", component.group.toLowerCase());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${component.id}.card.html`), page({
      group: component.group,
      name: component.name,
      subtitle: component.subtitle,
      body: `<div class="ds-specimens">\n${specimens.join("\n")}\n</div>`,
      depth: 2,
    }));
    fs.writeFileSync(path.join(dir, `${component.id}.prompt.md`), `# ${component.name}\n\n${component.prompt}\n\n변형: ${component.variants.map((variant) => variant.label).join(" · ")}\n`);
    written += 1;
  }

  console.log(`\n${written} component cards → ${path.join(BUNDLE_DIR, "components")}`);
  if (problems.length) {
    console.log(`\n${problems.length} problem(s) — reported, never faked:`);
    for (const problem of problems) console.log(`  - ${problem}`);
  }
}

async function waitForApi() {
  const started = Date.now();
  while (Date.now() - started < 60000) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok && (await r.json()).ok) return;
    } catch { /* still starting */ }
    await delay(400);
  }
  throw new Error("automation API never came up");
}

main().catch(async (error) => {
  console.error(error);
  try { await post("/api/window/close", {}); } catch { /* already gone */ }
  process.exit(1);
});
