# Agent View / Background Agents 상세 조사

출처:

- 공식 문서: https://code.claude.com/docs/en/agent-view
- 로컬 확인: `claude.cmd agents --help`, `claude.cmd agents --json --all`
- 로컬 CLI 버전: `Claude Code 2.1.169`

## 한 줄 정의

Agent view는 `claude agents`로 여는 전체 화면 session manager다. 사용자는 여러
Claude Code background session을 한 화면에서 dispatch, 감시, peek, reply,
attach, stop/delete, rename, pin, filter/grouping할 수 있다.

이것은 단순 “에이전트 목록”이 아니다. CLI의 Agent view는 여러 개의 독립
작업을 row로 관리하는 작업 관제 화면이며, 각 row는 살아 있는 Claude Code
대화 또는 background shell job을 가리킨다.

## 왜 필요한가

Claude Code가 agentic coding tool로 쓸모 있으려면 사용자가 모든 세션의 full
transcript를 계속 지켜볼 필요가 없어야 한다. Agent view는 다음 문제를 푼다.

- 여러 독립 작업을 동시에 맡길 수 있다.
- 어떤 작업이 사람 입력을 기다리는지 바로 보인다.
- 완료/실패/PR 준비 상태를 한 줄로 스캔할 수 있다.
- 필요한 순간에만 peek하거나 full session에 attach한다.
- background session은 terminal이 닫혀도 supervisor process에서 계속 돈다.

AgentParty의 “party/member sidebar”는 비슷한 방향이지만, 현재는 Claude Code
Agent view가 제공하는 session lifecycle/dispatch/peek/row summary/PR/worktree
개념이 충분히 노출되어 있지 않다.

## 화면 구조

공식 문서상 Agent view는 terminal 전체를 차지하는 table UI다.

구성 요소:

- Header
  - Claude Code 버전.
  - 현재 dispatch default model.
  - 현재 working directory.
  - session summary count.
  - input-needed count가 terminal title에도 반영된다.
- Session table
  - 상태별 group: `Pinned`, `Ready for review`, `Needs input`, `Working`,
    `Completed`.
  - directory 기준 grouping으로 전환 가능.
  - 오래된 completed session은 `... N more` row로 접힌다.
- Row
  - state icon.
  - session name.
  - one-line summary.
  - PR label.
  - last changed age.
- Peek panel
  - 선택 row의 최근 output 또는 필요한 질문/approval을 보여준다.
  - full transcript에 들어가지 않고 reply 가능.
- Dispatch input
  - 화면 하단 prompt 입력.
  - 입력 하나가 새 background session 하나를 만든다.
  - 비어 있을 때는 shortcut/filter/subagent 탐색 역할도 한다.
- Footer
  - keyboard hint.
  - active defaults: model, effort, permission, default agent 등.

## Row 상태 모델

Agent view row는 “작업이 지금 어떤 상태인지”와 “프로세스가 살아 있는지”를
나눠 보여준다.

상태:

- `Working`
  - Claude가 응답 생성 또는 tool 실행 중.
  - animated icon.
  - one-line summary가 주기적으로 갱신된다.
- `Needs input`
  - Claude가 사용자 질문, permission prompt, 선택지 응답 등을 기다린다.
  - 노란색 계열로 표시.
  - 리스트 상단에 올라와야 한다.
- `Idle`
  - 지금 할 일이 없고 다음 prompt를 기다린다.
  - dimmed 표시.
- `Completed`
  - task가 성공적으로 끝났다.
  - green 표시.
- `Failed`
  - error로 종료.
  - red 표시.
- `Stopped`
  - 사용자가 stop한 session.
  - grey 표시.

프로세스 shape:

- alive process
  - attach/reply 시 즉시 응답 가능.
- exited process
  - row는 남아 있으며 peek/reply/attach 시 conversation에서 재시작된다.
- loop/sleeping process
  - run count와 countdown을 표시한다.

AgentParty 작업:

- `MemberStatus`는 현재 `working | idle | approval | not-started` 정도라 너무
  좁다.
- 최소한 `needsInput`, `completed`, `failed`, `stopped`, `readyForReview`,
  `runningProcess`, `exitedButResumable`, `sleepingLoop` 개념을 추가해야 한다.
- sidebar와 tab badge에 `approval`만이 아니라 `needs input`, `failed`,
  `ready`, `PR`, `completed`를 표현해야 한다.

## Row summary

공식 Agent view는 각 row에 one-line summary를 보여준다. 이 summary는 사용자가
full transcript를 열지 않고도 “지금 뭘 하고 있는지 / 무엇을 기다리는지 / 무엇을
끝냈는지” 파악하게 한다.

특징:

- 작업 중에는 최대 약 15초 단위와 turn 종료 시 갱신된다.
- 병렬 work item이 두 개 이상이면 `done/total` count가 summary 앞에 붙는다.
  예: `2/5 run test shards`.
- summary generation 자체도 별도 model request이므로 비용/사용량에 영향을 준다.

AgentParty 작업:

- member row에 “마지막 transcript text”만 보여주는 방식은 부족하다.
- `session.activitySummary` 필드를 도입한다.
- summary source는 세 단계로 구현 가능:
  1. 1차: 최근 status/tool/assistant event에서 deterministic summary 생성.
  2. 2차: turn 종료 시 lightweight summarizer 호출.
  3. 3차: 사용자가 summary를 끄거나 비용 제한 설정 가능.
- UI 필드:
  - `currentAction`: `Edit src/auth.ts`, `waiting: approve npm test`, `result: PR opened`.
  - `progressCount`: `2/5`.
  - `lastChangedAt`.

## Peek panel

Peek은 Agent view의 핵심이다. full transcript attach 전 단계다.

역할:

- session이 기다리는 질문 또는 permission을 보여준다.
- 최근 output/result를 짧게 보여준다.
- PR 목록을 보여준다.
- parallel work item 중 가장 오래 걸리는 항목을 보여준다.
- 사용자가 바로 reply할 수 있다.
- multiple-choice question이면 숫자 key로 선택할 수 있다.
- suggested reply를 `Tab`으로 채울 수 있다.
- `!` prefix로 Bash command를 session에 보낼 수 있다.

AgentParty 작업:

- 현재 Workbench는 panel/tab을 열어야 transcript가 보인다.
- sidebar member hover/click 또는 split panel 상단에 “peek drawer”가 필요하다.
- Peek drawer 내용:
  - status headline.
  - pending approval/question.
  - latest assistant result.
  - latest failed tool/error.
  - PR/CI status.
  - reply input.
  - `Open full transcript` 버튼.
- 특히 multi-agent 환경에서는 “panel을 점유하지 않고 quick reply”가 중요하다.

## Attach / detach

Agent view에서 attach는 row의 full interactive session으로 들어가는 행위다.
detach는 session을 멈추지 않고 table로 돌아오는 행위다.

공식 동작:

- `Enter` 또는 `→`: selected row attach.
- attach하면 Agent view가 full interactive session으로 바뀐다.
- attach 시 Claude가 사용자가 자리를 비운 동안 있었던 일을 짧게 recap한다.
- `←`, `Ctrl+Z`, `/exit`, double `Ctrl+C`/`Ctrl+D`: detach. session은 계속 돈다.
- `/stop`: background session 자체를 멈춘다.

AgentParty 대응:

- AgentParty의 tab open은 attach와 유사하지만 detach 개념이 불명확하다.
- tab close가 session close인지, view detach인지, member close인지 명확히
  분리해야 한다.
- 권장 UX:
  - `Open in panel`: attach/view.
  - `Close tab`: view만 닫기.
  - `Stop session`: 실행 중지.
  - `Archive/remove`: 목록에서 제거.
  - `Resume`: exited/resumable session 재연결.

## Dispatch input

Agent view 하단 input은 “새 background session 생성기”다. 대화 follow-up 입력이
아니다. 입력 하나가 새 row/session 하나를 만든다.

지원되는 prefix/mention:

- `<agent-name> <prompt>`: 첫 단어가 subagent 이름이면 해당 subagent를 main
  agent로 실행한다.
- `@<agent-name>`: prompt 어디서든 subagent를 명시한다.
- `@<repo>`: parent directory 아래 repository를 target directory로 선택한다.
- `/<command>`: command/skill을 prompt로 dispatch한다.
- `! <command>`: Claude session 대신 background shell job을 실행한다.
- `#<number>` 또는 PR URL: 해당 PR을 처리 중인 session이 있으면 새로 만들지
  않고 선택한다.
- `Shift+Enter`: dispatch 후 즉시 attach.

AgentParty 작업:

- Party sidebar 상단에 “new member” input만 있는 것으로는 부족하다.
- 별도의 `Dispatch` surface가 필요하다.
- Dispatch는 member 생성과 다르다. member identity 없이도 “작업 row”를 만들 수
  있어야 한다.
- AgentParty에서는 두 모델 중 선택해야 한다:
  - 모델 A: 모든 dispatch는 member를 자동 생성한다.
  - 모델 B: dispatch task row와 party member를 분리한다.
- 현재 제품 방향상 모델 A가 단순하다. 예:
  - prompt 입력 → 자동 member name 생성 → session start → row/panel 생성.
  - `@reviewer`는 기존 member에 새 task를 보내거나 reviewer profile로 새
    member를 생성.

## Filter / grouping / list organization

Agent view 조작:

- `Ctrl+S`: state grouping과 directory grouping 전환.
- `Ctrl+T`: pin/unpin.
- `Shift+↑/↓`: reorder.
- `Ctrl+R`: rename.
- group header collapse.
- `Ctrl+X`: stop. 2초 내 다시 누르면 delete.
- filtering:
  - `a:<name>`: 특정 agent.
  - `s:<state>` 또는 `s:blocked`: 상태.
  - `#<number>`/PR URL: PR 담당 session.
  - URL: 첫 prompt에 해당 URL이 포함된 session.

AgentParty 작업:

- sidebar에 검색/filter input 추가.
- grouping mode: by party, by status, by workspace, by model/harness.
- pin/persist/reorder 상태 저장.
- destructive delete는 2-step confirm 필요.
- completed 접기: 완료된 member/session이 많아져도 sidebar가 죽지 않게 한다.

## PR status / Ready for review

Agent view는 PR을 결과물로 본다.

표현:

- row 우측 `PR #1234` label.
- PR 상태 색:
  - yellow: checks/review 대기 또는 실패.
  - green: checks passed, blocking review 없음.
  - purple: merged.
  - grey: draft/closed.
- 여러 PR이면 `3 PRs`.
- Ready for review group은 open PR이 있는 session을 강조한다.

AgentParty 작업:

- GitHub/`gh` integration 또는 adapter event가 필요하다.
- 최소 UI:
  - member row PR badge.
  - transcript에 `PR opened` card.
  - CI status bar.
  - `Auto-fix` / `Auto-merge`는 Desktop parity 문서에서 후순위로 다룬다.

## Worktree isolation

Agent view background session은 edit 전에 `.claude/worktrees/` 아래 isolated git
worktree로 이동한다. 병렬 session이 같은 checkout을 읽더라도 각자 별도
worktree에 쓴다.

중요한 UX:

- session row 또는 details에 worktree path를 보여줘야 한다.
- delete 시 Claude가 만든 worktree는 삭제될 수 있고, uncommitted changes 손실
  위험이 있다.
- user-created worktree와 Claude-created worktree를 구분한다.
- worktree isolation을 끄는 설정도 있다.

AgentParty 작업:

- 현재 Party member는 workspace root에서 session이 시작된다.
- parallel edit safety를 위해 member별 worktree 옵션이 필요하다.
- UI:
  - member creation wizard에 `Isolation: shared workspace | worktree`.
  - member header에 branch/worktree badge.
  - delete/archive confirm에 uncommitted changes warning.

## Background shell job

Agent view는 `! pytest -x` 같은 입력으로 Claude가 아닌 shell command를
background row로 실행할 수 있다.

특징:

- model 호출 없음.
- output은 session transcript가 아니라 job output.
- attach/peek/logs 가능.
- 종료 후 약 5분 뒤 row/output 자동 cleanup.

AgentParty 작업:

- “member”와 별개로 “job row”를 표현할 수 있어야 한다.
- 단기적으로는 test/build runner pane으로 구현 가능.
- transcript type에 `job` block 또는 `task` entity 추가.

## 로컬 JSON shape

로컬 `claude agents --json --all` 예:

```json
[
  {
    "pid": 51364,
    "cwd": "c:\\Project\\AgentPartyApp",
    "kind": "interactive",
    "startedAt": 1782728817554,
    "sessionId": "76169ef4-59f7-4c39-b40b-a122186f071c",
    "name": "team/worker"
  }
]
```

문서상 background entry에는 `id`, `state`, `status`, `waitingFor` 등이 추가될 수
있다. AgentParty API 설계 시 최소 필드는 다음으로 잡는다.

- `id`
- `sessionId`
- `name`
- `kind`: `interactive | background | shell-job`
- `cwd`
- `workspaceRoot`
- `worktreePath`
- `state`
- `processState`
- `waitingFor`
- `summary`
- `lastChangedAt`
- `startedAt`
- `model`
- `effort`
- `permissionMode`
- `agentProfile`
- `prStatus`
- `pinned`
- `group`

## AgentParty 구현 작업 단위

P0:

- member/session 상태 모델 확장.
- sidebar row에 needs-input/completed/failed/stopped/ready-for-review 표시.
- tab close와 session stop/remove 의미 분리.
- quick peek drawer.

P1:

- dispatch input: prompt 하나로 새 background member/session 생성.
- session row summary.
- filter/grouping/pin/rename.
- completed 접기.

P2:

- worktree isolation 설정과 표시.
- PR/CI status badge.
- background shell job row.
- attach/detach lifecycle을 명시적으로 모델링.

