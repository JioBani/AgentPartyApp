# AgentParty 장애 보고서 — 사용자가 입력한 메시지가 트랜스크립트에서 대화로 남지 않는다

- 작성일: 2026-08-06 (KST)
- 대상: WSL 워크스페이스 `wsl+Ubuntu-20.04:/home/spdlqj8876/Claude`, 파티 `STLM-466` (`party-1785824256133-36055f59b999e`), 멤버 `main`
- 조사 방식: 실행 중인 실제 AgentParty 프로세스의 온디스크 저장본, 하네스 원본 JSONL, 사용량 원장, 소스 코드 대조
- 코드 수정 여부: 없음. 앱이 실행 중이어서 저장본을 일절 건드리지 않았다. 이 문서는 진단과 수정 요구사항만 기록한다.
- 관련: `scripts/recover-transcript-from-harness.mjs`, `src/main/partyRepository.ts`, `src/shared/transcriptEvents.ts`

## 1. 증상

사용자 보고: "STLM-466 대화 내용이 일부 날아갔다. 15:10 이후에도 대화를 많이 했는데 내용이 사라졌다."

## 2. 판정

**데이터는 하나도 유실되지 않았다.** 세 가지 별개 결함이 겹쳐서, 사용자 자신이 입력한 메시지가 대화로 보이지 않을 뿐이다.

| # | 결함 | 위치 | 영향 |
|---|---|---|---|
| A | 직접 입력한 사용자 메시지가 `kind:"user"`가 아니라 `kind:"status"`로 저장된다 | `src/shared/transcriptEvents.ts:34-39` | **대화가 로그 줄로 렌더링된다. 주 원인** |
| B | 트랜스크립트 상한 800블록의 59%를 `status`/`diagnostic`이 차지한다 | `src/main/partyRepository.ts:166,334` | 실제 대화 보존 창이 ~2시간으로 축소 |
| C | 블록 `at`에 날짜가 없고 로케일 의존 문자열이다 | `src/shared/transcriptEvents.ts:542-544` | 언제 대화인지 알 수 없다. 멤버마다 포맷이 다르다 |

A가 B를 악화시킨다. 사용자 메시지가 `status`로 쌓이므로, `requesting`/`responding` 같은 잡음과 **같은 속도로 밀려난다.**

## 3. 확인된 사실

### 3-1. 원본은 온전하다

```
~/.claude/projects/-home-spdlqj8876-Claude/3d49cce5-ddef-47d2-b862-8afe9b739b4a.jsonl
   6.4MB · 2,417줄 · 2026-08-04T06:18Z ~ 2026-08-06T08:54Z (조사 시점에도 기록 중)
```

세션 ID는 사용량 원장에서 `STLM-466`/`main`으로 확인된다(턴 77건, 마지막 `2026-08-06T08:36Z`). 모델이 실제로 들고 있는 컨텍스트 점유량은 **917k** — 멤버는 아무것도 잊지 않았다. 표시 계층만의 문제다.

### 3-2. 사용자 메시지는 저장본에도 전부 있다 — `status` 블록 안에

`transcript.json`(800블록, `03:44 PM ~ 06:02 PM`)의 실측:

```
kind 분포 :  status 453 · tool 154 · assistant 96 · reasoning 70 · diagnostic 19 · user 6 · approval 2
```

`user` 블록은 6개뿐이고 **6개 모두 `fromQueue: true`** — 큐를 거친 메시지다.

```json
{"kind":"user","text":"1009 아니잖아","fromQueue":true,"queuedN":1,"from":null,"at":"04:03 PM"}
```

직접 입력한 메시지는 `sent: true`인 `status` 블록에 들어 있다. **42건이며 본문은 온전하다.**

```json
{"kind":"status","sent":true,"at":"03:59 PM","text":"sent: 그리고 중단은 유지"}
{"kind":"status","sent":true,"at":"04:05 PM","text":"sent: 이거 상세는 왜 안나와?>"}
```

보존 구간의 하네스 사용자 입력 44건 대비: `user` 블록 6건 + `sent` status 42건 = **전건 보존**.

### 3-3. 원인 코드

`src/shared/transcriptEvents.ts:27-58` — 유입 경로가 둘로 갈린다.

```ts
} else if (event.type === "status") {
  const channel = event.status === "sent" ? parseChannel(event.detail) : null;
  if (channel) { /* 멤버 간 메시지 → kind:"channel" */ }
  else {
    // A plain "sent" status is the harness echoing back the turn the app just
    // submitted — the user's own message, tagged so it does not cut a reply
    // that is still streaming ([#14]).
    next = appendBlock(next, sessionId, {
      kind: "status",                                   // ← 사용자 발화가 status가 된다
      text: [event.status, event.detail].filter(Boolean).join(": "),
      sent: event.status === "sent", at: nowTime(),
    });
  }
} else if (event.type === "queue_dequeued") {
  ...
  next = appendBlock(next, sessionId, {
    kind: "user",                                       // ← 큐 경유만 user가 된다
    text: event.text || "", fromQueue: true, ...
  });
}
```

주석이 의도를 설명한다 — 스트리밍 중인 답변을 끊지 않기 위해 `sent`로 태깅한다(`[#14]`). 그 목적 자체는 타당하다. 그러나 **그 부수효과로 발화의 종류(`kind`)까지 `status`가 되었다.** 렌더링 억제를 위해 필요한 것은 `sent` 플래그이지 `kind` 강등이 아니다.

대조적으로 `queue_dequeued` 경로(40-58행)는 같은 사용자 발화를 올바르게 `kind:"user"`로 만든다. **필요한 형태는 이미 같은 파일 안에 있다.**

### 3-4. 재시작이 지운 것이 아니다

앱 인스턴스는 `2026-08-06T06:11:16Z`(15:11 KST)에 새로 떴다(`~/Claude/.agent_party_app/instances/26644.json`). 그러나 같은 파티의 `search` 멤버 저장본은 오전 블록(`오전 10:19`)을 그대로 유지하고 있다. 전역 초기화는 일어나지 않았다.

### 3-5. 상한 예산을 잡음이 소진한다

`src/main/partyRepository.ts`

```ts
const TRANSCRIPT_CAP = 800;                                          // :334
const capped = next.slice(-TRANSCRIPT_CAP).map(stripAttachmentBytes); // :166
```

800블록 중 `status` 텍스트 상위:

```
182  "requesting"
182  "responding"
 25  "turn complete - $5 in / $25 out"
 17  "interrupt: requested"
```

**`requesting`/`responding` 두 단어가 364블록, 예산의 45%를 차지한다.** 대화 블록(`user`+`assistant`)은 102개, 12%에 불과하다. 결과적으로 보존 창이 약 2시간으로 줄어든다. 조사 시점 기준 다른 파티의 활성 멤버 대부분도 상한 800에 붙어 있다(`explore`, `impl`, `impl2`, `main`, `test2`, `req`).

### 3-6. 타임스탬프에 날짜가 없다

`src/shared/transcriptEvents.ts:542-544`

```ts
export function nowTime(): string {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
```

- **날짜가 없다.** `"03:44 PM"` 블록이 오늘인지 어제인지 판별할 수 없다.
- **로케일이 런타임 기본값(`[]`)이다.** 실제로 같은 파티에서 `main`은 `"05:54 PM"`, `search`는 `"오후 03:22"`로 서로 다른 포맷이 저장돼 있다.
- 이 때문에 이번 조사에서도 "상한에 밀린 것인지 별도 유실인지"를 저장본만으로는 판별할 수 없었고, 하네스 원본과 대조해야 했다.

## 4. 복구 도구의 한계

`scripts/recover-transcript-from-harness.mjs`가 이미 존재하지만, 이번 사안에는 부적합하다.

```js
const blocks = [...recovered, ...retained].slice(-800);   // 동일한 800 상한
```

- 상한이 같으므로 **총량을 늘리지 못한다.** 과거 구간을 되살리면 현재 구간을 밀어낸다.
- 그리고 애초에 유실이 아니므로 **복구할 대상이 없다.** 결함 A를 고치면 기존 저장본의 `sent` status 블록을 그대로 `user`로 승격해 렌더링할 수 있다.

## 5. 수정 요구사항

### R-1 (필수) 사용자 발화는 `kind:"user"`로 저장한다

`transcriptEvents.ts:34-39`의 `sent` 분기가 `kind:"status"` 대신 `kind:"user"` 블록을 만들어야 한다. 스트리밍 답변을 끊지 않는 동작은 기존 `sent` 플래그로 유지한다(`appendText` `[#14]` 경로는 `kind`가 아니라 `sent`를 보게 한다).

`text`에서 `"sent: "` 접두사를 제거하고 `event.detail`을 본문으로 쓴다.

**하위 호환**: 기존 저장본에는 `{kind:"status", sent:true, text:"sent: …"}`가 남아 있다. 읽기 시점에 이 형태를 `user` 블록으로 승격하는 정규화를 두면, 마이그레이션 없이 과거 대화가 즉시 복원된다.

### R-2 (필수) 상한을 대화 기준으로 센다

`TRANSCRIPT_CAP`이 `status`/`diagnostic`을 포함해 세는 한, 대화 보존 창은 세션 활동량에 반비례해 계속 줄어든다. 택일:

1. 대화 블록(`user`/`assistant`/`channel`)만 상한에 계산하고 잡음은 별도 소상한을 둔다
2. `requesting`/`responding` 같은 순간 상태는 애초에 영속화하지 않는다(휘발성 UI 상태로 처리)
3. 상한을 올린다 — 다만 근본 해결이 아니다

2번이 가장 직접적이다. `requesting`/`responding` 364블록은 스크롤백에서 아무 정보 가치가 없다.

### R-3 (필수) `at`을 ISO 8601로 저장한다

`nowTime()`을 `new Date().toISOString()`으로 바꾸고, 로케일 포맷은 **렌더 시점**에 적용한다. 저장 포맷과 표시 포맷의 분리는 이번 조사에서 판별을 막은 직접 원인이다.

기존 블록은 날짜를 복원할 수 없으므로, 정규화 시 날짜 불명으로 표시하거나 파일 mtime을 상한으로 추정한다.

### R-4 (권장) 회귀 테스트

`scripts/qa-transcript-append.mjs` 계열에 다음을 추가한다.

- 멤버가 유휴일 때 직접 입력한 메시지가 `kind:"user"` 블록으로 저장되는지
- 멤버가 응답 중일 때 큐를 거친 메시지와 **동일한 종류**로 저장되는지 (현재는 경로에 따라 종류가 갈린다)
- 상태 블록이 다수 발생해도 대화 블록이 상한에서 밀려나지 않는지

제품 E2E 규칙에 따라 실제 앱 프로세스를 띄우고 자동화 HTTP API로 구동한다.

## 6. 조사 중 발견한 별건

`STLM-466`/`main`의 컨텍스트 점유량이 **917k**로 1M 창에 근접해 있다. 곧 강제 컴팩션이 발생하며, **그 시점이 실제로 정보를 잃는 순간이다**(이번 사안은 표시 문제일 뿐 유실이 아니다). 별도 조치가 필요하다.

동일 조사에서 측정된 파티 운영 지표는 컨텍스트 크기가 단위 산출당 비용을 지배함을 보여준다 — 세션 내부 시계열 기준 초반 20% 대비 종반 20%가 중앙값 2.32배 악화, 컴팩션 직후 2.7배 회복(`SEL-6877`/`impl` 851k→414k 구간). 이는 별도 문서로 다룬다.
