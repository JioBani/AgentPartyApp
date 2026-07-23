# Cursor CLI 사용자 요구사항 및 수동 E2E 결과

검증일: 2026-07-24
검증 환경: 실제 AgentParty Electron 앱, 실제 Cursor Agent CLI
`2026.07.20-8cc9c0b`, 로그인된 Cursor Free 계정

이 표는 기존 Claude Code/Codex 모델이 제공하는 사용자 관점의 동작을
기준으로 Cursor `Auto`와 `Grok 4.5`를 비교한 결과다. 검증은 격리된 실제
앱 프로세스를 띄운 뒤 공개된 로컬 자동화 HTTP API를 항목별로 직접
호출하고, 실제 provider 응답·앱 상태·저장 transcript·화면 캡처를
확인하는 방식으로 수행했다.

상태:

- `PASS`: 현재 환경에서 실제 앱과 실제 provider로 확인
- `PARTIAL`: 핵심 경로는 동작하지만 기존 하네스와 기능 차이가 있음
- `BLOCKED`: 외부 계정/플랜 때문에 성공 응답을 검증할 수 없음
- `FAIL`: 명시된 제품 계약과 현재 동작이 다름
- `GAP`: 기존 하네스에 있는 사용자 기능이 Cursor에는 아직 없음

| ID | 사용자 요구사항 | 공개 API/UI 경로 | 수동 E2E 결과 | 상태 |
|---|---|---|---|---|
| R00 | 모든 사용자 조작을 자동화 API로도 수행할 수 있어야 함 | `/api/settings`, `/api/sessions/:id/*`, `/api/party/members/:name/*`, `/api/capture` 등 | Workbench의 send/start/close/resume/respawn/restart/compact/interrupt/force-stop/model/effort/thinking/permission/approval/MCP/게이트 동작을 `apiSpec`과 대조했다. 누락된 사용자 동작은 발견되지 않았다. | PASS |
| R01 | Cursor 설치·로그인 상태와 버전을 확인할 수 있어야 함 | `GET /api/harnesses/cursor/status`, 인증 화면 | 실제 CLI `2026.07.20-8cc9c0b`와 Cursor 인증 상태를 앱에서 확인했다. | PASS |
| R02 | Cursor에서 지원하는 임시 모델만 명확히 보여야 함 | `GET /api/models`, 멤버 생성/Runtime UI | `Auto → auto`, `Grok 4.5 → cursor-grok-4.5-high` 두 경로만 노출됨을 확인했다. | PASS |
| R03 | 실제 모델 응답, 추론 스트리밍, transcript가 보여야 함 | 멤버 message API, transcript API, Workbench | Auto가 `CURSOR_BASIC_OK`를 실제 응답했다. reasoning block, 21,746 context token, assistant transcript를 확인했다. Auto의 미공개 context window는 조작하지 않고 unknown으로 표시된다. | PASS |
| R04 | 후속 턴이 동일한 모델 대화 문맥을 이어야 함 | message API, `harnessSessionId` | 첫 턴에서 저장한 `CURSOR_MEMORY_7K`를 두 번째 턴에서 회상했다. 동일 Cursor chat ID와 2턴 누적을 확인했다. | PASS |
| R05 | 파티 멤버가 AgentParty MCP 도구를 실제 호출할 수 있어야 함 | session MCP API, session-scoped plugin | Default/Full Access에서 실제 `list` 호출과 결과 수신에 성공했다. 누락돼 있던 `gate-set`/`party-gate-set`도 등록했고, 실제 Auto가 `gate-set {"name":"cursor-fix","mode":"off"}`를 호출해 앱 상태가 변경됐다. provider ID를 `plugin-agentparty-session-agentparty-app`으로 안정화한 뒤 실제 앱 재시작·hard restart·respawn 전후에도 동일 ID로 도구를 발견했고 stale-server 오류가 없었다. Plan에서는 서버가 반환한 MCP `readOnlyHint`를 Cursor CLI가 제거하고 `isReadonly:false`로 판정해 호출을 거절했다. 쓰기 금지 보장을 깨는 강제 승인은 적용하지 않았다. | PARTIAL |
| R06 | Plan 권한은 허용되지 않은 파일 쓰기를 막아야 함 | member permission API, Runtime UI | `cursor-plan-blocked.txt` 생성이 거절됐고 실제 파일이 생기지 않았다. | PASS |
| R06a | Cursor의 작업 모드와 승인 모드를 Claude 권한과 혼합하지 않아야 함 | `cursorPolicy`, Composer/멤버 생성/Runtime UI, session/member permission API | `Agent/Ask/Plan`과 `Allowlist/Auto-review/Run Everything`을 독립 축으로 노출하고 각각 `--mode`, `--auto-review`, `--force`로 매핑했다. 기존 Claude형 Cursor 저장값도 같은 CLI 의미의 `cursorPolicy`로 마이그레이션한다. | PASS |
| R07 | 충분한 권한에서는 실제 파일/셸 도구 작업이 가능해야 함 | member permission API, message API | Full Access로 변경 후 `cursor-write-ok.txt`를 만들고 내용 `CURSOR_WRITE_OK`와 tool transcript를 확인했다. | PASS |
| R08 | 실행 중인 턴을 중단하고 다음 턴으로 복구할 수 있어야 함 | member/session interrupt API, Stop UI | 30초 대기 도구 턴을 중단했다. 중단된 결과는 나타나지 않았고 다음 턴이 `CURSOR_AFTER_INTERRUPT_OK`로 정상 응답했다. | PASS |
| R09 | 바쁜 동안 보낸 메시지는 순서대로 처리되어야 함 | member message API, Composer | 연속 전송한 `CURSOR_QUEUE_ONE`, `CURSOR_QUEUE_TWO`가 순서대로 완료됐다. | PASS |
| R10 | 지원하지 않는 이미지를 조용히 버리지 않아야 함 | session send API, Composer | 이미지 입력이 `vision` 진단 block과 복구 안내로 명시적으로 거절됐다. | PASS |
| R11 | 수동 압축은 결과가 보이고 이후 대화를 계속할 수 있어야 함 | `POST /api/sessions/:id/compact`, Compact UI | `/compress` 턴이 완료됐고 이후 새 응답 `POST_COMPACT_CURSOR_MEMORY_7K`를 받았다. | PASS |
| R12 | Respawn은 세션 프로세스를 교체하되 대화 문맥을 유지해야 함 | member respawn API, Reload UI | 새 `resume-*` 앱 세션이 만들어지고 기존 Cursor chat ID가 유지됐으며 기억을 다시 회상했다. | PASS |
| R13 | 앱 재시작 후 모델·권한·transcript·대화가 복원되어야 함 | 저장소, panel prewarm, state/transcript API | 실제 앱을 종료/재실행했다. Auto, Full Access, transcript, 동일 chat ID가 복원되고 `POST_APP_RESTART_CURSOR_MEMORY_7K` 응답에 성공했다. | PASS |
| R14 | Grok 4.5 선택 실패 시 오류를 보여주고 Auto로 몰래 바꾸지 않아야 함 | session create/send/state | Low/Medium/High를 각각 실제 앱에서 호출했다. 세 호출 모두 Free 플랜의 `Named models unavailable` 오류를 노출했고 snapshot은 계속 `Grok 4.5`였다. 성공 응답은 현재 계정 플랜 때문에 검증할 수 없다. | BLOCKED |
| R15 | 실제 사용자 화면에서 모델·상태·응답·도구/진단이 보여야 함 | Workbench, capture API | 실제 Auto 패널, 기억 응답, reasoning, token 표시를 화면 캡처로 확인했다. | PASS |
| R16 | Hard restart는 빈 모델 대화로 초기화해야 함 | `POST /api/sessions/:id/restart`, 멤버 메뉴 | 이전 채팅에만 `ORCHID-7319`를 저장한 뒤 hard restart했다. 다음 실제 Auto 턴은 이를 알지 못하고 `CONTEXT_CLEARED`를 반환했으며 새 Cursor chat ID와 `turnCount: 1`을 확인했다. | PASS |
| R17 | 일반 중단이 안 될 때 Force stop으로 큐를 풀고 복구할 수 있어야 함 | member/session force-stop API, Composer | 강제 종료 후 새 턴이 `CURSOR_AFTER_FORCE_OK`로 정상 완료됐다. | PASS |
| R18 | 상호작용 승인을 카드로 처리할 수 있어야 함 | session approve API, approval UI | Cursor print mode가 interactive approval request를 노출하지 않아 Claude/Codex와 같은 승인 카드 흐름이 없다. | GAP |
| R19 | 계정별 사용량 제한/리셋 창을 표시해야 함 | usage API, titlebar usage UI | Cursor CLI가 rate-limit window를 보고하지 않으며 Cursor usage provider가 아직 없다. | GAP |
| R20 | subagent 활동을 부모 transcript와 분리해 관측해야 함 | subagent UI/이벤트 | Cursor NDJSON의 subagent 이벤트 정규화/추적기가 없다. | GAP |
| R21 | MCP 서버의 실제 연결 상태와 도구 inventory를 보여야 함 | `GET /api/sessions/:id/mcp`, MCP UI | 구성 직후에는 메시지·권한·게이트를 포함한 11개 AgentParty 도구 inventory와 `unknown`을 노출한다. 실제 `getMcpTools` 성공을 관측한 뒤 `connected`로 전환됨을 실제 앱에서 확인했다. Cursor print mode가 별도 연결 이벤트를 주지 않으므로 그 이상은 추정하지 않는다. | PASS |
| R22 | Cursor가 Claude Code 멤버에게 실제 메시지를 보내고 응답을 받아야 함 | Cursor `agentparty-app/send`, channel transcript | Cursor Auto가 MCP `send`를 호출했고 Claude Code/Haiku transcript에 inbound channel이 생성됐다. Claude가 실제 provider 응답 `CLAUDE_RECEIVED_CURSOR`를 반환했다. | PASS |
| R23 | Claude Code 멤버가 Cursor에 실제 메시지를 보내고 Cursor가 처리해야 함 | Claude party tool, channel transcript | Claude/Haiku가 실제 party `send` tool을 호출했다. Cursor에 inbound channel card가 표시되고 실제 Auto 응답 `CURSOR_RECEIVED_CLAUDE`를 반환했다. | PASS |
| R24 | Cursor와 Codex 사이의 메시지 transport가 양방향이어야 함 | Cursor `agentparty-app/send`, Codex MCP HTTP bridge | Cursor의 실제 MCP `send` 결과는 성공했고 Codex transcript에 inbound channel이 저장됐다. 역방향도 Codex MCP가 사용하는 동일 `/api/harness/party/messages` 경로로 전달되어 Cursor가 `CURSOR_RECEIVED_CODEX_BRIDGE`로 실제 응답했다. | PASS |
| R25 | Cursor↔Codex 양쪽 모델이 실제 tool-driven 왕복을 완료해야 함 | Codex app-server + AgentParty MCP | 로컬 Codex가 `Logged in using ChatGPT`로 표시되지만 실제 호출에서 refresh token revoked 오류가 발생했다. Cursor→Codex 전달 이후 Codex 응답과 Codex 모델의 역방향 tool 호출은 현재 인증 상태 때문에 완료할 수 없다. | BLOCKED |

## 결론

핵심 코딩 흐름은 동작한다: 실제 응답, 연속 대화, 도구·파일 작업,
권한, 중단/강제종료, 큐, 압축, respawn, 앱 재시작 복원, 오류 노출이
실제 앱에서 확인됐다.

완전한 Claude Code/Codex 동등성은 아직 아니다. 이번 수정으로 hard
restart, stale MCP provider ID, stale `lastError`, MCP inventory/관측 연결
상태를 해결했다. 남은 제품/CLI 차이는 R18, R19, R20이며, R05의
Plan-mode MCP 호출은 서버가 `readOnlyHint`를 반환해도 현재 Cursor CLI가
이를 제거하고 쓰기 가능 도구로 판정하는 외부 런타임 제약이다. R14의 성공
검증은 named model을 사용할 수 있는 Cursor 플랜이 필요하다. R25는
Codex를 다시 로그인한 뒤 실제 model-driven 역방향 호출을 재검증해야
한다. 메시지 transport 자체는 R22~R24에서 양방향으로 확인됐다.

최종 화면 증거:
`C:\Users\Dev\AppData\Local\Temp\agentparty-cursor-manual-final.png`

Cross-harness 화면 증거:
`C:\Users\Dev\AppData\Local\Temp\agentparty-cursor-cross-harness.png`

이번 수정 후 실제 앱 화면 증거:
`C:\Users\Dev\AppData\Local\Temp\agentparty-cursor-fixes-manual.png`
