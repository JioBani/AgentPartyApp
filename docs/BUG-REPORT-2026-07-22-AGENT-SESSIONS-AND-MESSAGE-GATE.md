# AgentParty 장애 보고서 — 멤버 hang, 트랜스크립트 혼선, Message Gate 인증 503

- 작성일: 2026-07-22 (KST)
- 조사 대상 워크스페이스: `/home/spdlqj8876/sellmate-dockerize`
- 대상 파티: `SEL-6877`, `SEL-6874`
- 조사 방식: 실행 중인 실제 AgentParty 프로세스/API, Windows·WSL 프로세스, 앱 로그, 저장된 파티/트랜스크립트, 소스 코드 대조
- 코드 수정 여부: 없음. 이 문서는 진단 결과와 수정 요구사항만 기록한다.

## 1. 요약

| 사건 | 판정 | 핵심 원인 | 현재 상태 |
|---|---|---|---|
| SEL-6877 `impl`·`perf` 무반응/hang | 백엔드 수명주기 결함 | 해당 WSL 원격 엔진 프로세스가 종료된 뒤 Windows 클라이언트가 연결 종료와 RPC 실패를 처리하지 못함 | 해당 인스턴스는 API 일부가 무기한 대기할 수 있음 |
| SEL-6874 `req` 화면에 `main` 질문 카드 표시 | 렌더러 트랜스크립트 결함 | 실제 세션은 분리돼 있으나 승인 이벤트 중복 저장과 세션 재결합 시 트랜스크립트 복원 레이스가 존재 | 현재 req 세션과 화면은 정상 |
| Message Gate `Reviewer call failed (503)` | 인증 브리지 가용성 판정 결함 | Codex 인증 풀이 일시적으로 사용 불가했고, 앱은 `/models`만으로 브리지를 정상 판정함. 또한 8317 포트를 과거 QA 브리지가 점유 중 | 동일 Terra 최소 호출은 조사 시점에 200으로 회복 |
| SEL-6874 `req`의 `Not logged in · Please run /login` | WSL Claude 인증 소실 + 인증 상태 판정 범위 결함 | WSL의 Claude 자격증명에서 access/refresh token이 비워졌지만 앱은 Windows 구독 브리지 상태만 보고 Claude를 사용 가능으로 표시하고, 멤버 시작 전 WSL 인증을 점검하지 않음 | WSL 재로그인 후 기존 req 프로세스에서 실제 응답과 도구 실행 재개 확인 |
| SEL-6874 `impl`의 `CLIProxyAPI is not reachable` | WSL 교차 모델 라우팅 결함 | WSL Claude Code 런타임에서 GPT-5.6 Sol을 선택하면 WSL router가 Windows loopback의 8317을 직접 호출함. Message Gate와 달리 desktop reverse-RPC 위임이 없음 | inference gateway 43217은 정상이나 Windows CLIProxyAPI 연결은 구조적으로 불가 |

다섯 사건은 하나의 WSL 장애가 아니다. SEL-6877은 WSL에서 실행되는 **해당 AgentParty 엔진 프로세스의 종료**와 클라이언트의 수명주기 처리 부재이고, SEL-6874 화면 혼선은 렌더러 상태/저장 문제다. Message Gate 503은 Windows의 로컬 구독 브리지 인증 가용성 문제인 반면, req의 로그인 오류는 WSL 사용자 계정의 네이티브 Claude Code 인증이 실제로 소실된 별도 사건이다. impl의 연결 오류는 WSL에서 Windows loopback 서비스를 직접 호출하도록 남은 교차 라우팅 구현 누락이다.

---

## 2. 사건 A — SEL-6877 `impl`·`perf` hang

### 증상

- `impl`: 메시지를 출력하다가 작업 중 멈춤.
- `perf`: 작업 중 멈춘 뒤 사용자가 추가 메시지를 입력했으나 hang.
- Electron의 일부 로컬 API는 응답하지만 `/api/health` 등 원격 엔진 RPC가 필요한 요청은 끝나지 않음.

### 확인된 사실

- SEL-6877을 소유한 Windows AgentParty 프로세스와 자동화 API 포트는 살아 있었다.
- 해당 프로세스가 생성했던 WSL AgentParty 엔진 프로세스는 존재하지 않았다.
- 같은 WSL 배포판의 다른 AgentParty 엔진은 정상 동작했다.
- 따라서 WSL 배포판 전체가 멈춘 것은 아니다.
- `RemoteEngineClient`의 호출 대기열에는 응답 제한시간과 transport 종료 시 확실한 reject 경로가 부족하다. 원격 엔진이 사라지면 desktop 요청이 무기한 pending으로 남을 수 있다.

### 디스크 부하 가능성

- `perf`가 14:14:57경 실행한 광범위한 `rg`가 `backend`, `frontend`, `scripts`, `.`을 중복 탐색하고 minified 결과까지 읽었다.
- 관측된 원본 출력 규모는 약 4,419,185 tokens / 3,178 lines였으며 약 10초 동안 대량 파일 읽기와 결과 직렬화가 발생했을 가능성이 높다.
- 트랜스크립트 저장량은 약 22.4 MB/3.5분 수준으로 추정되어, 과거의 “매번 전체 트랜스크립트 쓰기”만으로 디스크 쓰기가 폭주했다고 보기는 어렵다.
- WSL 커널/OOM/ext4 오류 증거는 발견되지 않았다.

### 판정

광범위 검색이 순간적인 디스크 읽기·메모리·파이프 부하를 유발해 엔진 종료의 촉발 요인이 되었을 가능성은 있다. 그러나 엔진 종료의 직접 원인으로 확정할 로그는 없다. 사용자에게 hang으로 보이게 만든 확정 원인은 **원격 엔진 종료를 실패 상태로 전환하지 못한 클라이언트 수명주기 결함**이다.

---

## 3. 사건 B — SEL-6874 `req` 화면의 `main` 대화 혼선

### 증상

- `req` 탭 상단과 상태는 req였지만, 본문에는 main이 이전에 생성한 “이번 실행의 진입 단계는 어디부터 시작할까요?” 질문 카드가 두 장 표시됐다.
- req 모델은 기존 작업 문맥을 유지하고 정상적으로 UR 작업을 이어갔다.

### 세션 분리 증거

조사 시점의 앱 세션과 Claude 대화 ID는 서로 달랐다.

| 멤버 | 앱 sessionId | harnessSessionId |
|---|---|---|
| main | `resume-1784699318235` | `d7be492e-77fe-4e5d-81f1-aa20e80bf09d` |
| req | `resume-1784699310381` | `1a4ec71a-11d8-475a-af68-59a1850c9856` |
| explore | `resume-1784615898645` | `aff27f43-9c12-4d42-aa62-5b05606c2795` |

- req의 저장 트랜스크립트에는 문제의 `AskUserQuestion` 승인 블록이 없었다.
- 문제의 질문은 main 트랜스크립트에만 있었다.
- 따라서 req의 모델 문맥이나 Claude 대화가 main과 합쳐진 것은 아니다.

### 결함 1 — 승인 요청 중복 append

main 트랜스크립트에는 동일한 도구 사용 ID가 두 번 저장되어 있었다.

- `requestId`: `toolu_01AEjzYNwWZWhQAZigoj14C4`
- 연속된 approval 블록 두 개의 `id`, `requestId`, 질문 입력이 모두 동일

`src/renderer/app/transcriptEvents.ts`의 `approval_request` 처리기는 `requestId`로 기존 블록을 갱신하지 않고 항상 append한다. upstream이나 transport가 동일 이벤트를 다시 전달하면 같은 질문 카드가 두 장 생긴다.

### 결함 2 — 새 앱 세션 ID 결합 시 복원 레이스

14:48:30 req에 사용자 메시지를 보낸 직후 새 앱 sessionId가 생성됐다. 첫 세션 이벤트는 파티 상태가 새 ID를 req에 연결하기 전에 렌더러에 도착할 수 있다.

현재 로직은 다음 순서에 취약하다.

1. 새 sessionId의 이벤트가 먼저 도착한다.
2. `membersRef`에는 아직 이전 sessionId가 있으므로 어느 멤버의 저장 기록을 seed해야 하는지 찾지 못한다.
3. 새 세션 로그가 빈 배열에서 시작한다.
4. 파티 상태가 새 sessionId로 갱신된다.
5. 최초 복원은 이미 완료됐으므로 retro-seed effect가 다시 실행되지 않는다.
6. 디바운스 저장이 기존 기록과 공통 prefix를 찾지 못하고 전체 저장으로 전환한다.

실제 로그에서 14:48:31 req 저장은 `afterId`가 없는 2블록 전체 저장이었다. 이 동작은 모델의 harnessSessionId와 무관하게 UI용 저장 트랜스크립트를 새 기록으로 덮어쓸 수 있다.

### 판정

- 모델 메모리 오염: 아님.
- WSL 장애: 아님.
- 단순 CSS 문제: 아님.
- 확정 범주: 렌더러의 승인 블록 중복 처리 + 앱 sessionId 재결합/트랜스크립트 복원 레이스.
- 캡처 당시 main 블록이 req DOM에 남은 정확한 단일 렌더 경로는 재현되지 않았다. 다만 백엔드/저장 req 데이터에 질문이 없으므로 혼선은 렌더러 경계 안에서 발생했다.

---

## 4. 사건 C — Message Gate Codex 인증 503

### 오류

```text
Reviewer call failed (503):
{"type":"error","error":{"type":"api_error","message":"auth_unavailable: no auth available (providers=codex, model=gpt-5.6-terra)"}}
```

### 호출 경로

1. Message Gate 기본 reviewer: `GPT-5.6 Terra`, effort `low`.
2. `messageGateReviewer.ts`가 임베디드 라우터 `/v1/messages`를 호출한다.
3. 라우터가 catalog alias를 `gpt-5.6-terra` Codex 구독 대상으로 변환한다.
4. Windows loopback의 CLIProxyAPI `127.0.0.1:8317`로 전달한다.
5. CLIProxyAPI가 해당 시점에 사용할 수 있는 Codex 인증 후보를 찾지 못해 503을 반환했다.

일반 Codex 멤버는 Codex app-server가 자체 로그인으로 직접 실행될 수 있지만, Message Gate의 headless reviewer는 위 CLIProxyAPI 경로를 사용한다. 따라서 Codex 멤버가 정상이어도 게이트 reviewer만 인증 실패할 수 있다.

### 확인된 사실

- `/api/auth/subscriptions`와 CLIProxyAPI `/v1/models`는 Codex를 `available: true`로 보고했고 `gpt-5.6-terra`를 목록에 노출했다.
- Codex OAuth 파일은 존재하고 `disabled: false`, 만료 시각도 조사 시점 이후였다.
- 오류 조사 중 동일 브리지에 최소 Terra 요청을 다시 보냈을 때 `200 OK`와 `OK` 응답을 받았다.
- 따라서 영구적인 “로그인 파일 없음”이나 “Terra 모델 미지원” 오류는 아니다.
- 8317을 점유한 실제 프로세스는 정식 AgentParty userData가 아니라 과거 QA 임시 경로 `.../scratchpad/qa-userdata2/subscription-proxy/...`에서 시작된 CLIProxyAPI였다.
- 이 프로세스는 2026-07-21 09:22부터 살아 있었고, 두 AgentParty 프로세스 모두 이를 이미 실행 중인 정상 브리지로 받아들였다. API 상태의 `service.managed`도 `false`였다.
- 브리지 설정의 `logging-to-file`이 꺼져 있어, 최초 503 시 인증 후보가 제외된 직접 사유(갱신 중, 일시적 upstream 오류, rate-limit/cooldown 등)는 사후 확정할 수 없다.

### 근본 문제

1. **준비 상태 오판**: 앱은 `/v1/models`에 모델명이 보이는지만 검사한다. 모델 목록 노출은 실제 provider credential로 한 번의 요청이 가능한지 보장하지 않는다.
2. **서비스 소유권/포트 충돌**: 고정 포트 8317에 응답하는 임의의 CLIProxyAPI를 정상 서비스로 채택한다. QA 임시 프로세스인지, 현재 앱이 관리하는 브리지인지 검증하지 않는다.
3. **진단 부족**: 브리지 요청 로그가 꺼져 있어 `auth_unavailable`의 credential 제외 사유를 남기지 않는다.
4. **게이트 fail-open 영향**: reviewer 오류가 나면 `sendGatedMessage`는 실패 배지를 남기지만 메시지를 **검토 없이 전달한다**. 즉 503 동안 Message Gate의 규칙 강제력이 사라진다.

CLIProxyAPI의 공개 이슈에서도 burst 요청 시 동일한 `503 auth_unavailable`이 인증 풀 고갈 형태로 간헐 발생할 수 있음이 보고되어 있다. 이번 조사에서 현재 호출이 회복된 것도 일시적인 인증 후보 제외/회복 패턴과 일치한다. 단, 최초 후보 제외의 세부 원인은 브리지 로그 부재로 미확정이다.

---

## 5. 사건 D — SEL-6874 `req`의 Claude 로그인 오류

### 오류와 재현

```text
Not logged in · Please run /login
```

- req 트랜스크립트에서 서로 다른 사용자 요청 3건이 모두 같은 오류로 끝났다.
- req 멤버를 새 프로세스로 다시 시작한 뒤에도 오류가 재현됐다.
- 기존 트랜스크립트와 Claude harness session ID `1a4ec71a-11d8-475a-af68-59a1850c9856`은 보존돼 있다. 메모리나 세션 내용이 유실된 현상은 아니다.

### 직접 확인한 인증 상태

SEL-6874가 실제로 사용하는 WSL 사용자와 Claude CLI에서 다음을 확인했다.

```text
$ claude auth status
{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}
```

`/home/spdlqj8876/.claude/.credentials.json`은 소유자 `spdlqj8876`, 권한 `600`으로 존재하고 JSON 구조도 유효하지만 다음 상태다.

- `accessToken`: 없음
- `refreshToken`: 없음
- `expiresAt`: `0` (`1970-01-01T00:00:00.000Z`)
- `subscriptionType`: `max`
- 마지막 수정: 2026-07-22 15:23:32 KST

즉 파일 접근 실패나 프론트 표시 문제가 아니라, 네이티브 WSL Claude Code가 참조하는 OAuth 토큰이 실제로 비워진 상태다. 새 SEL-6874 엔진은 15:26:54, req 멤버는 15:27:05에 시작했으므로 이미 로그아웃된 자격증명을 읽었다.

### Message Gate 503과의 차이

- req의 `opus[1m]` 호출: WSL 내부 Claude Code → WSL의 `~/.claude/.credentials.json`
- Message Gate의 `gpt-5.6-terra` reviewer: Windows desktop → `127.0.0.1:8317` CLIProxyAPI → Codex 인증 풀

따라서 두 오류 모두 인증 관련이지만 저장소와 실행 경로가 다르다. Windows 구독 브리지가 Claude 모델을 노출하더라도 WSL 네이티브 Claude가 로그인됐다는 뜻은 아니다.

### 근본 제품 결함

1. `getAuthState()`는 Claude 기본 상태를 무조건 `available`로 만들고, 이후 UI 상태도 로컬 CLIProxyAPI의 `/models` 결과로 판단한다.
2. 이 상태 판정은 현재 워크스페이스가 WSL인지, 네이티브 Claude harness가 실제로 로그인됐는지를 확인하지 않는다.
3. 멤버 시작/메시지 전송 전 `claude auth status`에 해당하는 런타임 preflight가 없어, 앱은 req를 정상 시작된 것처럼 보이고 사용자 요청을 받은 뒤 provider 오류를 트랜스크립트에 남긴다.
4. 자격증명 파일을 누가 비웠는지 감사 로그가 없다. AgentParty 로그에는 같은 시각 `/logout` 호출이 없다. 명시적 로그아웃과 토큰 갱신 실패 후 Claude Code의 무효화 중 어느 쪽인지는 현재 증거로 확정할 수 없다.

### 운영 복구

WSL 배포판 `Ubuntu-20.04`에서 `claude auth login` 또는 대화형 Claude Code의 `/login`으로 다시 인증한 뒤 `claude auth status`가 `loggedIn: true`인지 확인하고 req 멤버를 재시작한다. 기존 harness session ID가 남아 있으므로 정상 인증 뒤에는 기존 작업을 resume할 수 있어야 한다.

실제 복구에서는 15:37 KST에 `loggedIn: true`, `authMethod: claude.ai`, `subscriptionType: max`를 확인했다. 이미 실행 중이던 req 프로세스도 재시작 없이 다음 요청에서 assistant 응답과 `Read` 도구 실행을 재개했다. 따라서 재시작은 인증 적용에 필수 조건이 아니라, 로그인 후에도 기존 프로세스가 회복하지 않을 때의 보조 절차다.

---

## 6. 사건 E — SEL-6874 `impl`의 WSL 교차 모델 연결 실패

### 오류

```text
API Error: 500 CLIProxyAPI is not reachable at http://127.0.0.1:8317/v1: fetch failed.
Start the local proxy; no OpenRouter fallback was attempted.
This is a server-side issue, usually temporary — try again in a moment.
If it persists, check your inference gateway (127.0.0.1:43217).
```

### 실행 조합과 확인 결과

- 멤버: SEL-6874 `impl`
- runtime: `claude-code`
- 선택 모델: `GPT-5.6 Sol`
- WSL inference gateway: `127.0.0.1:43217`, Linux node PID `1090013`이 정상 리슨
- Windows CLIProxyAPI: `127.0.0.1:8317`, Windows PID `27296`이 정상 리슨
- Windows desktop의 `/api/auth/subscriptions`는 같은 시점에 8317에서 Codex/Claude 모델 목록을 정상 수신
- WSL 내부의 `curl http://127.0.0.1:8317/v1/models`는 `Connection refused`

따라서 43217 gateway가 죽었거나 8317 프로세스가 완전히 중단된 것이 아니다. WSL 안의 `127.0.0.1`과 Windows의 `127.0.0.1`이 서로 다른 네트워크 네임스페이스인데, WSL gateway가 Windows 전용 loopback endpoint를 직접 호출한 것이 실패 원인이다.

### 코드상 원인

`engineServerEntry.ts`는 WSL 엔진에서 Message Gate reviewer만 `HostChannel.call("reviewGate", ...)`로 desktop에 위임한다. 반면 일반 모델 추론을 담당하는 `EmbeddedHarnessRouter.forwardToCodexSubscription()`은 `subscriptionProxyConfig()`의 기본값 `http://127.0.0.1:8317/v1`에 WSL 프로세스에서 직접 `fetch`한다.

즉 다음 조합이 구조적으로 실패한다.

```text
WSL workspace
  → Claude Code harness
  → GPT/Codex subscription model 선택
  → WSL inference gateway :43217
  → WSL의 127.0.0.1:8317 직접 호출
  → Connection refused
```

반대로 Windows desktop의 8317은 현재 응답 중이므로 화면의 “잠시 후 다시 시도” 안내는 이 사건에서는 부정확하다. 재시도만으로 네트워크 경계가 바뀌지 않는다. 또한 8317을 과거 QA 임시 프로세스가 점유한 문제는 별도로 남아 있지만, 올바른 production 프록시가 8317을 점유하더라도 loopback-only인 이상 WSL의 직접 호출은 실패한다.

### 필요한 구조

Message Gate와 동일하게 WSL router의 구독 모델 discovery와 inference HTTP 요청을 desktop reverse-RPC로 위임해야 한다. URL을 Windows host IP로 바꾸거나 8317을 외부 인터페이스에 노출하는 방식은 자격증명을 더 넓은 네트워크에 노출하고 WSL 주소 변화에 의존하므로 근본 해결이 아니다.

---

## 7. 수정 요구사항

### P0 — hang 종료 보장

- `RemoteEngineClient`의 모든 RPC에 제한시간을 둔다.
- stdout 종료, child `exit`/`error`, JSON line reader 종료 시 모든 pending RPC를 즉시 reject한다.
- workspace 엔진 상태를 `disconnected`로 전환하고 UI/API에 복구 가능한 오류와 재시작 동작을 노출한다.
- `/api/health`가 원격 엔진 장애 때문에 무기한 pending되지 않게 한다.

### P0 — 트랜스크립트 무결성

- approval 블록을 `(sessionId, requestId)` 기준으로 upsert한다.
- sessionId가 변경될 때마다 member identity로 저장 기록을 seed한 뒤 새 이벤트를 적용한다.
- 복원/결합이 끝나기 전에는 해당 멤버의 전체 저장을 금지한다.
- transcript get/save에 `partyId` 또는 안정적인 member identity를 명시적으로 전달한다.
- `Transcript`와 질문 카드의 React identity를 `partyId + member + sessionId + requestId`로 격리한다.

### P0 — Message Gate의 인증 신뢰성

- `/models` 목록만으로 provider 준비 완료를 판정하지 않는다. CLIProxyAPI가 제공하는 인증 상태를 사용하거나, credential 상태를 검증하는 별도 health contract를 둔다.
- 앱이 관리하는 브리지에 PID/설정 경로/instance nonce를 기록하고, 고정 포트의 다른 프로세스를 발견하면 정상으로 오인하지 말고 충돌을 명시적으로 보고한다.
- QA 브리지는 임의 포트를 사용하고 테스트 종료 시 child 종료를 보장한다.
- `auth_unavailable` 발생 시 provider, model, credential 후보 수, 제외 사유와 재시도 가능 시각을 민감정보 없이 구조화 로그로 남긴다.
- reviewer 호출은 idempotent하므로 짧은 backoff 후 한 번만 재검증할 수 있다. 재시도 실패 시 현재처럼 오류를 노출하되, fail-open/closed 정책을 사용자 설정으로 명확히 제공한다.

### P0 — 워크스페이스별 네이티브 harness 인증 검증

- WSL Claude 멤버를 시작하거나 첫 메시지를 보내기 전에 해당 배포판/사용자의 `claude auth status`를 확인한다.
- Windows CLIProxyAPI 인증과 WSL 네이티브 Claude 인증을 서로 다른 상태로 모델링하고 UI/API에 함께 노출한다.
- 인증이 없으면 멤버를 `idle/working`처럼 보이게 두지 말고 `auth_required` 상태와 실제 로그인 위치 및 명령을 표시한다.
- 인증 상태 확인과 로그인 진입점을 동일한 `AppController` 경로로 구현하고, 로컬 자동화 HTTP API와 `src/shared/apiSpec.ts`, `docs/API.md`에도 같은 기능을 제공한다.
- 인증이 유효 상태에서 무효 상태로 바뀔 때 배포판, 사용자, harness, 시각, 감지 원인을 토큰 없이 구조화 로그로 남긴다.

### P0 — WSL 교차 모델 요청의 desktop 위임

- WSL `EmbeddedHarnessRouter`가 Windows loopback의 CLIProxyAPI나 desktop router를 직접 호출하지 않게 한다.
- 구독 모델 discovery와 실제 streaming inference를 `HostChannel` reverse-RPC로 desktop에 위임한다. 요청 취소, backpressure, 응답 헤더·상태, 스트림 오류도 보존한다.
- Message Gate와 일반 멤버 추론이 동일한 host transport와 동일한 인증/브리지 소유권 검증을 사용하게 한다.
- runtime·workspace 위치·model route 조합을 멤버 시작 전에 검증하여 지원하지 않는 경로이면 provider 호출 전 명시적인 `route_unavailable`을 표시한다.
- `127.0.0.1:43217` gateway 자체 상태와 그 gateway의 upstream 상태를 구분해 UI/API/로그에 표시하고, 구조적 loopback 경계 실패를 “usually temporary”로 안내하지 않는다.

### P1 — 부하 방어

- 광범위 검색 명령의 중복 루트와 minified/vendor 결과를 기본 제외하도록 작업 지침 및 도구 출력을 제한한다.
- 도구 결과, transcript delta, remote RPC queue 크기를 계측하고 임계치 초과 시 경고한다.

---

## 8. 제품 E2E 인수 조건

실제 AgentParty 프로세스를 실행하고 UI 또는 로컬 자동화 HTTP API를 통해 검증한다.

1. WSL 엔진 프로세스를 종료한 뒤 5초 이내 멤버가 `disconnected/stalled`로 바뀌고 API가 오류로 종료된다.
2. 동일한 `approval_request`를 두 번 전달해도 질문 카드는 하나만 보인다.
3. 기존 transcript가 있는 멤버를 새 앱 sessionId로 resume하고 즉시 메시지를 보내도 과거 prefix와 새 블록이 모두 보존된다.
4. main/req 탭을 반복 전환해도 각 멤버의 질문·입력 상태·스크롤·transcript가 섞이지 않는다.
5. QA 브리지가 8317을 먼저 점유한 경우 앱은 이를 정상 production 브리지로 채택하지 않고 소유권 충돌을 표시한다.
6. `/models`는 Terra를 노출하지만 실제 reviewer 호출이 `auth_unavailable`인 시나리오에서 게이트 실패와 “검토 없이 전달됨”이 UI/API/로그 모두에 나타난다.
7. Codex 인증을 복구한 뒤 실제 `GPT-5.6 Terra` reviewer 호출이 allow/reject JSON을 반환한다.
8. WSL Claude 자격증명이 없는 상태에서 멤버 시작 또는 메시지 전송 시 provider 호출 전에 `auth_required`가 UI와 API에 동일하게 표시된다.
9. Windows CLIProxyAPI에는 Claude 모델이 있지만 WSL Claude는 로그아웃된 조합에서도 두 인증 상태가 합쳐져 `available`로 오판되지 않는다.
10. WSL에서 실제 Claude 로그인을 완료한 뒤 같은 req harness session을 resume하여 기존 트랜스크립트와 작업 맥락을 유지한 채 실제 최소 provider 호출에 성공한다.
11. 실제 WSL workspace의 Claude Code harness에서 실제 `GPT-5.6 Sol`을 선택하고 최소 요청을 보내 desktop reverse-RPC를 통해 응답을 스트리밍한다.
12. 같은 WSL 교차 모델 요청 중 사용자가 interrupt하면 desktop upstream 요청까지 취소되고, 다음 요청이 같은 gateway에서 정상 처리된다.

## 9. 조사 한계

- SEL-6877 WSL 엔진의 종료 직전 stderr/exit code가 남아 있지 않아 종료의 최초 촉발 원인은 확정할 수 없다.
- SEL-6874의 혼선 화면은 이후 req 이벤트가 진행되면서 정상화됐고 동일 타이밍으로 재현하지 못했다.
- CLIProxyAPI 파일 로깅이 꺼져 있어 최초 `auth_unavailable` 시 인증 후보 제외의 세부 사유는 확정할 수 없다.
- WSL Claude 자격증명 파일은 15:23:32에 토큰이 없는 상태로 갱신됐지만, 파일 변경 감사 로그가 없어 명시적 로그아웃인지 refresh 실패 후 자동 무효화인지 확정할 수 없다.

## 10. 외부 참고

- CLIProxyAPI 이슈 #636 — 간헐적인 `503 auth_unavailable`을 인증 풀 고갈로 함께 관측한 사례: <https://github.com/router-for-me/CLIProxyAPI/issues/636>
