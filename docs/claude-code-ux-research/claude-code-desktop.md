# Claude Desktop Code 탭 / Claude Code UX 조사

이 문서는 Claude Desktop에서 Claude Code에 해당하는 surface를 다룬다. SDK
내부가 아니라 사용자가 무엇을 보고 무엇을 제어하는지에 초점을 둔다.

## 제품 형태

Claude Desktop에는 Claude Code를 데스크톱 앱 안으로 가져오는 Code 탭이 있다.
Code 탭은 사용자가 모든 것을 터미널에서 직접 시작하지 않아도 UI에서 코딩
세션을 만들고 관리할 수 있게 한다.

문서화된 Desktop Code 탭은 현재 macOS 중심이다. 제공 기능:

- 데스크톱 앱에서 코딩 세션 생성.
- 대상 프로젝트 디렉터리 선택.
- prompt를 선택하거나 blank session으로 시작.
- 세션 진행 상황 모니터링.
- 데스크톱 앱에서 세션 재개.
- 여러 세션을 한 곳에서 관리.

AgentParty 관점에서 중요한 차이: Desktop은 단순 transcript viewer가 아니다.
Claude Code를 둘러싼 session launcher, session manager, progress monitor다.

## 세션 시작

Desktop 흐름:

- Code 탭을 연다.
- 프로젝트 디렉터리를 고른다.
- prompt로 시작하거나 blank session을 만든다.
- 앱이 해당 프로젝트의 Claude Code 세션을 만든다.

UX 요구:

- 프로젝트 선택은 명시적이고 화면에 보여야 한다.
- 세션 생성은 터미널 명령 하나가 아니라 form/wizard처럼 느껴져야 한다.
- 첫 prompt는 선택사항일 수 있다.
- 시작 전에 세션이 어떤 directory/repo에 붙는지 보여야 한다.

AgentParty 시사점: member/session 생성 시 selected workspace, member role,
harness, model, effort, permission mode, initial task가 launch 전에 보여야 한다.

## 세션 관리

Desktop Code 탭은 단일 터미널이 아니라 session list/manager를 제공한다.
사용자는 세션 사이를 이동하고 기존 작업을 재개할 수 있다.

필요한 session metadata:

- 프로젝트/저장소.
- 세션 제목 또는 prompt.
- 마지막 활동 / 진행 상태.
- running vs completed/resumable 상태.
- 현재 동작 또는 blocked 상태.

AgentParty 시사점: Workbench tab은 durable session registry를 기반으로 해야
한다. tab을 닫는 것이 반드시 session 삭제를 의미하면 안 된다. resume은
일급 UI action이어야 한다.

## 진행 상황과 Transcript 표시

Claude Desktop은 그래픽 앱이므로 Claude Code 진행 상황을 터미널 텍스트가
아니라 앱 UI로 렌더링해야 한다. 사용자는 다음을 이해할 수 있어야 한다.

- Claude가 thinking/responding 중이다.
- tool이 실행 중이다.
- permission request가 진행을 막고 있다.
- task가 완료되거나 실패했다.
- session은 나중에 재개할 수 있다.

AgentParty가 최소한 렌더링해야 할 transcript block:

- 사용자 메시지.
- assistant text.
- 가능한 경우 reasoning/thinking summary 또는 collapsible indicator.
- tool call started/running/completed/failed.
- file change.
- shell command execution.
- permission approval request.
- status/diagnostic message.
- turn completion.

## Tool Calling UI

Desktop 스타일 기대값:

- tool call은 plain log text가 아니라 시각적으로 구조화되어야 한다.
- running tool에는 active state가 있어야 한다.
- completed tool은 collapse 가능해야 한다.
- tool failure는 보여야 한다.
- file edit/write operation은 affected path를 표시해야 한다.
- shell command는 command text와 결과를 보여야 한다.
- MCP 제공 tool은 가능하면 source/server를 보여야 한다.

AgentParty의 현재 design handoff는 expandable tool card, approval card,
status block으로 이 방향과 맞다. 부족한 제품 기준은 completeness다. Claude
Code가 생성하는 모든 tool/event type이 안정적인 UI block으로 매핑되어야 한다.

## Permission과 Approval UI

Desktop 사용자는 approval이 숨겨진 terminal prompt가 아니라 UI card/dialog로
나오기를 기대한다.

필수 동작:

- tool name과 risk/action을 보여준다.
- 정확한 command, file path, edit summary를 보여준다.
- 명확한 allow/deny control을 제공한다.
- 결정을 transcript에 남긴다.
- 답변 전까지 session이 blocked 상태임을 명확히 보여준다.
- permission mode 표시와 전환을 지원한다.

AgentParty 시사점: approval request는 panel 안, member list, global
activity/notification 영역에 표시되어야 한다. blocked member를 놓치면 안 된다.

## 여러 세션과 Background Work

Desktop Code 탭은 여러 세션을 관리할 수 있고, Claude Code CLI도 background
agent를 제공한다. AgentParty에서는 이것이 제품의 핵심 장점이 된다.

UI 요구:

- 상태가 있는 session/member list.
- active/running indicator.
- blocked/approval badge.
- completed/resumable history.
- 여러 session을 side-by-side로 열기.
- 한 session이 실행 중일 때 다른 session을 검사하기.

AgentParty 시사점: split panel과 tab 구조는 적절하지만, sidebar는 신뢰할 수
있는 activity monitor로 남아야 한다.

## Desktop과 CLI의 상호작용 차이

CLI:

- keyboard와 terminal output에 최적화되어 있다.
- slash command와 inline permission prompt를 사용한다.
- terminal history/shortcut에 의존한다.

Desktop:

- visible session management에 최적화되어 있다.
- form, list, panel, card, button, badge를 사용한다.
- 사용자가 flag나 slash command를 외우지 않아도 같은 기능을 쓸 수 있어야
  한다.

AgentParty 시사점: slash command parity는 유지하되 중요한 workflow를 slash
command에만 의존하면 안 된다. model, permission, MCP, plugin, skill, session
resume, tool approval, member management는 UI control로 제공해야 한다.

## Desktop Wrapper에서 필요한 Claude Code 기능 parity

AgentParty는 다음 Claude Code capability를 GUI 형태로 제공해야 한다.

- 선택한 프로젝트에서 session 시작.
- session resume/continue.
- session name 설정.
- model 선택.
- 지원되는 경우 effort/thinking 선택.
- permission mode 선택.
- allowed directory 추가.
- built-in tool availability와 allow/deny list 설정.
- MCP server 구성과 pending approval 표시.
- auth/account status 표시.
- token/cost status 표시.
- compact/clear/restart/interrupt 실행.
- slash command palette 열기.
- skill과 command preview.
- custom agent/subagent 관리.
- plugin과 skill 관리.
- safe mode/bare/debug state 표시.
- hook/MCP/provider error 표시.
- project memory(`CLAUDE.md`)와 memory editing UX 지원.

## AgentParty Desktop만의 기회

AgentParty는 이미 multi-agent desktop app이므로 Claude Desktop의 단일 제품 Code
탭을 넘어설 수 있다.

- 여러 Claude Code session을 동시에 보여주기.
- subagent/background session을 visible member로 다루기.
- member 사이 message routing.
- member별 approval count와 unread count 표시.
- member별 model/permission/tool setting을 계속 보이게 유지.
- AI가 QA를 수행할 수 있도록 모든 UI capability에 API parity 제공.

## 열린 질문 / 검증 공백

공식 Desktop Code 탭 문서는 Claude Desktop 구현의 모든 시각 세부사항을
명시하지 않는다. 예를 들어 정확한 tool card layout, animation, 모든 transcript
block style은 문서만으로 확정하기 어렵다. 이 부분은 가능한 경우 실제 Claude
Desktop build로 visual QA를 해야 한다.

라이브 visual QA 전까지, 출처 기반으로 확실히 말할 수 있는 결론:

- Desktop에는 Claude Code session을 위한 Code 탭이 있다.
- 이 탭은 session 생성, monitoring, resume을 관리한다.
- terminal-only UX가 아니라 app-native session management를 사용한다.
- AgentParty는 Claude Code CLI capability를 pass-through text command뿐 아니라
  GUI control로 제공해야 한다.

