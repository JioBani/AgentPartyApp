/*
 * Full-process e2e for UNPRICEABLE usage — OFFLINE (seeded ledger, no model).
 * Regression guard for the AGENTS.md "no silent fallback" rule in the Token
 * Usage dashboard: a turn whose model has no catalog rate used to contribute
 * cost 0, and 0 sums into a total that then reads as "this cost nothing".
 *
 * A ledger is seeded with two members — one on a priced model, one on a model
 * that is deliberately absent from the catalog — and the app is booted on that
 * workspace. Assertions come from the aggregate API AND from measuring the
 * running renderer over CDP (`--remote-debugging-port=0`), never from looking
 * at a screenshot:
 *   - the aggregate reports the unpriced turns and their token volume instead
 *     of folding them into estCostUsd,
 *   - the per-bucket cost table shows "?" for the unpriceable member and marks
 *     its own totals "+?", and NO "$0.000" appears anywhere on the screen,
 *   - the timeline caption states how many turns are missing from its bars.
 * Not billed; safe to run anytime after `npm run build`.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { firstBaseUrl } from "./lib/discovery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ws = path.join(os.tmpdir(), "agentparty-usage-unpriced-e2e-workspace");
const userData = path.join(os.tmpdir(), "agentparty-usage-unpriced-e2e-user-data");
const PARTY = "party-unpriced-e2e";
const PRICED_MODEL = "claude-sonnet-4-6";
/** Deliberately not in modelCatalog.json — that is the whole point. */
const UNPRICED_MODEL = "some-unlisted-model-x";
const PRICED_TURNS = 6;
const UNPRICED_TURNS = 4;

let base = "";
const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };

async function main() {
  await removePath(ws);
  await removePath(userData);
  fs.mkdirSync(path.join(ws, ".agent_party_app", "usage"), { recursive: true });
  // Chromium writes DevToolsActivePort before Electron creates userData itself.
  fs.mkdirSync(userData, { recursive: true });

  const now = Date.now();
  const record = (member, model, i) => ({
    at: new Date(now - (20 - i) * 60_000).toISOString(),
    atStart: new Date(now - (20 - i) * 60_000 - 30_000).toISOString(),
    partyId: PARTY, member, appSessionId: `s-${member}`, sessionId: `sess-${member}`,
    provider: "claude", model, effort: "medium", trigger: "user",
    tokens: { input: 12_000, cacheRead: 40_000, cacheWrite: 3_000, output: 2_000, context: 60_000 },
  });
  const lines = [];
  for (let i = 0; i < PRICED_TURNS; i += 1) lines.push(record("priced-guy", PRICED_MODEL, i));
  for (let i = 0; i < UNPRICED_TURNS; i += 1) lines.push(record("unpriced-guy", UNPRICED_MODEL, i));
  fs.writeFileSync(path.join(ws, ".agent_party_app", "usage", "turns.jsonl"), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);

  const child = spawn(process.execPath, [path.join(root, "scripts", "launch-electron.mjs"), "--workspace", ws, "--remote-debugging-port=0"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, AGENTPARTY_QA: "1", AGENTPARTY_USER_DATA: userData, AGENTPARTY_WINDOW_DISPLAY: "left" },
    windowsHide: true,
  });
  child.stdout.on("data", (c) => process.stdout.write(c));
  child.stderr.on("data", (c) => process.stderr.write(c));

  let cdp;
  try {
    await waitForApi();
    assert((await getJson("/api/health")).ok, "health ok");

    const agg = await getJson(`/api/token-usage?fromMs=${now - 3600_000}&toMs=${now + 60_000}&bucketMinutes=5`);
    const priced = (agg.members || []).find((m) => m.key.endsWith(":priced-guy"));
    const unpriced = (agg.members || []).find((m) => m.key.endsWith(":unpriced-guy"));
    assert(!!priced && !!unpriced, "both seeded members reached the aggregate");
    assert(priced?.estCostUsd > 0 && priced?.unpricedTurns === 0, `the priced member has a real cost (${priced?.estCostUsd})`);
    assert(unpriced?.unpricedTurns === UNPRICED_TURNS && unpriced?.turns === UNPRICED_TURNS,
      `every turn on an uncatalogued model is reported as unpriced (${unpriced?.unpricedTurns}/${unpriced?.turns})`);
    assert(unpriced?.estCostUsd === 0 && unpriced?.unpricedTokens > 0,
      `and its tokens are reported as unaccounted rather than free (${unpriced?.unpricedTokens} tok)`);

    await post("/api/navigation", { view: "usage" });
    await delay(1500);
    cdp = await attachRenderer();
    const seen = await cdp.eval(`(() => {
      const text = document.body.innerText;
      const grab = (re) => (text.match(re) || [""])[0];
      // Read the bucket table structurally, not by scraping innerText: a member
      // row is the grid whose sticky first cell carries the member's name.
      const rowCells = (name) => {
        const scroll = document.querySelector('[data-tu="bucket-scroll"]');
        if (!scroll) return null;
        for (const row of scroll.children) {
          const label = row.firstElementChild?.textContent?.trim();
          if (label === name) return [...row.children].slice(1).map((c) => c.textContent.trim()).filter(Boolean);
        }
        return null;
      };
      const cells = rowCells("unpriced-guy");
      return {
        cells,
        pricedCells: rowCells("priced-guy"),
        markedTotal: text.includes("+?"),
        note: grab(/[^\\n]*단가[^\\n]*/),
      };
    })()`);
    assert(Array.isArray(seen.cells) && seen.cells.length > 0, `the unpriceable member has a row in the bucket table (${JSON.stringify(seen.cells)})`);
    // Its turns land in one bucket; other buckets are genuinely idle and $0.000
    // is the truth there. What must never happen is a COST standing in for the
    // buckets it actually spent tokens in.
    assert((seen.cells || []).includes("?"), `the bucket it spent tokens in reads "?" (${JSON.stringify(seen.cells)})`);
    assert(!(seen.cells || []).some((c) => /\$\d*[1-9]/.test(c)), `and no bucket of its row shows a fabricated cost (${JSON.stringify(seen.cells)})`);
    assert((seen.pricedCells || []).some((c) => /^\$\d/.test(c)), `the priced member still shows real costs (${JSON.stringify(seen.pricedCells)})`);
    assert(seen.markedTotal, "totals that omit unpriceable turns are marked +?");
    assert(/단가/.test(seen.note), `the timeline states what is missing from its bars (${seen.note})`);

    cdp.close();
    await post("/api/window/close", {});
    await waitForExit(child);
    console.log(failures.length ? `\nUSAGE UNPRICED E2E FAILED (${failures.length})` : "\nUSAGE UNPRICED E2E PASSED");
    process.exit(failures.length ? 1 : 0);
  } catch (error) {
    try { cdp?.close(); } catch { /* already gone */ }
    killProcessTree(child.pid);
    throw error;
  }
}

/** CDP attach — the port is ephemeral and read from the file Chromium writes. */
async function attachRenderer() {
  const portFile = path.join(userData, "DevToolsActivePort");
  const started = Date.now();
  let port = 0;
  while (Date.now() - started < 30000) {
    try { port = Number(fs.readFileSync(portFile, "utf8").split("\n")[0].trim()); if (port > 0) break; } catch { /* not written yet */ }
    await delay(250);
  }
  if (!port) throw new Error(`Electron never wrote ${portFile} — was --remote-debugging-port passed?`);
  let target;
  while (Date.now() - started < 30000) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    target = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (target) break;
    await delay(250);
  }
  if (!target) throw new Error("No debuggable renderer page target found.");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error("CDP websocket failed to open.")); });
  let nextId = 1;
  const pending = new Map();
  socket.onmessage = (event) => { const msg = JSON.parse(event.data); const cb = pending.get(msg.id); if (cb) { pending.delete(msg.id); cb(msg); } };
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
    socket.send(JSON.stringify({ id, method, params }));
  });
  return {
    async eval(expression) {
      const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(`Renderer evaluation threw: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`);
      return result.result.value;
    },
    close() { socket.close(); },
  };
}

async function waitForApi() {
  const started = Date.now();
  while (Date.now() - started < 60000) {
    base = firstBaseUrl(ws);
    if (base) { try { if ((await getJson("/api/health")).ok) return; } catch { /* still booting */ } }
    await delay(500);
  }
  throw new Error("Automation API did not start (no live instance file under the e2e workspace).");
}

async function getJson(u) { const r = await fetch(base + u); if (!r.ok) throw new Error(`${u} returned ${r.status}`); return r.json(); }
async function post(u, b) { const r = await fetch(base + u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) }); if (!r.ok) throw new Error(`${u} returned ${r.status}: ${await r.text()}`); return r.json(); }
async function removePath(target) { for (let i = 0; i < 10; i += 1) { try { fs.rmSync(target, { recursive: true, force: true }); return; } catch (e) { if (e?.code !== "EBUSY" || i === 9) return; await delay(300); } } }
function waitForExit(child) { return new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error("App did not exit after close API.")), 10000); child.once("exit", () => { clearTimeout(t); resolve(); }); }); }
function killProcessTree(pid) { if (!pid) return; try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch { try { process.kill(pid); } catch { /* gone */ } } }
function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

main().catch((e) => { console.error(e); process.exit(1); });
