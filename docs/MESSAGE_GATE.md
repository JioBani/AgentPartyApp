# 메시지 게이트 (Message Gate)

멤버 간 통신을 배달 직전에 경량 모델이 심사하여, 사용자가 정한 통신 규칙을
컨텍스트가 쌓여도 강제하는 기능의 기획/스펙 문서. 이 문서는 디자인 핸드오프와
구현의 단일 입력이다.

> 이름/네임스페이스: 코드 slug는 `gate`. Codex 하네스의 `guardian`
> (`approvalsReviewer: "auto_review"`, `src/shared/codexPolicy.ts`)과는 **별개**다.
> guardian은 Codex 내부 승인 리뷰어이고, Message Gate는 우리 코드가 경량 모델을
> 직접 호출해 **멤버 간 메시지**를 심사한다.

---

## 1. 목적 / 배경

워크플로우에서 멤버끼리 통신할 때 사용자는 보통 "오케스트레이터를 거치지 말고
멤버끼리 직접 소통하라", "간결하게 보내라" 같은 규칙을 지시문에 넣는다. 그러나
작업이 진행되며 컨텍스트가 쌓이면 멤버들이 그 규칙을 지키지 않는 경우가 많다.

메시지 게이트는 멤버 발신 메시지를 배달 전에 경량 모델에게 넘겨, 유효 규칙을
지키는지 심사하고 위반 시 **반려**한다. 발신 멤버는 반려 사유를 받아 다시 작성한다.

## 2. 용어

- **파티 규칙 (party rule)**: 파티 단위로 관리되는 전역 지시문. 파티의 모든 멤버가
  기본 적용한다.
- **멤버 오버라이드 (member gate override)**: 특정 멤버가 파티 규칙/스위치/리뷰어
  모델을 덮어쓴 값. 없으면 파티/설정을 그대로 상속한다.
- **게이트 기본값 (gate defaults)**: 앱 설정에 저장되는 리뷰어 모델/effort/하네스
  기본값. 멤버가 오버라이드하지 않으면 이 값이 리뷰어에 쓰인다.
- **유효 게이트 (effective gate)**: 위 세 층을 해석해 얻은, 실제 이 멤버에 적용되는
  최종 게이트 설정.
- **리뷰어 (reviewer)**: 심사를 수행하는 경량 모델 호출. "멤버가 하나 더 있다"고
  보면 된다 — harness/model/effort를 가진다.

## 3. 데이터 모델

### 3.1 파티 (`PartyDefinition`)

```ts
gate: {
  enabled: boolean;   // 마스터 스위치. 파티 생성 시 기본 false.
  rule: string;       // 파티 전역 지시문 (이 파티에서만 관리).
}
```

### 3.2 앱 설정 (`AppSettings.gateDefaults`)

리뷰어의 기본값 — **model + effort만(하네스 없음)**. 리뷰어는 헤드리스 raw
호출이라 하네스 에이전트 루프를 돌리지 않는다.

```ts
gateDefaults: {
  model: string;   // 예: "GPT-5.6 Terra" (기본값)
  effort: string;  // 예: "low"
}
```

### 3.3 멤버 (`PartyMember.gate`)

없으면(`undefined`) 파티/설정을 **완전히 상속**한다. 기존 멤버별 auto-compact
오버라이드(`PartyMember.autoCompact`, undefined=전역 상속)와 동일한 관례. 실제
타입/해석은 `shared/messageGate.ts`(`MemberGateOverride` / `effectiveGate`).

```ts
gate?: {
  mode?: "inherit" | "on" | "off";        // undefined=inherit
  rule?: string | null;                    // null=파티 규칙 상속, string=오버라이드
  reviewer?: { model: string; effort: string } | null; // null=설정 기본값 상속
};
```

## 4. 유효값 해석

멤버 `M`, 파티 `P`, 설정 `S`에 대해:

| 항목 | 우선순위 |
|------|----------|
| `enabled` | `M.gate?.enabled` → `P.gate.enabled` → `false` |
| `rule` | `M.gate?.rule` → `P.gate.rule` → `""` |
| `model` | `M.gate?.reviewer.model` → `P.gate?.reviewer.model` → `S.gateDefaults.model` |
| `effort` | `M.gate?.reviewer.effort` → `P.gate?.reviewer.effort` → `S.gateDefaults.effort` |

리뷰어는 **세 단계**다. 파티 단계가 있으므로 앱 전역 설정을 건드리지 않고
파티 하나만 다른 모델로 심사할 수 있다.

**심사 발동 조건**: `enabled === true` **그리고** `rule.trim() !== ""`.
규칙이 비어 있으면 리뷰어를 호출하지 않는다(불필요한 모델 호출/지연/비용 방지).

**`overridden`의 의미**: "멤버가 파티와 **다른 규칙 텍스트**를 강제한다"이다.
문자열이 저장되어 있다는 사실만으로는 오버라이드가 아니다 — 파티 규칙과 같은
텍스트를 들고 있으면 오버라이드로 표시하지 않는다. 그리고 파티 게이트 모달의
Inherit/On/Off는 **enablement만** 바꾸므로 rule 오버라이드가 남는다. 이건 의도된
분리이고, 목록의 "오버라이드" 배지 자체가 해제 버튼(`rule: null`)이다.

## 5. 전송 심사 흐름

개입 지점은 단 한 곳: `PartyApplicationService.sendMessage()` 진입부
(`src/main/application/partyApplicationService.ts`). 브로드캐스트도 이 메서드로
수렴하므로 자동 포함된다. **사람 사용자 → 멤버** 경로(`sendUserMessage`)는 심사
대상이 아니다(사용자 지시는 권위 있음).

```
멤버 A: send(to=B, content, force?, forceReason?)
   │
   ├─ from === "user" ? ───────────────▶ 심사 안 함, 그대로 배달
   ├─ force === true ? ────────────────▶ 우회 배달 + 우회 사실 표면화(§8)
   ├─ 유효 게이트(B의 발신? A의 발신?) 아래 §5.1 참고
   │   심사 발동 조건 불충족 ───────────▶ 그대로 배달
   │
   └─ 리뷰어 호출 (유효 harness/model/effort, 규칙 + 문맥 + content)
        ├─ allow ───────────────────────▶ 배달
        ├─ reject ──────────────────────▶ 배달 안 함, send 툴이
        │                                  {ok:false, error:사유} 반환 → A 재작성
        └─ 호출 실패(인증/레이트리밋/오류) ─▶ 오류 노출(로그+UI) + 배달 허용(fail-open)
```

### 5.1 어느 멤버의 규칙을 적용하는가 (발신자 기준)

게이트는 **발신 멤버(A)의 유효 게이트**를 적용한다. 규칙 지시문은 "네가 보내는
메시지를 이렇게 써라"라는 발신자 관점 지시이기 때문이다. (수신자 기준이 아니라
발신자 기준임을 구현/디자인에서 명확히 할 것.)

## 6. 리뷰어 계약

- 라우터의 `/v1` 엔드포인트(`EmbeddedHarnessRouter`, `src/core/routerShim.ts`)로
  **비스트리밍 1회 호출**. 기존 구독/OpenRouter/API키 인증·라우팅을 재사용하므로
  새 프로바이더 배선이 필요 없다.
- 입력: `{ rule, from, to, fromRole, toRole, content }`
- 출력(구조화 JSON 강제):

```json
{ "verdict": "allow" | "reject", "reason": "string" }
```

- 프롬프트 설계 원칙: 반려 시 `reason`은 "무엇이 규칙을 위반했고 어떻게 고쳐야
  하는지" 구체적으로 반환하여, 발신 멤버가 유의미하게 재작성하도록 한다. 무한
  반려 루프를 예방하는 핵심 장치.

## 7. 강제 전송 (force)

- `send` MCP 툴과 대응 HTTP 경로에 `force?: boolean`, `forceReason?: string` 추가.
- `force === true`면 심사를 건너뛰고 배달한다.
- **무력화 방지**: 강제 전송 사실을 반드시 표면화한다(§8). 후속 고려: `forceReason`
  필수화, 파티별 "강제 전송 금지" 옵션.

## 8. 관측 / 가시화 (침묵 금지)

AGENTS.md의 "실패를 침묵으로 숨기지 말 것" 원칙에 따라 다음을 사용자에게 노출한다.

- **반려**: transcript 배지 또는 파티 채널 이벤트 (발신자, 사유 포함).
- **강제 전송**: 우회 배지 (발신자, forceReason 포함).
- **리뷰 호출 실패**: 오류 로그 + UI 경고 배지 + 배달됨 표시(fail-open).
- 모든 이벤트는 `log("info"/"warn", "party", ...)`로 남긴다.

## 9. 상호 편집 (Cross-editing)

게이트의 모든 조작(지시 편집 / on-off / 리뷰어 모델 설정)을 **멤버가 서로에게**
수행할 수 있다. A가 B의 게이트를 편집하는 것을 막지 않는다.

- 파티 브리지(`partyBridgeFor`, `partyApplicationService.ts`)에 `setGate` 추가
  (기존 `setPermission`과 동일 구조). MCP 툴로 노출: `gate-set`.
- 브리지 `list` / `member-status` 응답에 각 멤버의 **유효 게이트**를 포함하여
  다른 멤버가 현재 상태를 조회할 수 있게 한다.
- `from`은 클로저 바인딩(발신 멤버)이며, 대상 멤버는 인자로 받는다.

## 10. AppController / API 표면 (AGENTS.md 체크리스트)

UI와 HTTP는 동일한 `AppController` 메서드를 통과한다. 신규 엔드포인트는
`src/shared/apiSpec.ts`에 등록하고 `docs/API.md`에 문서화한다.

신규/변경 능력(제안):

| 능력 | AppController | HTTP (제안) |
|------|---------------|-------------|
| 파티 게이트 설정(enabled, rule) | `setPartyGate` | 파티 액션 `POST /api/party/{id}/gate` |
| 멤버 게이트 오버라이드 설정/해제 | `setMemberGate` | 멤버 액션 `POST /api/party/members/{name}/gate` |
| 멤버 게이트를 전역으로 되돌리기 | `setMemberGate({}) ` (오버라이드 제거) | 위와 동일 (clear) |
| 게이트 기본값(모델/effort/하네스) | `setGateDefaults` | 설정 경로에 필드 추가 |
| 강제 전송 | `sendMessage(force)` | `send` 경로에 `force`/`forceReason` |

파티 액션/멤버 액션 디스패치는 각각
`src/main/engine/partyActions.ts`, `src/main/application/sessionActions.ts` 관례를
따른다.

## 11. UI 요구사항 (디자인 핸드오프)

1. **멤버 게이트 편집창** (멤버 런타임 모달 / 멤버 위저드의 권한 컨트롤 근처)
   - 열면 **파티 전역 규칙이 기본값으로 채워짐**. 편집하면 멤버 오버라이드 생성.
   - **"전역 규칙으로 되돌리기"** 버튼 = 멤버 오버라이드 삭제(다시 상속).
   - on/off: 3-state(상속 / 켬 / 끔).
   - 리뷰어 모델/하네스/effort 선택 — 모델 카탈로그의 **모든 모델·하네스** 사용
     가능(멤버 모델 선택 UI 재사용). 미설정 시 설정 기본값 상속.
2. **파티 생성 플로우**
   - "메시지 게이트 사용" 체크박스, **기본 꺼짐**. 미체크면 그냥 넘어감.
   - 체크 시 지시문 입력란 노출. 생성 후 별도 편집으로도 켤 수 있음.
3. **설정 → Runtime**
   - 게이트 기본 모델/effort/하네스(`gateDefaults`).
4. **검문 결과 표식**
   - transcript 내 반려/강제전송/리뷰실패 배지, 또는 채널 이벤트 렌더링.

## 12. 비용 / 지연 / 리스크

- 게이트가 켜진 멤버의 발신 메시지 1건마다 리뷰어 호출 1회 = 지연·비용 소폭 증가.
  게이트 꺼짐(기본) 시 0. 기본 모델은 저렴/빠른 Haiku 4.5 권장.
- **force 남용**: 에이전트가 습관적으로 force를 쓰면 게이트 무력화 → 표면화 필수,
  후속으로 forceReason 필수화/파티별 금지 옵션.
- **무한 반려 루프**: 리뷰어가 계속 반려 → §6의 구체 사유 반환으로 완화.

## 13. 구현 체크리스트 (ARCHITECTURE.md Feature Change Checklist)

1. `PartyDefinition.gate`, `PartyMember.gate`, `AppSettings.gateDefaults` 타입 추가
   (`src/shared/types.ts`) + 유효값 해석 헬퍼.
2. `sendMessage` 진입부에 심사 훅 + 리뷰어 호출(라우터 재사용) + fail-open 처리.
3. `AppController`에 `setPartyGate` / `setMemberGate` / `setGateDefaults` 추가.
4. IPC(`main.ts`) + HTTP(`automationApi.ts`) 노출, `apiSpec.ts` 등록, `docs/API.md` 문서화.
5. 파티 브리지 `setGate` + MCP 툴 `gate-set`, `list`/`status`에 유효 게이트 포함,
   `send` 툴에 `force`/`forceReason`(`src/core/partyBridge.ts`).
6. 렌더러: 멤버 게이트 편집창, 파티 생성 체크박스, 설정 gateDefaults, 결과 배지.
7. QA: 목업 기반 UI QA + **실제 앱 풀프로세스 E2E**(반려/강제/실패 각 경로 실모델
   최소 호출). `docs/E2E_TESTING.md` 표 갱신.

## 14. 구현 노트 / 미해결

구현된 표면(2026-07-21):
- 데이터: `shared/messageGate.ts`(타입·`effectiveGate`·patch), `PartyMember.gate` /
  `PartyDefinition.gate` / `AppSettings.gateDefaults`(types.ts), 기본값
  `{model:"GPT-5.6 Terra",effort:"low"}`(settings.ts). 측정 근거는 §리뷰어 추론 참조.
- 리뷰어: `core/messageGateReviewer.ts` — 헤드리스 1회 호출. anthropic 구독은
  subscription proxy, codex/openrouter는 임베디드 라우터로 디스패치.
- 심사 훅: `PartyApplicationService.sendGatedMessage`(에이전트 발신 경로 전용) →
  reject/forced/failed. 유저 턴(`sendUserMessage`)은 비대상.
- 배지: `gate` 정규화 이벤트(events.ts) → `sessionManager.emitGateBadge` → 렌더러
  transcript `kind:"gate"` 블록(§8).
- API: `POST /api/party/members/:name/gate`, `POST /api/parties/:id/gate`,
  send의 `force`/`forceReason`, 설정 `gateDefaults`(POST /api/settings). MCP 툴
  `gate-set`(멤버) / `party-gate-set`(파티 전역) + `send`의 force.
  IPC `party:gate`/`party:partyGate`.

에이전트 노출 범위: 멤버 게이트(`gate-set`)와 파티 전역 게이트
(`party-gate-set`) 둘 다 드라이브할 수 있다. 자기 자신의 게이트를 끄는 것도
가능하다 — 게이트는 **강제 통제 장치가 아니라 협업 규약 장치**다.

리뷰어 추론(effort) 전송 — 프로바이더별로 와이어가 다르다:
- **Anthropic(구독 브리지)**: `effort`를 보내면 400 `Extra inputs are not
  permitted`. `thinking`으로 표현한다. 모드는 모델 카탈로그의
  `reasoning.thinking.modes`를 따른다 — `adaptive`는 sonnet/opus에는 있지만
  haiku에는 없어서 보내면 400이다.
- **라우터(codex/openrouter)**: `effort`를 그대로 받는다. `thinking`은 보내지 않는다.

**thinking은 어떤 effort에서도 끄지 않는다.** 실측(라이브 144콜) 결과 haiku는
thinking을 끄면 12/24, 켜면 24/24였다 — 규칙을 충족한다고 스스로 인정한 메시지를
규칙에 없는 근거(“배포가 위험해 보인다”)로 거부했다. 분류기가 추론을 못 하면
게이트가 정상 트래픽을 막는다. 그래서 `effort`는 예산 크기만 조절한다(카탈로그
`budget.min`~`max`). 최소 예산 1024로도 24/24였다.

시스템 프롬프트로는 고쳐지지 않는다: 판단 범위를 제한하는 문장을 추가해도
12/24 → 12/24로 변화가 없었고, 길어진 프롬프트가 역할 이탈을 한 번 유발해
되돌렸다. `messageGateReviewer.ts`의 `reasoningPayload` 주석 참조.

WSL 워크스페이스: 리뷰어 HTTP 호출은 **데스크톱에서** 실행된다. 구독 브리지와
임베디드 라우터는 데스크톱의 `127.0.0.1`에 묶여 있어 배포판 안에서는 닿지 않는다
(호스트 IP로도 안 된다 — 리스너가 루프백 전용). 엔진은 게이트 판정·배지·거부
기록을 그대로 소유하고, 모델 호출만 `kind:"call"` 역방향 RPC로 위임한다.
`transport/hostChannel.ts`, docs/WSL_REMOTE.md §7.

미해결 / 후속:
- `forceReason` 필수화 여부, 파티별 "강제 전송 금지" 옵션.
- 리뷰어 결과 캐싱(동일 메시지 재심사 절감) 여부.
