/*
 * DESIGN QA for the SESSION START card — OFFLINE, in the real app.
 *
 * The card replaced a raw `spawned: <whole command line>` status line, so what
 * has to hold is both visual and safety-critical, and neither can be checked by
 * reading source: the card must stay inside a NARROW panel with a long working
 * directory and a long member name, must be legible in light and dark, must
 * carry a screen-reader label, and must show none of the spawn plumbing.
 *
 * Every member here is a design-gallery mock (src/shared/designGallery.ts):
 * no harness is launched, no model is called, nothing is billed. Each state is
 * captured as a PNG *and* measured over `/api/measure`, so a regression fails
 * the script instead of waiting for someone to notice it in a picture.
 *
 * Run: node scripts/qa-session-spawn-design.mjs [--keep] [--out <dir>]
 *   (after `npm run build`)
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { liveInstances, waitForLiveBaseUrl } from "./lib/discovery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ws = path.join(os.tmpdir(), "agentparty-spawn-design-workspace");
const userData = path.join(os.tmpdir(), "agentparty-spawn-design-user-data");

const keep = process.argv.includes("--keep");
const outIndex = process.argv.indexOf("--out");
const shotDir = outIndex > 0 && process.argv[outIndex + 1]
  ? path.resolve(process.argv[outIndex + 1])
  : path.join(os.tmpdir(), "agentparty-spawn-design-shots");

let base = "";
const shots = [];
const failures = [];
const assert = (condition, message) => {
  console.log(`  ${condition ? "✓" : "✗"} ${message}`);
  if (!condition) failures.push(message);
};

const STARTING = "27-세션-시작중";
const RUNNING = "28-세션-실행중";
const WSL = "29-세션-WSL";
const FAILED = "30-세션-실패";
const FAILED_SETUP = "31-세션-실패-설정";

/** Strings from the spawn command that must never appear on this surface. */
const PLUMBING = ["node.exe", "app-server", "mcp_servers", "127.0.0.1", "AGENTPARTY_", "C:\\Users", "--", "-c "];

async function shot(name, caption, options = {}) {
  const file = path.join(shotDir, `${name}.png`);
  const result = await post("/api/capture", { path: file, ...options });
  shots.push({ name, caption, file, bytes: result.bytes });
  console.log(`  ✓ ${name} — ${caption}`);
}

const measure = (selector, extra = {}) => post("/api/measure", { selector, ...extra });

async function main() {
  await stopPreviousRuns();
  await removePath(ws);
  await removePath(userData);
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(shotDir, { recursive: true });
  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ workspacePath: ws }, null, 2));

  const launchedAt = Date.now();
  const child = spawn(process.execPath, [path.join(root, "scripts", "launch-electron.mjs"), "--workspace", ws, "--remote-debugging-port=0"], {
    cwd: root,
    stdio: keep ? "ignore" : ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: keep,
    env: {
      ...process.env,
      AGENTPARTY_QA: "1",
      AGENTPARTY_USER_DATA: userData,
      AGENTPARTY_WINDOW_DISPLAY: keep ? "" : "left",
      AGENTPARTY_AUTOMATION_PORT: "",
    },
  });
  if (child.stderr) child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  try {
    base = await discover(launchedAt);
    const appRoot = (await get("/api/state")).runtime?.appRoot || "";
    const within = (appRoot + path.sep).toLowerCase().startsWith(root.toLowerCase() + path.sep);
    if (!within) throw new Error(`Running build is not this worktree (appRoot=${appRoot || "<missing>"}).`);
    console.log(`app: ${base}\nshots: ${shotDir}\n`);

    await post("/api/qa/design-gallery", {});
    await post("/api/navigation", { view: "workbench" });

    await states();
    await themes();
    await narrow();
    await accessibility();

    console.log("\nGallery:");
    for (const s of shots) console.log(`  ${s.name.padEnd(26)} ${s.caption}\n    ${s.file}`);
    console.log(`\n${shots.length} shots → ${shotDir}`);
  } catch (error) {
    if (keep) {
      child.unref();
      console.error(`\nFailed with the app still running at ${base} (pid ${child.pid}).`);
    } else {
      killProcessTree(child.pid);
    }
    throw error;
  }

  if (keep) {
    child.unref();
    console.log(`\nApp left running at ${base} (pid ${child.pid}). Close its window when done.`);
    process.exit(failures.length ? 1 : 0);
  }
  await post("/api/window/close", {}).catch(() => {});
  await waitForExit(child);
  console.log(failures.length ? `\n${failures.length} FAILED` : "\nall passed");
  process.exit(failures.length ? 1 : 0);
}

/** The three states, each in its own panel, wide. */
async function states() {
  console.log("\nstates:");
  await open([[STARTING], [RUNNING], [FAILED]]);
  await shot("01-states", "시작 중 · 시작됨 · 시작 실패");

  const cards = (await measure(".wb-spawn")).elements;
  assert(cards.length === 3, `three session cards on screen (${cards.length})`);
  assert(cards.every((card) => /세션 시작/.test(card.text)), "each card names the event in words, not as a command");
  for (const card of cards) {
    const leaked = PLUMBING.filter((needle) => card.text.includes(needle));
    assert(leaked.length === 0, `no spawn plumbing in the card body${leaked.length ? ` (${leaked.join(", ")})` : ""}`);
  }
  assert(cards.some((card) => /하네스가 시작 중 종료되었습니다/.test(card.text)), "the failed card gives a safe reason");
  assert(cards.some((card) => /다시 시작할 수 있습니다/.test(card.text)), "…and says whether retrying is worth it");

  // One attempt, one card: the gallery member gets exactly one start event.
  await open([[RUNNING]]);
  const single = (await measure(".wb-spawn")).elements;
  assert(single.length === 1, `one attempt draws exactly one card (${single.length})`);
}

async function themes() {
  console.log("\nthemes:");
  await open([[STARTING], [RUNNING], [FAILED]]);
  // The REAL theme setting, not a data-attribute poke: the app repaints from
  // its own preset tokens, which is what has to hold in both themes.
  await theme("agentparty-light");
  await shot("02-light", "라이트 테마");
  const light = (await measure(".wb-spawn", { styles: ["background-color", "color", "border-color"] })).elements;

  await theme("agentparty-dark");
  await shot("03-dark", "다크 테마");
  const dark = (await measure(".wb-spawn", { styles: ["background-color", "color", "border-color"] })).elements;

  assert(dark.every((card) => card.styles["background-color"] !== "rgba(0, 0, 0, 0)"), "the card paints its own background rather than borrowing the panel's");
  // A hardcoded color would survive the theme switch unchanged — that is the
  // failure this compares for, on every card at once.
  assert(
    dark.every((card, index) => card.styles["background-color"] !== light[index]?.styles["background-color"]),
    "…and every card's background follows the theme",
  );
  assert(
    dark.every((card, index) => card.styles.color !== light[index]?.styles.color),
    "…as does its text color, so the card stays readable in dark",
  );
  await theme("agentparty-light");
}

async function theme(id) {
  await post("/api/appearance/theme", { theme: id });
  await delay(400);
}

/** A narrow panel with a long directory is where a card overflows if it can. */
async function narrow() {
  console.log("\nnarrow panel:");
  await open([[WSL], [RUNNING], [FAILED_SETUP], [STARTING]]);
  await shot("04-narrow", "좁은 패널 4분할 — 긴 CWD/멤버명");

  const cards = (await measure(".wb-spawn")).elements;
  for (const card of cards) {
    assert(!card.scrollable.horizontal, `card ${card.index} does not scroll sideways in a narrow panel`);
  }
  const blocks = (await measure(".wb-transcript")).elements;
  for (const block of blocks) {
    assert(!block.scrollable.horizontal, "the transcript itself gains no horizontal scroll from the card");
  }
  const cwd = (await measure(".wb-spawn-cwd")).elements;
  assert(cwd.length > 0, "the working directory is shown");
  assert(cwd.every((chip) => !chip.text.includes("Users") && chip.text.startsWith("…/")), "…as its last segments only, never the full path");
}

async function accessibility() {
  console.log("\naccessibility:");
  await open([[STARTING], [RUNNING], [FAILED]]);
  const cards = (await measure(".wb-spawn", { attributes: ["aria-label", "role", "aria-live"] })).elements;
  assert(cards.every((card) => (card.attributes["aria-label"] || "").trim().length > 0), "every card carries a screen-reader label");
  assert(cards.every((card) => card.attributes.role === "group"), "…on a labelled group, so the label is announced with it");
  assert(
    cards.every((card) => PLUMBING.every((needle) => !(card.attributes["aria-label"] || "").includes(needle))),
    "the label repeats the card's facts, not the spawn command",
  );
  const live = cards.filter((card) => card.attributes["aria-live"]);
  assert(live.length === 1 && /시작 중/.test(live[0].text), "only the in-flight card announces itself; settled ones stay quiet");
  // The card is not interactive, so it must not sit in the tab order and steal a
  // stop from the composer.
  const focusable = (await measure(".wb-spawn", { attributes: ["tabindex"] })).elements;
  assert(focusable.every((card) => card.attributes.tabindex === null), "a non-interactive card takes no tab stop");
}

async function open(panels) {
  await post("/api/qa/open", { panels });
  await delay(900);
}

async function discover(since) {
  const url = await waitForLiveBaseUrl(ws, { since });
  if (!url) throw new Error("App did not advertise an automation endpoint for the design-QA workspace.");
  return url;
}

async function stopPreviousRuns() {
  for (const instance of await liveInstances(ws)) {
    console.log(`stopping a previous design-QA app (pid ${instance.pid})`);
    await fetch(`${instance.baseUrl}/api/window/close`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => {});
    killProcessTree(instance.pid);
  }
}

async function get(route) {
  const response = await fetch(base + route);
  if (!response.ok) throw new Error(`${route} ${response.status}: ${await response.text()}`);
  return response.json();
}

async function post(route, body) {
  const response = await fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  if (!response.ok) throw new Error(`${route} ${response.status}: ${await response.text()}`);
  return response.json();
}

async function removePath(target) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try { fs.rmSync(target, { recursive: true, force: true }); return; } catch (error) {
      if (error?.code !== "EBUSY" || attempt === 9) return;
      await delay(300);
    }
  }
}

function waitForExit(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(() => { killProcessTree(child.pid); resolve(); }, 10_000);
    child.once("exit", () => { clearTimeout(timeout); resolve(); });
  });
}

// Only ever this app's own process tree. NEVER a blanket electron kill — the
// user has their own AgentParty running.
function killProcessTree(pid) {
  if (!pid) return;
  try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* already gone */ }
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

main().catch((error) => { console.error(error); process.exit(1); });
