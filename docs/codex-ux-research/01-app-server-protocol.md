# Codex app-server 프로토콜 상세 (하네스 통합 표면)

출처:
- 로컬 확인: `codex app-server --help`, `codex app-server generate-json-schema`,
  `codex-cli 0.142.4`
- 기존 구현: `src/core/codexAdapter.ts`, `scripts/e2e-live-codex.mjs`
- 공식: https://github.com/openai/codex (`codex-rs/app-server`)

## 한 줄 정의

Codex 하네스는 CLI 텍스트를 파싱하는 것이 아니라 **`codex app-server`라는
장수명(long-lived) 프로세스에 stdio로 붙어 JSON-RPC 2.0로 대화**한다. 이 한
프로세스가 여러 스레드(=대화)를 관리하고, 턴을 실행하고, 승인 요청을 역방향으로
보내고, 아이템/토큰/상태 이벤트를 스트리밍한다. IDE 확장·데스크톱 앱·CLI TUI가
모두 이 동일한 app-server의 클라이언트다("단일 에이전트, 다중 ingress").

즉 AgentParty의 Codex 하네스는 **app-server의 또 하나의 클라이언트**가 된다.
현재 `src/core/codexAdapter.ts`가 이미 이 방식으로 초기 구현되어 있다.

## 프로세스 기동

```
codex [executableArgs...] app-server
```

- 기본 transport는 `stdio://`. `--listen`으로 `unix://`, `ws://IP:PORT`도 가능.
- 현재 어댑터: `spawn(executable, [...codexExecutableArgs(), "app-server"])`.
  - `executable`: `options.executablePath` → `AGENTPARTY_CODEX_BIN` → `"codex"`.
  - `AGENTPARTY_CODEX_ARGS`(JSON 배열)로 앞쪽 인자 주입 가능(e2e에서는
    `node codex.js app-server`로 실행).
- stdout은 **줄 단위 JSON**(`readline`). stderr는 진단 텍스트.
- `--analytics-default-enabled` 플래그가 있다(1st-party IDE 확장은 analytics
  기본 on). AgentParty는 명시적으로 켜지 않는 한 off로 두는 게 맞다.
- 비-loopback listener에는 `--ws-auth capability-token|signed-bearer-token`,
  `--ws-token-file`이 필요하다. 로컬 stdio에는 불필요.

## JSON-RPC 메시지 형태

한 줄에 JSON 하나. 3종류:

- **Request(client→server)**: `{ "id": <RequestId>, "method": "...", "params": {...} }`
  - `id`는 문자열 또는 정수. 어댑터는 `agentparty-<seq>` 문자열을 쓴다.
- **Response(server→client 또는 client→server)**: `{ "id": ..., "result": {...} }`
  또는 `{ "id": ..., "error": { "code", "message", "data" } }`.
- **Notification(단방향)**: `{ "method": "...", "params": {...} }` — `id` 없음.

**중요:** 서버도 클라이언트에게 **Request**를 보낸다(승인 요청 등). 이때
클라이언트는 그 `id`에 대해 `result`로 응답해야 한다. 즉 메시지 라우팅은
"내가 보낸 request의 응답인가 / 서버가 보낸 request인가 / notification인가"를
구분해야 한다. 어댑터 `readMessage()`가 정확히 이 3분기를 한다.

## 핸드셰이크

1. `initialize` (request) —
   ```json
   { "clientInfo": { "name": "agentparty", "title": "AgentParty", "version": "0.1.0" },
     "capabilities": { "experimentalApi": true, "requestAttestation": false } }
   ```
2. `initialized` (client notification) — 파라미터 없음.

이후 스레드를 시작/재개한다.

## 스레드(대화) lifecycle

- `thread/start` (request) → `{ thread: { id, ... }, model }` 반환.
  현재 파라미터: `model`, `cwd`, `approvalPolicy`, `approvalsReviewer:"user"`,
  `sandbox`.
- `thread/resume` (request) — `threadId`로 기존 스레드 재개. 같은 파라미터 +
  `threadId`.
- `thread/fork` — 스레드 분기(별도 threadId).
- `thread/list`, `thread/read`, `thread/loaded/list` — 목록/조회.
- `thread/metadata/update`, `thread/name/set` — 이름/메타 설정(세션 naming).
- `thread/archive` / `thread/unarchive` / `thread/delete` — 보관/삭제.
- `thread/compact/start` — context compaction 시작(어댑터 `compact()`).
- `thread/rollback` — 되감기(checkpoint).
- `thread/goal/set|get|clear` — 스레드 목표(goals 기능, `04` 참조).
- `thread/inject_items` — 외부에서 아이템 주입.
- `thread/shellCommand` — 스레드 맥락 셸 명령.
- `thread/unsubscribe` — 이벤트 구독 해제.

관련 notification: `thread/started`, `thread/status/changed`,
`thread/tokenUsage/updated`, `thread/compacted`, `thread/name/updated`,
`thread/goal/updated`, `thread/goal/cleared`, `thread/archived`,
`thread/unarchived`, `thread/deleted`, `thread/closed`,
`thread/settings/updated`.

## 턴(turn) lifecycle

- `turn/start` (request) — 사용자 입력으로 한 턴 실행. 현재 파라미터:
  ```json
  { "threadId", "input": [{ "type":"text", "text":"...", "text_elements":[] }],
    "cwd", "approvalPolicy", "approvalsReviewer":"user",
    "sandboxPolicy", "model", "effort" }
  ```
  반환 `{ turn: { id } }`.
- `turn/interrupt` (request) — `{ threadId, turnId }`로 실행 중단(어댑터
  `interrupt()`).
- `turn/steer` — 실행 중인 턴에 지시 주입(TUI의 Enter=steer 동작. 어댑터
  미구현 — P1).

관련 notification: `turn/started`, `turn/completed`(→ `turn.status`가
`"failed"`면 error), `turn/plan/updated`(plan/TODO), `turn/diff/updated`(누적
diff), `turn/moderationMetadata`.

## 아이템(transcript block) 이벤트

턴 내부의 개별 작업 단위가 **item**. notification:

- `item/started`, `item/completed` — `params.item`에 `type` 필드로 종류 구분.
  전체 `ThreadItem.type` 목록은 `03-transcript-items-rendering.md` 참조:
  `userMessage, hookPrompt, agentMessage, plan, reasoning, commandExecution,
  fileChange, mcpToolCall, dynamicToolCall, collabAgentToolCall,
  subAgentActivity, webSearch, imageView, sleep, imageGeneration,
  enteredReviewMode, exitedReviewMode, contextCompaction`.
- 스트리밍 delta:
  - `item/agentMessage/delta` — assistant 텍스트 조각.
  - `item/reasoning/textDelta`, `item/reasoning/summaryTextDelta`,
    `item/reasoning/summaryPartAdded` — reasoning 스트림.
  - `item/plan/delta` — plan 갱신.
  - `item/commandExecution/outputDelta` — 셸 live output.
  - `item/commandExecution/terminalInteraction` — 인터랙티브 터미널 상호작용.
  - `item/fileChange/outputDelta`, `item/fileChange/patchUpdated` — 패치 갱신.
  - `item/mcpToolCall/progress` — MCP 진행률.
  - `item/autoApprovalReview/started|completed` — guardian(auto_review) 심사.

## 서버 → 클라이언트 Request (승인/입력 요청)

이 메서드들은 **서버가 request로** 보내며 클라이언트가 `result`로 응답해야 한다.
(어댑터 `handleServerRequest()`가 `pendingApprovals`에 담고 `approval_request`
이벤트를 emit → UI가 allow/deny → `respond(id, decision)`.)

- `execCommandApproval` — 셸 실행 승인. 응답 `{ decision: "approved"|"denied" }`.
- `applyPatchApproval` — 패치 적용 승인. 응답 `{ decision: "approved"|"denied" }`.
- `item/commandExecution/requestApproval` — 응답 `{ decision:"accept"|"decline" }`.
- `item/fileChange/requestApproval` — 응답 `{ decision:"accept"|"decline" }`.
- `item/permissions/requestApproval` — 권한 상승 요청(네트워크/외부 경로 등).
- `item/tool/call` — 클라이언트가 제공하는 도구 실행 요청.
- `item/tool/requestUserInput` — 사용자 입력 요청(툴이 값을 물어봄).
- `mcpServer/elicitation/request` — MCP 서버 elicitation.
- `attestation/generate`, `account/chatgptAuthTokens/refresh` — 인증/증명.

> 현재 어댑터의 `approvalDecision()`이 위 decision 형태를 이미 매핑한다.
> 다만 `item/permissions/requestApproval`, `item/tool/requestUserInput`은
> 아직 미처리(P1). `02-approvals-sandbox-permissions.md` 참조.

## 그 외 상태/진단 notification

- `error` — 치명 오류(어댑터가 error 상태 전이).
- `warning`, `configWarning`, `deprecationNotice`, `guardianWarning`,
  `windows/worldWritableWarning` — 경고(조용히 버리면 안 됨).
- `model/rerouted`, `model/safetyBuffering/updated`, `model/verification` —
  모델 리라우트/안전버퍼(“no silent fallback” 정책상 반드시 표시).
- `mcpServer/startupStatus/updated`, `mcpServer/oauthLogin/completed` — MCP.
- `hook/started`, `hook/completed` — 훅 lifecycle.
- `process/exited`, `process/outputDelta` — 백그라운드 프로세스.
- `account/updated`, `account/rateLimits/updated`, `account/login/completed` —
  계정/rate limit.
- `fs/changed` — 파일시스템 변경 감시.
- `skills/changed`, `app/list/updated` — 스킬/앱 목록 갱신.

## 클라이언트 → 서버 Request 전체 목록(0.142.4, 87개)

app-server가 노출하는 전체 request 메서드. GUI가 필요로 하는 관리 기능이 거의
전부 프로토콜로 제공된다는 점이 핵심 — 별도 CLI 파싱 없이 이 request들로
모델/MCP/플러그인/스킬/계정/파일시스템까지 제어 가능하다.

- 초기화: `initialize`
- 스레드: `thread/start`, `thread/resume`, `thread/fork`, `thread/list`,
  `thread/read`, `thread/loaded/list`, `thread/metadata/update`,
  `thread/name/set`, `thread/archive`, `thread/unarchive`, `thread/delete`,
  `thread/compact/start`, `thread/rollback`, `thread/inject_items`,
  `thread/shellCommand`, `thread/unsubscribe`, `thread/goal/set`,
  `thread/goal/get`, `thread/goal/clear`, `thread/approveGuardianDeniedAction`
- 턴: `turn/start`, `turn/interrupt`, `turn/steer`
- 모델/제공자: `model/list`, `modelProvider/capabilities/read`
- 계정/인증: `account/read`, `account/login/start`, `account/login/cancel`,
  `account/logout`, `account/usage/read`, `account/rateLimits/read`,
  `account/rateLimitResetCredit/consume`, `account/workspaceMessages/read`,
  `account/sendAddCreditsNudgeEmail`
- 설정: `config/read`, `config/value/write`, `config/batchWrite`,
  `config/mcpServer/reload`, `configRequirements/read`,
  `permissionProfile/list`
- MCP: `mcpServerStatus/list`, `mcpServer/tool/call`,
  `mcpServer/resource/read`, `mcpServer/oauth/login`
- 플러그인/마켓: `plugin/list`, `plugin/installed`, `plugin/install`,
  `plugin/uninstall`, `plugin/read`, `plugin/skill/read`,
  `plugin/share/list|save|checkout|delete|updateTargets`,
  `marketplace/add`, `marketplace/remove`, `marketplace/upgrade`
- 스킬: `skills/list`, `skills/config/write`, `skills/extraRoots/set`
- 훅: `hooks/list`
- 앱: `app/list`
- 기능 플래그: `experimentalFeature/list`,
  `experimentalFeature/enablement/set`
- 파일시스템: `fs/readFile`, `fs/writeFile`, `fs/readDirectory`,
  `fs/createDirectory`, `fs/copy`, `fs/remove`, `fs/getMetadata`,
  `fs/watch`, `fs/unwatch`, `fuzzyFileSearch`
- 명령 실행(클라이언트 터미널): `command/exec`, `command/exec/write`,
  `command/exec/resize`, `command/exec/terminate`
- 외부 에이전트 마이그레이션: `externalAgentConfig/detect`,
  `externalAgentConfig/import`, `externalAgentConfig/import/readHistories`
- 리뷰: `review/start`
- Windows 샌드박스: `windowsSandbox/readiness`, `windowsSandbox/setupStart`
- 기타: `feedback/upload`

> 전체 파라미터/응답 스키마는 아래 재생성으로 확보한다. AgentParty repo에
> 551KB 스키마를 체크인하지 말고, 하네스 작업 시 로컬에서 재생성해 참조한다.

## 프로토콜 스키마 재생성 방법

```bash
codex app-server generate-json-schema --out <out-dir>
# 산출: ClientRequest.json, ClientNotification.json,
#       ServerNotification.json, ServerRequest.json,
#       codex_app_server_protocol.v2.schemas.json 등
codex app-server generate-ts --out <out-dir>   # TS 바인딩(experimental)
```

- `ClientRequest.json` = 위 87개 request의 params 스키마(oneOf, `method` enum).
- `ServerNotification.json` = 68개 notification.
- `ServerRequest.json` = 10개 서버→클라 request(승인/입력/증명).
- `codex_app_server_protocol.v2.schemas.json` = 전체 타입 정의(`ThreadItem`,
  `SandboxPolicy`, `AskForApproval`, `TurnPlanStep` 등).

**하네스 작업 세션은 `generate-ts`로 TS 타입을 뽑아 어댑터에 반영하는 것을
1순위 권장.** 현재 어댑터는 `any` 기반 수기 파싱이라 프로토콜 변경에 취약하다.

## 현재 `codexAdapter.ts`가 구현한 것 / 안 한 것

구현됨:
- initialize/initialized 핸드셰이크.
- thread/start · thread/resume · turn/start · turn/interrupt ·
  thread/compact/start.
- notification 정규화: thread/started, thread/status/changed, turn/started,
  turn/completed, thread/tokenUsage/updated, item/started, item/completed,
  item/agentMessage/delta, item/reasoning/*Delta, error, warning류.
- item 정규화: agentMessage, reasoning, commandExecution, fileChange,
  mcpToolCall/dynamicToolCall → AgentParty 정규 이벤트로 변환.
- 승인: execCommandApproval, applyPatchApproval,
  item/commandExecution/requestApproval, item/fileChange/requestApproval.
- 비용: `thread/tokenUsage/updated` → TurnUsage → costing(구독제 표기).
- permission mode → approvalPolicy + sandbox 매핑.

아직 안 된 것(하네스 작업 backlog → `05` 문서):
- `turn/steer`(실행 중 지시 주입, TUI Enter 동작).
- `item/permissions/requestApproval`, `item/tool/requestUserInput`,
  `mcpServer/elicitation/request` 처리.
- plan/goal/subAgentActivity/webSearch/imageGeneration/imageView item 렌더링
  (현재 무시됨).
- model/list·model/rerouted·rate limit·guardianWarning 등 상태 surface.
- `setModel`/`setEffort`/`setThinking`/`setPermissionMode`가 로컬 상태만 바꾸고
  실제 프로토콜(config/value/write 또는 다음 turn 파라미터)에 반영이 부분적.
- MCP/플러그인/스킬/계정/파일시스템 관리 request 미노출.
- TS 타입 미사용(수기 `any` 파싱).

## AgentParty 시사점

- Codex 하네스는 **한 member = 한 app-server 스레드**로 매핑하는 것이 자연스럽다.
  단, 하나의 app-server 프로세스가 여러 스레드를 다룰 수 있으므로, 프로세스를
  member마다 띄울지(현재 어댑터: member마다 1프로세스) 공유할지는 설계 선택.
  초기에는 member=프로세스=스레드 1:1:1이 단순하고 안전하다.
- app-server가 관리 기능을 전부 request로 노출하므로, AgentParty의 "모든
  user-facing capability는 HTTP API로" 원칙을 Codex 쪽에서도 충족시키기 쉽다.
  각 관리 UI(모델/ MCP/ 플러그인/ 스킬/ 계정)는 해당 request를 감싼 endpoint로.
- 승인은 서버가 request로 밀어주므로, member가 blocked 되는 지점이 명확하다.
  `pendingApprovals`를 sidebar badge / global "Needs input" inbox와 연결한다.
</content>
