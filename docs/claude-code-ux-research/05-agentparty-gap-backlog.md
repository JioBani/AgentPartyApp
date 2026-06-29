# AgentParty 누락 기능 및 우선순위 Backlog

이 문서는 Claude Code CLI/Desktop UX 조사 내용을 현재 AgentParty 구현과 비교해
프론트 작업 단위로 정리한다.

현재 대조 기준:

- Workbench: `src/renderer/workbench/*`
- Transcript event folding: `src/renderer/app/transcriptEvents.ts`
- Party/member backend: `src/main/application/partyApplicationService.ts`
- API: `docs/API.md`, `src/shared/apiSpec.ts`

## 이미 구현된 기반

AgentParty에 이미 있는 기능:

- Party list와 member list.
- member 생성 wizard: name → harness → model → reasoning → role.
- multi-panel + tab Workbench.
- panel density 대응.
- per-member composer.
- Stop/restart/compact.
- Runtime modal: model/effort/thinking/debug 일부.
- permission mode dropdown.
- transcript block:
  - user.
  - assistant.
  - reasoning.
  - tool.
  - approval.
  - status/error.
  - AgentParty channel.
  - member create/remove action.
- AskUserQuestion 형태의 interactive approval 렌더링.
- local automation API 일부.

이 기반은 좋지만 Claude Code parity 기준으로는 “member chat workbench” 단계다.
다음 단계는 “session/task control plane”이다.

## P0: 사용자가 즉시 느끼는 parity 결손

### 1. Slash command / skill palette

문제:

- Claude Code 사용자는 `/`로 기능을 찾고 실행한다.
- AgentParty composer는 현재 일반 메시지 입력에 가깝다.
- 스킬 preview, command discovery, argument hint가 없다.

작업:

- composer에서 `/` trigger.
- command palette component.
- built-in command inventory.
- command row: name, description, source, scope, disabled reason.
- preview pane.
- `/model`, `/permissions`, `/compact`, `/clear`, `/status`부터 연결.

API:

- `GET /api/commands`
- `POST /api/sessions/:id/commands`

### 2. Needs input 중심 상태 모델

문제:

- 현재는 approval 정도만 눈에 띈다.
- Claude Code Agent view는 `Needs input`, `Ready for review`, `Working`,
  `Completed`, `Failed`, `Stopped`를 핵심으로 삼는다.

작업:

- session/member state 확장.
- sidebar/tab badge 개선.
- global Needs input filter.
- pending approval/question count.
- completed/failed/stopped 표시.

API:

- `GET /api/sessions` 또는 `/api/state`에 expanded status.

### 3. Peek drawer

문제:

- member 내용을 보려면 panel/tab을 열어야 한다.
- 여러 agent를 관리할 때 full transcript까지 들어가는 것은 너무 무겁다.

작업:

- sidebar row click/hover 또는 dedicated button으로 peek drawer.
- latest output, pending question/approval, current action, PR status.
- quick reply input.
- open full transcript.

API:

- `GET /api/party/members/:name/peek`
- `POST /api/party/members/:name/reply`

### 4. Tool/approval card 고도화

문제:

- 현재 tool card는 name/input/result 중심.
- source, duration, affected files, stdout/stderr, approval decision, severity가
  부족하다.

작업:

- `TranscriptBlock` 확장.
- tool source badge.
- status phase.
- duration.
- affected files.
- stdout/stderr tabs.
- approval resolved state.
- sidebar count와 연동.

API:

- QA event schema 업데이트.

## P1: Agent view / Desktop Code 핵심 생산성

### 5. Agent view 스타일 session manager

문제:

- AgentParty는 party/member list는 있지만 background session manager가 아니다.
- dispatch, pin, rename, group, filter, stop/delete lifecycle이 부족하다.

작업:

- 별도 `Agent View` 또는 sidebar mode.
- row groups: Needs input, Ready for review, Working, Completed.
- pin/reorder/rename/archive.
- completed fold.
- dispatch input.

### 6. Dispatch input

문제:

- 새 member 생성은 wizard 중심이다.
- Claude Code Agent view는 prompt 하나로 background session을 만든다.

작업:

- Workbench 상단 또는 sidebar 하단 dispatch box.
- prompt → auto member/session 생성.
- `@member`, `@repo`, `/command`, `!shell`, `#PR` prefix 처리.
- dispatch 후 바로 attach 옵션.

### 7. Transcript view mode

문제:

- 많은 tool output이 쌓이면 multi-agent scan이 어렵다.

작업:

- Normal/Verbose/Summary mode.
- panel별 또는 app global 설정.
- Summary mode에서 final response/change/status만 보이게 한다.

### 8. Diff pane

문제:

- Claude Desktop은 변경사항을 diff viewer로 review/comment한다.
- AgentParty는 transcript file_change를 받고 있지만 diff review UI가 없다.

작업:

- member/session diff stats chip.
- pane type: Diff.
- file list + diff viewer.
- turn별 diff.
- comment submit.

### 9. Tasks pane

문제:

- Claude subagent/background shell/dynamic workflow는 party member와 다르다.
- 현재 내부 task를 볼 surface가 없다.

작업:

- pane type: Tasks.
- task list: subagent/shell/workflow.
- output view.
- stop task.

## P2: Desktop Code 탭 parity 확장

### 10. Preview pane

작업:

- embedded browser pane.
- dev server start/stop.
- `.claude/launch.json` 또는 app-specific launch config.
- screenshot/capture.
- persist session toggle.

### 11. File pane

작업:

- path click → file pane.
- save/discard.
- disk conflict warning.
- open external editor/show in Explorer/copy path.

### 12. Integrated terminal pane

작업:

- member/session cwd/worktree 기준 terminal.
- multiple terminal tabs.
- terminal output과 Claude transcript 분리.

### 13. MCP/plugin/skill management UI

작업:

- MCP list with connected/needs-auth/failed/pending.
- plugin list/install/enable/disable/details.
- skill browser/token count/hide.
- prompt `+` menu와 연결.

### 14. PR/CI status

작업:

- PR badge.
- CI status bar.
- auto-fix toggle.
- auto-merge toggle.
- desktop notification.

## P3: 고급 session lifecycle

### 15. Worktree isolation

작업:

- member/session isolation mode.
- worktree path badge.
- delete/archive warning.
- uncommitted changes check.

### 16. Side chat

작업:

- current member context를 읽는 side chat.
- main transcript에 영향을 주지 않음.
- promote result option.

### 17. Remote/cloud/SSH environment

작업:

- environment selector.
- local/WSL/SSH/cloud 상태.
- cloud/remote session monitoring.

### 18. Computer use

작업:

- future capability로 남김.
- per-app approval model과 UI research 필요.

## 추천 구현 순서

1. Command palette와 Needs input 상태 모델.
2. Peek drawer와 tool/approval card 고도화.
3. Agent view 스타일 session manager + dispatch input.
4. Transcript view mode + Diff pane.
5. Tasks pane + MCP/plugin/skill management.
6. Preview/File/Terminal panes.
7. Worktree/PR/CI/remote 고급 기능.

이 순서가 좋은 이유:

- 1~2는 현재 Workbench 구조 위에 바로 얹을 수 있고 사용성 체감이 크다.
- 3은 AgentParty의 multi-agent 정체성을 Claude Code parity 수준으로 끌어올린다.
- 4~6은 Desktop Code 탭 parity이며 대부분 프론트 pane 작업이다.
- 7은 backend/session orchestration 영향이 커서 뒤로 미루는 편이 안전하다.

