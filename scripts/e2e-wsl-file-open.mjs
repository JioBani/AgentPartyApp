/*
 * Product E2E: WSL local-file open/reveal through the real AgentParty process.
 *
 * Isolated userData, ephemeral automation discovery, a wsl+Ubuntu-22.04 window.
 * Seeds assistant markdown links (/home|/tmp, :line, /mnt/c, file:///..., file://wsl.localhost)
 * and drives open + folder-icon reveal via the live UI and POST /api/shell/open-path.
 *
 * Canonical product assertion for /mnt/c is the Windows drive path (C:\...), not
 * \\wsl$\distro\mnt\c. This run really opens default apps and Explorer.
 *
 * Run: npm run test:e2e:wsl-file-open   (after `npm run build`)
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { waitForLiveBaseUrl } from "./lib/discovery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distro = process.argv[2] || "Ubuntu-22.04";
const stamp = `${Date.now()}`;
const fixturePosix = `/tmp/agentparty-e2e-wsl-file-open-${stamp}`;
const wslUri = `wsl+${distro}:${fixturePosix}`;
const launchWs = path.join(os.tmpdir(), `agentparty-e2e-wsl-file-open-ws-${stamp}`);
const userData = path.join(os.tmpdir(), `agentparty-e2e-wsl-file-open-ud-${stamp}`);
const shotDir = path.join(os.tmpdir(), `agentparty-e2e-wsl-file-open-shots-${stamp}`);
const publicFile = path.join("C:\\Users\\Public", `agentparty-e2e-wsl-file-open-${stamp}.txt`);
const nativePosix = `${fixturePosix}/native.txt`;
const missingPosix = `${fixturePosix}/nope.txt`;
const nativeUnc = `\\\\wsl$\\${distro}${nativePosix.replace(/\//g, "\\")}`;
const mntHref = `/mnt/c/Users/Public/${path.basename(publicFile)}`;
const fileHome = `file://${nativePosix}`;
const fileWsl = `file://wsl.localhost/${distro}${nativePosix}`;
const fileMnt = `file:///mnt/c/Users/Public/${path.basename(publicFile)}`;

let base = "";
const failures = [];
const ok = (condition, message) => {
  console.log(`  ${condition ? "ok" : "FAIL"}: ${message}`);
  if (!condition) failures.push(message);
};

function wsl(command) {
  execFileSync("wsl.exe", ["-d", distro, "-e", "bash", "-lc", command], { stdio: "inherit" });
}

console.log("  ⚠ this test really opens things — that IS the behaviour under test:");
console.log("    a small .txt in the default app, Explorer for reveal, and a missing-file notice.\n");

async function main() {
  fs.mkdirSync(launchWs, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(shotDir, { recursive: true });
  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ workspacePath: launchWs }, null, 2));
  fs.writeFileSync(publicFile, "agentparty e2e /mnt/c fixture\n");
  wsl(`mkdir -p '${fixturePosix}' && printf '%s\\n' 'agentparty e2e native' > '${nativePosix}'`);

  const launchedAt = Date.now();
  const child = spawn(process.env.ComSpec || "cmd.exe", ["/c", "npm", "run", "start"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      AGENTPARTY_QA: "1",
      AGENTPARTY_ALLOW_MULTI_INSTANCE: "1",
      AGENTPARTY_USER_DATA: userData,
      AGENTPARTY_WINDOW_DISPLAY: "left",
      AGENTPARTY_AUTOMATION_PORT: "",
    },
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  try {
    base = await waitForLiveBaseUrl(launchWs, { since: launchedAt, timeoutMs: 90_000 });
    ok(Boolean(base), `discovered automation at ${base || "<none>"}`);
    const health = await get("/api/health");
    ok(health.ok, "app health ok");
    const appRoot = (await get("/api/state")).runtime?.appRoot || "";
    ok(
      Boolean(appRoot) && (appRoot + path.sep).toLowerCase().startsWith(root.toLowerCase() + path.sep),
      `running build is THIS worktree (appRoot=${appRoot || "<missing>"})`,
    );

    const win = await post("/api/windows", { workspacePath: wslUri });
    ok(String(win.workspacePath || "").toLowerCase() === wslUri.toLowerCase(), `WSL window workspace ${win.workspacePath}`);
    const q = `?window=${encodeURIComponent(win.id)}`;

    const LINKS = [
      { label: "native", href: nativePosix, expect: "opened", path: nativeUnc },
      { label: "line-suffix", href: `${nativePosix}:45`, expect: "opened", path: nativeUnc },
      { label: "mnt", href: mntHref, expect: "opened", path: publicFile },
      { label: "file-home", href: fileHome, expect: "opened", path: nativeUnc },
      { label: "file-wsl", href: fileWsl, expect: "opened", path: nativeUnc },
      { label: "file-mnt", href: fileMnt, expect: "opened", path: publicFile },
      { label: "missing", href: missingPosix, expect: "error" },
    ];
    const md = LINKS.map((link) => `[${link.label}](${link.href})`).join("\n\n");
    const seed = await post(`/api/qa/seed${q}`, {
      party: "wsl-file",
      members: [{ name: "linker", role: "writes links", location: wslUri, model: "sonnet", status: "idle", blocks: [{ type: "assistant_text_delta", text: md }] }],
    });
    ok(seed?.ok === true, "qa seed created the member");
    ok(seed?.members?.find((member) => member.name === "linker")?.location === wslUri, "member keeps its explicit WSL execution location");
    await post(`/api/parties/${encodeURIComponent(seed.currentPartyId)}/select${q}`, {});
    await post(`/api/navigation${q}`, { view: "workbench" });
    await post(`/api/qa/open${q}`, { panels: [["linker"]] });
    await delay(1200);

    const anchors = await post(`/api/measure${q}`, { selector: ".wb-md-link a", limit: 20 });
    ok(anchors.ok && anchors.count === LINKS.length, `all ${LINKS.length} links rendered (${anchors.count || 0})`);
    const reveal = await post(`/api/measure${q}`, { selector: ".wb-md-link-reveal", limit: 20 });
    ok(reveal.ok && reveal.count === LINKS.length, `every local-file link has a reveal control (${reveal.count || 0})`);

    const beforeDecisions = fileDecisions().length;
    const revealClick = await post(`/api/capture${q}`, {
      path: path.join(shotDir, "reveal-file-url.png"),
      click: `.wb-md-link:has(a[href="${fileHome}"]) .wb-md-link-reveal`,
    }).catch((error) => ({ ok: false, error: String(error) }));
    ok(revealClick?.ok === true, `clicked file:// reveal control (${revealClick?.error || "ok"})`);
    await delay(700);
    const afterReveal = fileDecisions().slice(beforeDecisions);
    const revealed = afterReveal.find((d) => d.kind === "revealed");
    ok(revealed?.kind === "revealed", `file:// reveal action is revealed (got ${revealed?.kind})`);
    ok(samePath(revealed?.target, nativeUnc), `file:// reveal resolved to ${nativeUnc} (got ${revealed?.target})`);

    for (const link of LINKS) {
      const shot = path.join(shotDir, `open-${link.label}.png`);
      const start = fileDecisions().length;
      const clicked = await post(`/api/capture${q}`, { path: shot, click: `.wb-md-link a[href="${link.href}"]` })
        .catch((error) => ({ ok: false, error: String(error) }));
      ok(clicked?.ok === true, `clicked ${link.label} (${clicked?.error || "ok"})`);
      await delay(700);
      const latest = fileDecisions().slice(start).at(-1);
      if (link.expect === "error") {
        const notice = await post(`/api/measure${q}`, { selector: ".app-toast", limit: 1 })
          .catch((error) => ({ ok: false, error: String(error) }));
        const noticeText = String(notice?.elements?.[0]?.text || notice?.texts?.[0] || "");
        ok(
          notice?.ok === true && /No such file|파일을 열지 못했습니다/.test(noticeText),
          `missing notice after 700ms (${noticeText || notice?.error || "no .app-toast"})`,
        );
        const noticeShot = path.join(shotDir, "missing-notice.png");
        const captured = await post(`/api/capture${q}`, { path: noticeShot })
          .catch((error) => ({ ok: false, error: String(error) }));
        ok(captured?.ok === true && captured.bytes > 0, `missing-notice.png (${captured?.error || noticeShot})`);
        continue;
      }
      ok(latest?.kind === link.expect, `${link.label}: UI ${link.expect} (got ${latest?.kind} — ${latest?.target})`);
      ok(samePath(latest?.target, link.path), `${link.label}: UI path ${link.path} (got ${latest?.target})`);

      const api = await post(`/api/shell/open-path${q}`, { path: link.href, sourceLocation: wslUri }).catch((error) => ({ ok: false, error: String(error) }));
      ok(api?.ok === true && api?.action === "opened", `${link.label}: HTTP opened (got ${api?.action || api?.error})`);
      ok(samePath(api?.path, link.path), `${link.label}: HTTP path matches UI (${api?.path})`);
      const revealedApi = await post(`/api/shell/open-path${q}`, { path: link.href, reveal: true, sourceLocation: wslUri }).catch((error) => ({ ok: false, error: String(error) }));
      ok(revealedApi?.ok === true && revealedApi?.action === "revealed", `${link.label}: HTTP reveal`);
      ok(samePath(revealedApi?.path, link.path), `${link.label}: HTTP reveal path matches open`);
    }

    // Render the same member-authored transcript content in a native Windows
    // workspace. The click must still resolve against linker's immutable WSL
    // location, not this new window's workspace.
    const localTranscriptWin = await post("/api/windows", { workspacePath: launchWs });
    const localTranscriptQ = `?window=${encodeURIComponent(localTranscriptWin.id)}`;
    const localSeed = await post(`/api/qa/seed${localTranscriptQ}`, {
      party: "windows-view-of-wsl-member",
      members: [{ name: "linker", role: "writes links", location: wslUri, model: "sonnet", status: "idle", blocks: [{ type: "assistant_text_delta", text: md }] }],
    });
    ok(localSeed?.members?.find((member) => member.name === "linker")?.location === wslUri, "Windows window keeps the member's WSL execution location");
    await post(`/api/parties/${encodeURIComponent(localSeed.currentPartyId)}/select${localTranscriptQ}`, {});
    await post(`/api/navigation${localTranscriptQ}`, { view: "workbench" });
    await post(`/api/qa/open${localTranscriptQ}`, { panels: [["linker"]] });
    await delay(1000);
    const localAnchors = await post(`/api/measure${localTranscriptQ}`, { selector: ".wb-md-link a", limit: 20 });
    ok(localAnchors.ok && localAnchors.count === LINKS.length, `same transcript content rendered in Windows window (${localAnchors.count || 0} links)`);
    const beforeLocalClick = fileDecisions().length;
    const localClick = await post(`/api/capture${localTranscriptQ}`, {
      path: path.join(shotDir, "windows-window-native-link.png"),
      click: `.wb-md-link a[href="${nativePosix}"]`,
    }).catch((error) => ({ ok: false, error: String(error) }));
    ok(localClick?.ok === true, `clicked WSL-authored link from Windows window (${localClick?.error || "ok"})`);
    await delay(700);
    const localDecision = fileDecisions().slice(beforeLocalClick).at(-1);
    ok(localDecision?.kind === "opened", `Windows window UI opened member link (got ${localDecision?.kind})`);
    ok(samePath(localDecision?.target, nativeUnc), `Windows window UI used member location (${localDecision?.target})`);
    const localApi = await post(`/api/shell/open-path${localTranscriptQ}`, { path: nativePosix, sourceLocation: wslUri });
    ok(samePath(localApi?.path, nativeUnc), `Windows window HTTP used the same member location (${localApi?.path})`);
    const invalidContext = await post(`/api/shell/open-path${localTranscriptQ}`, { path: nativePosix, sourceLocation: "relative/workspace" })
      .catch((error) => ({ error: String(error?.message || error) }));
    ok(/Invalid sourceLocation/.test(String(invalidContext?.error || "")), "invalid source location is rejected instead of falling back to the window");

    const windows = (await get("/api/windows")).windows || [];
    const localWin = windows.find((w) => String(w.workspacePath || "").replace(/\//g, "\\").toLowerCase() === launchWs.replace(/\//g, "\\").toLowerCase());
    ok(Boolean(localWin?.id), `local launch window still present (${localWin?.id || "missing"})`);
    const localHome = await post(`/api/shell/open-path?window=${encodeURIComponent(localWin?.id || "")}`, { path: "/home/nobody/no-guess.md" }).catch((error) => ({
      ok: false,
      error: String(error.message || error),
    }));
    const localErr = String(localHome?.error || "");
    ok(/No such file/.test(localErr) && !/wsl\$/i.test(localErr), `local window /home is a missing-file error, not a guessed distro (${localErr})`);
  } catch (error) {
    console.error(error);
    failures.push(String(error?.message || error));
  } finally {
    await post("/api/window/close", {}).catch(() => {});
    killProcessTree(child.pid);
    await delay(500);
    try { fs.rmSync(publicFile, { force: true }); } catch { /* leftover */ }
    try { wsl(`rm -rf '${fixturePosix}'`); } catch { /* leftover */ }
    await removePath(launchWs);
    await removePath(userData);
  }

  console.log("");
  if (failures.length) {
    console.log(`WSL FILE OPEN E2E FAILED: ${failures.length}`);
    for (const item of failures) console.log(`  - ${item}`);
    process.exit(1);
  }
  console.log("WSL FILE OPEN E2E PASSED");
  process.exit(0);
}

function fileDecisions() {
  const dir = path.join(userData, "logs");
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".ndjson")); } catch { return []; }
  return files
    .flatMap((f) => fs.readFileSync(path.join(dir, f), "utf8").split("\n"))
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean)
    .map((e) => {
      if (e.message === "local file opened in its default app") return { kind: "opened", target: String(e.data?.path ?? "") };
      if (e.message === "local file revealed instead of launched" || e.message === "no default app; revealed instead" || e.message === "local file revealed on request") {
        return { kind: "revealed", target: String(e.data?.path ?? "") };
      }
      if (e.message === "shell:openPath failed") return { kind: "error", target: String(e.data?.error ?? "") };
      if (typeof e.message === "string" && /No such file/.test(e.message)) return { kind: "error", target: e.message };
      return null;
    })
    .filter(Boolean);
}

function samePath(actual, expected) {
  const a = String(actual || "").replace(/\//g, "\\").toLowerCase();
  const b = String(expected || "").replace(/\//g, "\\").toLowerCase();
  return a === b;
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

function killProcessTree(pid) {
  if (!pid) return;
  try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* already gone */ }
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

main().catch((error) => { console.error(error); process.exit(1); });
