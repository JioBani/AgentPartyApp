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
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";
const npmCmd = isWin ? "npm.cmd" : "npm";
const npxCmd = isWin ? "npx.cmd" : "npx";

// Each step is a discrete command. Weights approximate relative duration so the
// bar advances at a believable pace.
const steps = [
  { name: "타입 체크 (renderer)", weight: 2, cmd: npxCmd, args: ["tsc", "-p", "tsconfig.json", "--noEmit"] },
  { name: "타입 체크 (main)", weight: 1, cmd: npxCmd, args: ["tsc", "-p", "tsconfig.main.json", "--noEmit"] },
  { name: "렌더러 빌드 (vite)", weight: 3, cmd: npxCmd, args: ["vite", "build"] },
  { name: "메인 프로세스 컴파일 (tsc)", weight: 2, cmd: npxCmd, args: ["tsc", "-p", "tsconfig.main.json"] },
  { name: "엔진 서버 번들", weight: 1, cmd: process.execPath, args: ["scripts/build-engine-server.mjs"] },
  { name: "Windows 패키징 (electron-builder)", weight: 6, cmd: npxCmd, args: ["electron-builder", "--win", "--x64"] },
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

  // Install deps if missing.
  if (!existsSync(path.join(projectRoot, "node_modules"))) {
    console.log(dim("  node_modules 없음 → npm install 실행 중...\n"));
    await runStep({ name: "의존성 설치", cmd: npmCmd, args: ["install"] }, 0, 0);
    process.stdout.write("\n");
  }

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
  console.error(red("\n예상치 못한 오류:"), e);
  process.exit(1);
});
