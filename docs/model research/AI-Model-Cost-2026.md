# AI 모델 비용표 — 저가 → 고가

> 조사 시점: **2026-06-27** · 작성: `team/analyst`
> 기준 문서: [AI-Model-Lineup-2026.md](AI-Model-Lineup-2026.md) 의 모델을 그대로 사용
> 가격 단위 = **USD / 1M tokens**. 정렬: **혼합 비용 = (3×In + Out) / 4** 오름차순 *(코딩 에이전트 입력:출력 ≈ 3:1 가중)*
> **출처 마커**: `OR` = OpenRouter / **`API` = 각 provider 공식 API 가격** (OpenRouter 미노출분을 공식가로 보강)

---

## 비용표 (저가순)

| # | Model | Provider | In | Out | 혼합(3:1) | Ctx | 출처 |
|---|---|---|---|---|---|---|---|
| 1 | Qwen3 Coder Flash | Qwen | 0.195 | 0.975 | **0.39** | 1M | OR |
| 2 | Qwen3.6 Flash | Qwen | 0.1875 | 1.125 | **0.42** | 1M | OR |
| 3 | **GPT-5.4 nano** | OpenAI | 0.20 | 1.25 | **0.46** | — | **API** |
| 4 | MiniMax-M3 | MiniMax | 0.30 | 1.20 | **0.53** | 1.05M | OR |
| 5 | DeepSeek V4 Pro | DeepSeek | 0.435 | 0.87 | **0.54** | 1.05M | OR |
| 6 | Qwen3.7 Plus | Qwen | 0.32 | 1.28 | **0.56** | 1M | OR |
| 7 | Gemini 3.1 Flash Lite | Google | 0.25 | 1.50 | **0.56** | 1.05M | OR |
| 8 | Qwen3 Coder 480B A35B | Qwen | 0.22 | 1.80 | **0.62** | 262K | OR |
| 9 | Qwen3.6 27B | Qwen | 0.2885 | 2.65 | **0.88** | 262K | OR |
| 10 | Kimi K2 Thinking | Moonshot | 0.60 | 2.50 | **1.08** | 262K | OR |
| 11 | Grok Build 0.1 | xAI | 1.00 | 2.00 | **1.25** | 256K | OR |
| 12 | Qwen3 Coder Plus | Qwen | 0.65 | 3.25 | **1.30** | 1M | OR |
| 13 | Kimi K2.6 | Moonshot | 0.66 | 3.41 | **1.35** | 262K | OR |
| 14 | Kimi K2.7 Code | Moonshot | 0.74 | 3.50 | **1.43** | 262K | OR |
| 15 | GLM-5.2 | Z.AI | 0.95 | 3.00 | **1.46** | 1.05M | OR |
| 16 | Grok 4.3 | xAI | 1.25 | 2.50 | **1.56** | 1M | OR |
| 17 | Grok 4.20 | xAI | 1.25 | 2.50 | **1.56** | 2M | OR |
| 18 | Grok 4.20 multi-agent | xAI | 1.25 | 2.50 | **1.56** | 2M | OR |
| 19 | **GPT-5.4 mini** | OpenAI | 0.75 | 4.50 | **1.69** | 400K | **API** |
| 20 | Qwen3.7 Max | Qwen | 1.25 | 3.75 | **1.88** | 1M | OR |
| 21 | Claude Haiku 4.5 *(벤치 기준선)* | Anthropic | 1.00 | 5.00 | **2.00** | 200K | OR |
| 22 | Qwen3.6 Max Preview | Qwen | 1.04 | 6.24 | **2.34** | 262K | OR |
| 23 | **Magistral Medium 2506** | Mistral | 2.00 | 5.00 | **2.75** | 41K | **API** |
| 24 | Gemini 3.5 Flash | Google | 1.50 | 9.00 | **3.38** | 1.05M | OR |
| 25 | Gemini 3.x Pro | Google | 2.00 | 12.00 | **4.50** | 1.05M | OR |
| 26 | **GPT-5.3-Codex** | OpenAI | 1.75 | 14.00 | **4.81** | — | **API** |
| 27 | **GPT-5.4** | OpenAI | 2.50 | 15.00 | **5.63** | 1M | **API** |
| 28 | Claude Sonnet 4.6 | Anthropic | 3.00 | 15.00 | **6.00** | 1M | OR |
| 29 | Claude Opus 4.8 | Anthropic | 5.00 | 25.00 | **10.00** | 1M | OR |
| 30 | GPT-5.5 | OpenAI | 5.00 | 30.00 | **11.25** | 1.05M | OR |
| 31 | Claude Fable 5 | Anthropic | 10.00 | 50.00 | **20.00** | 1M | OR |
| 32 | Claude Opus 4.8 Fast | Anthropic | 10.00 | 50.00 | **20.00** | 1M | OR |
| 33 | **GPT-5.4 Pro** | OpenAI | 30.00 | 180.00 | **67.50** | 1M | **API** |
| 34 | GPT-5.5 Pro | OpenAI | 30.00 | 180.00 | **67.50** | 1.05M | OR |

> **제외됨 (현 시점 에이전틱 코딩 부적합 판단으로 삭제)**: DeepSeek V4 Flash · MiniMax-M2.5 · MiniMax-M2.7 · Mistral Small 4 · Qwen3.6 35B-A3B · Codestral 2508 · Mistral Large 3 · Kimi K2.5 · Devstral 2. *Claude Haiku 4.5는 벤치마크 기준선 역할로 유지.*

---

## 여전히 가격 미확인 (OpenRouter·공식 모두 미노출)

| Model | Provider | 사유 |
|---|---|---|
| GPT-5.5 Instant | OpenAI | 공식 가격 페이지 미등재 |
| GPT-5.4 Thinking | OpenAI | 별도 과금 없음 — GPT-5.4($2.50/$15) 동일 라인의 추론 모드 |
| GPT-5.4-Codex / 5.2-Codex | OpenAI | 공식 가격 페이지 미등재 |
| GPT-5.2 / 5.2 Pro | OpenAI | 현 공식 페이지 미등재 (직전 세대, 은퇴 추정) |
| Grok 4.1 Fast / Grok 4 Fast / Grok Code Fast 1 | xAI | 현 xAI docs 모델 목록 미등재 (은퇴 추정) |
| Qwen3.6 4B | Qwen | 오픈웨이트 전용(포켓 모델) — 자체호스팅, API 과금 없음 |

> 참고: 공식 페이지에 안 보이는 OpenAI/xAI 모델들은 후속 모델로 대체되어 신규 사용이 막혔을 가능성이 높다. 단순 "비싸서 비움"이 아니라 **현 시점 신규 호출 불가/미공개**라는 뜻.

---

## 메모

- **혼합(3:1)** 은 순위용 지표다. 입력 비중이 크면(대형 컨텍스트) In 컬럼, 출력이 많으면 Out 컬럼으로 재정렬해 판단.
- `API` 마커 행은 **각 provider 공식 가격**(OpenAI/Mistral 공식 페이지), 나머지 `OR` 은 OpenRouter 기준이다. 두 출처의 표준 단가는 대체로 일치하나, 할인·배치·리전(예: Qwen 중국 리전 ~60-70% 저렴) 차이는 별도다.
- 같은 가격대 클러스터: 초저가(<0.5) / 중가(0.5~2) / 고가(>3, 프런티어).
- GPT-5.4($2.50/$15)는 GPT-5.5($5/$30)의 **절반가 mainstream frontier** 포지션.

---

## 출처

- **OpenRouter** — [models API](https://openrouter.ai/api/v1/models), provider 페이지([moonshotai](https://openrouter.ai/moonshotai)·[minimax](https://openrouter.ai/minimax)·[x-ai](https://openrouter.ai/x-ai)·[mistralai](https://openrouter.ai/mistralai)), Qwen Coder([480B](https://openrouter.ai/qwen/qwen3-coder)·[plus](https://openrouter.ai/qwen/qwen3-coder-plus)·[flash](https://openrouter.ai/qwen/qwen3-coder-flash))
- **공식 API 가격** — [OpenAI Pricing](https://developers.openai.com/api/docs/pricing) · [Mistral Pricing](https://mistral.ai/pricing) · [xAI Models](https://docs.x.ai/docs/models)
