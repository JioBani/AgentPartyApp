/*
 * One-click Windows packaging with a CLI progress UI.
 *
 * Runs the full build + electron-builder pipeline as discrete steps, showing a
 * percentage progress bar and the current task. Child output is buffered and
 * only printed if a step fails (so the progress bar stays clean, but failures
 * are never hidden — see AGENTS.md).
 *
 * Usage:  node scripts/package-win.mjs   (or double-click package-win.cmd)
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MOBILE_PIPE_PACKAGE,
  mainTsconfig,
  mobilePipeNotice,
  pruneBrokenPipeLink,
  pruneExternalPipeLinkForPackaging,
} from "./mobile-pipe.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";
const npmCmd = isWin ? "npm.cmd" : "npm";
const localTool = (name) =>
  path.join(projectRoot, "node_modules", ".bin", isWin ? `${name}.cmd` : name);

const requiredBuildTools = ["tsc", "vite", "electron-builder"];

/**
 * Dependencies a build is allowed to be missing. `@agentparty/protocol` is a
 * local-path package from the AgentPartyServer repo, so npm cannot fetch it and
 * a machine without that checkout builds the app without the mobile pipe (see
 * `mobile-pipe.mjs`). Announced, never silent — but not a reason to stop.
 */
const optionalPackages = new Set([MOBILE_PIPE_PACKAGE]);

/**
 * What counts as installed: every required package.json dependency resolves to
 * a folder in node_modules, and every build tool has its .bin shim. Checking
 * only the shims misses a dependency that was added to package.json but never
 * installed — the build then dies deep inside tsc ("Cannot find module ...")
 * instead of here, where it can just be installed.
 *
 * existsSync follows symlinks, so a `file:` dependency whose target directory
 * is gone counts as missing too.
 */
function missingInstalls() {
  const pkg = JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  const declared = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  const missingPackages = declared.filter(
    (name) => !optionalPackages.has(name) && !existsSync(path.join(projectRoot, "node_modules", ...name.split("/"))),
  );
  const missingTools = requiredBuildTools.filter((name) => !existsSync(localTool(name)));
  return [...new Set([...missingPackages, ...missingTools])];
}

const summarize = (names, max = 6) =>
  names.length <= max ? names.join(", ") : `${names.slice(0, max).join(", ")} 외 ${names.length - max}개`;

/** Local-path dependencies npm cannot fetch: say where they were supposed to be. */
function localPathHints(names) {
  const pkg = JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  const specs = { ...pkg.dependencies, ...pkg.devDependencies };
  return names
    .filter((name) => typeof specs[name] === "string" && specs[name].startsWith("file:"))
    .map((name) => {
      const target = path.resolve(projectRoot, specs[name].slice("file:".length));
      return `  - ${name} → ${target} (이 경로가 없습니다. 해당 저장소를 받아 빌드한 뒤 다시 실행하세요)`;
    });
}

// Each step is a discrete command. Weights approximate relative duration so the
// bar advances at a believable pace.
const buildSteps = () => [
  { name: "타입 체크 (renderer)", weight: 2, cmd: localTool("tsc"), args: ["-p", "tsconfig.json", "--noEmit"] },
  { name: "타입 체크 (main)", weight: 1, cmd: localTool("tsc"), args: ["-p", mainTsconfig(), "--noEmit"] },
  { name: "렌더러 빌드 (vite)", weight: 3, cmd: localTool("vite"), args: ["build"] },
  { name: "메인 프로세스 컴파일 (tsc)", weight: 2, cmd: localTool("tsc"), args: ["-p", mainTsconfig()] },
  { name: "엔진 서버 번들", weight: 1, cmd: process.execPath, args: ["scripts/build-engine-server.mjs"] },
  { name: "Windows 패키징 (electron-builder)", weight: 6, cmd: localTool("electron-builder"), args: ["--win", "--x64"] },
];

// ---- Terminal helpers -------------------------------------------------------
const supportsColor = process.stdout.isTTY;
const c = (code, s) => (supportsColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s) => c("2", s);
const cyan = (s) => c("36", s);
const green = (s) => c("32", s);
const red = (s) => c("31", s);
const bold = (s) => c("1", s);

const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function renderBar(fraction, label, frame) {
  const width = 28;
  const filled = Math.round(fraction * width);
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  const pct = String(Math.round(fraction * 100)).padStart(3, " ");
  const spin = frame == null ? " " : cyan(spinnerFrames[frame % spinnerFrames.length]);
  const line = `${spin} ${cyan(bar)} ${bold(pct + "%")}  ${label}`;
  if (process.stdout.isTTY) {
    process.stdout.write("\r\x1b[K" + line);
  } else {
    process.stdout.write(line + "\n");
  }
}

function runStep(step, baseFraction, stepFraction) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let frame = 0;
    // Only .cmd shims (npx.cmd) need a shell; running node.exe (process.execPath)
    // through a shell breaks on the space in "C:\Program Files\...".
    const needsShell = isWin && /\.cmd$/i.test(step.cmd);
    const child = spawn(step.cmd, step.args, {
      cwd: projectRoot,
      shell: needsShell,
      env: process.env,
    });

    const timer = setInterval(() => {
      frame += 1;
      // Ease within the step so the bar creeps forward without ever completing early.
      const creep = Math.min(0.9, frame / 120);
      renderBar(baseFraction + stepFraction * creep, dim(step.name), frame);
    }, 80);

    child.stdout.on("data", (d) => chunks.push(d));
    child.stderr.on("data", (d) => chunks.push(d));

    child.on("error", (err) => {
      clearInterval(timer);
      reject({ err, output: Buffer.concat(chunks).toString("utf8") });
    });
    child.on("close", (code) => {
      clearInterval(timer);
      if (code === 0) resolve();
      else reject({ code, output: Buffer.concat(chunks).toString("utf8") });
    });
  });
}

async function main() {
  console.log(bold("\n  AgentParty · Windows 패키징\n"));

  const externalPipe = pruneExternalPipeLinkForPackaging();
  if (externalPipe) {
    console.log(dim(`  외부 로컬 패키지 링크 제외: ${externalPipe.link} → ${externalPipe.target}`));
    console.log(dim("  electron-builder는 앱 루트 밖의 파일을 패키징할 수 없어 모바일 연결을 뺀 배포본으로 진행합니다.\n"));
  }

  // node_modules can exist while empty, stale, or only partially installed.
  // Verify what package.json actually declares instead of treating the
  // directory as sufficient.
  // A reduced build must never be a quiet one: say so before the bar starts.
  const pipeNotice = mobilePipeNotice();
  if (pipeNotice) console.log(dim(`  ${pipeNotice}\n`));

  const missing = missingInstalls();
  if (missing.length > 0) {
    console.log(dim(`  의존성 누락 (${summarize(missing)}) → npm install 실행 중...\n`));
    await runStep({ name: "의존성 설치", cmd: npmCmd, args: ["install"] }, 0, 0);
    process.stdout.write("\n");

    const stillMissing = missingInstalls();
    if (stillMissing.length > 0) {
      const hints = localPathHints(stillMissing);
      throw new Error(
        `npm install 후에도 없는 패키지: ${summarize(stillMissing)}` +
          (hints.length > 0 ? `\n${hints.join("\n")}` : ""),
      );
    }
  }

  // After the install (which recreates it) and before electron-builder, whose
  // `@electron/rebuild` stats every node_modules entry and cannot survive a link
  // that points at nothing.
  const pruned = pruneBrokenPipeLink();
  if (pruned) {
    console.log(dim(`  끊어진 링크 정리: ${pruned}\n`));
  }

  const steps = buildSteps();
  const totalWeight = steps.reduce((a, s) => a + s.weight, 0);
  let done = 0;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const base = done / totalWeight;
    const frac = step.weight / totalWeight;
    renderBar(base, dim(step.name), 0);
    try {
      await runStep(step, base, frac);
    } catch (e) {
      renderBar(base, red(step.name + " 실패"), null);
      process.stdout.write("\n\n");
      console.error(red(bold(`  ✖ 단계 실패: ${step.name}`)));
      console.error(dim(`  명령: ${step.cmd} ${step.args.join(" ")}\n`));
      if (e.output && e.output.trim()) {
        console.error(e.output.trim());
      } else if (e.err) {
        console.error(String(e.err));
      }
      process.stdout.write("\n");
      process.exit(1);
    }
    done += step.weight;
    if (process.stdout.isTTY) {
      process.stdout.write("\r\x1b[K" + `  ${green("✔")} ${step.name}\n`);
    }
  }

  renderBar(1, green("완료"), null);
  process.stdout.write("\n\n");

  const releaseDir = path.join(projectRoot, "release");
  console.log(green(bold("  ✔ 패키징 완료")));
  console.log(dim(`  결과물: ${releaseDir}\n`));

  if (isWin && existsSync(releaseDir)) {
    spawn("explorer", [releaseDir], { detached: true, stdio: "ignore" }).unref();
  }
}

main().catch((e) => {
  // runStep rejects with { code, output } rather than an Error; print the child
  // output as text so a failed npm install is readable instead of inspected.
  console.error(red(bold("\n  ✖ 패키징 중단")));
  if (e instanceof Error) console.error(e.message);
  else if (e?.output?.trim()) console.error(e.output.trim());
  else console.error(e);
  process.stdout.write("\n");
  process.exit(1);
});
