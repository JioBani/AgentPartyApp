# B.AI 추론 설정 조사 (2026-09-15)

B.AI(`api.b.ai`) 모델을 AgentParty에 붙이면서 추론 설정(effort, thinking)이 모델에 적용되지 않는 문제를 조사한 기록이다. 결정은 보류 상태다.

## 1. 문제

- **Claude Code 하네스:** Anthropic Messages로만 보낸다. 추론 설정은 `thinking`과 `output_config.effort`에 담긴다.
  - SDK는 Claude가 아닌 모델 이름에도 이 값을 보낸다.
  - 실제 요청 캡처에서 `thinking:{type:"adaptive"}`, `output_config:{effort:"medium"}`을 확인했다.
- **내장 게이트웨이(`src/core/routerShim.ts`):** 모델 ID만 바꾸고 나머지를 그대로 넘긴다. 추론 설정 변환 코드는 없다.
  - 추론 설정이 적용되는지는 제공자의 Anthropic 입구가 결정한다.
- **제공자별 동작**

| 제공자 | Anthropic 입구의 추론 설정 처리 | 근거 |
|---|---|---|
| DeepSeek 직결 | `output_config.effort`를 자체 단계로 매핑. `budget_tokens`는 무시 | DeepSeek 문서 |
| Z.ai(GLM), Alibaba(Qwen) | 서버가 매핑하고 매핑표를 문서화 | 각사 문서 |
| OpenRouter | 공식 보장 문구 없음 | 실측 필요 |
| B.AI | MiniMax M3만 반응. 나머지는 버림 | 실측 |

- **Codex 하네스:** Responses로만 보낸다. 0.154.0 바이너리에 `` `wire_api = "chat"` is no longer supported. ``가 있다.

## 2. B.AI 입구별 공식 지원

- **Responses:** "GPT와 DeepSeek 계열만 지원"(API 문서).
  - Hy4 Preview·Qwen3.8-Max 모델 페이지에는 Responses 지원이라고 적혀 있어 API 문서와 충돌한다. 미확인.
- **Chat Completions:** 모든 모델. 추론 파라미터 이름은 모델 페이지마다 다르다. API 문서의 파라미터 표에는 없다.
- **Messages:** `thinking`을 "Extended thinking configuration" 한 줄로만 설명한다.
- **B.AI Claude Code 가이드:** `ANTHROPIC_BASE_URL=https://api.b.ai` 설정만 있고 추론 설정 안내는 없다.
  - Claude Code 도구 호출을 검증했다는 모델 목록에는 22개 중 gemini-3.5-flash, minimax-m3, minimax-m2.7만 들어 있다(2026-03 기준).

## 3. 모델별 추론 파라미터 (문서 + 실측)

| 모델 | 입구 | 파라미터·값 | 기본값 | 끄기 | 실측 |
|---|---|---|---|---|---|
| DeepSeek V4.1 Flash | Responses | `reasoning.effort` low/high/max, `none` | high | ✅ | 켜기/끄기 ✅, 강도 차이 미관측. Chat `reasoning_effort` 차이 없음 |
| DeepSeek V4 Flash Vision Exp | Responses·Chat·Messages | low/high/max (medium·xhigh→high) | high | ✅ | — |
| DeepSeek V4 Pro | Responses | 문서 없음 | — | — | — |
| GLM-5.3-Flash / GLM-5.3 | Chat | `reasoning_effort` low/high/max | max | ❌ | Flash: low 1261 / high 5872 토큰 |
| GLM-5.2 | Chat | `reasoning_effort` high/max | — | — | — |
| Kimi K3 | Chat | `reasoning_effort` max만 | max | ❌ | — |
| Kimi K2.6 | Chat | 문서 없음 | — | — | — |
| Qwen3.8-Flash | Chat | `enable_thinking` | 켜짐 | ✅ | 켜기/끄기 ✅, `reasoning_effort` 효과 없음 |
| Qwen3.8-Max | Chat | `reasoning_effort` low/medium/xhigh | xhigh | — | — |
| Qwen 27B | Chat | 켜기/끄기(이름 미기재) | — | — | — |
| Hy3 | Chat | `no_think`/`think_low`/`think_high` | — | ✅ | Chat `reasoning_effort` low 2881 / high 7050 토큰 |
| Hy4 Preview | Chat | low/high | high | — | — |
| MiMo-V2.5(-Pro) | Chat | `thinking.type` | 켜짐 | ✅ | B.AI 과부하로 측정 못 함 |
| Gemini 3.8 / 3.5 Flash | Chat | low/medium/high (3.5는 minimal 포함) | medium | — | — |
| Gemini 3.6 / 3.5-Lite / 3.1 Pro | Chat | 문서 불충분 | — | — | Lite: 생각 내용 비노출 |
| MiniMax M3 | Messages로도 됨 | 문서 없음 | — | — | Messages thinking/effort 반응 ✅ |
| MiniMax M2.7 | Chat | 문서 없음 | — | — | — |

Messages 입구에 고유 파라미터(`reasoning_effort`, `enable_thinking`, `thinking` 예산)를 끼워 보낸 실측에서는 Qwen·GLM·Hy3·DeepSeek 모두 효과가 없었다.

## 4. 검토한 해결책

### A. 기존 CLIProxyAPI 브리지에 B.AI 등록 (가장 싼 후보)

앱은 이미 `cli-proxy-api.exe`(`127.0.0.1:8317`)를 구독 브리지로 쓴다. v7.3.4 소스(`8335eac`)를 읽고 확인한 사항은 다음과 같다.

- **변환:** `openai-compatibility` 제공자로 `https://api.b.ai/v1`을 등록하면 `/v1/messages` 요청이 Chat으로 변환되고 응답은 Claude SSE로 돌아온다. 도구와 이미지도 포함된다.
  - 변환 코드: `internal/translator/openai/claude/`
- **추론:** 내보내는 필드는 `reasoning_effort` 하나다.
  - adaptive는 effort를 그대로 넘기고, disabled는 `none`, `budget_tokens`는 단계로 바꾼다.
  - `models[].thinking.levels`로 가장 가까운 단계에 맞춘다(clamp).
  - `none`을 levels에 넣지 않으면 끄기가 가장 낮은 단계로 조용히 바뀐다.
- **기타 파라미터:** `payload.override/filter` 규칙으로 넣는다. 모델 이름과 최종 `reasoning_effort` 값을 조건으로 쓸 수 있다. override와 filter의 실행 순서는 미확인이다.
- **위험 1:** `reasoning_content`를 **서명 없는** thinking 블록으로 돌려준다. 과거 xAI 경로에서 Claude Code가 서명 없는 thinking 때문에 답을 버린 이력이 있다.
- **위험 2:** DeepSeek 도구 대화에서 필요한 `reasoning_content` 재전송은 `is-compat: true`일 때만 된다. 위험 1과 충돌할 수 있다.
  - 관련 이슈: #4893(텍스트 전용 턴 400), PR #3800(DeepSeek/MiMo, open).
- **위험 3:** v7.2.122 이상이 필요하다.
  - 이 PC의 `~/cliproxyapi` 바이너리는 2026-06-21자로 v7.2.x 초반으로 추정된다.
  - 앱은 `~/cliproxyapi/config.yaml`이 있으면 그 파일을 쓰고 직접 관리하지 않는다. 브리지 소유권 미해결 문제와 겹친다.
- **확인 계획(미실행):** QA용 별도 인스턴스에 GLM-5.3-Flash와 DeepSeek V4.1 Flash만 등록하고 Claude Code로 도구 1회 대화를 한다. 유료 호출 4회 안팎.

### B. Chat 네이티브 하네스 추가

조사 문서는 `docs/Anthropic-Messages-변환-조사-2026-09-15.md`다(브랜치 `docs/messages-conversion-research`).

- **1순위 Qwen Code:** 모델별 추론 dialect가 가장 체계적이다. stream-json, ACP, MCP를 지원한다.
- **2순위 OpenCode:** 공식 TS SDK, 서버·SSE, 세션·중단·승인 API가 있다. 매핑표는 직접 만들어야 한다.
- **공통 주의:** B.AI 호스트 전용 설정과 모델 매핑표가 필요하다. `reasoning_content`는 도구 대화의 필수 상태다.
- **BAI code(B.AI 자체 CLI):** 부적합하다.
  - Python 약 1,400줄이고 소스는 비공개다.
  - 추론 파라미터를 보내지 않고, 받은 생각 내용도 버린다.
  - JSON 출력, SDK, ACP, MCP, 승인 기능이 없다.

### C. 게이트웨이 자체 변환기

- **선례:**
  - new-api `relayconvert/reasoning`: 중립 intent를 만들고 제공자별로 렌더링한다. 변환 경고를 기록한다.
  - LiteLLM: `output_config.effort`를 `reasoning_effort`로 바꾸고, 능력 플래그에 따라 단계를 낮춘다.
- **TS 후보:** `@the-next-ai/ai-gateway`의 어댑터/IR.
- **비용:** 도구, 스트리밍, thinking 서명, 재전송, usage, 캐시를 모두 책임져야 하므로 비용이 가장 크다.

## 5. 현재 상태

- 카탈로그의 B.AI 22개는 `reasoning: null`이다. Claude Code에서는 대화와 도구만 확인됐다.
- Codex 하네스는 DeepSeek V4.1 Flash와 Vision Exp만 켜져 있다.
  - V4 Pro는 DeepSeek 직결과 모델 ID가 같아 앱이 구분하지 못해 꺼져 있다.
- 결정 대기: A 확인 호출 진행 여부, B/C 채택 여부.
