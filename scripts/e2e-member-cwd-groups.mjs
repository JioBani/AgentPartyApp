/*
 * Full-process e2e for the member list's host/cwd tree, the panel header's
 * location line, the provider marks, and the composer/queue at a narrow panel
 * width — OFFLINE (mock members, no model, not billed).
 *
 * Measured in the REAL renderer over CDP rather than read off a picture: what
 * these changes are about is layout under pressure (a folded group, a hundred-
 * character path, a 300px panel), and only real flex pressure can answer
 * whether a control ended up outside its panel. Screenshots are saved as a
 * record for a human, but nothing here depends on anyone looking at them.
 *
 * Run after `npm run build`.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { firstBaseUrl } from "./lib/discovery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ws = path.join(os.tmpdir(), "agentparty-member-cwd-groups-e2e-workspace");
const userData = path.join(os.tmpdir(), "agentparty-member-cwd-groups-e2e-user-data");
const shots = path.join(os.tmpdir(), "agentparty-member-cwd-groups-e2e");

const LONG_WIN = "C:\\Users\\Dev\\AppData\\Roaming\\AgentParty\\worktrees\\member-cwd-groups";
const OTHER_WIN = "C:\\Project\\AgentPartyApp";
const WSL_CWD = "wsl+Ubuntu-24.04:/home/dev/services/gateway";
const SECOND_WSL = "wsl+Debian:/srv/edge";

let base = "";
const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "\u2713" : "\u2717"} ${msg}`); if (!cond) failures.push(msg); };

async function main() {
  await removePath(ws);
  await removePath(userData);
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(shots, { recursive: true });

  const child = spawn(process.execPath, [path.join(root, "scripts", "launch-electron.mjs"), "--workspace", ws, "--remote-debugging-port=0"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      AGENTPARTY_QA: "1",
      AGENTPARTY_ALLOW_MULTI_INSTANCE: "1",
      AGENTPARTY_USER_DATA: userData,
      AGENTPARTY_WINDOW_DISPLAY: "left",
    },
    windowsHide: true,
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", (c) => process.stderr.write(c));

  let cdp;
  try {
    await waitForApi();
    assert((await getJson("/api/health")).ok, "health ok");

    await post("/api/qa/seed", { party: "cwd-tree", members: [{ name: "main", role: "e2e", location: LONG_WIN }] });
    // Two Windows directories and one distro, plus a member on another model
    // provider — the exact spread the tree and the marks exist to tell apart.
    await post("/api/qa/members", { name: "api-worker", role: "e2e", location: LONG_WIN, model: "sonnet" });
    await post("/api/qa/members", { name: "docs-writer", role: "e2e", location: OTHER_WIN, model: "sonnet" });
    await post("/api/qa/members", { name: "gateway-with-a-deliberately-long-name", role: "e2e", location: WSL_CWD, runtime: "codex", model: "GPT-5.6 Sol" });
    await post("/api/party/members/main/open");
    await delay(900);
    cdp = await attachRenderer();
    await dismissGuideOffer(cdp);

    console.log("\nmember list \u2014 environment / directory tree:");
    const tree = await cdp.eval(`(() => {
      const hosts = [...document.querySelectorAll(".wb-member-list .wb-env-group")].map((host) => ({
        host: host.dataset.host,
        open: host.classList.contains("is-open"),
        label: host.querySelector(".wb-env-name")?.textContent,
        count: host.querySelector(".wb-group-count")?.textContent,
        groups: [...host.querySelectorAll(".wb-cwd-group")].map((group) => ({
          open: group.classList.contains("is-open"),
          title: group.querySelector(".wb-cwd-row")?.getAttribute("title"),
          tail: group.querySelector(".wb-cwd-tail")?.textContent,
          distro: group.querySelector(".wb-cwd-distro")?.textContent || null,
          members: [...group.querySelectorAll(".wb-member-row .wb-member-name")].map((el) => el.textContent),
        })),
      }));
      const rows = document.querySelectorAll(".wb-member-list .wb-member-row").length;
      const anyCwdOnRow = [...document.querySelectorAll(".wb-member-row")].some((row) => (row.textContent || "").indexOf(String.fromCharCode(92)) >= 0 || (row.textContent || "").indexOf("/") >= 0);
      return { hosts, rows, anyCwdOnRow };
    })()`);
    assert(tree.hosts.length === 2, `Windows and the distro are separate top-level sections (got ${tree.hosts.length})`);
    assert(tree.hosts[0]?.host === "windows" && tree.hosts[1]?.host === "wsl", "Windows leads, the distro follows");
    assert(tree.hosts.every((host) => host.open) && tree.hosts.every((host) => host.groups.every((group) => group.open)),
      "every group starts expanded");
    // `main` is created with the party itself, in the workspace directory, so
    // Windows holds three: the workspace and the two seeded checkouts.
    assert(tree.hosts[0]?.groups.length === 3, `each Windows directory is its own group (got ${tree.hosts[0]?.groups.length})`);
    const worktree = tree.hosts[0]?.groups.find((group) => group.tail === "member-cwd-groups");
    assert(Boolean(worktree), "a group is labelled by its directory NAME, not by a truncated ancestor");
    assert(worktree?.title === LONG_WIN, "\u2026and the full path is on the row's tooltip");
    assert(worktree?.members.join(",") === "api-worker", "members sit under the directory they run in");
    const other = tree.hosts[0]?.groups.find((group) => group.tail === "AgentPartyApp");
    assert(other?.members.join(",") === "docs-writer", "…and a member in another checkout is in another group");
    assert(tree.hosts[1]?.label === "Ubuntu-24.04", `the distro IS the section, named by itself (got ${tree.hosts[1]?.label})`);
    assert(!/WSL/i.test(tree.hosts[1]?.label || ""), "\u2026without a 'WSL' word repeated in front of it");
    assert(tree.hosts[1]?.groups[0]?.distro === null, "\u2026and the directory row below no longer repeats the distro as a badge");
    assert(tree.rows === 4, `every member is still listed exactly once (got ${tree.rows})`);
    assert(!tree.anyCwdOnRow, "no member row repeats the path its group already states");

    // Windows-only is the common party, and the one the flat rule exists for.
    const flat = await cdp.eval(`(() => {
      const list = document.querySelector(".wb-member-list");
      return {
        flat: list.classList.contains("is-flat"),
        envs: list.querySelectorAll(".wb-env-group").length,
        topLevelCwds: [...list.children].filter((el) => el.classList.contains("wb-cwd-group")).length,
      };
    })()`);
    assert(!flat.flat && flat.envs === 2 && flat.topLevelCwds === 0, "with two environments the tree keeps its headers and nests nothing at the root");

    console.log("\nprovider marks replace the status dot:");
    const marks = await cdp.eval(`(() => {
      const rows = [...document.querySelectorAll(".wb-member-list .wb-member-row")];
      return {
        withMark: rows.filter((row) => row.querySelector(".wb-member-mark")).length,
        markFirst: rows.every((row) => row.firstElementChild?.classList.contains("wb-member-mark")),
        dots: rows.filter((row) => row.querySelector(".wb-dot")).length,
        titles: rows.map((row) => row.querySelector(".wb-member-mark")?.getAttribute("title")),
        statuses: rows.filter((row) => row.querySelector(".wb-member-status, .wb-working-dots")).length,
        tabMark: document.querySelector(".wb-tab .wb-member-mark")?.getAttribute("title"),
        byName: Object.fromEntries(rows.map((row) => [row.querySelector(".wb-member-name")?.textContent, row.querySelector(".wb-member-mark")?.getAttribute("title")])),
        vendorMarks: document.querySelectorAll(".wb-member-list .wb-member-mark svg[data-vendor-mark]").length,
      };
    })()`);
    assert(marks.withMark === 4 && marks.markFirst, "every row leads with a provider mark");
    assert(marks.dots === 0, "the colour status dot is gone from the rows");
    assert(marks.statuses === 4, "\u2026and every row still reports its status in words");
    assert(marks.titles.every(Boolean), "each mark names its provider for the tooltip and the a11y label");
    // The Codex-harness member runs an OpenAI model and the Claude Code ones run
    // Anthropic: the mark has to follow the MODEL, which is the whole point.
    assert(marks.byName["api-worker"] === "Anthropic", `an Anthropic model is marked Anthropic (got ${marks.byName["api-worker"]})`);
    assert(marks.byName["gateway-with-a-deliberately-long-name"] === "OpenAI", `an OpenAI model is marked OpenAI (got ${marks.byName["gateway-with-a-deliberately-long-name"]})`);
    assert(marks.vendorMarks >= 2, "known providers render their vector brand mark rather than the neutral fallback");
    assert(Boolean(marks.tabMark), "the open tab carries the same mark");

    console.log("\ncollapsing a group:");
    const collapsed = await cdp.eval(`(() => {
      const host = document.querySelector('.wb-member-list .wb-env-group[data-host="wsl"]');
      host.querySelector(".wb-env-row").click();
      return null;
    })()`);
    void collapsed;
    await delay(120);
    const afterCollapse = await cdp.eval(`(() => {
      const host = document.querySelector('.wb-member-list .wb-env-group[data-host="wsl"]');
      const rows = host.querySelectorAll(".wb-member-row");
      return {
        open: host.classList.contains("is-open"),
        visible: [...rows].filter((row) => row.getClientRects().length > 0).length,
        count: host.querySelector(".wb-group-count")?.textContent,
        windowsRows: document.querySelectorAll('.wb-env-group[data-host="windows"] .wb-member-row').length,
      };
    })()`);
    assert(!afterCollapse.open && afterCollapse.visible === 0, "folding an environment hides its members");
    assert(afterCollapse.count === "1", "\u2026while the folded header still reports how many are inside");
    assert(afterCollapse.windowsRows === 3, "\u2026and the other environment is untouched");
    await cdp.eval(`document.querySelector('.wb-env-group[data-host="wsl"] .wb-env-row').click()`);
    await delay(120);

    console.log("\npanel header shows WHERE the member runs, not its name again:");
    await post("/api/party/members/api-worker/open");
    await delay(500);
    const header = await cdp.eval(`(() => {
      const panels = [...document.querySelectorAll(".wb-panel")];
      const panel = panels.find((el) => el.querySelector(".wb-tab.is-active .wb-tab-name")?.textContent === "api-worker") || panels[0];
      const id = panel.querySelector(".wb-toolbar-id");
      const children = [...id.children].map((el) => el.className);
      const cwd = id.querySelector(".wb-toolbar-cwd");
      return {
        first: children[0],
        hasName: Boolean(id.querySelector("strong")),
        cwdTitle: cwd?.getAttribute("title"),
        tail: cwd?.querySelector(".wb-cwd-tail")?.textContent,
        hasEnvIcon: Boolean(cwd?.querySelector("svg")),
        insidePanel: (() => {
          const outer = panel.getBoundingClientRect();
          const box = panel.querySelector(".wb-toolbar").getBoundingClientRect();
          return box.right <= outer.right + 1 && box.left >= outer.left - 1;
        })(),
      };
    })()`);
    assert(header.first?.includes("wb-status-pill"), "the status chip is the leftmost thing in the header");
    assert(!header.hasName, "the member name no longer repeats the tab above it");
    assert(header.cwdTitle?.includes(LONG_WIN), "the header states the member's full path in its tooltip");
    assert(header.tail === "member-cwd-groups", "\u2026and shows the directory name itself");
    assert(header.hasEnvIcon, "an environment icon marks Windows vs WSL");
    assert(header.insidePanel, "the header stays inside its panel");

    await capture("01-tree-and-header.png");

    console.log("\nseveral distros are peers, and each folds on its own:");
    await post("/api/qa/members", { name: "edge-proxy", role: "e2e", location: SECOND_WSL, model: "sonnet" });
    await delay(600);
    const distros = await cdp.eval(`(() => {
      const envs = [...document.querySelectorAll(".wb-member-list .wb-env-group")];
      return {
        labels: envs.map((env) => env.querySelector(".wb-env-name")?.textContent),
        hosts: envs.map((env) => env.dataset.host),
        ids: envs.map((env) => env.querySelector(".wb-env-row")?.getAttribute("aria-controls")),
        // Every section is a labelled group whose header says whether it is
        // open and what it opens — the hierarchy a screen reader reads.
        groups: envs.every((env) => env.getAttribute("role") === "group" && (env.getAttribute("aria-label") || "").length > 0),
        buttons: envs.every((env) => {
          const row = env.querySelector(".wb-env-row");
          return row?.tagName === "BUTTON" && row.getAttribute("aria-expanded") !== null && document.getElementById(row.getAttribute("aria-controls"));
        }),
        cwdGroups: [...document.querySelectorAll(".wb-member-list .wb-cwd-group")].every((group) => {
          const row = group.querySelector(".wb-cwd-row");
          return group.getAttribute("role") === "group" && row?.getAttribute("aria-expanded") !== null && document.getElementById(row.getAttribute("aria-controls"));
        }),
        focusables: [...document.querySelectorAll(".wb-member-list .wb-env-row, .wb-member-list .wb-cwd-row")].every((el) => el.tabIndex >= 0),
      };
    })()`);
    assert(distros.labels.join(",") === "Windows,Debian,Ubuntu-24.04", `each distro is a top-level section beside Windows (got ${distros.labels.join(",")})`);
    assert(distros.hosts.join(",") === "windows,wsl,wsl", "…and both distros are marked as the WSL family for their icon");
    assert(new Set(distros.ids).size === distros.ids.length, "each section controls its own body, so the collapse keys cannot collide");
    assert(distros.groups && distros.buttons, "every environment section is a labelled group with an expandable header");
    assert(distros.cwdGroups, "…and so is every directory group inside it");
    assert(distros.focusables, "both levels are reachable with the keyboard");

    await cdp.eval(`document.querySelector('.wb-env-group[data-distro="Debian"] .wb-env-row').click()`);
    await delay(150);
    const foldOne = await cdp.eval(`(() => {
      const at = (distro) => document.querySelector('.wb-env-group[data-distro="' + distro + '"]');
      return {
        debian: at("Debian").classList.contains("is-open"),
        ubuntu: at("Ubuntu-24.04").classList.contains("is-open"),
        debianExpanded: at("Debian").querySelector(".wb-env-row").getAttribute("aria-expanded"),
      };
    })()`);
    assert(!foldOne.debian && foldOne.ubuntu, "folding one distro leaves the other open");
    assert(foldOne.debianExpanded === "false", "…and the folded header says so out loud");
    await cdp.eval(`document.querySelector('.wb-env-group[data-distro="Debian"] .wb-env-row').click()`);
    await delay(150);

    console.log("\nthe drawer is narrow, and the tree still reads:");
    const fit = await cdp.eval(`(() => {
      const list = document.querySelector(".wb-member-list");
      const listBox = list.getBoundingClientRect();
      const inside = (el) => {
        const box = el.getBoundingClientRect();
        return box.left >= listBox.left - 1 && box.right <= listBox.right + 1;
      };
      const names = [...list.querySelectorAll(".wb-member-name")];
      const deepest = [...list.querySelectorAll(".wb-member-row")]
        .map((row) => row.getBoundingClientRect().left - listBox.left)
        .reduce((most, indent) => Math.max(most, indent), 0);
      return {
        width: Math.round(listBox.width),
        noScroll: list.scrollWidth <= list.clientWidth + 1,
        rowsInside: [...list.querySelectorAll(".wb-env-row, .wb-cwd-row, .wb-member-row")].every(inside),
        indent: Math.round(deepest),
        nameWidth: Math.min(...names.map((el) => Math.round(el.getBoundingClientRect().width))),
        titled: names.every((el) => (el.getAttribute("title") || "").length > 0),
        pathTitled: [...list.querySelectorAll(".wb-cwd-row")].every((el) => (el.getAttribute("title") || "").length > 0),
      };
    })()`);
    assert(fit.width <= 300, `the member drawer really is narrow (${fit.width}px)`);
    assert(fit.noScroll && fit.rowsInside, "nothing in the tree spills out of it sideways");
    assert(fit.indent <= 24, `a member row is at most a shallow indent from the edge (${fit.indent}px)`);
    assert(fit.nameWidth >= 60, `…so the member name still has room to be read (${fit.nameWidth}px)`);
    assert(fit.titled, "a clipped member name is recoverable from its tooltip");
    assert(fit.pathTitled, "…and so is a clipped path");
    await capture("05-environment-sections.png");
    // The real theme, not a capture-time flag: the section headers, the
    // fallback label and the hairline that hangs the members off their
    // directory are all token colours, and a token that resolves to the same
    // ink as its background only shows up when the app is actually painted in
    // that theme.
    for (const theme of ["agentparty-dark", "agentparty-light"]) {
      await post("/api/appearance/theme", { theme });
      await delay(250);
      const painted = await cdp.eval(`(() => {
        const list = document.querySelector(".wb-member-list");
        const env = list.querySelector(".wb-env-row");
        const name = list.querySelector(".wb-member-name");
        const read = (el, prop) => getComputedStyle(el)[prop];
        return {
          theme: document.documentElement.getAttribute("data-theme"),
          envInk: read(env, "color"),
          listPaint: read(list.closest(".wb-drawer, aside") || document.body, "backgroundColor"),
          nameInk: read(name, "color"),
          rowsInside: [...list.querySelectorAll(".wb-env-row, .wb-cwd-row, .wb-member-row")].every((el) => {
            const box = el.getBoundingClientRect();
            const outer = list.getBoundingClientRect();
            return box.left >= outer.left - 1 && box.right <= outer.right + 1;
          }),
        };
      })()`);
      assert(painted.theme === theme, `the app is really painted ${theme} (got ${painted.theme})`);
      assert(painted.envInk !== painted.listPaint && painted.nameInk !== painted.listPaint, `…and the tree's ink is not its own background in ${theme}`);
      assert(painted.rowsInside, `…with every row still inside the drawer in ${theme}`);
      await post("/api/capture", { path: `${shots}/06-environment-sections-${theme}.png` });
    }
    assert(fs.existsSync(`${shots}/06-environment-sections-agentparty-dark.png`), "the tree is captured in both themes");


    console.log("\nnarrow panels \u2014 composer and queue keep their controls:");
    // Four panels side by side is the pressure case: each lands near the
    // minimum width a panel is ever given.
    await post("/api/qa/open", { panels: [["main"], ["api-worker"], ["docs-writer"], ["gateway-with-a-deliberately-long-name"]] });
    await delay(500);
    // A member that is WORKING is what puts messages in a queue instead of
    // delivering them, which is the only way to see a queue row at all.
    await post("/api/qa/members/api-worker/emit", { status: "working" }).catch(() => {});
    await delay(300);
    for (const text of [
      "통합 브랜치 상태를 확인하고 병합 요청을 준비해줘. https://example.com/a/very/long/path/that/should/not/escape/the/card",
      "두 번째 메시지",
    ]) {
      await post("/api/party/members/api-worker/message", { text }).catch(() => {});
      await delay(200);
    }
    await delay(700);
    const narrow = await cdp.eval(`(() => {
      const panels = [...document.querySelectorAll(".wb-panel")];
      const panel = panels.find((el) => el.querySelector(".wb-queue-row")) || panels[0];
      const panelBox = panel.getBoundingClientRect();
      const inside = (el) => {
        if (!el) return null;
        const box = el.getBoundingClientRect();
        return box.left >= panelBox.left - 1 && box.right <= panelBox.right + 1;
      };
      const composer = panel.querySelector(".wb-composer");
      const send = composer?.querySelector(".wb-send-labeled, .wb-send");
      const stop = composer?.querySelector(".wb-composer-stop");
      const perm = composer?.querySelector(".wb-dd-trigger, .wb-pill");
      return {
        panelWidth: Math.round(panelBox.width),
        atSign: composer?.querySelectorAll(".wb-composer-tools").length ?? 0,
        sendInside: inside(send),
        stopInside: inside(stop),
        stopIsIcon: Boolean(stop?.classList.contains("is-icon")),
        stopLabel: stop?.getAttribute("aria-label") || "",
        stopBox: stop ? { w: Math.round(stop.getBoundingClientRect().width), h: Math.round(stop.getBoundingClientRect().height) } : null,
        stopAfterSend: Boolean(send && stop && (send.compareDocumentPosition(stop) & Node.DOCUMENT_POSITION_FOLLOWING)),
        permInside: inside(perm),
        sendWidth: send ? Math.round(send.getBoundingClientRect().width) : 0,
        sendScrollWidth: send ? send.scrollWidth : 0,
      };
    })()`);
    assert(narrow.panelWidth < 420, `panels really are narrow (${narrow.panelWidth}px)`);
    assert(narrow.atSign === 0, "the composer's @ button is gone");
    assert(narrow.sendInside && narrow.permInside, "send and the permission control stay inside the panel");
    assert(narrow.sendWidth + 1 >= narrow.sendScrollWidth, "the send/queue button is at least as wide as its own label \u2014 no character-per-line break");
    if (narrow.stopBox) {
      assert(narrow.stopIsIcon && narrow.stopBox.w >= 24 && narrow.stopBox.h >= 24, `Stop is a small icon with a real target (${narrow.stopBox.w}\u00d7${narrow.stopBox.h})`);
      assert(Boolean(narrow.stopLabel), "\u2026carrying its wording in the accessible label");
      assert(narrow.stopAfterSend, "\u2026and it sits immediately after the queue button");
      assert(narrow.stopInside, "\u2026inside the panel");
    }

    const queue = await cdp.eval(`(() => {
      const row = document.querySelector(".wb-queue-row");
      if (!row) return { present: false };
      const panelBox = row.closest(".wb-panel").getBoundingClientRect();
      const actions = row.querySelector(".wb-queue-row-actions");
      const ord = row.querySelector(".wb-queue-ord");
      return {
        present: true,
        ordFirstInHead: row.querySelector(".wb-queue-row-head")?.querySelector(".wb-queue-ord, .wb-queue-grip") === row.querySelector(".wb-queue-grip, .wb-queue-ord"),
        ordLabel: ord?.getAttribute("aria-label") || "",
        ordText: ord?.textContent || "",
        metaAfterOrd: Boolean(ord && row.querySelector(".wb-queue-meta") && (ord.compareDocumentPosition(row.querySelector(".wb-queue-meta")) & Node.DOCUMENT_POSITION_FOLLOWING)),
        textInHead: row.querySelector(".wb-queue-text")?.parentElement === row.querySelector(".wb-queue-row-head"),
        rowLines: (() => {
          const text = row.querySelector(".wb-queue-text");
          return text ? Math.round(row.getBoundingClientRect().height / text.getBoundingClientRect().height) : 0;
        })(),
        actionsInside: actions ? actions.getBoundingClientRect().right <= panelBox.right + 1 : null,
        actionLabels: [...(actions?.querySelectorAll("button") || [])].map((el) => el.getAttribute("aria-label")),
      };
    })()`);
    if (queue.present) {
      assert(/\\d/.test(queue.ordText), "a queue row leads with its delivery position");
      assert(queue.ordLabel.length > 0, "\u2026labelled so the number cannot be read as a count or an id");
      assert(queue.metaAfterOrd, "sender and state come after the position, in their own band");
      assert(queue.textInHead, "the message body shares the row with the position, the sender and the controls");
      assert(queue.rowLines <= 2, `\u2026so a short message makes a short card (${queue.rowLines} text-heights tall)`);
      assert(queue.actionsInside, "the row's controls stay inside the panel");
      assert(queue.actionLabels.every(Boolean), "\u2026and every one of them is labelled");
    } else {
      console.log("  (no queued row to inspect \u2014 skipped)");
    }

    await capture("02-narrow-composer-queue.png");

    console.log("\ntool cards say what HAPPENED, not merely that the call closed:");
    const at = new Date().toISOString();
    await post("/api/qa/members/api-worker/emit", { events: [
      { type: "tool_call", id: "t-ok", name: "Bash", input: { command: "npm test" }, status: "completed", exitCode: 0, at },
      { type: "tool_call", id: "t-exit", name: "Bash", input: { command: "npm run broken" }, status: "completed", exitCode: 2, at },
      { type: "tool_call", id: "t-fail", name: "Read", input: { file_path: "/nope" }, status: "failed", result: "ENOENT", at },
      { type: "tool_call", id: "t-denied", name: "Write", input: { file_path: "/etc/hosts" }, status: "denied", result: "The tool use was rejected", at },
      { type: "tool_call", id: "t-run", name: "Grep", input: { pattern: "x" }, status: "started", at },
    ] }).catch((error) => console.log("  (tool emit skipped: " + error.message + ")"));
    await delay(500);
    const outcomes = await cdp.eval(`(() => {
      const panels = [...document.querySelectorAll(".wb-panel")];
      const panel = panels.find((el) => el.querySelector(".wb-tab.is-active .wb-tab-name")?.textContent === "api-worker") || panels[0];
      const marks = [...panel.querySelectorAll(".wb-tool-check")].map((el) => ({
        classes: el.className,
        label: el.getAttribute("aria-label") || "",
      }));
      return {
        classes: marks.map((mark) => (mark.classes.match(/is-(ok|failed|denied|running)/) || [])[1]),
        labels: marks.map((mark) => mark.label),
        badges: [...panel.querySelectorAll(".wb-tool-outcome")].length,
      };
    })()`);
    if (outcomes.classes.length) {
      assert(outcomes.classes.includes("denied"), `a refused call is marked denied, not failed and above all not done (${outcomes.classes.join(",")})`);
      assert(outcomes.classes.filter((kind) => kind === "failed").length >= 2, "a reported error AND a non-zero exit both read as failures");
      assert(outcomes.classes.includes("ok"), "a clean run still reads as a success");
      assert(outcomes.classes.includes("running"), "an in-flight call reads as progress");
      assert(outcomes.labels.every(Boolean), "every mark carries its meaning in words, not only in colour");
      assert(outcomes.badges === 1, "only denial prints a status word; failures use the red X alone");
    } else {
      console.log("  (no tool cards to inspect - skipped)");
    }
    await capture("04-tool-outcomes.png");

    console.log("\ntab drag must not resize the panels underneath it:");
    const dragEffect = await cdp.eval(`(async () => {
      const widthsOf = () => [...document.querySelectorAll(".wb-panel")].map((el) => Math.round(el.getBoundingClientRect().width));
      const before = widthsOf();
      const tab = document.querySelector(".wb-tab");
      const box = tab.getBoundingClientRect();
      const opts = { bubbles: true, clientX: box.left + 10, clientY: box.top + 10, button: 0, pointerId: 1 };
      tab.dispatchEvent(new PointerEvent("pointerdown", opts));
      window.dispatchEvent(new PointerEvent("pointermove", { ...opts, clientX: box.left + 120, clientY: box.top + 40 }));
      await new Promise((r) => setTimeout(r, 120));
      const during = widthsOf();
      const zone = document.querySelector(".wb-newpanel-zone");
      const overlay = zone ? getComputedStyle(zone).position === "absolute" : null;
      window.dispatchEvent(new PointerEvent("pointerup", { ...opts, clientX: box.left + 120, clientY: box.top + 40 }));
      await new Promise((r) => setTimeout(r, 200));
      return { before, during, after: widthsOf(), zonePresent: Boolean(zone), overlay };
    })()`);
    assert(dragEffect.zonePresent, "dragging a tab offers the new-panel target");
    assert(dragEffect.overlay, "\u2026as an overlay, which takes no layout space");
    assert(JSON.stringify(dragEffect.before) === JSON.stringify(dragEffect.during),
      `panel widths do not change while a tab is in hand (${dragEffect.before} \u2192 ${dragEffect.during})`);
    assert(JSON.stringify(dragEffect.before) === JSON.stringify(dragEffect.after),
      `\u2026and nothing temporary is left behind after the drop (${dragEffect.after})`);
    const leftovers = await cdp.eval(`document.querySelectorAll(".wb-newpanel-zone, .wb-drag-ghost").length`);
    assert(leftovers === 0, "the drag ghost and the drop target are gone once the drag ends");

    await capture("03-after-drag.png");
  } finally {
    await post("/api/window/close", {}).catch(() => {});
    await delay(300);
    child.kill();
  }

  console.log(failures.length ? `\nMEMBER CWD GROUPS E2E FAILED (${failures.length})` : "\nMEMBER CWD GROUPS E2E PASSED");
  console.log(`screenshots: ${shots}`);
  process.exit(failures.length ? 1 : 0);
}

async function capture(name) {
  const target = path.join(shots, name);
  const result = await post("/api/capture", { path: target }).catch(() => ({}));
  assert(Boolean(result?.ok ?? fs.existsSync(target)), `saved ${name}`);
}

async function dismissGuideOffer(cdp) {
  const dismissed = await cdp.eval(`(() => {
    const dismiss = document.querySelector("[data-guide-offer] .ghost-btn");
    if (!(dismiss instanceof HTMLElement)) return false;
    dismiss.click();
    return true;
  })()`);
  if (dismissed) await delay(150);
}

// ---- plumbing (same shape as the other offline e2e scripts) ----------------

async function attachRenderer() {
  const portFile = path.join(userData, "DevToolsActivePort");
  const started = Date.now();
  let port = 0;
  while (Date.now() - started < 30000) {
    try {
      port = Number(fs.readFileSync(portFile, "utf8").split("\n")[0].trim());
      if (port > 0) break;
    } catch { /* not written yet */ }
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
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error("CDP websocket failed to open."));
  });
  let nextId = 1;
  const pending = new Map();
  socket.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    const entry = pending.get(msg.id);
    if (entry) { pending.delete(msg.id); entry(msg); }
  };
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
    socket.send(JSON.stringify({ id, method, params }));
  });
  return {
    async eval(expression) {
      const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) {
        throw new Error(`Renderer evaluation threw: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`);
      }
      return result.result.value;
    },
    async rightClick(x, y) {
      const point = { x: Math.round(x), y: Math.round(y), button: "right", clickCount: 1 };
      await send("Input.dispatchMouseEvent", { type: "mousePressed", buttons: 2, ...point });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", buttons: 0, ...point });
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function removePath(target) {
  await fs.promises.rm(target, { recursive: true, force: true }).catch(() => {});
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
