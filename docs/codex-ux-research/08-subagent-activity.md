# 서브에이전트 활동 정보 — Codex vs Claude Code 하네스

이 문서는 **한 세션 안에서 도는 서브에이전트를 직관적 UI로 표시**하기 위해, 각
하네스가 서브에이전트 동작에 대해 어느 정도의 정보를 제공하는지 정리한다.

최종 목적(요구):
- 한 세션 안에 서브에이전트가 **몇 개** 도는지.
- **각 서브에이전트가 무엇을 하는지** 간단 표시(예: "문서 읽는중", "코드 탐색중").

이 문서는 Codex와 Claude Code 양쪽을 다룬다(두 하네스 공통 주제). Codex 조사
폴더(`docs/codex-ux-research/`)와 Claude 조사 폴더 양쪽에서 참조된다.

출처/확인일: **2026-07-04**. 로컬 실측 —
`codex app-server generate-json-schema`(v2 스키마), `src/core/claudeAdapter.ts`,
`src/core/events.ts`. 공식 문서 교차검증(하단).

## 한 줄 결론

**둘 다 가능하다.** 구조적 풍부도는 **Codex가 더 강하다**(서브에이전트가 각각
독립 thread이고 프로토콜이 1급으로 노출). Claude Code도 tool 단위 활동·귀속·
진행 요약을 제공하지만 서브에이전트의 텍스트는 기본 요약된다. 두 하네스의
"서브에이전트" 개념·전달 방식이 달라 **공통 UI 추상화**가 필요하다.

두 하네스 모두 현재 AgentParty 어댑터/정규화에서 이 정보를 **버리고 있다**(Codex
item 무시, Claude parent_tool_use_id 미사용). 데이터는 들어오는데 표면화가 안 됨.

---

## A. Codex 하네스 — 구조화된 서브에이전트 정보 (풍부)

Codex는 서브에이전트가 **각각 독립 thread**이며(multi_agent, stable), app-server
프로토콜이 이를 명시적으로 노출한다. 세 소스에서 정보가 나온다.

### 1) `collabAgentToolCall` item (부모 thread 인라인) — 가장 풍부

`ThreadItem::collabAgentToolCall` 필드:

| 필드 | 의미 |
|---|---|
| `tool` | `spawnAgent \| sendInput \| resumeAgent \| wait \| closeAgent` (무슨 조작) |
| `prompt` | **서브에이전트에 배정된 작업 텍스트** ("뭘 하라고 시켰나") |
| `model`, `reasoningEffort` | 스폰된 에이전트 설정 |
| `senderThreadId` | 요청을 낸 에이전트 thread |
| `receiverThreadIds[]` | 대상(스폰이면 새 에이전트) thread id들 |
| `agentsStates` | `{ threadId → { status, message } }` — **에이전트별 라이브 상태** |
| `status` | `inProgress \| completed \| failed` |

### 2) `subAgentActivity` item (경량 lifecycle 마커)

`agentPath`(계층 경로), `agentThreadId`, `kind`: `started | interacted | interrupted`.

### 3) `thread/list` — 서브에이전트 thread 열거

각 `Thread`:
- `parentThreadId` — 있으면 이 thread는 서브에이전트.
- `agentRole` — AgentControl이 배정한 역할(예: 코드탐색).
- `agentNickname` — 랜덤 고유 별명.
- `status`(`ThreadStatus`) — 런타임 상태.
- `source`(`SubAgentSource::thread_spawn`) — `depth`, `parent_thread_id`,
  `agent_role`, `agent_nickname`, `agent_path`.
- `preview` — 보통 첫 사용자 메시지(라이브 활동 아님).
- `cwd`, `name`, `updatedAt`, `recencyAt`.

### 에이전트별 라이브 status (`CollabAgentStatus`)

`pendingInit / running / interrupted / completed / errored / shutdown / notFound`.

### Codex로 만들 수 있는 것

- **개수**: `agentsStates` 항목 수 / `parentThreadId==부모`인 thread 수. 동시성
  상한은 config `[agents] max_threads`(기본 6), `max_depth`(기본 1).
- **각자 뭐하는지(요약)**: `agentRole`/`agentNickname` + `collabAgentToolCall.
  prompt` + per-agent `status` → "role=코드탐색, running" 수준 즉시 표시.
- **각자 뭐하는지(세밀, "grep중/read중")**: 서브에이전트 thread의 **자기 item
  스트림**(commandExecution/fileChange/webSearch)을 봐야 함. 모든 notification이
  `threadId`를 달고 오므로 자식 threadId로 필터. 경량 요약(1~3)은 부모 스트림에
  그냥 들어오고, 세밀 활동은 자식 thread 구독/`thread/read`로 확장.

---

## B. Claude Code 하네스 — tool 단위로는 보이나, 텍스트는 요약됨

Claude Code의 서브에이전트는 **`Agent` tool_use**(구 `Task`, v2.1.63에 개명 —
감지는 `Agent`와 `Task` 둘 다 매칭해야 함)로 스폰되고, **각자 fresh 대화**로 돈다.
현재 어댑터가 `includePartialMessages: true`라 중첩 이벤트가 흘러들어온다.

- **개수/식별**: 활성 `Agent`/`Task` tool_use 블록 1개 = 서브에이전트 1개. 그
  input에 `description`(3~5단어 라벨) + `subagent_type` + `prompt`.
- **귀속(핵심)**: 서브에이전트 내부에서 나오는 메시지/이벤트는
  **`parent_tool_use_id`**(= 그 Agent tool_use id)를 달고 온다. StreamEvent에
  `parent_tool_use_id: str | null`. 이걸로 "어느 서브에이전트가 뭘 하는지" 그룹핑.
- **라이브 tool 활동**: 서브에이전트의 **tool_use/tool_result 블록은 부모로
  전달됨** → 자식이 Grep(코드 탐색중)/Read(문서 읽는중)/Bash(명령 실행중) 하는
  것을 tool 단위로 볼 수 있음.
- **진행 요약**: `system` subtype `task_started` / `task_updated` /
  `task_progress` / `tool_use_summary`에 `summary`/`description`/`status`(롤링 요약).
- **제약**: 서브에이전트의 **text/thinking은 기본 요약(summarize)되어 안 옴** —
  전체 전사가 필요하면 `forward_subagent_text: true` 필요(현재 미설정).
- **동시성**: 여러 서브에이전트 동시 실행 가능. 별도 개수 필드 없음(활성 tool_use
  id로 카운트).
- 관련 telemetry 속성: `gen_ai.turn.is_subagent`,
  `gen_ai.turn.parent_tool_use_id`, `gen_ai.turn.subagent_type`.

### 현재 어댑터 갭 (`src/core/claudeAdapter.ts`)

- `task_started/updated/progress`·`tool_use_summary`를 그냥 `emitStatus(subtype,
  summary||description||status)`로 뭉갬 → 요약 구조 손실(line ~740).
- `parent_tool_use_id`를 **안 씀** → 모든 tool_call을 평평하게 emit해서 어느
  서브에이전트 것인지 그룹핑 불가(`normalizeAssistantSnapshot`/
  `normalizeStreamEvent`가 parent id 무시).
- 즉 데이터는 유입되는데 정규화에서 버려짐.

---

## C. 비교표

| 항목 | Codex 하네스 | Claude Code 하네스 |
|---|---|---|
| 서브에이전트 단위 | 독립 thread (`parentThreadId`) | `Agent`/`Task` tool_use 블록 |
| 개수 파악 | `agentsStates` / `thread/list` | 활성 Agent tool_use id 카운트 |
| 배정 작업 | `collabAgentToolCall.prompt` | Agent tool_use `description`+`prompt`+`subagent_type` |
| 역할/이름 | `agentRole` / `agentNickname` | `subagent_type`, `description` |
| 라이브 상태 | `CollabAgentStatus`(running/completed/errored…) | `task_progress` 요약 + tool 흐름 |
| "grep중/read중" 세밀도 | 자식 thread item 스트림(threadId 필터) | 중첩 tool_use(+`parent_tool_use_id`) |
| 서브에이전트 텍스트 | thread 스트림에 있음 | **기본 요약, `forward_subagent_text`로 켜야** |
| 동시성 상한 | config `[agents] max_threads`(기본 6) | 명시 없음(활성 카운트) |
| 현재 AgentParty 지원 | item 무시됨(`03` 문서 gap) | 데이터 유입되나 정규화서 버림 |

---

## D. UI 구현 관점 — 공통 추상화 권고

두 하네스를 한 UI로 묶으려면 정규 이벤트(`src/core/events.ts`)에 **서브에이전트
개념**을 추가해야 한다(현재 없음 — Task/서브에이전트가 일반 `tool_call`로만 옴).

최소 모델:

```
Subagent {
  id            // Codex: agentThreadId / Claude: Agent tool_use id
  parentId      // 세션/부모 thread
  label         // Codex: agentRole/nickname / Claude: description·subagent_type
  status        // running | completed | failed | interrupted ...
  currentAction // "코드 탐색중"(Grep/commandExecution) 등 — 최신 tool로 도출
  assignedTask  // Codex prompt / Claude Agent prompt
  updatedAt
}
```

- **currentAction 도출(공통)**: "가장 최근 자식 tool 종류 → 한글 라벨" 매핑.
  - Read / fileChange(read) → "문서 읽는중"
  - Grep / commandExecution(grep·find) → "코드 탐색중"
  - Bash / commandExecution(exec) → "명령 실행중"
  - WebSearch / webSearch → "웹 검색중"
  - Edit·Write / fileChange(write) → "파일 수정중"
  → 사용자가 원한 "간단 표시"가 이 매핑으로 충족된다.
- **개수 badge**: 활성 서브에이전트 수를 세션 헤더/사이드바에 표시.
- **하네스별 소스**:
  - Codex: `collabAgentToolCall` + `agentsStates`만으로 요약 카드가 나오고,
    세밀도는 자식 thread 구독으로 확장.
  - Claude: `parent_tool_use_id` 그룹핑 + `task_progress` 요약이 열쇠.

---

## E. 현재 AgentParty 최소 작업

1. `src/core/events.ts`에 서브에이전트 개념 추가 — 신규 `subagent_activity`
   이벤트, 또는 `tool_call`에 `parentId`/`agentId` 필드.
2. **Claude 어댑터**: `parent_tool_use_id`로 tool_call 귀속 + `task_started/
   updated/progress`·`tool_use_summary` 요약을 구조화 이벤트로 복원(현재
   `emitStatus`로 뭉갠 것). 필요 시 `forward_subagent_text` 옵션화.
3. **Codex 어댑터**: `collabAgentToolCall`/`subAgentActivity` item 정규화(현재
   무시). `agentsStates`→서브에이전트 status. (연계: `03-transcript-items-
   rendering.md`의 미렌더 item 목록.)
4. 렌더러: 세션 내 서브에이전트 목록 + 개수 badge + `currentAction` 라벨.

우선순위: 이 기능은 `06-implementation-roadmap.md`의 "2군 8. subagent/collab
Tasks pane"에 해당. 위 currentAction 라벨링은 그 pane의 핵심 UX다.

---

## 근거 (확인일 2026-07-04)

- 로컬 app-server v2 스키마: `ThreadItem::collabAgentToolCall` /
  `::subAgentActivity`, `CollabAgentStatus`, `CollabAgentTool`,
  `CollabAgentToolCallStatus`, `Thread`(agentRole/agentNickname/parentThreadId/
  source/status/preview), `SubAgentSource`, `MultiAgentMode` — 재생성은
  `01-app-server-protocol.md` 참조.
- `src/core/claudeAdapter.ts`(`task_*` subtype 처리 ~L740, `parent_tool_use_id`,
  `includePartialMessages: true` ~L429), `src/core/events.ts`(정규 이벤트에
  서브에이전트 개념 부재).
- https://platform.claude.com/docs/en/agent-sdk/subagents — 서브에이전트 격리,
  tool_use/tool_result만 부모로, `forward_subagent_text`.
- https://platform.claude.com/docs/en/agent-sdk/streaming-output — StreamEvent
  `parent_tool_use_id`.
- https://code.claude.com/docs/en/agent-sdk/subagents — Agent(구 Task) 개명
  (v2.1.63), 동시 실행.
</content>
