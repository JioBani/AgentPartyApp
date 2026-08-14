# B-07. Cursor 컨텍스트 계산이 이상하다

**판정: 차단 유력 (2026-08-08 실측) — 지어낸 숫자다** · 갈래: *숫자가 안 맞는다* · 출처: 사용자

---

## ✅ 구현됨 (2026-08-08, beta-impl) — Cursor 하네스는 컨텍스트 창을 보고하지 않는다

**규칙 복원이다.** 1-14-1 / 1-14-2 는 이미 코드에 구현돼 있었고(`ContextDonut` 에 `창 크기 미상`
경로가, `shouldAutoCompact` 에 *"we don't guess against a fabricated window"* 가 이미 있었다),
`"500K"` 하드코딩만 그 규칙을 비껴가게 하고 있었다.

### 바꾼 것 (5파일 · +47/−8)
| 파일 | 변경 |
|---|---|
| `shared/harnessCapabilities.ts` | 능력 플래그 `contextWindow` 추가 (cursor=false) |
| `core/cursorAdapter.ts:311` | `parseContextTokens("500K")` → `undefined` (죽은 import 제거) |
| `renderer/workbench/memberStatus.ts` | `contextFor` 가 능력 없는 하네스에서 창 해석 사슬 전체를 건너뜀 · `thresholdWindowFor()` 신설 |
| `AutoCompactEditor.tsx` · `RuntimeModal.tsx` | `view.member.lastContextWindow` 직접 폴백 → `thresholdWindowFor()` |

⚠️ **어댑터만 고쳤으면 아무것도 안 바뀐다.** 폴백이 3층이었다 —
`snapshot.contextWindow` → `member.lastContextWindow`(영속) → `parseContextTokens(route.meta.context)`(**카탈로그의 500K**).
어댑터를 지워도 카탈로그가 같은 500K 를 다시 공급하고, 기존 사용자의 파티 파일에는 500K 가 **이미 저장돼 있다.**
그래서 하네스 능력으로 사슬 전체를 막았다.

### 실측 검증 — 실제 앱 · 실제 모델 · 17/17
Claude(haiku, 200K) 멤버를 **양성 대조**로 같이 띄웠다. 대조가 없으면 "Cursor 가 압축 안 했다"가
죽은 경로 때문인지 구분되지 않는다.

| 확인 | 결과 |
|---|---|
| Cursor 미터 | `컨텍스트 40,228 토큰 (창 크기 미상)` · 표시 `40K` · used/total 범위 없음 → **1-14-1 준수** |
| Cursor 자동 압축 | 임계 11% 로 켠 뒤 45초 관측 — **발동 안 함** → **1-14-2 준수** |
| Claude 미터 | `30,357 / 200,000 토큰 (15%)` — **비율 그대로, 회귀 없음** |
| Claude 자동 압축 | 임계 14%(실측 15%)에서 **발동함** — 트랜스크립트에 `sent: /compact` → `compacting` |
| 수동 압축 | 도넛 클릭 → 다이얼로그 → `지금 압축 실행` 정상 |
| 분자 | Cursor 는 **토큰 수를 계속 보고한다**(20,144 / 40,228) — 창만 사라졌다 |

`typecheck` ✅ · `build` ✅ · `test:ui` 선재 실패 1건(`wb-stop-pill`) 외 **회귀 0**

### ⚠️ 계측 정정 — 두 번 잘못 쟀다
1. `window.agentParty.compact` 를 래핑해 압축 호출을 세려 했으나 **contextBridge 객체는 동결돼 있어
   대입이 조용히 무시된다.** 수동 압축까지 0 으로 나와 "자동 압축이 아예 안 돈다"로 잘못 읽힐 뻔했다.
   → 세션 상태 전이 + 트랜스크립트 관측으로 교체.
2. 프롬프트에 넣은 마커(`OKR`)로 턴 완료를 판정했더니 **내가 보낸 user 블록에 매칭**돼,
   턴이 진행 중인데 완료로 읽혔다. → 세션 상태로 판정하도록 교체.

### 🔧 아래 ② 정정 — stream-json 에 `usage` 는 **온다**
*"문서화된 stream-json 스키마에 usage·token 필드가 아예 없다"* 는 **공식 문서 기준으로는 맞지만
실제 CLI 와 다르다.** 실제 `result` 프레임에는
`usage: {inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}` 가 온다
(CLI 2026.07.23 · 2026.08.04 양쪽 실측 + 번들의 프레임 조립부 판독).
→ ③의 CONTESTED 항목(2026-02-27 직원 발언)이 **맞았고 문서에 반영이 안 된 것**이다.

**다만 이것은 점유량이 아니다.** 턴 안의 모든 모델 호출을 합산한 **처리량**이다:
- 툴 없는 턴 3연속 — `input+cacheRead` = 18,288 → 18,425 → 18,557 (프롬프트 크기와 일치)
- 툴 10회 호출 턴 1회 — **113,872** (실제 대화 내용 ~33K → **3.4배 초과**)

ACP 쪽도 실물로 확인했다: `usage_update` 는 CLI 번들에 **스키마로만** 있고(전체 1회),
ACP 서버가 실제 방출하는 sessionUpdate 9종에 없다. `session/prompt` 결과는 `{stopReason}` 뿐이라
**ACP 는 stream-json 보다도 적다.**

### 남은 것 (이 변경 범위 밖)
- **표시 문구** · `남은 양` 표기 전환 → D-02 용어표와 함께 결정
- 카탈로그의 `context: "500K"` 는 Cursor 변형에 대해 여전히 틀린 값(실제 256k).
  분자를 못 구하니 비율은 어차피 못 만들어 **고치지 않았다** — 별건으로 남긴다.

### 작업 위치 (2026-08-09, cursor-context 인계 후)
위 5파일 변경은 `431e1cb "Beta prep: diagnostics, crash records, and the cross-harness lock"` 에
다른 항목들과 함께 이미 커밋돼 master 에 있다.
- 이어지는 코드 작업: 워크트리 `C:/Project/AgentPartyApp-b07` · 브랜치 `fix/b-07-cursor-context` (base `bcb0649`)
- `node_modules` 는 master 설치본으로 junction (b10 선례). `typecheck` 통과 확인 — 툴체인 정상
- **문서(이 파일)는 master 에서 관리한다.** 워크트리에 가두면 다른 사람이 못 읽는다

---

## ✅ 구현됨 2/2 (2026-08-09, cursor-context) — 분자도 제거했다

**사용자 결정(2026-08-09)**: 토큰 수를 빼고, **최대 컨텍스트량도 표기하지 않으며**, 대신
*"컨텍스트 사용량과 자동 압축을 제공하지 않는다"* 를 문구로 적는다. (제시한 ⓐ/ⓑ/ⓒ 중 **ⓒ**)

앞 단계가 분모(창 크기)를 지웠지만 **분자는 화면에 남아 있었다** — `컨텍스트 40,228 토큰 (창 크기 미상)`.
그 값은 `input+output+cacheRead` 로, 도구 쓰는 턴에서 실제 대화의 **3.4배**다. 비율이 없을 뿐
여전히 지어낸 숫자였다.

### 바꾼 것 (7파일 · 워크트리 `C:/Project/AgentPartyApp-b07` · 브랜치 `fix/b-07-cursor-context`)
| 파일 | 변경 |
|---|---|
| `shared/harnessCapabilities.ts` | 플래그 `contextWindow` → **`contextUsage`** 로 개명(이제 분모만이 아니라 사용량 전체를 가른다) · `contextUsageNote` 추가(사유 문구를 데이터로 보유) |
| `core/cursorAdapter.ts` | `contextTokens` 필드 자체 제거 → 스냅샷은 항상 `undefined` · `lastTokens.context` 도 미설정(원장의 context 는 점유량이므로) |
| `renderer/workbench/memberStatus.ts` | `contextFor` 가 능력 없는 하네스에서 **즉시 반환**(영속된 옛 값도 차단) · `contextUsageNoteFor()` 신설 |
| `renderer/workbench/types.ts` | `MemberView.contextNote` 추가 |
| `renderer/workbench/ContextDonut.tsx` | `context` 선택적 · 미보고 시 **`—` + 사유 툴팁**, 링은 빈 링 |
| `renderer/workbench/Panel.tsx` | 사유가 있으면 미터 자리를 비우지 않고 유지 |
| `renderer/workbench/AutoCompactEditor.tsx` · `ModelCatalogModal.tsx` · `styles.css` | 다이얼로그·Runtime 편집기에서 **사용량 카드와 임계치 컨트롤을 사유 문구로 대체** · 수동 압축은 그대로 |

⚠️ **죽은 노브를 같이 없앴다.** Runtime 모달의 자동 압축 토글은 Cursor 에서 켜도 임계 판정 근거가
없어 아무 일도 일어나지 않았다. 켜지는 스위치를 남겨두는 것이 없는 것보다 나쁘다.

### 실측 검증 — 실제 앱 · 격리 워크스페이스 · Claude(haiku) 양성 대조
| 확인 | 결과 |
|---|---|
| Cursor 헤더 | 빈 링 + **`—`** · 툴팁에 사유 · 숫자 없음 |
| Cursor Auto-compact 다이얼로그 | 사용량 카드·토글·슬라이더 **전부 사라지고 사유 문구** · `지금 압축 실행` 은 유지 |
| Cursor Runtime 모달 | Auto-compact 자리에 사유 문구 (토글 없음) |
| **실제 Cursor 턴 1회 후** | `turnCount:1 · status:idle` 인데 스냅샷에 **`context` 를 포함하는 키가 0개** · 다이얼로그는 여전히 사유 문구뿐 → **숫자가 돌아오지 않는다** |
| **Claude 대조군** | 턴 후 `contextTokens: 31869` 보고 · 도넛 **16% 비율 정상** → 회귀 없음 |
| 툴체인 | `typecheck` ✅ · `build` ✅ · `test:ui` **base 와 동일한 선재 실패 1건**(`a busy member's toolbar shows Stop`) → 회귀 0 |

⚠️ **함정**: 앱을 재기동해도 이전 부트가 소유하던 멤버는
*"start skipped: member is running in another app process"* 로 세션이 안 뜬다.
턴 검증은 **새 멤버를 만들어** 돌려야 했다.

### WSL(원격 엔진) 검증 — 2026-08-09
워크스페이스 `wsl+Ubuntu-22.04:/home/dev/b07-wsl-ws`. 엔진 번들은 접속 시마다
`$HOME/.agent_party_app/server/engine-server.mjs` 로 **매번 복사**되므로 이 워크트리 빌드가 실제로 돈다
(`wslEngine.ts:43`).

| 확인 | 결과 |
|---|---|
| Cursor 하네스 멤버(원격 엔진) | 헤더 `—` · 다이얼로그 사유 문구 · 스냅샷 **context 키 0개** → Windows 와 동일 |
| 판정 위치 | 화면 판정은 렌더러의 `member.runtime` 하나로 하므로 **전송 경로와 무관**하다 — 코드 근거가 실측과 일치 |

⚠️ **WSL 에서 못 한 것 2가지 — distro 의 `cursor-agent` 가 로그인돼 있지 않다**
(`status --format json` → `isAuthenticated: false`). 그래서:
1. **성공한 Cursor 턴**을 못 봤다. 턴은 `Authentication required. Please run 'agent login'` 로 실패했다.
   (실패 턴에서도 context 키는 0개였다.)
2. **교차 하네스 경로(Cursor 구독 모델을 Claude/Codex 멤버에 물리는 것)** 를 못 봤다.
   이 경로는 설계상 **distro 안에서 ACP 릴레이로 돈다**(`engineServerEntry.ts:66` — distro 가 로그인을 소유).
   그 멤버의 `runtime` 은 `claude-code`/`codex` 라 **B-07 의 게이트가 적용되지 않고 미터가 그대로 뜬다.**
   ACP 가 usage 를 안 보내는데 그 미터에 무엇이 표시되는지는 **미확인**이다. → 아래 새 항목 후보 3번.

**사용자 결정(2026-08-09): distro 로그인은 하지 않고 이 확인은 건너뛴다.**
B-07 본체(Cursor 하네스)는 Windows·WSL 양쪽에서 검증 완료로 마감하고,
교차 하네스 표면은 새 항목 후보로만 남긴다.

### 🔴 범위 밖 결함 2건 (새 항목 후보)
1. **카탈로그 `Grok 4.5` 엔트리 하나가 서로 다른 두 창을 겸한다.** Runtime 모달의 모델 카드는
   Cursor 멤버에게도 **`CONTEXT 500K`** 를 그대로 보여준다. 그런데 그 엔트리는 OpenRouter 경유
   xAI 네이티브 Grok 4.5(500k)와 **Cursor 가 서빙하는 변형(256k)** 을 같은 행으로 쓴다.
   → **지우면 OpenRouter 경로의 맞는 값이 사라지고, 256k 로 바꾸면 OpenRouter 가 틀려진다.**
   한 행을 둘로 쪼개는 문제라 B-07 에서 처리하지 않았다.
2. **Cursor 로그인 상태 오탐 — Windows 에서만.** 앱은 `~/.config/cursor/auth.json` 을 읽는데
   (`core/cursorUsage.ts:31`, 주석은 *"the Windows CLI uses it too"*) **이 Windows 호스트에는 그 파일이 없다.**
   실제 CLI 는 `status --format json` 에서 `isAuthenticated: true` 를 반환하는데도 앱은
   *"Cursor CLI is not logged in on this host"* 배너를 띄운다.
   **WSL 에서 같은 코드가 정상 동작하는 것이 이를 확증한다** — distro 는 실제로 로그인이 안 돼 있고
   앱도 그렇게 보고했다. 즉 경로가 Linux 기준이고 **Windows 에서만 틀린다.**
   판정에 `cursor-agent status --format json`(이미 `cursorAgentAuthStatus()` 로 구현돼 있다)을 쓰면 된다.
   사용량 읽기 경로(B-04 계열)이지 턴 실행 경로가 아니다.
3. **교차 하네스 Cursor 구독 모델의 컨텍스트 미터가 미확인이다.** 위 WSL 절 참조.
   `runtime` 이 `claude-code`/`codex` 라 B-07 게이트 밖이고, 실제 모델은 usage 를 안 보내는 ACP 로 서빙된다.
   무엇이 표시되는지 아무도 확인하지 않았다.

---

## 🔎 Cursor CLI 가 컨텍스트를 노출하는 표면 — 전수 조사 (2026-08-08, cursor-context)

설치된 최신 번들 `%LOCALAPPDATA%\cursor-agent\versions\2026.08.04-aaa8809`(217MB) 정적 판독 +
공식 문서 대조. **결론: 값은 CLI 안에 완전한 형태로 존재하지만, 우리가 쓰는 헤드리스 경로로는 안 나온다.**

| 표면 | 컨텍스트 정보 | 우리가 쓸 수 있나 |
|---|---|---|
| **TUI 미터** | `contextWindowSize` · `totalTokensUsed` · `percentFull` · 카테고리별 토큰 분해 | ✗ 화면 렌더 전용 |
| **`statusLine`** | `context_window:{context_window_size, used_percentage, total_input_tokens, total_output_tokens, current_usage, remaining_percentage}` | ✗ 페이로드가 React `useMemo` 안에서 조립된다 → **TUI 전용** |
| **hooks** | `preCompact` → `context_tokens` · `context_window_size` · `context_usage_percent` · `trigger:"manual"\|"auto"` · `messages_to_compact` | ⚠️ **압축 직전에만 발화** — 계기판 아님 |
| **ACP** | 없음 (`usage_update` 미방출) | ✗ |
| **`stream-json`** (우리 경로) | `result.usage` 4필드 = 턴 합산 처리량 | ⚠️ 점유량 아님 |

**Cursor CLI TUI 는 Claude Code 의 `/context` 와 동등한 미터를 그린다.** 즉 값이 없어서 안 주는 게 아니라
**헤드리스 표면에 안 실은 것**이다. `statusLine` 페이로드 스키마는 Claude Code 의 것을 그대로 복제했다
(`context_window.used_percentage` · `context_window_size` 필드명까지 동일).

### 근거 — ACP 방출 목록
번들이 실제로 생성하는 `sessionUpdate` 리터럴은 9종이고 `usage_update` 는 없다:
```
user_message_chunk, agent_message_chunk, agent_thought_chunk,
tool_call, tool_call_update, plan,
available_commands_update, current_mode_update, session_info_update
```
`usage_update` 는 파싱용 스키마 union 에만 1회 등장한다. → **포럼의 Cursor 직원 진술이 최신 빌드에서도 참.**
(`beta-impl` 이 ACP 서버를 실제로 띄워 독립 확인 — 정적 판독과 실물 관측이 일치한다.)

### 문서에 없는 필드 — `afterAgentResponse`
공식 문서는 페이로드가 `{text}` 뿐이라고 하지만, 번들은
`input_tokens` · `output_tokens` · `cache_read_tokens` · `cache_write_tokens` 를 함께 넘긴다.
**문서보다 번들이 앞선다** — Cursor 문서만 읽고 판단하면 안 된다.

### 압축은 Cursor 가 스스로도 한다
`/summarize`(별칭 `/compress`)가 수동 압축이고, `preCompact` 훅 페이로드의
`trigger` 가 `"manual"` 이 아니면 `"auto"` 로 보고된다 → **자동 압축 경로가 CLI 안에 존재한다.**
→ 1-14-2 로 우리 자동 압축이 멈춰도 **압축 기능 자체가 사라지는 것이 아니다.** 주체가 하네스로 넘어간다.
⚠️ 임계값·발화 조건은 확인하지 못했다(추정 아님, **미확인**).

### 분모는 우리가 넘기는 인자이기도 하다
`--model` 이 파라미터화 모델을 받는다 — `--help` 원문:
`'claude-opus-4-8[context=1m,effort=high,fast=false]'`.
`--list-models` 라벨에도 크기가 박혀 있다(`Opus 5 1M`, `GPT-5.5 1M High`).
**Grok 계열 라벨에는 크기 표기가 없다** — 500K 의 근거는 어디에도 없다.

---

## ✅ 첫 갈래 결과 — **"그럴듯한 비율이 뜨는데 틀리다"**

문서가 가르라고 한 두 경우 중 **나쁜 쪽**이다. 규칙(*"모르면 비율을 만들지 않는다"*) 위반이다.

### 실측 (실제 원장의 Cursor 턴 61건)
```
context 값이 있는 턴   : 61 / 61
500K 창을 넘는 턴      : 27 (44%)      ← 점유량이면 불가능
표시됐을 최대 비율     : 1,098.9%
턴 간 값이 감소한 횟수 : 31 / 60       ← 점유량은 압축 때만 줄어든다
```
모든 샘플에서 **`context` 가 `input + output + cacheRead` 와 바이트 단위로 동일**했다.

### 원인 — 분자가 틀렸다
`cursorAdapter.ts:654`
```ts
this.contextTokens = (input || 0) + (output || 0) + (cache || 0);  // ← 그 턴이 쓴 토큰 합계
```
**"그 턴이 쓴 비용"이지 "창에 얼마나 차 있나"가 아니다.**

대조 — 나머지 둘은 제대로 한다:
- **Claude**: `contextTokensFromUsage()` + `withContextOccupancy()`
  (주석: *"`context` = the live occupancy meter"*)
- **Codex**: 하네스가 준 `params.tokenUsage.contextWindow` 와 점유량을 그대로 사용

### 분모는 의외로 맞다 (다만 취약하다)
`parseContextTokens("500K")`(`:311`) — 카탈로그의 Grok 4.5 가 500K 이고
`isSupportedCursorModel` 이 `auto` 와 Grok 4.5 만 허용하므로 지금은 맞다.
⚠️ 단 **카탈로그를 조회하지 않고 문자열로 박아둔 것**이라 **모델이 늘면 조용히 틀어진다.**

`auto` 모델은 `contextWindow: undefined` 로 두어 **비율을 안 만든다 — 그 부분은 1-14-1 을 지킨다.**

## "멈춘 값" 가설은 아니다 — [B-04](B-04%20사용량%20산출.md) 와 다르다
매 턴 갱신되지만 **엉뚱한 양**이다. 오히려 **요동친다**
(1.17M → 100K → 67K → 183K → 1.36M).
**사용자가 "이상하다"고 한 것이 이 요동일 가능성이 높다.**

## 🔴 곁다리 확인 — 문서 예상과 **반대**다. 그리고 더 나쁘다.

문서는 *"컨텍스트 크기를 모르면 자동 압축이 아예 안 걸린다"* 를 걱정했다.
**Cursor 는 크기를 안다고 착각하는 쪽**이다.

자동 압축(`App.tsx:231`)은 `view.context.used / total` 로 걸리므로:
- **큰 턴 한 번(234%)** → 임계치 훌쩍 넘김 → **필요 없는 압축이 발동**
- **긴 대화 끝의 작은 턴(10%)** → **정말 꽉 찼어도 발동 안 함**

> 즉 **압축이 안 걸리는 게 아니라 엉뚱하게 걸린다.**
> 사용자가 켜 둔 자동 압축이 **대화를 아무 때나 날린다**는 뜻이다.

(`auto` 모델만 문서 예상대로 — 창 미상이라 압축 미발동.)

---

## 외부 조사 결과 (2026-08-08) — **Cursor 는 점유량을 제공하지 않는다**

### ① ACP 에는 필요한 것이 이미 정의돼 있다
RFD *"Session Usage and Context Status"* (Completed 2026-06-05, agentclientprotocol.com/rfds/session-usage):
- `session/update` 알림의 `sessionUpdate: "usage_update"` → `UsageUpdate`
  - **`used`** (필수) — 현재 컨텍스트에 든 토큰 = **점유량**
  - **`size`** (필수) — 컨텍스트 창 크기
  - 클라이언트가 `remaining = size - used`, `percentage = used / size` 를 계산
- 별도로 **턴 단위** 데이터는 `PromptResponse.usage`(UNSTABLE):
  `total/input/output/thought/cached_read/cached_write_tokens`
- RFD 명시: **캐시된 토큰도 컨텍스트를 차지하므로 `used` 에 포함해야 한다.**

### ② Cursor 는 그것을 보내지 않는다 (Cursor 직원 확인)
- Cursor 직원 발언: ***"Right now, `agent acp` really doesn't send `usage_update`."*** 그리고
  **`PromptResponse.usage` 도 채워지지 않는다.**
  (forum.cursor.com/t/cli-emit-acp-usage-update-…/165358 — 기능 요청으로 등록, 일정 없음)
- 문서화된 `--output-format json` / `stream-json` 스키마에 **usage·token·cost·context 필드가 아예 없다**
  (cursor.com/docs/cli/reference/output-format). `result` 이벤트는
  `type, subtype, duration_ms, duration_api_ms, is_error, result, session_id, request_id` 뿐.
- ⚠️ **CONTESTED**: 2026-02-27 에 Cursor 직원이 *"최신 CLI 의 마지막 json 출력에 토큰 사용량이
  포함될 것"* 이라고 언급했으나 **현재 문서에 반영돼 있지 않고** 이후 사용자 보고도 부재를 말한다.
  설령 있더라도 그것은 **턴 단위 비용**이지 점유량이 아니다.

### ③ Zed 가 확증한다
Zed 는 **1.7.2(PR #58680)** 에서 ACP 에이전트용 컨텍스트 미터를 넣었다
(`TokenUsage{max_tokens, used_tokens}`, `AcpThreadEvent::TokenUsageUpdated`, 전적으로 ACP `usage_update` 기반).
**Claude Code 등에서는 동작하지만 Cursor 에서는 표시하지 못한다** —
그것이 위 Cursor 기능 요청의 명시된 동기다.
→ **ACP 클라이언트를 제대로 구현해도 Cursor 에서는 못 얻는다.**

### 🔴 ④ 분모도 틀렸다 — 별개 버그
- **Cursor 의 Grok 4.5 는 256k 다.** xAI 네이티브 Grok 4.5(500k)와 **다른 모델**이며,
  Cursor 직원이 *"expected behavior, not a bug"* 라고 확인했다
  (forum.cursor.com/t/why-does-grok-4-5-in-cursor-only-have-a-256k-context-window/166519).
  → **`cursorAdapter.ts:311` 의 `"500K"` 는 틀린 값이다.**
- **`auto` 는 고정 창이 없다** — 모델 사이를 라우팅하므로 어떤 상수를 넣어도 일부 턴에서 틀린다.
- cursor.com/docs/models 에 **컨텍스트 창 컬럼이 없고**, 조회 가능한 API 도 없다.

---

## 🔵 레퍼런스 구현 실측 (2026-08-08) — **맞교환이 아니었다**

로컬에 설치된 **실물 바이너리**에서 확인. 문서가 아니다.

### Codex CLI (`codex.exe`)
- `"You have unknown tokens left in this context window."` ← **모름 상태가 1급 문구로 존재**
- `get_context_remaining` 툴: *"Remaining tokens …, **or null when unavailable**"*
- statusline 필드: *"omitted when unavailable"*
- 표기는 **`100% context left`** — 쓴 양이 아니라 **남은 양**

### Claude Code (`claude.exe`)
- `"Context usage isn't available over this remote connection"`
  ← **점유량을 못 구하는 연결에 대한 전용 문구가 이미 있다. 우리 상황과 같다**
- statusline: `.context_window.remaining_percentage // empty` — **비면 아예 안 그림**
- 표기: `% remaining` · `Context low (` — 역시 **남은 양**
- **자동 압축 임계 = `min(설정, 모델 최대 창)` — 실제 점유량에만 건다**

### Zed
ACP `usage_update` 기반 미터를 갖되 **Cursor 에는 안 그린다**(웹 조사).

### 결론
| 안 | 선례 |
|---|---|
| **ⓐ 비율 포기 → "알 수 없음"** | **3/3** |
| ⓑ 추정 | **0/3** — 어느 구현도 점유량을 지어내지 않는다 |

**우리 전제와 충돌 없음** — 멀티 멤버라 한 멤버만 비는데, 그건 Codex 의
*"omitted when unavailable"* 과 같은 모양이다.

## 🔴 그런데 더 중요한 것 — 자동 압축은 선택지가 아니다

**Claude Code 도 Codex 도 압축 임계를 실제 점유량에만 건다.**
*"추정치로 압축한다"* 는 모드가 **어느 쪽에도 없다.**

그리고 **우리 기능정의서에도 이미 그 규칙이 있다** — 1-14-2:
> ⚠ **전체 컨텍스트 크기를 모르면 자동 압축하지 않는다.**

**즉 이건 새로 정할 일이 아니라 이미 정해진 규칙이 안 지켜지고 있는 것이다.**
Cursor 가 그 규칙을 비껴가는 이유는 하나다 — **`cursorAdapter.ts:311` 이 `"500K"` 를 박아둬서
앱이 "창 크기를 안다"고 믿기 때문**이다.

→ **하드코딩을 걷어내면 Cursor 는 `auto` 와 같은 경로로 떨어진다.**
비율도 안 만들고(1-14-1), 자동 압축도 안 걸린다(1-14-2). **두 규칙이 저절로 복원된다.**

## 채택 기준 적용 (*"없어서 사용자가 막히는가"*)
- **가져온다**: 모름 표기 · **남은 양** 표기 · **모르면 압축 안 함** → **막힌다**(대화가 날아감)
- **안 가져온다**: Codex 의 `get_context_remaining` 툴, 컨텍스트 그리드 시각화 → 불편일 뿐

## ⚠️ 남은 결정
**"—"로 비울지, 문구를 넣을지, 넣으면 뭐라고 쓸지.**
→ [D-02](D-02%20내부%20용어%20노출.md) 용어표와 한 몸이므로 같이 정한다.
(레퍼런스 문구: `"Context usage isn't available over this remote connection"` /
`"You have unknown tokens left in this context window."`)

---

## ~~⚠️ 결정 — 맞교환의 성격이 바뀌었다~~ (위로 대체됨)

**"더 나은 공식"은 존재하지 않는다.** 가용한 데이터(턴 단위 input/output/cache)로는
점유량을 계산할 방법이 없고(그 값은 정당하게 창을 초과한다), **분모조차 신뢰할 수 없다.**

### ⓐ Cursor 멤버는 비율을 표시하지 않는다 — **권장**
1-14-1(*"전체 크기를 모르면 비율을 만들지 않는다"*)을 그대로 따른다.
**선례가 이미 있다** — `auto` 모델이 그 상태다.
- 대가: **Cursor 멤버는 자동 압축을 쓸 수 없다**(임계 판정 근거가 없으므로).
  ⚠️ 다만 **지금 상태는 자동 압축이 엉뚱하게 발동하는 것**이므로,
  기능이 없어지는 것이 아니라 **잘못 동작하던 것이 멈추는 것**이다.

### ⓑ 로컬 누적 추정치를 쓰고 "추정"으로 표시한다
앱이 자기가 보낸/받은 토큰을 누적해 근사한다.
- 대가: 캐시·시스템 프롬프트·하네스 내부 압축을 알 수 없어 **오차가 누적된다.**
  "추정"이라고 표시해도 자동 압축을 그 위에 얹으면 여전히 잘못 발동할 수 있다.

### 어느 쪽이든 함께 할 것
- **`"500K"` 하드코딩 제거** — 값이 틀렸고, 문자열 상수라 모델이 늘면 또 틀어진다.
- **ACP `usage_update` 수신 경로를 미리 만들어 둔다** — 스키마가 확정돼 있으므로,
  Cursor 가 보내기 시작하면 그때 바로 정상 동작한다.

---

## 무엇을

Cursor 멤버의 컨텍스트 사용량 계산이 맞지 않는 것 같다.

## ⚠️ 먼저 가를 것 — 두 경우는 작업 성격이 완전히 다르다

**지킬 규칙** (기능정의서 1-14-1):
> **전체 컨텍스트 크기를 모르면 토큰 수만 표시하고 비율을 만들지 않는다.**

| 증상 | 판정 |
|---|---|
| **비율이 안 뜬다 / 토큰 수만 나온다** | **규칙대로 동작한 것일 수 있다.** Cursor 의 전체 컨텍스트 크기를 앱이 모르는 상태 |
| **그럴듯한 비율이 뜨는데 틀리다** | **지어낸 숫자다.** 규칙 위반이므로 고칠 대상 |

**어느 쪽인지부터 확인한다.** 앞이면 "모른다는 걸 더 잘 보여주기"이고,
뒤면 "잘못된 계산 고치기"다.

## 왜 Cursor 에서만인가 — 유력한 가설

**세 하네스 중 프로세스 모델이 가장 다르다.**

> **Cursor 는 턴마다 프로세스를 새로 띄운다.** (프로세스가 없는 것이 정상 대기 상태다 — [#21])

턴 경계로 누적하거나, 프로세스 수명 동안 유지되는 값을 전제하는 계산이라면
**여기서만 어긋난다.**

관련 이력: [#10] 에서 Cursor 는 *"턴이 완료될 때만 채팅에 기록한다"* 는 성질 때문에
정지된 턴이 통째로 사라졌다. **턴 경계 처리가 다른 하네스와 다르다**는 것이 이미 확인된 사실이다.

## ⚠️ B-04 와 다른 수치다 — 묶지 말 것

| | 성질 |
|---|---|
| **컨텍스트** (이 항목) | **점유량** — 지금 얼마나 차 있나. 줄어들 수 있다 |
| **사용량** ([B-04](B-04%20사용량%20산출.md)) | **누적** — 지금까지 얼마나 썼나. 줄지 않는다 |

**둘을 한 작업으로 묶으면 서로의 전제를 오염시킨다.**
(`tokens.context` 를 누적 합으로 착각하는 것이 이미 알려진 함정이다.)

## 볼 자리

- 자동 압축이 **컨텍스트 크기를 모르면 동작하지 않는다**(기능정의서 1-14-2 ⚠).
  → **Cursor 멤버는 자동 압축이 아예 안 걸리고 있을 수 있다.** 같이 확인할 것.
- 닫힌 멤버의 마지막 값 흐림 처리와 `~` 표기가 Cursor 에서도 맞는지

## 연관

- [B-04](B-04%20사용량%20산출.md) — 다른 수치
- [D-05](D-05%20비용%20표시.md) — 컨텍스트 도넛 자리에 비용을 얹으려는 항목. **같은 자리**
