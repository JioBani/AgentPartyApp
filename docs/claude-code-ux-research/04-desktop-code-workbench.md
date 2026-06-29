# Claude Desktop Code 탭 Workbench 상세 조사

출처:

- 공식 문서: https://code.claude.com/docs/en/desktop

## 한 줄 정의

Claude Desktop Code 탭은 Claude Code를 GUI로 감싼 session workbench다. chat만
있는 것이 아니라 sidebar session manager, pane layout, embedded terminal,
file editor, diff viewer, preview browser, tasks pane, side chat, connector/plugin
browser, environment selector를 제공한다.

AgentParty의 Workbench 방향은 이와 맞지만, 현재 구현은 “multi-member chat
workspace”에 가깝고 Desktop Code 탭의 개발 도구 pane들이 아직 부족하다.

## Session start area

Desktop에서 첫 메시지 전 prompt area에서 정하는 것:

- Environment
  - Local: 내 machine.
  - Remote: Anthropic cloud.
  - SSH: 사용자가 관리하는 remote machine.
- Project folder/repository.
  - cloud session은 multiple repositories 가능.
- Model.
- Permission mode.
- Task prompt.

AgentParty 현재:

- workspace는 앱/window 설정으로 존재.
- member wizard에서 harness/model/reasoning/role 설정.
- environment selector는 WSL/local 정도만 별도 설계 문서에 존재.

추가 작업:

- New session/member form에 `Environment` 축 추가:
  - Local.
  - WSL.
  - SSH.
  - Cloud(planned).
- project/repo selection을 member creation과 분리하지 말고 launch summary에 표시.
- 첫 prompt optional/required를 명확히 한다.

## Pane-based workspace

Desktop Code 탭 pane:

- chat.
- diff.
- preview.
- terminal.
- file.
- plan.
- tasks.
- subagent.

조작:

- pane header drag로 위치 변경.
- pane edge drag로 resize.
- Views menu에서 pane 열기.
- shortcut으로 pane toggle.
- session 두 개를 side-by-side로 열 수 있음.

AgentParty 현재:

- member transcript panel/tab/split은 있음.
- pane type은 사실상 transcript 하나뿐.
- Runtime modal은 overlay.

추가 작업:

- Panel model을 `member transcript`만이 아니라 `pane`으로 일반화.
- Pane types:
  - Member Chat.
  - Diff.
  - Preview.
  - Terminal.
  - File.
  - Tasks.
  - Agent View.
  - Runtime.
- 기존 split/tab logic을 pane layout engine으로 확장.

## Preview pane

Desktop preview:

- Claude가 dev server를 시작하고 embedded browser로 app을 확인한다.
- screenshots, DOM inspection, clicks, form fills로 auto-verify한다.
- static HTML/PDF/image/video도 열 수 있다.
- Preview dropdown에서 server start/stop, persist sessions, config edit, stop all.
- `.claude/launch.json`에 server config 저장.
- port conflict 처리:
  - auto pick.
  - exact port.
  - ask and remember.

AgentParty 현재:

- browser/preview pane 없음.
- QA screenshot API는 있음.

추가 작업:

- Preview pane:
  - URL/address bar.
  - server dropdown.
  - start/stop.
  - logs link.
  - persist cookies/localStorage toggle.
  - screenshot button.
  - inspect/click mode는 후순위.
- `.agent_party_app/launch.json` 또는 Claude 호환 `.claude/launch.json` 읽기.
- API:
  - list preview configs.
  - start/stop server.
  - capture screenshot.
  - open file/url in preview.

## Diff pane

Desktop diff:

- 변경 후 diff stats chip.
- file list + diff viewer.
- line click comment.
- comments batch submit.
- Claude가 comments를 반영.
- Review code button으로 Claude review comments 생성.

AgentParty 작업:

- `file_change` event와 git diff를 결합.
- member/session별 diff state.
- line comment composer.
- review action:
  - current member에게 review 요청.
  - 또는 reviewer member 생성/dispatch.

## Integrated terminal

Desktop terminal:

- session working directory에서 열린다.
- Claude와 같은 environment.
- multiple terminal tabs.
- file/folder context menu에서 open in terminal.
- local session only.

AgentParty 작업:

- Terminal pane 추가.
- session/member cwd/worktree 기준으로 shell 시작.
- terminal output은 transcript와 분리.
- 위험: terminal command는 사용자가 직접 실행하는 것이므로 Claude permission과
  다르다. UI에 구분 필요.

## File pane

Desktop file pane:

- chat/diff file path 클릭으로 open.
- HTML/PDF/image/video는 preview pane으로 open.
- spot edit 후 Save.
- disk changed warning.
- Discard.
- absolute path copy.
- local/SSH session에서 가능.

AgentParty 작업:

- File viewer/editor pane.
- path click routing.
- unsaved state.
- disk conflict warning.
- save/discard.
- open external editor/show in Explorer/copy path context menu.

## Side chat

Desktop side chat:

- session context를 읽지만 main conversation에 내용을 다시 추가하지 않는다.
- 코드 이해, 가정 확인, 아이디어 탐색용.
- shortcut 또는 `/btw`.
- local/SSH session에서 가능.

AgentParty 작업:

- member panel에 side chat drawer.
- main transcript와 분리된 ephemeral thread.
- side chat 결과를 main으로 “promote”할지 선택 가능.

## Tasks pane

Desktop tasks pane:

- current session 내부 background work 표시.
- subagents.
- background shell commands.
- dynamic workflows.
- entry click → output을 subagent pane에서 확인.
- stop 가능.

AgentParty 작업:

- member 내부 task list.
- AgentParty member와 Claude subagent를 혼동하지 않는 label:
  - `Party member`: 독립 session.
  - `Claude subagent`: 한 session 내부 worker.
  - `Background job`: shell/dynamic workflow.

## Session sidebar

Desktop sidebar:

- session 목록.
- `+ New session`.
- status/project/environment filter.
- group by project.
- multiple sessions parallel.
- Ctrl/Cmd click으로 두 session side-by-side.
- archive icon.
- auto-archive after PR merge/close.

AgentParty 현재:

- party/member sidebar 있음.
- status filter/group/archive는 없음.

추가 작업:

- sidebar 상단 filter chips:
  - All.
  - Needs input.
  - Running.
  - Ready for review.
  - Failed.
  - Completed.
- group selector:
  - Party.
  - Status.
  - Project.
  - Environment.
- archive/remove 구분.

## Connectors, skills, plugins

Desktop:

- prompt `+` button에서 Connectors, Skills, Plugins 접근.
- connectors는 그래픽 setup flow가 있는 MCP servers.
- plugins는 skills, agents, hooks, MCP servers, LSP configs를 추가한다.
- cloud session에서는 plugin 미지원.

AgentParty 작업:

- prompt `+` menu:
  - Attach file.
  - Mention file.
  - Slash commands.
  - Connectors/MCP.
  - Skills.
  - Plugins.
- Settings/secondary view:
  - Connectors/MCP 관리.
  - Plugin browser.
  - Skill browser.

## Computer use

Desktop:

- Claude가 실제 desktop app을 보고 클릭/입력/스크롤.
- off by default.
- per-app approval.
- app control tier:
  - View only.
  - Click only.
  - Full control.
- broad app에는 extra warning.

AgentParty 우선순위:

- 당장 Claude Code harness wrapping의 핵심은 아님.
- 다만 future capability로 API/UI extension point를 남겨야 한다.
- 현재 AgentParty가 Electron app 자체 QA를 위해 browser automation을 쓰는 것과
  사용자 desktop control은 다르다.

## AgentParty 구현 우선순위

P0:

- Session/member sidebar filter/group/status.
- Transcript view mode.
- prompt `+` menu와 slash palette.

P1:

- Diff pane.
- Preview pane basic.
- Tasks pane.
- side chat.

P2:

- Integrated terminal.
- File pane/editor.
- PR/CI status bar.
- connector/plugin GUI.

P3:

- remote/cloud/SSH environment parity.
- computer use.
- auto-verify with browser actions.

