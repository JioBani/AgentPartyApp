# B-24 파티 MCP 도구 소실 — CLI 내부 원인 분석

2026-08-12, beta-impl. 대상: `@anthropic-ai/claude-agent-sdk` 0.3.191 이 내장한 네이티브 CLI (내부 버전 **2.1.191**, 2026-06-24 빌드, `claude-agent-sdk-win32-x64/claude.exe`). 바이너리에 평문으로 내장된 JS 번들(오프셋 ~150MB 이후)을 카빙해 코드 수준으로 확인했다. 인용한 식별자는 그 번들의 압축명이다.

## 증상 (실측 두 형태)

| | 형태 1 (Pupil main, 09:02·09:42) | 형태 2 (impl2, 11:42) |
|---|---|---|
| 증상 | 세션 시작부터 파티 도구 미등록 | 5회 정상 호출 후 소실 |
| `mcpServerStatus()` | 서버 자체가 없음 | **connected, tools=16** |
| ToolSearch | — | 이름 검색도 실패 |
| 동시 사건 | 레거시 플러그인 실패 캐시 | claude.ai 커넥터 단절·재연결 |

## 확정한 구조적 사실

앱 쪽 배선은 무죄다(설치본과 바이트 비교 완료). 아래는 전부 CLI 2.1.191 내부다.

**F1. sdk 서버 등록 경로.** 호스트(sdk.mjs)는 `initialize` 제어 요청의 `sdkMcpServers`(이름 배열)로 CLI 에 알린다. CLI 의 initialize 핸들러는 이름을 동적 레지스트리 `i` 에 넣는다: `i[name]={type:"sdk",name}`. 실제 연결·tools/list 는 첫 턴의 `he()` 스위프가 수행한다(지연 등록 실측과 일치).

**F2. `$t`(동적 서버 재조정)는 `i` 를 지우고 다시 채운다.** `for(key of Object.keys(i)) delete i[key]; Object.assign(i, newSdkState.configs)`. `newSdkState.configs` 는 `LIc` 진입 시점의 `{...i}` 스냅숏 기반이다. `$t` 끼리는 promise 체인(`zt`)으로 직렬화되지만 **initialize 핸들러의 `i` 쓰기와는 동기화가 없다.**

**F3. 시작 시 reconcile 은 항상 즉시 돈다.** `yIc(hn)` = `hn().then(...)`. `hn`→플러그인 설치 diff→`Vn`→`$t`. 즉 모든 세션 시작에서 F2 의 재조정이 initialize 와 경합한다.

**F4. 모델 도구 목록과 상태 조회는 서로 다른 저장소를 읽는다.** 모델에 주는 목록(`_t`)은 클로저 변수 `le`(마지막 스위프 결과), `mcpServerStatus`(`Jt`)는 appState.mcp.tools + 클라이언트 배열 `ue`. **"상태는 connected/16개인데 모델은 호출 불가"가 구조적으로 가능하다.**

**F5. 재스위프는 옛 클라이언트를 정리하지 않는다.** `he()` 재실행 시 `PSa` 가 서버마다 **새 MCP 클라이언트 + 새 핸드셰이크**를 만들고 `ue` 배열만 교체한다. config 에서 빠진 이름만 cleanup 하므로 이름이 유지되는 sdk 서버의 옛 클라이언트는 산 채로 버려진다. 호스트의 응답 라우팅 키는 `서버이름:jsonrpc-id` 하나뿐이고 새 클라이언트는 id 를 0부터 다시 쓰므로, 공존하는 두 클라이언트 간 **id 충돌 시 pending 응답이 덮어써진다** (호스트 `handleMcpControlRequest` 는 중복 키를 검사 없이 `set`).

**F6. `he()` 는 `zt` 체인 밖에서 돈다.** `he()` 가 `PSa` 를 기다리는 동안 `$t` 본문이 완료되면, `$t` 가 `LIc` 진입 시점에 스냅숏한 낡은 `le` 로 되돌린다(lost update). 이때 `ue` 와 appState 는 `he()` 결과가 남으므로 F4 의 불일치가 실제로 만들어진다.

**F7. 15분 실패 캐시는 sdk 서버에 적용되지 않는다.** "Skipping connection (recent failure cached…)" 스킵은 `stdio+pluginSource` 와 http/sse(needs-auth) 전용. Pupil main 이 본 그 메시지는 레거시 플러그인 서버 것이고, 파티 도구 미등록과는 별개 경로다.

**F8. `alwaysLoad` 는 정상 전달된다.** `createSdkMcpServer({alwaysLoad:true})` → 도구별 `_meta["anthropic/alwaysLoad"]` → CLI `rj()`(isDeferredTool)가 이를 보고 지연로딩에서 제외. 건강한 세션에서 파티 도구가 즉시 보이는 것과 일치. ToolSearch 지연로딩은 이번 소실의 원인이 아니다.

## 두 형태의 설명

**형태 1 = F2+F3 경합 (코드로 특정).**
1. CLI 부팅, reconcile(`hn`→`Vn`→`$t`→`LIc`) 시작. `LIc` 가 `i` 스냅숏(아직 비어 있음)을 뜨고 비-sdk 서버 연결(MIc)을 await.
2. 그 사이 initialize 처리 → `i["agentparty-app"]` 추가.
3. `$t` 적용: `delete i[*]` 후 스냅숏으로 복원 → **agentparty-app 이 레지스트리에서 소리 없이 삭제.**
4. 첫 턴 `he()`: `i` 에 없으니 연결 시도 자체가 없음. 상태에도 안 나오고 에러도 없다.

경합창 크기 = MIc 의 비-sdk 서버 연결 시간. Pupil 은 죽은 플러그인 MCP 서버 2개(포트 충돌·마커 없음)가 연결 타임아웃을 만들어 창이 유독 컸다 — 발생 시점·간헐성·플러그인 제거 후 완화가 전부 맞아떨어진다.

**형태 2 = F4~F6 계열 (후보 특정, 트리거 미확정).** 11:42 커넥터 단절·재연결이 동적 재조정을 돌렸고, F6 lost-update 또는 F5 응답 혼선으로 `le` 만 파티 도구를 잃으면 impl2 의 모순(상태 connected/16 + 모델 호출 불가 + ToolSearch 무결과)이 정확히 재현된다. 어느 인터리빙이 실제로 났는지는 CLI 내부 로그 없이는 못 박을 수 없다.

## 결론과 조치

- 근본 원인은 **CLI 2.1.191 의 동적 MCP 레지스트리 동시성 결함**(F2/F3/F5/F6)이다. 우리 코드로는 못 고친다.
- 우리가 넣은 감지+1회 자동복구(`restart(true)`)는 Query 를 새로 만들어 `i`/initialize 부터 다시 시작하므로 **네 결함 모두에서 유효한 회복 수단**이다. 유지한다.
  → 2026-08-12 구현·실앱 검증 완료 (`fix/closed-member-tabs` `d53c777`, 11/11 통과). 상세는 FEEDBACK #30.
- 내장 CLI 는 2.1.191(6/24), 전역 CLI 는 2.1.226 — 35릴리스 차. **SDK 0.3.228 로 업그레이드**하면 더 새 CLI 가 내장될 수 있다(semver `^0.3.186` 범위 안). 업그레이드 + 수동 e2e 재검증이 다음 후보 작업.
- 업스트림 보고 여부는 사용자 결정 사항(공개 저장소 이슈). 보고 시 이 문서의 F2/F5/F6 인용이면 충분하다.
