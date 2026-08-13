/**
 * A fixed environment report covering every state the 환경 screen can show.
 *
 * The screen reads a LIVE probe of the machine it runs on, which is exactly
 * what it is for — and exactly why its design could not be reviewed: on a
 * healthy machine every row is green, and the interesting states (missing CLI,
 * version skew, a repair that failed) only appear on a broken one. Breaking a
 * reviewer's machine to look at a card is not an acceptable price.
 *
 * So this is the same report shape, filled in by hand, installed by the QA-only
 * `POST /api/qa/environment`. Shared with the design gallery so the settings
 * tab and the in-transcript blocker cards are reviewed against ONE fixture.
 *
 * The ids are real check ids (`harness.codex`, …), not invented ones: the
 * transcript card looks its content up by id, so a fixture with made-up ids
 * would render the fallback text instead of the design under review.
 */
import type { EnvironmentReport } from "./environment";

export const GALLERY_ENVIRONMENT_REPORT: EnvironmentReport = {
  checkedAt: "2026-08-13T01:00:00.000Z",
  expectedClaudeCli: "2.1.191",
  checks: [
    // --- harness: one row per state -------------------------------------
    {
      id: "harness.claude-code",
      group: "harness",
      label: "Claude Code",
      status: "warn",
      detail: "사용 중: 이 PC에 설치된 Claude Code (PATH). 이 빌드의 Agent SDK는 2.1.191과 짝을 이루는데 설치된 버전은 2.1.229입니다. 대부분 동작하지만 문제가 생기면 이 차이를 먼저 의심하세요.",
      version: "2.1.229 (Claude Code)",
      path: "C:\\Users\\me\\.local\\bin\\claude.exe",
      remedies: [
        { kind: "command", label: "설치 명령 복사", command: "npm install -g @anthropic-ai/claude-code" },
        { kind: "docs", label: "설치 안내", url: "https://claude.com/claude-code" },
        { kind: "settings", label: "실행 파일 경로 지정", settingsField: "claudeExecutablePath" },
      ],
    },
    {
      id: "harness.codex",
      group: "harness",
      label: "Codex",
      status: "ok",
      detail: "설치되어 있고 로그인되어 있습니다.",
      version: "codex-cli 0.146.0",
      path: "C:\\Users\\me\\AppData\\Roaming\\npm\\codex.CMD",
    },
    {
      id: "harness.cursor",
      group: "harness",
      label: "Cursor",
      status: "missing",
      detail: "설치되어 있지만 로그인되어 있지 않습니다.",
      path: "C:\\Users\\me\\AppData\\Local\\cursor-agent\\versions\\2026.07.23-e383d2b",
      remedies: [
        { kind: "command", label: "로그인 명령 복사", command: "cursor-agent login" },
        { kind: "repair", label: "로그인", repairId: "harness.cursor.login", command: "cursor-agent login", confirm: "Cursor 로그인을 실행합니다. 브라우저가 열릴 수 있습니다." },
      ],
    },
    {
      id: "harness.grok",
      group: "harness",
      label: "Grok Build",
      status: "missing",
      detail: "Grok Build CLI가 설치되어 있지 않습니다. Grok 하네스 멤버를 실행할 수 없습니다.",
      raw: "The official Grok Build CLI was not found. Install it with `irm https://x.ai/cli/install.ps1 | iex` (Windows) or `curl -fsSL https://x.ai/cli/install.sh | bash`, then run `grok login`. Tried: grok: spawn grok ENOENT. No fallback was attempted.",
      remedies: [
        { kind: "command", label: "설치 명령 복사", command: "irm https://x.ai/cli/install.ps1 | iex" },
        { kind: "repair", label: "설치하기", repairId: "harness.grok.install", command: "irm https://x.ai/cli/install.ps1 | iex", confirm: "이 PC에 Grok Build CLI를 설치합니다." },
        { kind: "docs", label: "설치 안내", url: "https://x.ai/cli" },
        { kind: "settings", label: "실행 파일 경로 지정", settingsField: "grokExecutablePath" },
      ],
    },

    // --- runtime ---------------------------------------------------------
    { id: "runtime.git", group: "runtime", label: "Git", status: "ok", detail: "사용 가능합니다.", version: "git version 2.47.0.windows.2", path: "C:\\Program Files\\Git\\cmd\\git.exe" },
    {
      id: "runtime.node",
      group: "runtime",
      label: "Node.js",
      status: "error",
      detail: "Node.js를 찾았지만 실행하지 못했습니다.",
      path: "C:\\Program Files\\nodejs\\node.exe",
      raw: "spawn C:\\Program Files\\nodejs\\node.exe EACCES",
      remedies: [{ kind: "docs", label: "Node.js 설치 안내", url: "https://nodejs.org/" }],
    },

    // --- wsl: the drift case this feature was built for -------------------
    { id: "wsl.available", group: "wsl", label: "WSL", status: "ok", detail: "배포판 2개: Ubuntu-20.04, Ubuntu" },
    { id: "wsl.Ubuntu-20.04.node", group: "wsl", label: "Ubuntu-20.04 · Node.js", status: "ok", detail: "배포판 안에 Node.js가 있습니다.", version: "v20.20.1" },
    {
      id: "wsl.Ubuntu-20.04.sdk",
      group: "wsl",
      label: "Ubuntu-20.04 · Claude Agent SDK",
      status: "warn",
      detail: "이 배포판에는 0.3.201이 설치되어 있고 앱은 0.3.191을 씁니다. 배포판 SDK는 처음 설치된 뒤 자동으로 갱신되지 않습니다.",
      version: "0.3.201",
      remedies: [{ kind: "repair", label: "SDK 다시 설치", repairId: "wsl.sdk.reinstall:Ubuntu-20.04" }],
    },
    {
      id: "wsl.Ubuntu.node",
      group: "wsl",
      label: "Ubuntu · Node.js",
      status: "missing",
      detail: "배포판 안에 Node.js가 없습니다. 이 배포판의 워크스페이스는 열 수 없습니다.",
      remedies: [
        { kind: "command", label: "설치 명령 복사", command: "wsl -d Ubuntu -e bash -lc \"sudo apt update && sudo apt install -y nodejs npm\"" },
        { kind: "docs", label: "WSL에 Node 설치", url: "https://learn.microsoft.com/windows/dev-environment/javascript/nodejs-on-wsl" },
      ],
    },
    { id: "wsl.Ubuntu.sdk", group: "wsl", label: "Ubuntu · Claude Agent SDK", status: "unknown", detail: "아직 설치되지 않았습니다. 이 배포판의 워크스페이스를 처음 열 때 자동으로 설치됩니다." },
  ],
};
