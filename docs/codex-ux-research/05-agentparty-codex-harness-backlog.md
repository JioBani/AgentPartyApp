# AgentParty Codex 하네스 — 개념 매핑 · 갭 · Backlog

이 문서는 앞의 조사(01~04, codex-*.md)를 현재 AgentParty/`codexAdapter` 구현과
대조해 Codex 하네스를 "완전한 제품 parity"까지 끌어올리기 위한 작업 단위로
정리한다. 다른 세션이 이 문서만 보고 작업할 수 있도록 함.

대조 기준(현재 코드):
- 하네스 인터페이스: `src/main/harness/types.ts`(`HarnessSession`).
- 어댑터: `src/core/codexAdapter.ts`(app-server JSON-RPC).
- 선택/생성: `src/main/sessionManager.ts:213`(harness=codex → `CodexAdapter`),
  `src/main/application/partyDomain.ts`(`normalizeHarnessId`).
- 라이브 e2e: `scripts/e2e-live-codex.mjs`.
- 정규 이벤트/스냅샷: `src/core/events.ts`(Codex는 Claude와 같은
  `ClaudeNormalizedEvent`/`ClaudeSessionSnapshot`을 재사용).

## 이미 되어 있는 것

- Codex가 harness로 등록됨(`harnesses[].id="codex"`, status `available`).
- `CodexAdapter`가 app-server를 spawn하고 initialize→thread/start→turn/start의
  핵심 루프, interrupt/compact/restart, 토큰비용, 승인(명령/패치) 4종을 처리.
- e2e가 실 Codex로 2턴 라이브 통과(`gpt-5.4-mini`), slash command 노출 검증.
- permission mode → approvalPolicy+sandbox 매핑(`sandboxModeFor` 등).
- member 생성 wizard가 harness/model/reasoning/role을 이미 받음(공용).

즉 "member chat이 도는" 단계. 다음은 "Codex 제품 parity" 단계.

## Claude Code ↔ Codex 개념 매핑 (혼동 주의)

| 개념 | Claude Code | Codex | AgentParty 처리 |
|---|---|---|---|
| 통합 표면 | CLI stream-json | **app-server JSON-RPC**(장수명 stdio) | 어댑터 종류만 다름 |
| 세션 단위 | session | **thread** | member=thread 1:1 |
| 실행 단위 | turn | turn | 동일 |
| 권한 | 단일 permission mode | **샌드박스 × 승인 2축**(+guardian) | 2축 UI 필요(`02`) |
| plan | plan mode | `/plan` + goals + plan item | 별도(`03`,`04`) |
| 서브에이전트 | subagent | multi_agent(collab/subAgentActivity) | 개념 분리(아래) |
| 백그라운드 | background agent / Agent view | thread/list + Cloud tasks | session manager |
| worktree | `--worktree` | 데스크톱 앱 Local/Worktree/Cloud 모드 | isolation 축 |
| 클라우드 | ultrareview(제한적) | **Codex Cloud**(1급) | 위임 액션(`cloud`) |
| 코드리뷰 | `/review`, ultrareview | `codex review` + `@codex` GitHub | 리뷰 pane/PR |
| 스킬/플러그인 | skill/plugin | skills/plugins/marketplace | 매니저 UI 공용화 |
| MCP | `claude mcp` | `codex mcp` + app-server request | 매니저 UI 공용화 |
| 메모리 | auto-memory | memories(sqlite) | 매니저 UI |

**서브에이전트 vs member(반드시 구분)**:
- **Party member** = AgentParty의 독립 세션(= Codex thread). transcript 보유.
- **Codex 서브에이전트** = 한 thread 내부 worker(collabAgentToolCall/
  subAgentActivity). member가 아니라 Tasks/agent-roster pane에 표시.
- **Codex Cloud task** = 원격 컨테이너 작업. member 액션의 결과물(diff/PR).

## 하네스 인터페이스 부합/확장

`HarnessSession`(types.ts)은 Claude 중심이라 Codex 고유 기능을 담기엔 좁다.
현재 어댑터가 인터페이스는 만족하지만 아래가 no-op/부분 구현:
- `setModel/setEffort/setPermissionMode` — 로컬 상태만 갱신, 다음 turn 파라미터
  에만 반영. `config/value/write` 또는 재확인 status 필요.
- `setThinking` — Codex는 app-server가 reasoning 내부 관리 → status만 emit(정상,
  단 effort와의 관계를 UI에 안내).
- `respondApproval` — 4종만. permissions/tool-input/mcp-elicitation 누락.

→ 확장 방향(선택): `HarnessSession`에 옵셔널 Codex-특화 메서드를 추가하거나,
`codex` 전용 확장 인터페이스 + 캡ability 플래그(`supportsCloud`, `supports
Guardian`, `supportsSubagents` 등)로 UI가 분기.

## P0 — 사용자 체감 큰 결손

### 1. 승인/샌드박스 2축 UI + guardian
- 현재 단일 permission mode를 2축에 눌러담아 Codex 표현과 어긋남(`02`).
- 작업: Codex member Runtime에 샌드박스(read-only/workspace-write/full) ×
  승인(untrusted/on-request/never) 2축 + **Read Only/Auto/Full Access 프리셋** +
  **guardian(auto_review) 토글**(`approvalsReviewer` 하드코딩 제거).
- 승인 카드: once / for-session / **prefix rule** / decline + guardian 심사 표시
  + request-user-input 카운트다운.
- API: `POST /api/sessions/:id/runtime`에 codex 2축 필드; 승인 응답 endpoint에
  decision variants.

### 2. Transcript item 커버리지(`03`)
- 현재 무시: plan, commandExecution live output/exitCode/cwd/duration, fileChange
  diff 축적, mcpToolCall source, subAgentActivity, webSearch, imageGeneration.
- 작업: `normalizeItem`을 스키마 18종에 맞춰 확장 + delta 구독
  (`item/commandExecution/outputDelta`, `item/plan/delta`, reasoning summary 등).
- API: QA 이벤트 스키마에 item source/status/duration/diffStats/exitCode 추가.

### 3. slash command inventory
- 어댑터 `CODEX_COMMANDS`는 9개뿐. `codex-cli.md`의 실제 TUI 명령으로 확장하고,
  가능하면 정적 하드코드 대신 app-server(`app/list`, `skills/list`, `plugin/list`,
  `hooks/list`)로 라이브 discovery.
- 공용 command palette(Claude Code 조사 `02`)에 Codex source badge.

### 4. 상태/진단 surface(no silent fallback)
- 반드시 표시: `model/rerouted`, `account/rateLimits/updated`, `guardianWarning`,
  `configWarning`, `deprecationNotice`, MCP startup status, Windows 샌드박스 경고.
- 현재 어댑터는 warning류를 status로 emit만 함 → severity/category 부여 +
  member header/badge 연동(`03` tool card 스키마 통일).

## P1 — 생산성 parity

### 5. turn/steer & queue 구분
- TUI Enter=steer(진행 중 턴 주입), Tab=queue. 현재 어댑터는 실행 중이면 무조건
  큐잉. `turn/steer` request 추가 + composer UX(steer/queue) 구분.

### 6. 세션 lifecycle(thread) 일급화
- `thread/list|read|fork|archive|unarchive|delete|name/set`을 member 액션으로.
  resume은 이미 `resumeSessionId`로 부분 지원 → fork/archive/rename/delete 추가.
- `~/.codex/sessions` 공유 특성상 다른 Codex surface와 상호운용.

### 7. 서브에이전트/Tasks pane
- collabAgentToolCall/subAgentActivity를 agent-roster/Tasks pane에 표시(member와
  구분). `/agent` 대응 전환/중지. `[agents]` 캡 노출.

### 8. Diff pane + 리뷰
- fileChange를 diff 모델로 축적 → per-file/per-hunk accept/reject(IDE 갭 주의,
  `codex-ide-desktop.md`) + apply-to-worktree.
- `codex review`/`review/start` request → 리뷰 코멘트 pane(enteredReviewMode 그룹).

### 9. 관리 매니저 UI(app-server request로)
- MCP(`mcpServerStatus/list`, `mcpServer/oauth/login`, `config/mcpServer/reload`),
  Plugins/Apps(`plugin/*`, `marketplace/*`, `app/list`), Skills(`skills/*`),
  Hooks(`hooks/list` + 신뢰 심사), Memories, Auth(`account/*`), Config(`config/*`).
- 프로토콜이 전부 request로 노출 → 각 매니저를 감싼 HTTP endpoint로 API parity.

## P2 — 고급 / 차별 기능

### 10. Codex Cloud 위임(`codex-cloud-github.md`)
- member 액션 "Run in cloud"(from main / from local changes) → 진행 모니터 →
  결과 diff pull. 초기엔 `codex cloud exec/status/logs/apply` 배치 감싸기.
- 작업 상태(QUEUED…AWAITING_USER_FEEDBACK…COMPLETED)를 Needs-input inbox 연동.
- `--attempts 1~4` best-of-N 옵션.
- 환경/시크릿 선택(민감정보 마스킹).

### 11. PR/CI status
- 클라우드 PR 생성/`@codex` 리뷰 → member row PR badge + "PR opened" 카드 +
  CI status. Claude Code 조사 backlog와 공용화.

### 12. worktree isolation(데스크톱 앱 Local/Worktree/Cloud 축)
- member 생성 wizard에 isolation 모드. worktree path badge.

### 13. 능력 토글(browser/computer/in-app/image)
- feature/플러그인/권한 게이트 토글 + 임베디드 프리뷰 pane + 인라인 이미지.

### 14. goals / memories / personality UI
- goal 배너(composer 위, pause/resume/edit/clear), memories 매니저(가시화),
  personality selector.

## 기반 정비(선행 권장)

- **TS 타입 생성**: `codex app-server generate-ts --out <dir>`로 프로토콜 타입을
  뽑아 어댑터의 `any` 파싱 제거. 프로토콜 드리프트 내성.
- **캡ability 플래그**: harness descriptor/스냅샷에 Codex 지원 기능 노출 →
  Runtime/palette가 하네스별로 UI 분기(Claude엔 없는 guardian/cloud/2축 등).
- **문서 동기화**(프로젝트 지침): Codex endpoint 추가 시 `src/shared/apiSpec.ts`
  + `docs/API.md`, QA 스크립트는 `docs/E2E_TESTING.md`에 반영.

## 추천 구현 순서

1. 승인 2축+guardian, transcript item 커버리지, 상태/진단 surface(P0 1~4).
2. steer/queue, thread lifecycle, TS 타입 생성(P1 5~6 + 기반).
3. 서브에이전트/Tasks, Diff pane/리뷰, 관리 매니저(P1 7~9).
4. Codex Cloud 위임 + PR/CI(P2 10~11).
5. worktree/능력/goals·memories·personality(P2 12~14).

이 순서 근거:
- 1은 현재 어댑터 위에 바로 얹히고 Codex의 정체성(2축 승인/샌드박스, 풍부한 item)
  을 즉시 살린다.
- 2~3은 app-server가 이미 request로 전부 노출하므로 백엔드 비용이 낮다.
- 4~5는 클라우드/GitHub 등 외부 연동이라 뒤로.
</content>
