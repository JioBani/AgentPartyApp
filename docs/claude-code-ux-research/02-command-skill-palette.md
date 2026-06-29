# Slash Command / Skill Palette 상세 조사

출처:

- 공식 commands reference: https://code.claude.com/docs/en/commands
- Desktop reference: https://code.claude.com/docs/en/desktop
- 로컬 확인: `claude.cmd --help`, `claude.cmd plugin --help`

## 한 줄 정의

Claude Code에서 `/`는 단순 문자열 명령 입력이 아니라 command/skill/workflow/MCP
prompt discovery surface다. 사용자는 `/`를 입력해 가능한 기능을 탐색하고,
filter하고, 선택하고, argument를 붙여 실행한다.

AgentParty는 지금 composer가 plain textarea에 가깝다. Claude Code parity를
위해서는 `/` palette가 핵심 프론트 작업이다.

## 무엇을 해결하는가

사용자는 모든 기능의 위치를 외울 수 없다. Slash command palette는 다음 역할을
한다.

- 숨겨진 기능 발견.
- 현재 session에서 사용 가능한 기능만 표시.
- command의 scope/source를 알려준다.
- skill/plugin/MCP prompt까지 한 곳에서 실행.
- argument 형식을 보여준다.
- command를 prompt에 삽입하거나 즉시 실행한다.

Desktop Code 탭에서도 같은 개념이 있다. prompt box의 `+` 버튼 또는 `/` 입력으로
skills, slash commands, connectors, plugins를 탐색한다.

## Command taxonomy

Claude Code command는 크게 다섯 종류로 나눠야 한다.

### Built-in control command

CLI가 직접 처리하는 명령.

예:

- `/model`
- `/effort`
- `/permissions`
- `/config`
- `/status`
- `/clear`
- `/compact`
- `/resume`
- `/diff`
- `/mcp`
- `/plugin`
- `/agents`
- `/tasks`
- `/background` / `/bg`

UI 요구:

- 즉시 실행 또는 dialog open.
- session state를 직접 바꿀 수 있음.
- destructive command는 confirm 필요.

### Built-in skill

명령처럼 보이지만 실제로는 prompt/workflow로 Claude에게 넘겨지는 기능.

예:

- `/batch`
- `/code-review`
- `/debug`
- `/deep-research`
- `/verify`
- `/run`
- `/simplify`
- `/loop`

UI 요구:

- skill 설명.
- 예상 동작: read-only인지, edit인지, background 작업인지.
- 필요한 조건: git repo, app preview, GitHub auth 등.
- 실행 후 어떤 pane/row에 결과가 나타나는지 표시.

### User/project custom command

Markdown prompt file 기반 command.

UI 요구:

- scope: user/project/local/plugin.
- file path.
- argument placeholder.
- team-shared 여부.
- reload 가능 상태.

### MCP prompt

MCP server가 노출하는 prompt. 형식은 `/mcp__<server>__<prompt>`.

UI 요구:

- MCP server name.
- connection status.
- unavailable/pending approval이면 disabled.
- 실행 시 어떤 external service context를 사용하는지 표시.

### AgentParty command

AgentParty가 추가해야 할 앱 고유 command.

예:

- `/party-create`
- `/member-create`
- `/member-open`
- `/send-to <member>`
- `/split-panel`
- `/open-peek`
- `/dispatch`
- `/route-model`

UI 요구:

- Claude Code command와 섞되 source badge를 `AgentParty`로 표시.
- 모든 command는 local automation API endpoint와 연결.

## Palette UI 설계

Trigger:

- composer에서 `/` 입력.
- prompt box `+` 버튼의 “Slash commands”.
- keyboard shortcut.

Layout:

- 검색 input.
- command list.
- 오른쪽 또는 하단 preview pane.
- category tabs 또는 section headers:
  - Commands
  - Skills
  - Agents
  - MCP prompts
  - Plugins
  - AgentParty
- disabled item은 왜 disabled인지 보여준다.

Command row 최소 정보:

- icon.
- command name.
- short description.
- category/source.
- scope: built-in/user/project/plugin/MCP.
- badge:
  - `requires git`
  - `read-only`
  - `edits files`
  - `background`
  - `cloud`
  - `needs auth`
  - `disabled`
- argument signature.

Preview pane:

- 긴 설명.
- 입력 예시.
- 실행 결과가 어디에 표시되는지.
- 위험/권한 영향.
- 관련 설정.
- source file 또는 plugin.

## 입력 동작

Claude Code command는 메시지 시작 위치에서만 인식된다. AgentParty도 이 규칙을
따르는 것이 좋다.

동작:

- `/` + 글자 입력: filter.
- Enter:
  - argument가 필요 없으면 실행 또는 삽입.
  - argument가 필요하면 composer에 command scaffold 삽입.
- Tab:
  - highlighted suggestion 적용.
- Escape:
  - palette 닫기.
- command 선택 후 일반 text를 이어 쓰면 argument/prompt로 전달.

Agent view dispatch input과 차이:

- 일반 session composer에서 `/compact`는 현재 session에 실행된다.
- Agent view dispatch input에서 `/init` 같은 command/skill은 새 background
  session의 첫 prompt로 dispatch될 수 있다.
- AgentParty는 “현재 member에 실행”과 “새 member로 dispatch”를 명확히 구분해야
  한다.

## 중요한 command별 UX 요구

### `/model`

사용 목적:

- session model 변경.
- 지원 모델의 effort 조정.
- current session only 또는 default 변경 구분.

AgentParty 상태:

- Runtime modal이 model/effort/thinking 일부를 제공한다.

추가 작업:

- command palette에서 `/model` 실행 시 Runtime modal을 열거나 inline picker.
- current member only / global default 선택.
- 모델 변경 시 “현재 context 재처리/재시작 가능성” 안내.

### `/permissions`

사용 목적:

- allow/ask/deny rule 관리.
- working directory 관리.
- recent auto mode denial review.

AgentParty 상태:

- composer에 permission dropdown은 있음.
- allow/deny rule 관리 UI는 없음.

추가 작업:

- Permission panel:
  - mode selector.
  - allow rules.
  - deny rules.
  - ask rules.
  - working directories.
  - recent denials.
- tool approval card와 연결.

### `/mcp`

사용 목적:

- MCP server list.
- reconnect.
- enable/disable.
- OAuth auth.

AgentParty 상태:

- in-process party tool은 있지만 사용자 MCP 관리 UI는 없음.

추가 작업:

- MCP panel:
  - connected / needs auth / failed / pending approval.
  - reconnect button.
  - enable/disable.
  - tool inventory.
  - server source: user/project/plugin/Claude.ai.

### `/agents`

사용 목적:

- subagent library와 running subagent 관리.

추가 작업:

- Agent profile manager:
  - Running tab.
  - Library tab.
  - create/edit/delete.
  - tool/model/permission/memory/color 설정.

### `/tasks`

사용 목적:

- 현재 session 내부에서 도는 background work 확인.
- subagents, background shell commands, dynamic workflows 표시.

추가 작업:

- member panel의 Tasks pane.
- task row 클릭 시 output/subagent pane.
- stop task.

### `/diff`

사용 목적:

- uncommitted changes와 turn별 diff를 interactive viewer로 확인.

추가 작업:

- AgentParty diff pane.
- file list + diff view.
- turn selector.
- inline comment.

### `/context`

사용 목적:

- context usage grid.
- context-heavy tool과 memory bloat 경고.

추가 작업:

- usage/context ring.
- context breakdown popover.
- compact suggestion.

### `/compact`, `/clear`, `/resume`, `/branch`, `/rewind`

사용 목적:

- context/session lifecycle 관리.

추가 작업:

- session lifecycle menu.
- destructive/branching action confirm.
- checkpoint/rewind timeline은 후순위.

## Skill browser

`/skills`는 available skills를 보여주고 token count로 정렬하거나 숨길 수 있다.

AgentParty UI:

- Skill list table:
  - name.
  - source.
  - description.
  - token count.
  - enabled/hidden.
  - open details.
- Invocation:
  - command palette에서 선택하면 composer에 `/skill-name` chip 삽입.
  - skill argument 또는 task text 입력 후 send.

## Plugin browser

`/plugin`과 CLI `claude plugin`은 plugin install/list/enable/disable/details를
제공한다.

AgentParty UI:

- Plugin list:
  - id.
  - version.
  - scope.
  - enabled.
  - installPath.
  - installedAt/lastUpdated.
  - components: skills, agents, MCP servers, hooks, LSP.
- Actions:
  - enable/disable.
  - install/update/uninstall.
  - details.
  - reload plugins.
- Local 확인에서는 plugin list JSON에 `mcpServers`가 포함된다. 따라서 plugin
  row에서 “이 plugin이 어떤 MCP server를 추가하는지” 보여야 한다.

## AgentParty 구현 우선순위

P0:

- composer `/` trigger.
- command palette 기본 UI.
- built-in command inventory hardcode 또는 main process discovery.
- `/model`, `/permissions`, `/compact`, `/clear`, `/status` 연결.

P1:

- skills/plugin/MCP prompt inventory.
- command preview pane.
- source/scope/disabled reason 표시.
- `/agents`, `/tasks`, `/diff`, `/context` placeholder 또는 실제 panel 연결.

P2:

- custom command file discovery.
- skill token count/hide.
- plugin install/update/uninstall.
- MCP prompt execution.

