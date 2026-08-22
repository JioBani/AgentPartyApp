/*
 * Full-process e2e for "a link in the chat must open in the OS browser, never
 * inside the app".
 *
 * The renderer already intercepts markdown links whose href starts with http(s)
 * and hands them to `shell.openExternal`. What this covers is everything that
 * ESCAPES that check — a scheme-less `[x](example.com)`, a relative path, a
 * `mailto:` — which Electron would otherwise turn into a NEW APP WINDOW (the
 * anchor carries `target="_blank"`) or a navigation that replaces the workbench
 * with the linked page. Both are the reported bug.
 *
 * Assertions are deliberately about the APP, not the browser: after each click
 * the window count must be unchanged and the window must still be showing the
 * app. Clicking a real http link is left out on purpose — it would launch the
 * developer's browser on every test run, and the app-side behaviour (do not
 * navigate, do not spawn a window) is identical for all of them.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ws = path.join(os.tmpdir(), "agentparty-links-ws");
const userData = path.join(os.tmpdir(), "agentparty-links-ud");
const port = Number(process.env.AGENTPARTY_LINKS_PORT || "") || 48967;
const base = `http://127.0.0.1:${port}`;
const outDir = process.env.AGENTPARTY_LINKS_OUT || os.tmpdir();
const failures = [];
const assert = (c, m) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) failures.push(m); };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const asst = (text) => ({ type: "assistant_text_delta", text });
const backslashFile = path.join(ws, "samples", "windows-backslash.md");
const encodedBackslashHref = backslashFile.replace(/\\/g, "%5C");

async function getJson(u) { const r = await fetch(`${base}${u}`); return r.json(); }
async function post(u, b) { const r = await fetch(`${base}${u}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) }); return r.json(); }
async function waitForApi() { for (let i = 0; i < 120; i++) { try { if ((await getJson("/api/health")).ok) return true; } catch {} await delay(500); } throw new Error("API never came up"); }
function killTree(pid) { if (!pid) return; try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch {} }

async function windowCount() { return ((await getJson("/api/windows")).windows || []).length; }

/**
 * The main-process log lines for this run.
 *
 * The window-count check above CANNOT see the bug on its own: `/api/windows`
 * lists windows the app registered, and a `window.open` child is not one of
 * them. The decisive evidence is the guard's own record — it fires exactly when
 * the page asked for a window or a navigation, which before the fix is the
 * moment Electron opened one.
 */
function mainLog() {
  const dir = path.join(userData, "logs");
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".ndjson")); } catch { return []; }
  return files
    .flatMap((f) => fs.readFileSync(path.join(dir, f), "utf8").split("\n"))
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

/**
 * Every decision made about a link, from BOTH guards, newest last:
 * - `shell:openExternal` — the renderer recognised the href and handed it over.
 * - the main guard's own lines — a click that escaped the renderer.
 *
 * Read together because which guard acts is an implementation detail; what the
 * test asserts is the outcome for the user.
 */
function linkDecisions() {
  return mainLog()
    .map((e) => {
      if (e.message === "shell:openExternal") {
        return { kind: "web", target: String(e.data?.args?.[0] ?? "") };
      }
      if (e.message === "link opened in the default app") {
        return { kind: "web", target: String(e.data?.target ?? "") };
      }
      if (e.message === "link refused: unsupported scheme") {
        return { kind: "refused", target: String(e.data?.target ?? "") };
      }
      if (e.message === "local file opened in its default app") {
        return { kind: "opened", target: String(e.data?.path ?? "") };
      }
      if (e.message === "local file revealed instead of launched" || e.message === "no default app; revealed instead" || e.message === "local file revealed on request") {
        return { kind: "revealed", target: String(e.data?.path ?? "") };
      }
      if (e.message === "shell:openPath failed") {
        return { kind: "error", target: String(e.data?.error ?? "") };
      }
      return null;
    })
    .filter(Boolean);
}

/** Whether the app itself is still on screen (its own chrome is present). */
async function appStillShowing() {
  const probe = await post("/api/measure", { selector: ".program-main", limit: 1 }).catch(() => null);
  return Boolean(probe?.ok);
}

/**
 * The links a model realistically writes. Each is a separate escape route from
 * the renderer's `^https?://` check.
 */
const LINKS = [
  // Meant for the web despite the missing scheme — the renderer recovers these
  // and they must reach the OS as https, not die as a file:// refusal.
  { label: "no-scheme", href: "example.com", markdown: "[no-scheme](example.com)", expect: "https://example.com" },
  { label: "www-path", href: "www.example.com/pricing", markdown: "[www-path](www.example.com/pricing)", expect: "https://www.example.com/pricing" },
  // The one scheme besides http(s) that belongs in the OS's hands.
  { label: "mailto-link", href: "mailto:someone@example.com", markdown: "[mailto-link](mailto:someone@example.com)", expect: "mailto:someone@example.com" },
  // Real paths must NOT be guessed into web addresses. They open in their
  // default app instead — resolved against the WINDOW'S WORKSPACE, not the app
  // bundle, which is why these files are written into the scratch workspace.
  { label: "relative-md", href: "./samples/sample.md", markdown: "[relative-md](./samples/sample.md)", expect: "opened" },
  { label: "bare-file", href: "samples/sample.json", markdown: "[bare-file](samples/sample.json)", expect: "opened" },
  // react-markdown percent-encodes backslashes before the renderer classifies
  // the href. It must remain a file link (with its icon), not become a `C:` URI.
  { label: "windows-backslash", href: encodedBackslashHref, markdown: `[windows-backslash](<${backslashFile}>)`, expect: "opened" },
  // Never launched, only revealed — a link written by a model must not be able
  // to run a script.
  { label: "script", href: "./samples/danger.ps1", markdown: "[script](./samples/danger.ps1)", expect: "revealed" },
  // A path that does not exist is an error the user sees, not a dead click.
  { label: "missing", href: "./samples/nope.pdf", markdown: "[missing](./samples/nope.pdf)", expect: "error" },
];

async function main() {
  // Stated up front because it is real and intended: the passing behaviour IS
  // "the OS opens it", so this run will put an example.com tab in the default
  // browser and open the default mail client once. Suppressing that under a QA
  // flag would leave the actual fix untested.
  console.log("  ⚠ this test really opens things — that IS the behaviour under test:");
  console.log("    a browser tab (example.com), the mail client, three small sample files in");
  console.log("    their default apps, and one Explorer window. Close them afterwards.\n");

  for (const p of [ws, userData]) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }
  fs.mkdirSync(path.join(ws, "samples"), { recursive: true });
  // The files the local-path links point at. Written into the SCRATCH
  // workspace, which is also what proves relative links resolve against the
  // workspace rather than the app bundle.
  fs.writeFileSync(path.join(ws, "samples", "sample.md"), "# e2e sample\n");
  fs.writeFileSync(path.join(ws, "samples", "sample.json"), '{"e2e":true}\n');
  fs.writeFileSync(backslashFile, "# encoded backslash e2e sample\n");
  fs.writeFileSync(path.join(ws, "samples", "danger.ps1"), 'Write-Output "this must never run"\n');

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
    const opened = (await getJson("/api/state")).workspace?.path || "";
    assert(opened.replace(/\\/g, "/").toLowerCase() === ws.replace(/\\/g, "/").toLowerCase(),
      `window opened on the scratch workspace (${opened})`);

    const seed = await post("/api/qa/seed", {
      party: "links",
      members: [{ name: "linker", role: "writes links", model: "sonnet", status: "idle", blocks: [asst(LINKS.map((l) => l.markdown).join("\n\n"))] }],
    });
    assert(seed?.ok === true, `qa seed created the member (${JSON.stringify(seed).slice(0, 120)})`);
    await post("/api/navigation", { view: "workbench" });
    await post("/api/qa/open", { panels: [["linker"]] });
    await delay(1200);

    const anchors = await post("/api/measure", { selector: ".wb-md-link a", limit: 20 });
    assert(anchors.ok && anchors.count === LINKS.length, `all ${LINKS.length} links rendered (${anchors.count || 0})`);

    // Only FILE links get the reveal control — a web link has no folder. The
    // three web links (two http-ish + mailto) must not carry one.
    const fileLinkCount = LINKS.filter((l) => !/^(https?|mailto):/.test(String(l.expect))).length;
    const reveal = await post("/api/measure", { selector: ".wb-md-link-reveal", limit: 20 });
    assert(reveal.ok && reveal.count === fileLinkCount, `only file links carry the 탐색기 icon (${reveal.count || 0} of ${LINKS.length}, expected ${fileLinkCount})`);

    // The icon reveals rather than opens — a separate intent from clicking.
    const revealShot = path.join(outDir, "links-reveal.png");
    const revealClick = await post("/api/capture", { path: revealShot, click: ".wb-md-link-reveal" }).catch((e) => ({ ok: false, error: String(e) }));
    assert(revealClick?.ok === true, `clicked the 탐색기 icon (${revealClick?.error || "ok"})`);
    await delay(700);
    const revealed = linkDecisions().pop();
    assert(revealed?.kind === "revealed", `the icon revealed the file (got ${revealed?.kind} — ${revealed?.target})`);

    const before = await windowCount();
    assert(before === 1, `one app window before clicking (${before})`);

    for (const link of LINKS) {
      // `/api/capture`'s click fails loudly on a selector that matches nothing,
      // so a renamed class cannot make this pass by clicking air.
      const shot = path.join(outDir, `links-${link.label}.png`);
      const clicked = await post("/api/capture", { path: shot, click: `.wb-md-link a[href="${link.href}"]` })
        .catch((error) => ({ ok: false, error: String(error) }));
      assert(clicked?.ok === true, `clicked ${link.label} (${clicked?.error || "ok"})`);
      await delay(600);

      const after = await windowCount();
      assert(after === before, `${link.label}: no extra app window opened (${after})`);
      assert(await appStillShowing(), `${link.label}: the app is still on screen (did not navigate away)`);

      // Something must have DECIDED about this click. Silence would mean it
      // reached Electron's default handling, which is the bug: a new app window.
      const decisions = linkDecisions();
      const latest = decisions[decisions.length - 1];
      assert(Boolean(latest), `${link.label}: a link guard ran`);
      if (link.expect === "opened" || link.expect === "revealed" || link.expect === "error") {
        assert(latest?.kind === link.expect, `${link.label}: ${link.expect} (got ${latest?.kind} — ${latest?.target})`);
        if (link.expect !== "error") {
          // Resolution is the part that silently goes wrong: a relative link
          // resolved against the app bundle points at a file that is not there.
          const target = String(latest?.target || "").replace(/\\/g, "/").toLowerCase();
          const workspace = ws.replace(/\\/g, "/").toLowerCase();
          assert(target.startsWith(workspace), `${link.label}: resolved inside the workspace (${latest?.target})`);
        }
      } else {
        assert(latest?.kind === "web" && latest?.target === link.expect,
          `${link.label}: handed to the OS as ${link.expect} (got ${latest?.kind} ${latest?.target})`);
      }
    }

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
  if (failures.length) { console.log(`EXTERNAL LINKS E2E FAILED: ${failures.length}`); process.exit(1); }
  console.log("EXTERNAL LINKS E2E PASSED (no link opens an app window or navigates the workbench)");
  process.exit(0);
}

main();
