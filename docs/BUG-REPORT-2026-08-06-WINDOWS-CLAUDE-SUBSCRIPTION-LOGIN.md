# AgentParty 장애 보고서 — Windows에서 "Claude 구독 연결됨"인데 하네스는 로그인 요구

- 작성일: 2026-08-06 (KST)
- 대상: Windows 네이티브 워크스페이스 (`C:\Project\AgentPartyApp`)
- 조사 방식: 실행 중인 실제 AgentParty 프로세스의 자동화 HTTP API, 소스 코드 대조, Windows 자격증명 파일 직접 확인
- 코드 수정 여부: 없음. 이 문서는 진단과 수정 요구사항만 기록한다.
- 관련: `docs/BUG-REPORT-2026-07-22-AGENT-SESSIONS-AND-MESSAGE-GATE.md` §4·§5 (동일 결함의 WSL 변종)

## 1. 증상

- Windows에서 Claude 구독을 "연결"했고 앱은 연결됨으로 표시한다.
- 그런데 멤버는 `Not logged in · Please run /login`으로 실패한다.
- **연결을 반복해도 아무것도 바뀌지 않는다.**
- VS Code Claude 확장에서도 로그인을 요구해 거기서 로그인했고 확장은 로그인됨으로 표시되지만, AgentParty는 여전히 실패한다.

## 2. 판정

**서로 다른 두 개의 자격증명 저장소가 하나의 UI 카드로 표현된다.** 사용자가 "연결"하는 것과 멤버가 실제로 쓰는 것이 다르다.

| | 저장소 | 누가 쓰는가 | UI 카드에 반영되는가 |
|---|---|---|---|
| A. 구독 브리지 | CLIProxyAPI (`127.0.0.1:8317`)의 OAuth 풀 | 교차 하네스 모델 라우팅, Message Gate reviewer | **예 — 이것만 반영된다** |
| B. 네이티브 로그인 | `%USERPROFILE%\.claude\.credentials.json` | **`claude-code` 런타임 멤버의 실제 추론** | **아니오 — 전혀 검사하지 않는다** |

"연결" 버튼은 A를 다룬다. 멤버가 실패하는 것은 B다. 그래서 A를 아무리 다시 연결해도 B는 달라지지 않는다.

## 3. 확인된 사실 (코드)

### 3-1. Claude 하네스 카드는 검사 없이 `available`로 하드코딩돼 있다

`src/main/authService.ts:68-77`

```ts
{
  id: "claude",
  label: "Claude",
  kind: "subscription",
  status: "available",          // ← 무조건. 아무것도 확인하지 않는다
  description: "Uses the Claude Code login and subscription managed by Claude Code.",
  source: "Claude Code CLI login",
  detail: "AgentParty delegates subscription auth to the local Claude Code harness.",
}
```

주석은 "로컬 Claude Code 하네스에 인증을 위임한다"고 말하지만, **위임한 결과를 확인하는 코드가 없다.**

대조적으로 **Cursor는 올바르게 구현돼 있다.** `withCursorCliAuth`(38-55행)가 CLI의 실제 로그인 상태를 카드에 덮어쓰고, 로그아웃 상태면 `status: "invalid"`와 함께 실행할 명령(`cursor-agent login`)까지 알려준다. 실제로 조사 시점의 API 응답에서 Cursor만 정확히 `invalid`를 보고했다. **필요한 패턴은 이미 이 파일 안에 있다.**

### 3-2. 카드는 브리지 상태로 덮어써진다

`src/main/authService.ts:126-180` `withSubscriptionProxyAuth`가 `providerStatus.available` 하나로 카드의 status/detail을 결정한다.

### 3-3. 그 `available`은 "모델 목록이 보이는가"일 뿐이다

`src/main/subscriptionProxyService.ts:429-437`

```ts
const status = await getSubscriptionProxyStatus();
if (status[provider].available) {
  this.loginStates.delete(provider);
  log("info", "subscription-proxy", "subscription authentication verified by model discovery", {
    provider, modelCount: status[provider].models.length,
  });
  return;
}
```

로그 문구가 그대로 결함을 자백한다 — **인증을 모델 발견으로 검증한다.** 모델 목록 노출은 실제 credential로 한 번의 요청이 가능하다는 보장이 아니다(§4 2026-07-22 리포트에서 이미 지적된 "준비 상태 오판").

코드베이스는 이 간극을 **Codex에 대해서만** 이미 인지하고 있다. `subscriptionProxyService.ts:161`:

```
"Codex bridge reports available models but has no complete active OAuth credential"
```

같은 검사가 Claude에는 없다.

### 3-4. 재연결이 no-op인 직접 원인

`src/main/subscriptionProxyService.ts:172-182`

```ts
async login(provider: SubscriptionProxyProvider): Promise<SubscriptionProxyLoginResult> {
  let subscriptions = await this.ensureRunning();
  if (subscriptions[provider].available) {
    return { ok: true, provider, status: "already_available",
      detail: `${providerLabel(provider)} subscription is already connected.`, subscriptions };
  }
  ...
```

브리지가 모델을 나열하는 한 `available`은 참이므로, **로그인 흐름은 시작조차 되지 않고 "이미 연결됨"을 반환한다.** 사용자가 몇 번을 눌러도 동일한 이유가 이것이다.

### 3-5. 멤버 시작·전송 전 인증 preflight가 없다

`startMember`(`partyApplicationService.ts:457`)와 `sendMessage`(1394행) 어디에도 해당 런타임의 실제 인증을 확인하는 단계가 없다. 그래서 멤버는 정상 시작된 것처럼 보이고, 사용자의 요청을 받은 뒤에야 provider 오류를 트랜스크립트에 남긴다.

## 4. 확인된 사실 (실행 중인 앱)

Windows 워크스페이스 인스턴스(자동화 API 포트 54767) 조회 결과:

- `GET /api/auth` → `claude`: `status: "available"`, `detail: "Claude Code subscription is connected for both harnesses."`
- `GET /api/auth/subscriptions` → 브리지 `http://127.0.0.1:8317/v1`가 claude 모델 15종을 나열, `claude.available: true`
- 같은 응답의 `service.managed: **false**` — **앱이 이 브리지를 소유하고 있지 않다.** 2026-07-22 리포트 §4의 "서비스 소유권/포트 충돌"(고정 포트 8317에 응답하는 임의의 CLIProxyAPI를 정상으로 채택)이 아직 그대로다.
- `authentication: {}` — 인증 상세는 비어 있는데도 카드는 연결됨이다.

## 5. 자격증명 파일 실측

`%USERPROFILE%\.claude\.credentials.json` (조사 시점):

- 키: `mcpOAuth`, `claudeAiOauth`
- `accessToken` / `refreshToken`: 둘 다 존재
- `subscriptionType`: `max`
- 만료: 미래 시각 (유효)

즉 **조사 시점에는 네이티브 저장소(B)가 정상이다.** 사용자가 VS Code 확장에서 로그인한 결과가 여기에 반영된 것으로 보이며, 그 시점 이후 네이티브 경로는 회복됐을 가능성이 높다. 다만 **장애 시점에 B가 비어 있었는지는 사후 확정할 수 없다** (자격증명 변경 감사 로그가 없다 — 2026-07-22 리포트 §9와 같은 한계).

이것은 결함 판정을 바꾸지 않는다. B의 상태와 무관하게 **앱은 B를 한 번도 보지 않으며, A가 초록불이면 언제나 연결됨으로 표시한다.**

## 6. 오해하기 쉬운 지점 (다시 쫓지 말 것)

`src/core/claudeAdapter.ts:650-654`는 하네스에 다음 env를 넘긴다.

```ts
const env = {
  ...process.env,
  CLAUDE_CODE_ENTRYPOINT: "claude-vscode",
  CLAUDE_AGENT_SDK_CLIENT_APP: "agentparty-native-vscode/0.0.1",
};
```

`claude-vscode`라는 값 때문에 "앱이 VS Code 확장을 사칭해 인증 경로가 바뀐 것"으로 의심하기 쉽다. **아니다.** SDK 번들(`node_modules/@anthropic-ai/claude-agent-sdk/bridge.mjs`)을 확인한 결과 이 값은 `anthropic-client-platform` **HTTP 헤더 문자열로만** 변환되어 쓰인다(`claude-vscode` → `claude_code_vscode`). 자격증명 파일 경로나 OAuth 클라이언트를 바꾸지 않는다.

또한 이 env는 `process.env`를 그대로 상속하므로 `HOME`/`USERPROFILE`이 보존된다. 즉 하네스는 표준 위치인 `%USERPROFILE%\.claude\.credentials.json`을 읽는다. **자격증명 경로 오지정은 원인이 아니다.**

## 7. 수정 요구사항

### P0 — 두 인증을 별개로 모델링하고 정직하게 노출

1. `getAuthState()`의 Claude(및 Codex) 하네스 카드에서 **하드코딩된 `available`을 제거**한다.
2. 네이티브 하네스 로그인 상태를 실제로 확인한다. **`withCursorCliAuth`와 같은 패턴을 재사용한다** — 새 구조를 만들지 말 것.
3. UI/HTTP API에 **두 상태를 함께** 노출한다: "구독 브리지(교차 하네스 라우팅)"와 "네이티브 Claude Code 로그인". 하나가 초록이라고 다른 하나를 초록으로 만들지 않는다.
4. 실패 시 **어디서 무엇을 실행해야 하는지** 알려준다 (Cursor 카드가 이미 하듯이). Windows 네이티브면 `claude` 로그인, 브리지면 `cli-proxy-api.exe -claude-login`.

### P0 — 준비 상태를 모델 목록으로 판정하지 않는다

5. `/v1/models` 노출만으로 `available`을 결정하지 않는다. credential 상태를 검증하는 별도 계약을 쓰거나, Codex에 이미 있는 "모델은 있는데 활성 OAuth credential이 없다"(161행) 검사를 Claude에도 적용한다.
6. `login()`의 `already_available` 조기 반환에 **강제 재인증 경로**를 둔다. 사용자가 "연결"을 다시 누르는 것은 "지금 안 되고 있으니 다시 해달라"는 뜻이지, "상태를 확인해달라"가 아니다.

### P0 — 멤버 시작/전송 전 preflight

7. 멤버를 시작하거나 첫 턴을 보내기 전에 해당 런타임의 실제 인증을 확인한다.
8. 인증이 없으면 멤버를 `idle`처럼 보이게 두지 말고 **`auth_required`**와 로그인 위치·명령을 표시한다.
9. 동일 기능을 `AppController` 경유로 구현해 로컬 자동화 HTTP API, `src/shared/apiSpec.ts`, `docs/API.md`에도 제공한다 (AGENTS.md 요구사항).

### P1 — 브리지 소유권과 감사

10. `service.managed: false` 상태, 즉 앱이 시작하지 않은 CLIProxyAPI가 8317을 점유한 경우를 정상으로 채택하지 말고 **소유권 충돌로 표시**한다 (2026-07-22 §7과 동일 요구, 미해결 상태로 재확인됨).
11. 자격증명이 유효→무효로 바뀔 때 시각과 감지 원인을 토큰 없이 구조화 로그로 남긴다. 이번 조사에서 장애 시점의 B 상태를 확정하지 못한 직접적 이유다.

## 8. 제품 E2E 인수 조건

실제 AgentParty 프로세스를 실행하고 UI 또는 로컬 자동화 HTTP API로 검증한다.

1. 네이티브 Claude 자격증명을 비운 상태에서 브리지는 정상일 때, Claude 카드가 **연결됨으로 표시되지 않는다**.
2. 같은 상태에서 `claude-code` 멤버를 시작하면 provider 호출 전에 `auth_required`가 UI와 HTTP API에 동일하게 나타난다.
3. 브리지만 끊긴 상태와 네이티브만 끊긴 상태가 **서로 다른 안내**를 낸다.
4. 이미 `available`인 상태에서 "연결"을 눌러도 no-op이 아니라 재인증이 시작된다.
5. 네이티브 로그인 복구 후 기존 harness session을 resume하여 실제 최소 provider 호출에 성공한다.

## 9. 조사 한계

- 장애 시점의 `%USERPROFILE%\.claude\.credentials.json` 내용은 남아 있지 않아, B가 실제로 비어 있었는지 확정할 수 없다. 조사 시점에는 유효했다.
- VS Code 확장이 어느 저장소에 기록하는지는 이번 조사 범위에서 확인하지 않았다. 확장 로그인 이후 네이티브 파일이 유효해진 정황은 있으나 인과로 단정하지 않는다.
