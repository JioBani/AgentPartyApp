# Claude Code UX 조사

이 폴더는 AgentParty가 Claude Code를 하네스로 감쌀 때 이해하거나
재현해야 할 사용자 관점의 Claude Code 동작을 정리한다.

이번 조사의 목적은 단순 기능 목록 작성이 아니다. 각 기능이 무엇을 위한
것인지, 사용자가 어떤 화면에서 어떻게 조작하는지, AgentParty 프론트엔드에
어떤 작업으로 반영해야 하는지를 판단할 수 있을 정도로 UX 요구사항을
분해하는 것이다.

조사 범위:

- `claude-code-cli.md`: Claude Code CLI의 기능, 상호작용 모델, 명령,
  권한, 에이전트, 도구, 터미널 UI 기대값.
- `claude-code-desktop.md`: Claude Desktop의 Code 탭 / Claude Code 통합
  동작. SDK가 아니라 앱 UI와 사용자 흐름에 초점을 둔다.
- `agentparty-product-implications.md`: CLI/Desktop UX에서 도출한
  AgentParty 제품 요구사항.
- `01-agent-view-background-agents.md`: `claude agents` Agent view의 화면 구조,
  row 상태, peek/attach/dispatch, 작업 목록 관리, AgentParty 대응 작업.
- `02-command-skill-palette.md`: `/` command palette, built-in command,
  skill/plugin/MCP prompt discovery, 입력 UX.
- `03-transcript-tools-permissions.md`: tool call, approval, permission mode,
  diff/context/status 표시 요구사항.
- `04-desktop-code-workbench.md`: Claude Desktop Code 탭의 pane 기반 workbench,
  preview/diff/terminal/file/tasks/side chat UX.
- `05-agentparty-gap-backlog.md`: 현재 AgentParty와 비교한 누락 기능 및
  우선순위 backlog.

로컬 확인:

- 설치된 로컬 CLI: `Claude Code 2.1.169`.
- `claude.cmd --help`, `claude.cmd agents --help`,
  `claude.cmd mcp --help`, `claude.cmd plugin --help`,
  `claude.cmd auth --help`의 출력으로 로컬 기능 표면을 확인했다.

주요 출처:

- Claude Code overview: https://docs.anthropic.com/en/docs/claude-code/overview
- Interactive mode: https://docs.anthropic.com/en/docs/claude-code/interactive-mode
- Slash commands: https://docs.anthropic.com/en/docs/claude-code/slash-commands
- CLI reference: https://docs.anthropic.com/en/docs/claude-code/cli-reference
- Settings: https://docs.anthropic.com/en/docs/claude-code/settings
- Hooks: https://docs.anthropic.com/en/docs/claude-code/hooks
- Subagents: https://docs.anthropic.com/en/docs/claude-code/sub-agents
- Skills: https://docs.anthropic.com/en/docs/claude-code/skills
- Plugins: https://docs.anthropic.com/en/docs/claude-code/plugins
- MCP: https://docs.anthropic.com/en/docs/claude-code/mcp
- IDE integrations: https://docs.anthropic.com/en/docs/claude-code/ide-integrations
- Claude Code on the web: https://docs.anthropic.com/en/docs/claude-code/claude-code-on-the-web
- Claude Desktop Code tab: https://docs.anthropic.com/en/docs/claude-code/desktop
- Security / permissions: https://docs.anthropic.com/en/docs/claude-code/security
- Release notes: https://docs.anthropic.com/en/release-notes/claude-code

현재 AgentParty 대조 기준:

- 확인한 파일: `src/renderer/workbench/*`, `src/renderer/app/transcriptEvents.ts`,
  `src/main/application/partyApplicationService.ts`.
- 이미 있는 것: party/member sidebar, multi-panel Workbench, member wizard,
  per-member Runtime modal, 기본 transcript/tool/approval/channel/action card.
- 큰 누락: Agent view 스타일의 background session manager, slash/skill palette,
  Desktop Code 탭의 diff/preview/terminal/file/tasks/side chat pane, MCP/plugin/skill
  GUI 관리, PR/CI 상태, worktree/session lifecycle UI.
