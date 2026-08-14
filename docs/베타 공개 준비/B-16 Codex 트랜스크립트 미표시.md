# B-16. Codex 트랜스크립트 항목 미표시 — ❌ **오탐. 항목 취소**

**판정: 차단 아님 (2026-08-08 실측으로 기각)** · 출처: [F-11](F-11%20Claude%20Codex%20격차.md) 조사 → **그 조사가 틀렸다**

---

## 실측 결과 — 셋 다 이미 처리·표시된다

| 항목 | Codex 가 보내나 | 어댑터가 처리하나 | 화면에 그려지나 |
|---|---|---|---|
| `webSearch` | ✅ 보냄 | ✅ | ✅ **그려짐** |
| `imageGeneration` | ✅ 보냄 | ✅ | ✅ **그려짐** |
| `subAgentActivity` | ❌ **애초에 안 옴** | — | ✅ (실제 채널은 따로 있고 그려짐) |

### 근거 ① 라이브 실측
실제 앱 + 실제 Codex(gpt-5.4-mini) 세션에서 RawLogger 로 JSON-RPC 원문 녹화:
- 웹검색 지시 → `"type":"webSearch"` **2건**(`item/started`+`item/completed`) 수신
- 이미지 생성 지시 → `"type":"imageGeneration"` **2건** 수신
- **DOM 실측**(`/api/measure`, 캡처 육안 아님)으로 카드가 실제로 그려진 것 확인:
  `wb-tool-name=web_search | wb-tool-source=web`, `image_generation | source: image | completed`

### 근거 ② `subAgentActivity` 는 오지 않는다
저장소에 이미 있는 **실제 녹화본**(`scripts/fixtures/subagents/codex-gptmini-2subagents.jsonl`,
서브에이전트 2개를 실제로 돌린 트래픽)에서:
- `subAgentActivity` **0건**
- `collabAgentToolCall` **4건** ← **이것이 진짜 채널이다**

어댑터 주석도 같은 말을 한다(*"Optional lifecycle marker (absent in observed runs)"*).
기존 `scripts/qa-subagent-tracker.mjs` 로 그 실트래픽을 재생하니 **전부 통과**
(`2 collab subagents attributed by threadId`, `child-thread items routed to subagents (75)`).

---

## ⚠️ 왜 조사가 틀렸나 — 방법론 교훈

조사는 `src/shared/transcriptEvents.ts` 와 `Transcript.tsx` **두 파일만** 봤다.
거기에 `webSearch`·`imageGeneration` 이라는 이름이 없으니 *"처리 안 함"* 으로 결론냈다.

**그런데 이 항목들은 `codexAdapter` 가 범용 `tool_call` 로 변환해서 올린다**
(`src/core/codexAdapter.ts:1353-1372`):
- `webSearch` → `web_search` (`source: web`)
- `imageGeneration` → `image_generation` (`source: image`)

**렌더러에 그 이름이 없어도 정상 표시된다.**

> **교훈: "렌더러에 이름이 없다"는 "화면에 안 나온다"가 아니다.**
> 변환 계층을 건너뛰고 양 끝만 보면 이런 오탐이 난다.
> [조사-미완 미검증 표면](조사-미완%20미검증%20표면.md) 이 적은 *"코드 읽기로는 안 잡힌다"* 의
> **반대 방향 사례**다 — 코드 읽기가 **없는 결함을 만들어냈다.**

그리고 **시점 문제도 있다.** `subAgentActivity` 핸들러는 서브에이전트 UI 커밋(`4d14ec8`)에서
들어왔고 `webSearch`/`imageGeneration` 은 그보다 **먼저** 있었다.
F-11 이 대조한 격차 문서가 낡았을 뿐 아니라, **F-11 조사 자체도 이미 낡은 전제 위에 섰다.**

---

## 남는 진짜 작업 — 문서 하나

**구현 작업은 없다.** 원래 이 문서가 지적한 *"하네스 비대칭이 문서에 없다"* 는
**여전히 유효하되 내용이 반대**다.

기능정의서(1-9-2 도구 실행 표시 · 1-17 서브에이전트)에 적을 것은
~~"Codex 는 이것들이 안 보인다"~~ 가 아니라:

> **Codex 서브에이전트는 `collabAgentToolCall` + 자식 threadId 로 잡히며,
> `subAgentActivity` 는 오지 않는다.**

## 캡처

`shots/b16-websearch-rendered.png` · `shots/b16-codex-cards.png`
원문 녹화: `scratchpad/b16-userdata/logs/logs/2026-08-08T03-56-01-169Z-session-*.ndjson`
