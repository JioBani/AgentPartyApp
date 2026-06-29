# Claude Code CLI 기능 및 UX 조사

이 문서는 사용자에게 보이는 Claude Code CLI 제품을 다룬다. 터미널
상호작용, 명령 표면, 도구/권한 표시, 에이전트, 설정을 중심으로 정리하며
SDK 구현 세부사항은 범위에서 제외한다.

## 제품 형태

Claude Code CLI는 기본적으로 대화형 터미널 코딩 세션을 시작한다.
또한 `--print`를 통해 비대화형 자동화 모드도 지원한다.

사용자 관점의 핵심 모델:

- 터미널은 채팅 입력창이면서 동시에 실시간 실행 콘솔이다.
- Claude는 현재 저장소, 추가 허용 디렉터리, 활성화된 MCP 서버,
  플러그인, 스킬에 접근한다.
- 도구 사용은 사용자에게 보이며, 정책상 허용된 경우를 제외하면 권한
  확인을 거친다. 사용자는 실행 중인 응답을 중단할 수 있다.
- 세션은 디렉터리나 세션 ID 기준으로 재개할 수 있고 이름을 붙일 수 있다.
- 커스텀 동작은 프로젝트/사용자 설정, `CLAUDE.md`, slash command, 스킬,
  플러그인, hook, MCP, subagent에서 온다.

로컬 확인 버전: `2.1.169 (Claude Code)`.

## 실행 및 세션 모드

대화형 실행:

- `claude`는 현재 디렉터리에서 대화형 세션을 시작한다.
- prompt 인자를 넘기면 첫 사용자 메시지와 함께 세션을 시작한다.
- `--name`은 prompt box, resume picker, 터미널 제목에 표시되는 세션 이름을
  설정한다.
- `--continue`는 현재 디렉터리의 가장 최근 대화를 이어간다.
- `--resume [value]`는 세션 ID로 재개하거나 picker를 연다.
- `--from-pr [value]`는 PR에 연결된 세션을 재개하거나 picker를 연다.
- `--fork-session`은 재개 시 기존 세션 ID를 재사용하지 않고 새 세션 ID를
  만든다.
- `--session-id <uuid>`는 특정 세션 ID를 사용한다.
- `--no-session-persistence`는 print 모드에서 세션 저장을 끈다.

비대화형 실행:

- `-p, --print`는 응답을 출력하고 종료한다.
- `--output-format text|json|stream-json`은 출력 형식을 정한다.
- `--input-format text|stream-json`은 일반 입력 또는 실시간 streaming 입력을
  지원한다.
- `--include-partial-messages`는 stream-json에서 부분 메시지 chunk를 내보낸다.
- `--include-hook-events`는 stream-json에 hook lifecycle event를 포함한다.
- `--replay-user-messages`는 streaming 입력 메시지를 stdout으로 다시 내보낸다.
- `--json-schema`는 구조화 출력의 JSON Schema 검증을 수행한다.
- `--max-budget-usd`는 print 모드의 API 비용 상한을 둔다.
- `--fallback-model`은 primary 모델이 불가하거나 과부하일 때 대체 모델을
  순서대로 시도한다.
- `--prompt-suggestions`는 turn 이후 다음 사용자 prompt 예측을 내보낸다.

최소/문제 해결 모드:

- `--safe-mode`는 `CLAUDE.md`, 스킬, 플러그인, hook, MCP 서버, 커스텀 명령,
  에이전트, output style, workflow, theme, keybinding 등을 비활성화한다.
  인증, 모델 선택, 내장 도구, 권한은 정상 동작한다.
- `--bare`는 더 엄격한 최소 모드다. hook, LSP, plugin sync, attribution,
  auto-memory, background prefetch, keychain read, `CLAUDE.md` 자동 탐색을
  건너뛴다. 필요한 context는 명시적으로 제공해야 한다.
- `--debug [filter]`, `--debug-file`, `doctor`는 진단 표면을 제공한다.

## 메인 입력창과 키보드 UX

문서화된 대화형 단축키:

- `Ctrl+C`: 현재 입력/생성을 취소한다.
- `Ctrl+D`: Claude Code를 종료한다.
- `Ctrl+L`: 터미널 화면을 지운다.
- 위/아래 방향키: 명령 history를 이동한다.
- `Esc` 두 번: 이전 메시지를 수정한다.
- `Shift+Tab`: permission mode를 전환한다.
- 입력 시작 위치의 `#`: memory shortcut. `CLAUDE.md`에 context를 빠르게
  추가하는 데 사용된다.
- `/`: slash command를 연다.

AgentParty 시사점: composer는 단순 textarea가 아니라 명령 surface처럼
동작해야 한다. command discovery, history, interrupt, 이전 메시지 수정 또는
그에 준하는 기능, mode 전환 표시가 필요하다.

## Slash Command 시스템

Slash command는 일급 상호작용 계층이다. 단순 문자열 명령이 아니라 discovery,
preview, argument, custom command, skill/plugin entry를 포함하는 UX다.

문서화된 내장 명령:

- `/add-dir`: 추가 작업 디렉터리를 허용한다.
- `/agents`: 커스텀 AI subagent를 관리한다.
- `/bug`: Anthropic에 버그를 보고한다.
- `/clear`: 대화 history를 지운다.
- `/compact [instructions]`: context를 compact한다. 선택적으로 집중할 지시를
  줄 수 있다.
- `/config`: 설정을 보거나 수정한다.
- `/cost`: token/cost 사용량을 보여준다.
- `/doctor`: Claude Code 설치 상태를 점검한다.
- `/help`: 사용 도움말을 보여준다.
- `/init`: 프로젝트 안내를 `CLAUDE.md`에 초기화한다.
- `/login`, `/logout`: 계정 인증.
- `/memory`: memory file을 편집한다.
- `/mcp`: MCP 서버 연결 및 OAuth 인증을 관리한다.
- `/model`: 모델을 선택하거나 변경한다.
- `/output-style`: output style을 선택한다.
- `/permissions`: 권한 설정을 보거나 수정한다.
- `/pr-comments`: PR comment를 본다.
- `/review`: 코드 리뷰를 요청한다.
- `/status`: 계정, 시스템, 도구 상태를 보여준다.
- `/terminal-setup`: newline 입력을 위한 key binding 지원을 설치한다.
- `/vim`: Vim editing mode로 들어간다.

커스텀 slash command:

- Markdown prompt file로 저장된다.
- 프로젝트 범위 또는 사용자 범위로 둘 수 있다.
- argument와 폴더 기반 namespace를 지원한다.
- command 내용에서 파일과 bash command 출력을 참조할 수 있다.
- 프로젝트 파일로 팀과 공유할 수 있다.

스킬과 slash command:

- 스킬은 `/skill-name` 형태로 호출된다.
- `/`를 입력할 때 CLI가 스킬을 preview/discovery할 수 있다.
- 로컬 help에서 `--disable-slash-commands`가 모든 스킬을 비활성화한다고
  설명한다. 즉 제품 모델상 스킬은 slash-command-discoverable capability다.

AgentParty 시사점: `/`는 내장 명령, 프로젝트 명령, 스킬, 플러그인,
AgentParty의 member/app 명령을 검색할 수 있는 command palette를 열어야 한다.
각 항목에는 이름, 설명, scope/source, argument, disabled/unavailable 상태가
표시되어야 한다.

## 모델, Effort, Thinking, Runtime 선택

CLI flag:

- `--model <model>`은 `sonnet`, `opus` 같은 alias 또는 전체 모델 이름을
  받는다.
- `--effort low|medium|high|xhigh|max`는 reasoning effort를 설정한다.
- `--permission-mode acceptEdits|auto|bypassPermissions|default|dontAsk|plan`은
  approval 동작을 설정한다.
- `--tools`는 사용 가능한 내장 도구를 제한한다.
- `--allowedTools`, `--disallowedTools`는 tool permission을 조정한다.
- `--betas`는 API key 사용자에게 beta header를 붙인다.

대화형 명령도 같은 역할을 한다:

- `/model`: 모델 변경.
- `/permissions`: 권한 설정.
- `/config`, `/status`: runtime/account/config 상태 확인.

AgentParty 시사점: runtime surface는 세션별로 보여야 한다. transcript header에
model, effort/thinking, permission mode, tool, MCP state, debug/safe-mode
indicator가 있어야 한다.

## Tool Use와 Permission UX

Claude Code는 read, edit, write, search, bash, web, todo, notebook 관련 작업
등 저장소/쉘 기반 내장 도구를 제공한다. 실제 사용 가능 도구는 mode, settings,
MCP, plugin, command-line 제한에 따라 달라진다.

보존해야 할 사용자-facing 동작:

- 도구 호출은 assistant turn의 일부로 보인다.
- 위험하거나 정책상 gate가 필요한 도구는 권한 요청을 띄운다.
- 사용 중 permission mode를 바꿀 수 있다.
- 도구 allow/deny는 전역 또는 실행 단위로 설정할 수 있다.
- 사용자는 실행 중인 응답을 중단할 수 있다.
- debug output은 stderr, API, hook, MCP 등 category를 보여줄 수 있다.
- hook은 tool use 전/후에 실행될 수 있으며 실행 결과에 영향을 줄 수 있다.

로컬 CLI에서 확인한 permission mode:

- `default`
- `acceptEdits`
- `plan`
- `auto`
- `dontAsk`
- `bypassPermissions`

AgentParty 시사점: tool call은 구조화된 expandable block으로 렌더링해야 한다.
status, input summary, output/error, duration, permission state, hook/MCP
provenance가 필요하다. approval card는 무엇을 실행/변경할지 정확히 보여주고
allow/deny/update 선택지를 제공해야 한다.

## Subagent와 Background Agent

Claude Code에는 서로 관련되지만 다른 두 가지 agent 개념이 있다.

커스텀 subagent:

- `/agents`와 `agents` command로 관리한다.
- file로 정의하거나 `--agents <json>`으로 전달할 수 있다.
- `--agent <agent>`로 현재 세션의 agent를 선택할 수 있다.
- description, prompt, tool access를 가지며 전문화된 작업에 사용된다.
- Claude가 자동으로 사용할 수도 있고 사용자가 명시적으로 사용할 수도 있다.

Background agents / agent view:

- 로컬 CLI는 `claude agents`를 제공한다.
- `claude agents --json`은 active session을 scripting용 JSON 배열로 출력한다.
- `--all`은 완료된 session까지 agent view 목록에 포함한다.
- `--cwd`는 working directory로 필터링한다.
- dispatch되는 background session의 기본값으로 model, effort, permission
  mode, MCP config, settings, plugin dir, agent, extra directory 등을 줄 수
  있다.

관련 실행 flag:

- `--worktree [name]`: 세션용 git worktree를 만든다.
- `--tmux`: worktree용 tmux session을 만든다. 가능한 경우 iTerm2 native pane을
  사용한다.
- `ultrareview`: 현재 branch, PR, base branch에 대한 cloud-hosted multi-agent
  code review를 실행한다.

AgentParty 시사점: member는 identity, role, cwd/worktree, model, permission
mode, status, transcript, result history를 가진 실제 agent로 보여야 한다.
background/completed 상태도 사라지지 않고 탐색 가능해야 한다.

## MCP UX

CLI command group: `claude mcp`.

사용자에게 보이는 기능:

- HTTP MCP server 추가.
- header가 포함된 HTTP server 추가.
- env var와 subprocess arg가 있는 stdio server 추가.
- JSON으로 MCP server 추가.
- 지원 플랫폼에서 Claude Desktop의 MCP server를 가져오기.
- 구성된 server 목록 보기.
- server 상세 보기.
- server 제거.
- project-scoped approval/rejection 초기화.
- Claude Code 자체를 MCP server로 serve.
- 승인되지 않은 project-scoped `.mcp.json` server를 pending approval 상태로
  표시. 승인 전에는 연결하지 않는다.

AgentParty 시사점: MCP server는 configured/pending/connected/error 상태가 있는
connection panel에 보여야 한다. tool call은 어떤 MCP server가 제공한 도구인지
식별해야 한다.

## Plugin과 Skill

Plugin:

- `claude plugin|plugins`로 관리한다.
- install, uninstall/remove, update, list, enable, disable, details, validate,
  scaffold new plugin, marketplace 관리, prune, tag를 제공한다.
- `--plugin-dir`, `--plugin-url`로 세션 한정 plugin을 load할 수 있다.
- safe mode는 plugin을 비활성화한다.

Skill:

- `/skill-name`으로 호출된다.
- instruction, reference, script, asset을 포함할 수 있다.
- slash command UX를 통해 discovery된다.
- 로컬 CLI help 기준 bare mode에서도 명시적으로 제공된 skill은 resolve된다.

AgentParty 시사점: skill/plugin inventory, status, source, 가능한 경우 token/cost
preview, 세션별 enable/disable control이 필요하다.

## Hook과 자동화

Claude Code는 lifecycle hook을 지원하며 특히 tool use 주변 hook이 중요하다.
stream-json mode에서는 hook event를 output stream에 포함할 수 있다.

사용자-facing 요구:

- hook 실행이 동작에 영향을 주면 보여야 한다.
- hook error는 조용히 사라지면 안 된다.
- debug filter를 통해 hook/API/MCP 실패를 검사할 수 있어야 한다.

AgentParty 시사점: hook lifecycle을 status 또는 tool-adjacent event로 표시하고,
hook 실패를 visible diagnostics/log로 라우팅해야 한다.

## IDE 통합

CLI flag:

- `--ide`: 시작 시 유효한 IDE가 정확히 하나 있으면 자동 연결한다.

문서화된 IDE 통합은 editor context awareness와 editor 관련 workflow를 포함한다.
CLI 사용자는 파일 선택, diagnostics, editor state가 Claude에게 context로 전달될
것을 기대할 수 있다.

AgentParty 시사점: AgentParty가 IDE가 아니더라도 현재 repo/path context가
무엇인지 보여주고 context attachment를 명시적으로 제공해야 한다.

## 인증과 계정 UX

CLI command group: `claude auth`.

명령:

- `login`
- `logout`
- `status`

대화형 slash command:

- `/login`
- `/logout`
- `/status`

AgentParty 시사점: 계정/auth 상태는 log를 열지 않아도 보여야 한다. provider
error와 credential missing은 session header와 auth panel에 표시되어야 한다.

## 로컬 CLI에서 확인한 명령

`claude.cmd --help` on 2.1.169:

- `agents`: background agent 관리.
- `auth`: 인증 관리.
- `auto-mode`: auto mode classifier 설정 검사.
- `doctor`: updater/installation health 확인.
- `install`: native build 설치.
- `mcp`: MCP server 구성 및 관리.
- `plugin|plugins`: plugin 관리.
- `project`: Claude Code project state 관리.
- `setup-token`: long-lived auth token 설정.
- `ultrareview`: cloud-hosted multi-agent code review.
- `update|upgrade`: 업데이트 확인 및 설치.

## AgentParty UX 체크리스트

- preview와 disabled state가 있는 searchable slash command palette.
- composer history, interrupt, clear, 이전 메시지 수정 affordance.
- status, input, output, error, timing, source가 있는 구조화 tool card.
- allow/deny/update와 결정 history가 남는 approval card.
- session header: model, effort/thinking, permission mode, cwd, auth, MCP,
  plugin/skill/safe-mode/debug state.
- agent list: active, background, completed, resumable session.
- subagent/member 생성: name, role, prompt, tools, model, effort, permission,
  cwd/worktree.
- MCP panel: configured, pending approval, connected, failed.
- Plugin/skill panel: installed, enabled, source, 가능한 경우 projected token
  cost.
- hook, MCP, provider, auth, permission failure의 visible diagnostics.

