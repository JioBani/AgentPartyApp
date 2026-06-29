# Claude Code UX가 AgentParty에 주는 제품 요구사항

이 문서는 Claude Code CLI/Desktop 조사 내용을 AgentParty의 구체적 요구사항으로
변환한 요약이다. 실제 작업 단위와 우선순위는
`05-agentparty-gap-backlog.md`를 기준으로 본다.

## 원칙

AgentParty는 Claude Code를 감싸는 앱이므로 사용자는 Claude Code 기능 parity와
더 나은 multi-agent supervision을 기대한다. CLI 또는 Desktop에서 중요한 Claude
Code 작업은 AgentParty에서도 보여야 하고 제어 가능해야 한다.

## Workbench 필수 Surface

member별 session header:

- member name과 role.
- workspace/cwd.
- harness.
- model.
- effort/thinking.
- permission mode.
- running/idle/blocked/failed 상태.
- auth/provider state.
- MCP/plugin/skill/debug/safe-mode indicator.

Transcript block:

- 사용자 메시지.
- assistant text.
- reasoning/thinking summary.
- tool start/running/completed/failed.
- shell command.
- file read/edit/write.
- search/grep.
- web/MCP tool call.
- hook lifecycle/status.
- approval request.
- file change event.
- cost/token/status event.
- turn complete.

Composer:

- 일반 메시지 입력.
- slash command palette.
- `/` 입력 시 skill preview.
- prompt history.
- interrupt/stop.
- clear/compact control.
- 이전 메시지 수정 또는 equivalent.
- attach/add context affordance.

## Slash Command Parity

다음을 포함하는 searchable command palette를 구현해야 한다.

- Claude Code built-in command.
- project/user custom command.
- `/skill-name` 형태의 skill.
- AgentParty-specific member/party command.
- disabled/unavailable state.
- command source/scope.
- argument preview.

다음 command는 실제 UI control로도 제공해야 한다.

- model selection.
- permission settings.
- MCP management.
- memory editing.
- compact/clear.
- cost/status.
- login/logout/status.
- agents/subagents.

## Tool과 Approval 렌더링

Tool card 최소 필드:

- tool name.
- source: built-in, MCP server, plugin, AgentParty.
- status: queued/running/completed/failed/denied.
- input summary.
- expandable full input.
- output preview.
- expandable full output/error.
- duration.
- affected file path.
- 해당되는 경우 approval decision.

Approval card 최소 필드:

- approval이 필요한 이유.
- 정확한 command/edit/path.
- permission mode.
- allow once.
- deny.
- 지원되는 경우 modify/update input.
- transcript에 남는 decision result.
- sidebar/global blocked badge.

## Agent와 Subagent

AgentParty에는 이미 member 개념이 있다. Claude Code 개념과 조심스럽게 매핑해야
한다.

- Claude Code custom subagent는 agent profile 또는 callable specialist가 된다.
- Claude Code background agent는 active/resumable member session이 된다.
- AgentParty party member는 transcript를 가진 상위 visible identity다.

필수 UI:

- agent/member 생성 wizard.
- role/prompt editor.
- tool access control.
- model/effort/permission control.
- running/completed/resumable state.
- worktree/cwd visibility.
- background task list.

## MCP, Plugin, Skill

MCP panel:

- configured server.
- transport type.
- connected/error/pending approval.
- tool inventory.
- project-scoped choice reset/reject/approve.
- 지원되는 경우 Claude Desktop에서 import.

Plugin/skill panel:

- installed plugin.
- enabled/disabled state.
- marketplace/source.
- 가능한 경우 details/token cost.
- session-only plugin state.
- skill list와 slash name.
- invocation 전 skill preview.

## Runtime과 Permission

AgentParty에는 이미 Runtime modal이 있다. 여기에 다음 항목이 확장되어야 한다.

- model과 provider route.
- effort.
- thinking mode와 budget.
- permission mode.
- tool allow/deny list.
- extra allowed directory.
- safe mode/debug indicator.
- session별 MCP/plugin/skill enablement.

## Diagnostics

실패를 숨기면 안 된다. 다음을 surface해야 한다.

- Claude executable missing.
- auth missing/expired.
- provider/model route error.
- router error.
- MCP connection error.
- hook failure.
- permission denied decision.
- tool execution error.
- session crash/restart.
- unsupported harness/model combination.

각 항목은 다음 위치에 나타나야 한다.

- transcript/status block.
- member/session header.
- logs/API diagnostics.

## Automation API Parity

프로젝트 지침상 모든 user-facing capability는 local automation API로도 제공되어야
한다. 이 조사 기준으로는 향후 endpoint가 다음을 다뤄야 한다.

- slash command inventory와 execution.
- skill/plugin inventory와 enable/disable.
- MCP inventory, add/remove/approve/reset.
- tool permission settings.
- approval response.
- role/tools/model/permission을 포함한 agent/member creation.
- session resume/continue/fork/name.
- runtime model/effort/thinking/permission 변경.
- compact/clear/interrupt/restart.
- cost/status 조회.
- diagnostics/log access.

## 우선순위

1. tool, approval, error, status에 대한 transcript event coverage 완성.
2. slash command/skill palette 구현.
3. Runtime modal을 permission/tools/context/MCP indicator까지 확장.
4. MCP/plugin/skill management panel 추가.
5. subagent/background-session management parity 추가.
6. advanced resume/fork/worktree/session naming parity 추가.

## 상세 문서 연결

- Agent view/background session manager:
  `01-agent-view-background-agents.md`
- Slash command/skill palette:
  `02-command-skill-palette.md`
- Tool/approval/transcript:
  `03-transcript-tools-permissions.md`
- Desktop Code tab pane/workbench:
  `04-desktop-code-workbench.md`
- AgentParty 구현 backlog:
  `05-agentparty-gap-backlog.md`
