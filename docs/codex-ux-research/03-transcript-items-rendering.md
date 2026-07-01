# Transcript Item Taxonomy & 렌더링 요구사항

출처: `codex app-server generate-json-schema` →
`codex_app_server_protocol.v2.schemas.json`의 `ThreadItem` 정의(18 variant),
`src/core/codexAdapter.ts`. 검증일 2026-07-01.

## 한 줄 정의

Codex transcript는 assistant 텍스트 로그가 아니라 **타입이 있는 item의 append
스트림**이다. app-server는 `item/started`·`item/completed` notification의
`params.item.type`으로 종류를 구분하고, 실행 중에는 `item/<kind>/*Delta`로 조각을
흘린다. AgentParty는 각 item 타입을 **안정적인 UI 블록**으로 매핑해야 한다.

## ThreadItem 전체 타입 (18종, 스키마 확정)

각 항목: 타입 = 필드들 → AgentParty 렌더링.

1. **userMessage** = `clientId, content, id`
   - 사용자 메시지. → user bubble.
2. **hookPrompt** = `fragments, id`
   - 훅이 주입한 프롬프트 조각. → 접힌 "hook injected context" 블록. 훅 실패는
     `hook/started`/`hook/completed`와 연동.
3. **agentMessage** = `text, phase, memoryCitation, id`
   - assistant 텍스트. `phase`(진행 단계), `memoryCitation`(메모리 인용 표시).
     → markdown assistant 블록. 스트리밍은 `item/agentMessage/delta`.
4. **plan** = `text, id`
   - plan/TODO. 스트리밍 `item/plan/delta`, 턴 레벨 `turn/plan/updated`
     (`TurnPlanStep`/`TurnPlanStepStatus`). → 체크리스트 카드, 단계 상태 표시.
5. **reasoning** = `content, summary, id`
   - reasoning 요약. 스트리밍 `item/reasoning/textDelta`,
     `summaryTextDelta`, `summaryPartAdded`. → collapsible thinking 블록.
6. **commandExecution** = `command, aggregatedOutput, exitCode, cwd, durationMs,
   processId, status, source, commandActions, id`
   - 셸 실행. live output `item/commandExecution/outputDelta`, 인터랙션
     `item/commandExecution/terminalInteraction`. → tool card: 명령 + cwd +
     stdout/stderr(스트리밍) + exitCode + duration. 승인은
     `execCommandApproval` / `item/commandExecution/requestApproval`.
7. **fileChange** = `changes, status, id`
   - 파일 패치. `changes`(파일별 diff), 스트리밍 `item/fileChange/outputDelta`,
     `item/fileChange/patchUpdated`. → diff 블록(파일별 컬러 diff, +/- stats,
     accept/reject). 승인 `applyPatchApproval` / `item/fileChange/requestApproval`.
8. **mcpToolCall** = `server, tool, arguments, result, error, durationMs,
   status, pluginId, appContext, mcpAppResourceUri, id`
   - MCP 도구 호출. 진행 `item/mcpToolCall/progress`. → tool card + **source
     badge = `mcp:<server>`**(+ pluginId면 plugin 출처). error 분리 표시.
9. **dynamicToolCall** = `namespace, tool, arguments, contentItems, success,
   durationMs, status, id`
   - 동적 도구(앱/커넥터 등). → tool card + source badge = `namespace`.
10. **collabAgentToolCall** = `tool, prompt, model, reasoningEffort,
    senderThreadId, receiverThreadIds, agentsStates, status, id`
    - 협업 에이전트 호출(spawn/send/followup/interrupt). 복수 수신 스레드.
      → 서브에이전트 활동 카드(누가 누구에게, 모델/effort).
11. **subAgentActivity** = `agentPath, agentThreadId, kind, id`
    - 서브에이전트 활동(v2, 완료형). `kind` = started/interacted/interrupted.
      → agent-roster 피드 행(agentPath로 계층 표시). `04` 서브에이전트 참조.
12. **webSearch** = `query, action, id`
    - 웹검색. → "Searched: <query>" 칩 + 결과 링크.
13. **imageView** = `path, id`
    - 이미지 뷰(입력/참조 이미지). → 인라인 이미지(경로).
14. **sleep** = `durationMs, id`
    - 에이전트 대기/sleep. → "waiting Ns" 상태 칩.
15. **imageGeneration** = `result, revisedPrompt, savedPath, status, id`
    - 이미지 생성(gpt-image-2). → 생성 이미지 + revisedPrompt + 저장 경로.
16. **enteredReviewMode** = `review, id` / **exitedReviewMode** = `review, id`
    - 코드리뷰 모드 진입/이탈. → 리뷰 세션 구분 헤더/푸터(리뷰 코멘트 그룹핑).
17. **contextCompaction** = `id`
    - context 압축 발생. 턴 레벨 `thread/compacted`. → "context compacted"
      status 라인.

(참조: `ResponseItem`은 더 저수준(message/reasoning/function_call/
image_generation_call/compaction 등)이며 raw 이벤트용. UI는 `ThreadItem` 기준.)

## 현재 `codexAdapter.ts` 커버리지

`normalizeItem()`이 처리하는 것:
- agentMessage → `assistant_text_delta`
- reasoning → `reasoning_delta`(summary+content 합침)
- commandExecution → `tool_call`(name `command_execution`)
- fileChange → `file_change`
- mcpToolCall / dynamicToolCall → `tool_call`

**무시되는(미렌더) item**: plan, collabAgentToolCall, subAgentActivity,
webSearch, imageView, sleep, imageGeneration, enteredReviewMode,
exitedReviewMode, contextCompaction, hookPrompt.

## AgentParty 작업(→ `05` backlog)

P0/P1(사용자 체감 큰 것):
- **plan** — 멀티스텝 작업이면 plan 카드가 없으면 진행 파악 어려움. `turn/plan/
  updated`로 단계 상태.
- **commandExecution stdout/stderr 스트리밍** — 현재 `aggregatedOutput`만 결과로
  담음. `item/commandExecution/outputDelta` 구독해 live 표시 + exitCode/cwd/
  duration을 tool card에 노출.
- **fileChange를 diff 모델로** — `changes`를 파일별 diff pane에 축적(+/- stats).
- **mcpToolCall source badge** — `server`/`pluginId`로 provenance 표시.

P2(고급):
- subAgentActivity / collabAgentToolCall → 서브에이전트 pane.
- imageGeneration / imageView → 인라인 이미지 블록.
- webSearch → 검색 칩.
- enteredReviewMode → 리뷰 코멘트 그룹.
- contextCompaction / sleep / hookPrompt → status 라인.

## 공통 tool card 필드(Claude Code 조사와 정합)

Codex item에서 채울 수 있는 필드:
- `source`: built-in(command/file) / `mcp:<server>` / plugin / dynamic namespace.
- `phase/status`: started / completed(+ 승인 시 denied).
- `startedAt/completedAt/durationMs`(commandExecution.durationMs 등).
- `affectedFiles` + `diffStats`(fileChange.changes).
- `exitCode` / `cwd`(commandExecution).
- `stdout`/`stderr`(outputDelta 스트림 분리).
- `approvalRequestId`(승인 request와 연결).

→ Claude Code `03-transcript-tools-permissions.md`의 tool card 요구와 동일한
스키마로 통일하면 두 하네스가 같은 UI 블록을 공유한다.
</content>
