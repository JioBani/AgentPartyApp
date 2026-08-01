# AgentParty 피드백

> 실사용/QA 중 발견한 이슈와 개선 제안을 기록하는 문서. 새 항목은 위에 추가.

- **빌드/버전**: `0.1.0` (패키징: `AgentParty Setup 0.1.0.exe` / `AgentParty 0.1.0.exe`)
- **환경**: Windows 11 + WSL2 (Ubuntu-20.04, Ubuntu-22.04), node 설치됨
- **작성자**: (이름)

---

## 이슈 목록

### #10 Cursor CLI: 턴을 정지하면 그 메시지가 모델 대화에서 통째로 사라짐 ✅ FIXED

- **상태**: FIXED
- **심각도**: 높음 — 사용자는 보냈다고 믿는데 모델은 들은 적이 없음(무성 데이터 손실)
- **증상**: Cursor 멤버에게 질문 → Stop → 다시 질문하면 모델이 "이 대화에는 이전 맥락이 거의 없어요"라며 정지된 질문을 전혀 모름. 실사용 트랜스크립트에서 `유녀전기`(정지) → `카구야`(정지) → "뭐 물어봤었지?" 에 대해 모델이 두 질문 모두 모른다고 답함.
- **근본 원인**: `cursor-agent`는 **턴이 완료될 때만** 그 턴을 채팅에 기록한다. AgentParty의 Stop은 프로세스를 SIGTERM으로 죽이므로 그 유저 메시지와 부분 답변은 채팅에 저장되지 않고, 다음 턴의 `--resume`는 사용자가 그 말을 한 적 없는 히스토리를 넘겨받는다. 앱 트랜스크립트에는 그대로 남아 있어서 손실이 보이지 않았다. (Claude/Codex는 인터럽트해도 하네스가 히스토리를 보존하므로 Cursor 전용 문제.)
- **수정**: `src/core/cursorAdapter.ts` — 커밋되지 않은 턴(정지/실패/stdio 사망)을 `uncommittedTurns`에 모아 다음 프롬프트에 `<unsaved_history>` 블록으로 재생하고, 턴이 실제로 커밋될 때만 비운다. 부분 답변도 함께 재생한다. 재생 예산(8턴) 초과 시 조용히 버리지 않고 경고 진단을 띄운다. Stop 상태 줄에도 "Cursor가 저장하지 않아 다음 메시지에 함께 보낸다"고 표시.
- **함께 고친 것**:
  - 파티 primer가 `turnCount === 0`에만 실려서 **첫 턴을 정지하면 멤버가 primer를 영구히 못 받던 문제** → 실제로 커밋된 턴 기준(`primerDelivered`)으로 변경.
  - `src/main/sessionManager.ts` — 앱 쪽 턴이 `turn_complete`/`error`로만 닫혀서 Cursor의 `interrupted`로는 `turnActive`가 영원히 열려 있었다(→ Cursor 멤버는 stall 워치독이 영영 못 잡고, 사용량 원장의 턴 활동시간이 부풀려짐). `interrupted`를 턴 종료로 처리.
- **검증**: `npm run test:cursor`(정지 턴/부분 답변/연속 정지 누적/primer 재전송/커밋 후 backlog 해제 회귀 추가), `npm run typecheck`, `npm run test:stall-status`, `npm run test:interrupt-recovery`, 실 `cursor-agent` 어댑터 검증(정지된 질문을 모델이 기억: UNKNOWN → BANANA), **실제 앱 전체 프로세스 E2E**로 위 유녀전기/카구야 시나리오 재현 → 모델이 두 질문 모두 나열.

---

### #9 Codex 하네스에서 agent-party-app MCP 도구가 노출되지 않음 ✅ FIXED

- **FIXED 요약**: Codex 세션 시작 시 `mcp_servers.agentparty-app` stdio MCP 서버를 인라인 config로 주입하고, 해당 서버가 로컬 자동화 HTTP API를 통해 같은 AppController/PartyApplicationService 경로를 호출하도록 구현. 사용자 `~/.codex/config.toml`은 수정하지 않음.
- **검증**: `npm run test:party-bridge`, `npm run test:codex-party-tools`, `npm run test:e2e:live-codex-party-tools`, `npm run typecheck`

- **상태**: FIXED
- **심각도**: 높음 — Codex 멤버가 파티/앱 자동화(agent-party-app MCP) 도구를 전혀 쓰지 못함 → Claude 멤버와 기능 비대칭
- **증상**: Claude 하네스 멤버에게는 `agent-party-app` MCP 서버의 도구가 정상 노출되는데, **Codex 하네스 멤버에게는 같은 도구가 도구 목록에 나타나지 않음**. Codex 멤버가 파티 조작/앱 제어 도구를 호출할 수 없음.
- **기대 결과**: Codex 하네스에서도 `agent-party-app` MCP 도구가 동일하게 노출되어, 하네스 종류와 무관하게 같은 파티/앱 자동화 도구를 쓸 수 있어야 함
- **추정 원인 후보** (미확정):
  - MCP 서버 주입/등록 경로가 Claude 어댑터에만 배선되어 있고 Codex 어댑터에는 누락 (하네스별 MCP 구성 비대칭)
  - Codex는 MCP 서버 구성 형식/전달 방식이 달라(예: `codex` config의 `mcp_servers` 테이블) 앱이 넘긴 서버 정의가 반영되지 않음
- **확인 필요**: Claude vs Codex 어댑터의 MCP 서버 구성 코드 경로 비교(`src/core/claudeAdapter.ts` / `src/core/codexAdapter.ts`), Codex 실행 시 실제 전달되는 MCP 설정 로그
- **연관**: AGENTS.md의 "모든 사용자 기능은 로컬 자동화 HTTP API로 노출" 원칙 — MCP 도구 비대칭은 하네스 간 QA/자동화 커버리지 불일치를 만듦

---

### #8 한 프로젝트에 대해 창 여러 개(멀티 인스턴스 또는 워크벤치 창 분리) 지원 요청 ✅ (a) 구현됨

- **상태**: (a) 멀티 인스턴스 = **구현됨** (멀티프로세스 재설계). (b) 워크벤치 창 분리(detach)는 별개 후속 항목으로 유지.
- **구현 내용 (4단계)**: ① 파티 스토리지 분리(`parties.json` 인덱스 + `parties/<id>/party.json`)로 같은 워크스페이스의 다른 파티끼리 쓰기 격리 + `currentPartyId` 프로세스별 런타임화 → ② 전역 `automation.json` 제거하고 **워크스페이스별 발견**(`.agent_party_app/instances/<pid>.json`, WSL은 `\\wsl$` UNC) → ③ **단일 인스턴스 락 제거** + 포트 ephemeral화 → ④ 설정 원자적 쓰기. 이제 같은 cwd라도 프로세스 N개가 서로 간섭 없이 뜬다(같은 파티 동시 편집만 last-writer-wins, 별개 문제). 검증: `e2e-discovery`(다른 cwd 비간섭), `e2e-party-store`(분리+마이그레이션+재시작 복원), 같은 cwd 2프로세스 수동 검증(각자 ephemeral 포트로 발견·도달).
- ~~**상태**: OPEN (기능 요청)~~
- **심각도**: 중간 — 멀티 모니터/병렬 작업 사용성
- **요청 내용**: 하나의 프로젝트(작업공간)에 대해
  - (a) **여러 AgentParty 인스턴스**를 동시에 켜거나,
  - (b) **하나의 프로세스 안에서 워크벤치 창을 분리(detach)** 해 별도 창으로 보고 싶음
- **동기**: 여러 파티/멤버를 동시에 넓게 펼쳐 보거나, 모니터별로 창을 나눠 병렬로 작업하고 싶음
- **현재 동작/제약**: 현재는 **단일 인스턴스 락**(`app.requestSingleInstanceLock`)으로 한 프로세스가 해당 작업공간의 모든 창을 소유함. 같은 작업공간에 라이벌 프로세스가 뜨는 걸 막는 구조라, (a)는 기본적으로 차단됨. (`src/main/main.ts` 41~51행, `handleSecondInstance`)
- **고려 사항 / 방향 제안**:
  - (b) 방식이 데이터 정합성 측면에서 안전 — 한 프로세스/한 엔진이 작업공간 스토어를 소유하면서 창만 여러 개(detachable 워크벤치)로 여는 방식. 기존 다중 창 구조(`windowRegistry`) 확장.
  - (a) 방식(멀티 인스턴스)은 같은 작업공간 스토리지에 엔진이 2개 붙어 상태/파일 충돌 위험 → 허용하려면 스토어 동시성 설계 필요.
- **연관**: [#5]/[#7] 대화 상태 격리 이슈와 함께 고려 시, "작업공간 스토어 단일 소유 + 창 분리" 원칙이 더 명확해짐

---

### #7 멤버 삭제 후 재생성해도 이전 메시지가 남아 있는 것처럼 보임 ✅ 수정됨

- **상태**: FIXED — 렌더러의 복원 트랜스크립트 캐시(`restoredByMember`)가 멤버 **이름**만으로 키잉되어, 삭제 후 같은 이름으로 재생성하면 이전 in-memory 블록을 그대로 재사용함(디스크는 삭제 시 정상 제거됨). 캐시 키를 `(partyId, name, createdAt)` 로 변경(`memberKey`) → 재생성 멤버는 새 `createdAt` 로 새 키가 되어 빈 상태로 시작. 실앱 캡처로 검증(재생성 후 패널 빈 상태). [[#5]] 와 동일 근본 원인.
- ~~**상태**: OPEN~~
- **심각도**: 높음 — 삭제/재생성으로도 상태가 초기화되지 않음
- **재현 절차**:
  1. 대화 이력이 있는 멤버를 삭제
  2. 같은 자리(또는 같은 이름/역할)로 멤버를 다시 생성
- **실제 결과**: 새로 만든 멤버인데도 **이전 멤버의 메시지가 그대로 남아 보임**
- **기대 결과**: 재생성된 멤버는 빈 상태(대화 이력 없음)로 시작해야 함
- **추정 원인 후보** (미확정): 멤버 식별 키가 재생성 시 재사용되어 이전 메시지 스토어에 다시 바인딩됨, 또는 삭제 시 해당 멤버의 메시지/세션이 실제로 클리어되지 않음(캐시/스토어 잔존)
- **연관**: [#5](파티 전환 시 대화 잔존)와 같은 "대화 상태 격리/클리어" 계열일 가능성 — 함께 조사 권장

---

### #6 서브에이전트 명령 메시지가 접기 없이 전체 표시되어 채팅창을 거의 차지함 🟡 진행중

- **상태**: OPEN
- **심각도**: 중간 — 기능은 되나 가독성/사용성 저하
- **재현 절차**:
  1. 서브에이전트를 실행하는 멤버 대화에서
  2. 서브에이전트에 넘기는 명령(프롬프트) 메시지가 매우 긴 경우
- **실제 결과**: 긴 명령 메시지가 **접기(collapse) 없이 전체가 그대로 표시**되어, 서브에이전트 채팅창의 대부분을 차지함 (스크롤 부담, 실제 대화/결과가 밀림)
- **기대 결과**: 긴 명령 메시지는 기본적으로 접혀서 요약/일부만 보이고, 클릭 시 펼쳐볼 수 있어야 함 (더보기/접기 토글)
- **개선 방향 제안**: 일정 길이(줄 수/문자 수) 초과 시 자동 접기 + "더보기" 토글, 서브에이전트 카드/드릴인 상세 양쪽에 적용

---

### #5 파티 간 이동 시 멤버 대화 내용이 다른 파티에 그대로 남음 ✅ 수정됨

- **상태**: FIXED — 모든 파티가 `main` 을 가지는 등 멤버 **이름이 파티 간 유일하지 않은데**, 렌더러 복원 캐시(`restoredByMember`)와 복원 이펙트의 중복 방지 가드가 이름만으로 키잉됨 → 파티 B 로 전환해도 같은 이름 멤버의 캐시(파티 A 것)를 재사용해 A 의 대화가 노출됨. 캐시 키를 `(partyId, name, createdAt)` 로 변경(`memberKey`) → 파티별로 격리 fetch. 디스크 저장소는 원래부터 `(workspace, party, member)` 로 분리돼 정본은 정상이었음. 실앱 캡처로 양방향 검증(alpha↔beta 동명 `dup` 이 각자 대화만 표시). [[#7]] 와 동일 근본 원인.
- ~~**상태**: OPEN~~
- **심각도**: 높음 — 파티(작업공간/세션) 간 대화가 격리되지 않음
- **재현 절차**:
  1. 서로 다른 파티 A, B가 있는 상태에서
  2. 파티 A의 멤버와 대화 후
  3. 파티 B로 이동했다가 다시 A(또는 B)로 왔다갔다 함
- **실제 결과**: 다른 파티인데도 이전 파티 멤버의 대화 내용이 그대로 남아 있음 (대화 이력이 파티 경계를 넘어 섞임/유지됨)
- **기대 결과**: 각 파티는 자신의 멤버 대화만 보여야 하고, 파티를 전환하면 해당 파티의 이력만 표시되어야 함
- **추정 원인 후보** (미확정): 파티/작업공간 전환 시 대화 상태(멤버 메시지 스토어)가 파티 키 기준으로 분리되지 않고 공유됨, 또는 전환 시 이전 상태가 클리어/재바인딩되지 않음

---

### #4 멤버 생성 시 모델 변경하면 오류 + 턴 입력해도 메시지가 계속 queue됨 ✅ 수정됨

- **상태**: FIXED — **큐 데드락**이 근본 원인. 서로 다른 백엔드(구독↔OpenRouter)로 모델을 바꾸면 `ClaudeAdapter.setModel` 이 `restart()` 를 호출하는데, `restart()` 가 `sessionId`/큐 등은 초기화하면서 **`turnState`/`currentStatus` 는 리셋하지 않음**. 진행 중이던 요청은 재시작으로 `"Query closed before response received"` 로 거부되고 이 에러는 (의도적으로) 조용히 무시됨 → `turnState` 가 `"responding"`/`"submitted"` 로 **영구 고착** → `isTurnActive()` 가 계속 true → 이후 모든 턴이 dispatch 되지 못하고 큐에만 쌓임. `restart()` 에서 `turnState=undefined; currentStatus="idle"` 로 초기화하도록 수정(Codex 어댑터 `restart()` 는 이미 올바르게 초기화하고 있었음 — 동작 정합화). 실모델 e2e 로 검증: sonnet 응답 중 GLM-5.2(OpenRouter)로 교차 변경 → 재시작 → 후속 턴이 정상 dispatch 되어 응답 수신, `queuedTurnCount=0`.
- ~~**상태**: OPEN~~
- **심각도**: 높음 — 멤버 생성/대화 시작이 막힘
- **재현 절차**:
  1. 파티 멤버 생성 과정에서 모델을 바꿈(변경)
  2. 이후 턴(메시지)을 입력
- **실제 결과**:
  - 모델 변경 시점에 오류 발생
  - 턴을 입력해도 메시지가 처리되지 않고 계속 **queue 상태로만 쌓임** (응답/실행으로 넘어가지 않음)
- **기대 결과**: 모델 변경이 오류 없이 반영되고, 입력한 턴이 정상적으로 실행되어 응답이 와야 함
- **추정 원인 후보** (미확정): 멤버 생성 도중 모델 스위칭이 세션/엔진 초기화와 경쟁(race)하거나, 변경 후 세션이 비정상 상태가 되어 큐만 쌓이고 소비되지 않음. 오류 발생 시 큐가 flush/실패 처리되지 않고 무한 대기.
- **추가 확인 필요**: 오류 메시지 원문/로그, 어떤 모델→모델 변경에서 재현되는지

---

### #1 `agent-party` (WSL) 콜드 스타트 시 "작업공간 없음"으로 열림 ✅ 수정됨

- **상태**: FIXED — `--workspace=<uri>` argv 콜드 스타트 경로가 재정렬/깨진 인자를 복구하도록 수정 (`627f7b6 fix(window): recover reordered --workspace path`, `caffced fix(window): never fabricate a workspace from a broken --workspace argv`). 콜드 스타트에서 WSL URI 가 작업공간으로 정상 오픈됨.
- ~~**상태**: OPEN (원인 조사 중)~~
- **심각도**: 높음 — WSL CLI의 핵심 동작이 안 됨
- **재현 절차**:
  1. AgentParty 앱이 **꺼진 상태**에서
  2. WSL(Ubuntu-20.04) 셸에서 프로젝트 디렉터리에 들어가 `agent-party` 실행
- **실제 결과**:
  ```
  spdlqj8876@DESKTOP-CVG31RF:~$ agent-party
  Launching AgentParty for wsl+Ubuntu-20.04:/home/spdlqj8876…
  ```
  → 앱은 뜨지만 화면에 **"작업공간 없음"** 으로 표시됨 (해당 WSL 경로가 작업공간으로 안 열림)
- **기대 결과**: `wsl+Ubuntu-20.04:/home/spdlqj8876` 가 작업공간으로 열려야 함
- **중요한 단서**:
  - 앱을 켠 뒤 **앱 내부의 "작업공간 열기"로 같은 WSL 경로를 열면 정상 동작함.**
  - 즉 WSL 작업공간 여는 로직 자체는 정상이고, **`--workspace=<uri>` argv 콜드 스타트(초기 실행) 경로만** URI를 작업공간으로 못 푸는 것으로 보임.
- **추정 원인 후보** (미확정):
  - `--workspace=wsl+Ubuntu-20.04:/home/...` URI 파싱 시 distro 이름의 `-`/`.`(`Ubuntu-20.04`)과 `:` 구분자 처리
  - 콜드 스타트(초기 창 생성)와 running-app(`/api/windows`) 경로가 WorkspaceLocation을 다르게 처리
- **관련 코드**: `src/main/main.ts` `workspaceFromArgv` / `launchWorkspace` / `createWindow`, 공용 `workspaceArgFromArgv`

---

### #2 WSL `agent-party` 셰임 CRLF 줄바꿈으로 실행 불가 ✅ 수정됨

- **상태**: FIXED (이번 세션)
- **증상**: 패키징된 `resources/bin/agent-party` 가 CRLF라 WSL에서 `/usr/bin/env: 'sh\r': No such file or directory` 로 실행 불가
- **원인**: 원본 `scripts/agent-party` 가 CRLF, LF 강제하는 `.gitattributes` 부재 → Windows 체크아웃마다 CRLF 복원
- **수정**: `scripts/agent-party` → LF 변환, `.gitattributes` 추가(`scripts/agent-party text eol=lf`, `*.sh`)

---

### #3 개발자 모드/관리자 권한 없이 Windows 패키징 실패 ✅ 해결됨

- **상태**: RESOLVED (이번 세션)
- **증상**: `npm run dist:win` 시 electron-builder가 `winCodeSign` 캐시의 macOS 심볼릭 링크(`libcrypto.dylib`, `libssl.dylib`) 추출에서 권한 부족으로 실패 → 인스톨러 `.exe` 미생성 (`win-unpacked`만 나옴)
- **해결**: app-builder는 `<cache>\winCodeSign\winCodeSign-2.6.0\` 폴더 존재 여부만 확인(체크섬 없음)하므로, 심볼릭 링크 2개를 빈 파일로 대체해 캐시를 미리 채워두면 추출 단계를 건너뜀 → 개발자 모드 없이 패키징 성공
- **후속(선택)**: 이 우회를 `scripts/`에 자동화하거나 CI에서 캐시 프리로드 고려

---

## 개선 제안

- (예) 콜드 스타트에서 작업공간 파싱 실패 시 "작업공간 없음"으로 조용히 넘어가지 말고, 실패한 URI를 로그/토스트로 노출 (AGENTS.md의 "silent fallback 금지" 원칙)
- (추가 작성)

---

## 기타 / 메모

- (자유 기록)





## 추가 피드백 (미분류)

> 2026-07-28 정리: 이 덩어리에 버그와 기능 요청이 섞여 있어 분류했다.
> **기능 요청은 [아이디어 백로그](아이디어/아이디어.md)로 이관**했고, 이미 구현된 항목은 아래에
> 표시했다. 남은 것은 아직 조사되지 않은 버그다 (원문 그대로 보존).

### 아직 조사 안 된 버그

- claude code - gpt 백앤드가 동작하지 않음
- codex 권한이 리셋되는문제
- 다시 키거나 메뉴를 돌아다니면, 멤버의 대화가 닫혀있는 문제
  - 멤버가 켜져있어도 켜져있는 것으로 인식이 안됨
  - 닫았다 열여도 인식 안됨
  - compacting 을 해도 무반음
  - 채팅을 하면 대화 내용이 모두 날라가면서 spawn 되고 채팅이 시작됨
  - 이때 대화는 남아있음
  - 그러면서 열려있는것으로 다시 인식됨

### 아이디어 백로그로 이관됨

- 기계적으로 턴을 깨우는 기능 (MCP 도구 + 사용자 컨트롤) → [B-1](아이디어/아이디어.md)
- 한도가 돌아온 이후 턴을 다시 깨우는 기능 → [B-2](아이디어/아이디어.md)

### 이미 구현됨 (2026-07-28 코드·문서 확인)

- ~~특정 권한으로 초기 세팅해서 멤버 생성~~ — 멤버 생성 마법사에 **초기 권한 단계**가 있고,
  에이전트의 `member-create` 도구도 `permissionMode`/`codexPolicy`를 명시적으로 받는다
  ([PARTY_COMMUNICATION.md](PARTY_COMMUNICATION.md), [USER_FEATURES.md](USER_FEATURES.md) §5.6)
- ~~런타임 기본값에 권한 설정~~ — 하네스별 기본 프로필에 Claude 권한 모드 / Codex 안전 정책이
  포함된다 ([USER_FEATURES.md](USER_FEATURES.md) §19.2)
- ~~멤버가 다른 멤버의 권한을 수정~~ — `member-permission` 도구
  ([partyBridge.ts](../src/core/partyBridge.ts))
