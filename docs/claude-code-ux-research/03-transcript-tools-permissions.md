# Transcript / Tool Call / Permission UI 상세 조사

출처:

- 공식 commands reference: https://code.claude.com/docs/en/commands
- 공식 Desktop reference: https://code.claude.com/docs/en/desktop
- 로컬 확인: current AgentParty `Transcript.tsx`, `transcriptEvents.ts`

## 한 줄 정의

Claude Code transcript는 assistant text만 보여주는 채팅 로그가 아니다. 사용자가
Claude의 행동을 이해하고 승인/거절/수정/중단할 수 있게 하는 execution ledger다.

AgentParty는 이미 기본 tool card와 approval card가 있지만, Claude Code parity를
위해서는 view mode, diff, task, permission, context/cost/status, source provenance
까지 포함해야 한다.

## Transcript가 해결해야 하는 질문

사용자는 각 시점에 다음을 알아야 한다.

- Claude가 지금 생각 중인지, 도구를 실행 중인지, 입력을 기다리는지.
- 어떤 파일을 읽었고 어떤 파일을 바꿨는지.
- 어떤 shell command가 실행됐고 결과가 무엇인지.
- 어떤 도구가 built-in인지, MCP인지, plugin인지, AgentParty tool인지.
- 어떤 작업이 permission approval을 기다리는지.
- 거절/허용한 decision이 무엇이었는지.
- 지금까지 context/cost가 어느 정도인지.
- failure가 tool failure인지, provider error인지, auth/MCP/hook error인지.

## Claude Desktop view modes

Desktop Code 탭에는 transcript detail level을 조절하는 view mode가 있다.

- Normal
  - tool calls collapsed into summaries.
  - full text responses.
- Verbose
  - every tool call, file read, intermediate step 표시.
  - debugging에 유용.
- Summary
  - final responses와 changes 중심.
  - 여러 session scan에 유용.

AgentParty 작업:

- panel toolbar 또는 composer 옆에 view mode dropdown.
- `TranscriptBlock`에는 모든 event를 보존하고, mode에 따라 렌더링만 달리해야
  한다.
- multi-agent Workbench에서는 default를 `Normal`, narrow panel에서는 `Summary`
  추천.

## Tool card 요구사항

현재 AgentParty:

- `kind: "tool"` block.
- name, input summary, full input, result 표시.
- wide에서는 result 자동 open.
- full detail modal 있음.

추가해야 할 필드:

- `source`
  - `built-in`
  - `mcp:<server>`
  - `plugin:<plugin>`
  - `agentparty`
- `phase`
  - queued / started / running / completed / failed / cancelled / denied.
- `startedAt`, `completedAt`, `durationMs`.
- `riskLevel` 또는 permission classification.
- `affectedFiles`.
- `diffStats`: `+12 -1`.
- `exitCode` for shell.
- `cwd`.
- `stdout`, `stderr` 분리.
- `approvalRequestId`.
- `hookEvents`.
- `cost` 또는 token usage가 있으면 연결.

UI 표현:

- collapsed row:
  - status icon.
  - tool name.
  - source badge.
  - primary target: file path or command.
  - duration.
  - diff stats.
- expanded body:
  - input JSON/command.
  - stdout/stderr/result tabs.
  - affected files list.
  - hook lifecycle.
  - copy/open file buttons.

## Approval card 요구사항

Claude Desktop permission modes:

- Ask permissions / `default`
  - edit와 command 전에 묻는다.
- Auto accept edits / `acceptEdits`
  - file edit와 common filesystem command는 자동 허용.
  - 다른 terminal command는 묻는다.
- Plan mode / `plan`
  - read/explore 후 plan 제시. source edit 없음.
- Auto / `auto`
  - background safety check로 prompt를 줄인다.
- Bypass permissions / `bypassPermissions`
  - 명시 ask rule을 제외하고 prompt 없이 실행.
- `dontAsk`
  - CLI 전용.

Approval UI는 단순 allow/deny 버튼이 아니다.

필수 표시:

- permission mode.
- tool name.
- action type: file edit / shell command / MCP external action / app control.
- exact command/path/diff.
- risk reason.
- source.
- scope: cwd/worktree/extra dir/external service.
- allow once.
- deny.
- 가능하면 edited input으로 allow.
- decision result.

AgentParty 현재:

- approval card는 tool name, description, command, Deny/Allow once.
- multiple-choice AskUserQuestion 렌더링 있음.

추가 작업:

- approval type 구분.
- allow once / always allow similar / deny / edit command 구분.
- resolved state에 decision과 timestamp 표시.
- sidebar/tab에 pending approval badge count.
- global “Needs input” inbox.
- auto mode denial history panel.

## Diff integration

Claude Desktop:

- diff stats indicator가 나타난다. 예: `+12 -1`.
- 클릭하면 diff viewer.
- file list + per-file diff.
- diff line click으로 comment 작성.
- 여러 comment를 모아 submit.
- Claude가 comment를 읽고 수정한다.

AgentParty 작업:

- transcript file_change event를 diff model로 축적.
- panel toolbar에 diff stats chip.
- Diff pane:
  - file list.
  - current git diff.
  - per-turn diff.
  - inline comment.
  - submit comments to member.
- approval card의 edit 승인도 diff preview와 연결.

## Status / diagnostic block

상태는 transcript에 묻혀도 안 되고 조용히 사라져도 안 된다.

표시해야 할 status:

- router-check.
- model changed.
- permission mode changed.
- session restarted.
- compaction started/completed.
- auth missing/expired.
- MCP needs auth/failed.
- hook failed.
- provider error.
- worktree created.
- PR opened/updated.
- CI failed/passed.

현재 AgentParty:

- `kind: "status"`와 `kind: "error"` block은 있음.

추가 작업:

- severity: info/warn/error/success.
- category: model/auth/router/mcp/hook/git/preview/ci.
- row-level badge와 연동.
- retry/action button.

## Context / usage / cost

Claude Code에는 `/context`, `/usage`, `/cost`, usage ring이 있다.

Desktop:

- model picker 옆 usage ring.
- session context usage와 plan usage를 보여준다.

AgentParty 작업:

- member header에 context/cost ring.
- popover:
  - context used.
  - estimated remaining.
  - cost/session usage.
  - high context contributors.
  - compact button.
- 현재 비용 계산은 `core/costing.ts`에 일부 있으므로 UI surface가 필요하다.

## Tasks / subagents transcript

Claude Desktop tasks pane:

- current session 내부 background work 표시.
- subagents, background shell commands, dynamic workflows.
- entry click 시 output을 subagent pane에 표시.
- stop 가능.

AgentParty 작업:

- Transcript와 별도로 `Task` entity 필요.
- member panel에 Tasks tab/pane.
- transcript에는 task start/completed summary card만 남기고 세부 output은 task pane.

## AgentParty 구현 우선순위

P0:

- Transcript view mode: Normal/Verbose/Summary.
- tool card source/status/duration/affected files.
- approval card resolved state와 count badge.
- severity/category가 있는 status block.

P1:

- diff stats chip과 diff pane.
- context/usage ring.
- global Needs input inbox.
- tool stdout/stderr/result tabs.

P2:

- inline diff comments.
- auto mode denial history.
- tasks/subagent pane.
- hook lifecycle detail view.

