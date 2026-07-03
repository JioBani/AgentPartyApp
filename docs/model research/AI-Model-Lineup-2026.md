# AI 모델 라인업 — 코딩 에이전트 (벤치마크/비용 조사 기반표)

> 조사 시점: **2026-06-27** · 작성: `team/analyst`
> 목적: **모델별 벤치마크 + 비용** 조사를 위한 기준표. 따라서 base / pro / mini / flash / max 등 **변형(variant)을 각각 별도 행**으로 분리한다 (세대·발전사 관점 아님).
> 교차검증 출처: **OpenRouter**(카탈로그+가격) · **models.dev**(카탈로그+가격) · **Artificial Analysis**(Intelligence Index+가격)
> 가격 단위: **USD / 1M tokens** (input / output). 출처별로 값이 갈리면 병기.
> ⚠️ 빠르게 갱신됨. 실사용 전 각 provider 공식 문서로 재확인.

---

## 0. 읽는 법 (컬럼 정의)

| 컬럼 | 의미 |
|---|---|
| Model / variant | 과금·벤치마크 단위가 되는 개별 모델 (Pro/Mini 등 분리) |
| Ctx | 컨텍스트 윈도우 |
| In / Out | 입력 / 출력 가격 (USD per 1M tokens) |
| Reasoning 제어 | effort / thinking 토글 / budget 등 추론 설정 (§ 끝 reference 참조) |
| AA Idx | Artificial Analysis Intelligence Index (높을수록 ↑, 교차 벤치 지표) |

---

## 1. Anthropic (Claude)

| Model / variant | Ctx | In | Out | Reasoning 제어 | AA Idx |
|---|---|---|---|---|---|
| **Claude Fable 5** | 1M | 10 | 50 | adaptive thinking **상시 ON**(끌 수 없음) | **60** |
| **Claude Opus 4.8** | 1M | 5 *(AA/models.dev 4.29)* | 25 *(21.46)* | adaptive only — `thinking:{type:"adaptive"}`, 수동 `budget_tokens`는 400 에러 | 56 |
| **Claude Opus 4.8 Fast** | 1M | 10 | 50 | 동일 (고속 변형) | — |
| **Claude Sonnet 4.6** | 1M | 3 | 15 | `budget_tokens` 수용(deprecated) | — |
| **Claude Haiku 4.5** | 200K | 1 | 5 | 경량 | — |

- 공통: `effort` 파라미터(Opus 4.7+ 도입), `display: summarized|omitted`(Fable5/Opus4.8 기본 omitted).

## 2. OpenAI (GPT)

| Model / variant | Ctx | In | Out | Reasoning 제어 | AA Idx |
|---|---|---|---|---|---|
| **GPT-5.5 Pro** | 1.05M | 30 *(models.dev 27.27)* | 180 *(163.64)* | `reasoning_effort` | — |
| **GPT-5.5** | 1.05M | 5 *(models.dev 3)* | 30 *(18)* | `reasoning_effort`: low/medium/**high(기본 medium)**/xhigh | xhigh **55** / high 53 |
| **GPT-5.5 Instant** | 400K | 5 | 30 | 저지연 (mini/nano 없음 — 경량은 5.4 패밀리) | — |
| **GPT-5.4** | 1M | 2.5 | 15 | `reasoning_effort`: **none(기본)**/low/medium/high/xhigh. Computer Use API 첫 탑재 | — |
| **GPT-5.4 Pro** | 1M | 30 | 180 | 최고 성능 변형 | — |
| **GPT-5.4 mini** | 400K | 0.75 | 4.5 | 경량 (OpenRouter `gpt-mini-latest` 별칭이 이걸 가리킴) | — |
| **GPT-5.4 nano** | — | 0.20 | 1.25 | 엣지/임베디드 | — |
| **GPT-5.4 Thinking** | 1M | (5.4 동일대) | | 인터랙티브 추론 변형 | — |
| **GPT-5.4-Codex** | — | — | — | 에이전트 코딩 특화 (5.4가 5.3-Codex 후속). 가격 미노출 | — |
| **GPT-5.3-Codex / 5.2-Codex** | — | — | — | 직전 Codex 라인 | — |
| **GPT-5.2 / 5.2 Pro** | — | 1.75 / 21 | 14 / 168 | 직전 세대 | — |

- GPT-5.4는 "더 저렴한 mainstream frontier 패밀리"로 유지(2026-03 출시). 5.4부터 effort 기본값이 **none**. GPT-5는 `minimal`도 지원. GPT-5.5는 동일 effort에서 추론 토큰을 더 적게 써서 도달(토큰 효율 ↑).

## 3. Google (Gemini)

| Model / variant | Ctx | In | Out | Reasoning 제어 | AA Idx |
|---|---|---|---|---|---|
| **Gemini 3.x Pro** (`gemini-pro-latest`) | 1.05M | 2 | 12 | `thinking_level` | — |
| **Gemini 3.5 Flash** | 1.05M | 1.5 | 9 | `thinking_level`: minimal/low/medium/**high(기본)** | — |
| **Gemini 3.1 Flash Lite** | 1.05M | 0.25 | 1.5 | 저비용 고처리량 | — |

- `thinking_budget`는 하위호환용(레거시). `thinking_level`로 마이그레이션 권장. 둘 동시 지정 금지.

## 4. xAI (Grok)

| Model / variant | Ctx | In | Out | Reasoning 제어 | AA Idx |
|---|---|---|---|---|---|
| **Grok 4.3** | 1M | 1.25 | 2.5 | `reasoning_effort`: **none/low(기본)/medium/high** | — |
| **Grok 4.20** | 2M | 1.25 | 2.5 | reasoning 상시, `reasoning_effort` **미지원** | — |
| **Grok 4.20 multi-agent** | 2M | 1.25 | 2.5 | 4-에이전트 아키텍처 | — |
| **Grok 4.1 Fast / 4 Fast** | 2M | (저가, 미공개) | | 고속 | — |
| **Grok Code Fast 1** | 256K | (미공개) | | 코딩 특화 고속 | — |
| **Grok Build 0.1** | 256K | 1 | 2 | 터미널 코딩 에이전트, `/goal` 자율 모드 | — |

- 주의: Grok 4 / 4.20 은 `reasoning_effort` 미지원(상시 추론). 4.3만 effort 조절 가능. 프롬프트 포팅 시 파라미터 제거 필요.

## 5. Moonshot (Kimi) — 오픈웨이트

| Model / variant | Ctx | In | Out | Reasoning 제어 | AA Idx |
|---|---|---|---|---|---|
| **Kimi K2.7 Code** | 262K | 0.74 | 3.5 | `thinking_budget`, `preserve_thinking`. 코딩 특화 | — |
| **Kimi K2.6** | 262K | 0.66 | 3.41 | 동일. SWE-Bench Pro 58.6(오픈 최초 GPT-5.4 추월). 300 서브에이전트 스웜 | — |
| **Kimi K2.5** | 262K | 0.375 | 2.025 | — | — |
| **Kimi K2 Thinking** | 262K | 0.60 | 2.5 | 추론 전용 변형 | — |

## 6. Z.AI / Zhipu (GLM) — 오픈웨이트

| Model / variant | Ctx | In | Out | Reasoning 제어 | AA Idx |
|---|---|---|---|---|---|
| **GLM-5.2** | 1.05M | 0.95 | 3 | hybrid thinking, **기본 ON**. MIT 라이선스 | **51** (오픈웨이트 최상위) |

- ⚠️ Air 등 경량 변형이 존재할 가능성 — OpenRouter 추출에서 단일만 잡힘. 보강 필요.

## 7. DeepSeek — 오픈웨이트

| Model / variant | Ctx | In | Out | Reasoning 제어 | AA Idx |
|---|---|---|---|---|---|
| **DeepSeek V4 Pro (Max)** | 1.05M | 0.435 | 0.87 | hybrid, `extra_body{"thinking":{"type":"enabled"}}`, **기본 OFF** | 44 |
| **DeepSeek V4 Flash** | 1.05M | 0.09 | 0.18 | 초저가 | — |

## 8. Alibaba (Qwen) — 오픈웨이트

| Model / variant | Ctx | In | Out | Reasoning 제어 | AA Idx |
|---|---|---|---|---|---|
| **Qwen3.7 Max** | 1M | 1.25 | 3.75 | `enable_thinking` + `thinking_budget`, `/think` `/no_think`. hybrid 기본 ON. 툴콜 정확도 ↑ | — |
| **Qwen3.7 Plus** | 1M | 0.32 | 1.28 | 동일 | — |
| **Qwen3.6 Max Preview** | 262K | 1.04 | 6.24 | — | — |
| **Qwen3.6 Flash** | 1M | 0.1875 | 1.125 | 고속 | — |
| **Qwen3.6 27B (dense)** | 262K | 0.29 | 2.65 | 오픈웨이트, 27B 단일 모델로 플래그십급 코딩 | — |
| **Qwen3.6 35B-A3B (MoE)** | 262K | 0.14 | 1.0 | 오픈웨이트 MoE(활성 3B), 에이전트 코딩 강세 | — |
| **Qwen3.6 4B** | — | (저가) | | 포켓/엣지 | — |

### Qwen Coder 전용 라인 ("Coder" 브랜드)

| Model / variant | Ctx | In | Out | 비고 |
|---|---|---|---|---|
| **Qwen3 Coder 480B A35B** | 262K | 0.22 | 1.80 | 오픈웨이트 MoE(480B/활성 35B). 코딩 전용. function calling·tool use·long-context |
| **Qwen3 Coder Plus** | 1M | 0.65 | 3.25 | 프로프라이어터리(480B의 Alibaba 상용판) |
| **Qwen3 Coder Flash** | 1M | 0.195 | 0.975 | Coder Plus의 고속·저가판, 출력 64K |

> 정리: **"Coder" 브랜드 = Qwen3 Coder 라인(2025)**. Qwen3.6 dense/MoE는 그 자체가 코딩 특화 오픈웨이트(현 자체호스팅 코더), Qwen3.7-Max는 코딩·에이전트용 프로프라이어터리 플래그십.

## 9. MiniMax

| Model / variant | Ctx | In | Out | Reasoning 제어 | AA Idx |
|---|---|---|---|---|---|
| **MiniMax-M3** | 1.05M | 0.30 *(models.dev 0.28)* | 1.20 *(1.10)* | 추론 모델 | 44 |
| **MiniMax-M2.7** | 205K | 0.18 | 0.72 | — | — |
| **MiniMax-M2.5** | 205K | 0.12 | 0.48 | — | — |

## 10. Mistral

| Model / variant | Ctx | In | Out | Reasoning 제어 | AA Idx |
|---|---|---|---|---|---|
| **Mistral Large 3 (2512)** | 262K | 0.50 | 1.50 | 표준(추론 토글 없음) | — |
| **Mistral Medium 3.5** | 262K | 1.50 | 7.50 *(AA 6.90)* | 표준 | — |
| **Devstral 2 (2512)** | 262K | 0.40 | 2.00 | 에이전트 코딩 특화 (Vibe CLI) | — |
| **Codestral 2508** | 256K | 0.30 | 0.90 | 인라인 코드 보완, sub-200ms | — |
| **Magistral Medium 2506** | 41K | (미공개) | | **추론 전용** 모델 | — |
| **Mistral Small 4** | 262K | 0.15 | 0.60 | 경량 | — |

---

## Reasoning 제어 — 패턴 reference

| Provider | 메커니즘 | 값 / 기본 |
|---|---|---|
| Anthropic | adaptive thinking + `effort` + `budget_tokens`(deprecated) | Fable5 상시 ON / Opus4.8 adaptive only |
| OpenAI | `reasoning_effort` | minimal(5세대)·low·medium(기본)·high·xhigh |
| Google | `thinking_level` (구 `thinking_budget`) | minimal·low·medium·high(기본) |
| xAI | `reasoning_effort` (**4.3만**) | none·low(기본)·medium·high / 4·4.20 미지원 |
| Qwen | `enable_thinking` + `thinking_budget` / `/think` | hybrid, Max·Plus 기본 ON |
| DeepSeek | `thinking`(extra_body) | hybrid, 기본 **OFF** |
| GLM | hybrid thinking | 기본 **ON** |
| Kimi | `thinking_budget` + `preserve_thinking` | K2 Thinking = 전용 변형 |
| MiniMax | 추론 모델(M3) | — |
| Mistral | 추론은 **Magistral** 라인 전용 | Devstral·Codestral·Large 토글 없음 |

---

## 벤치마크 (현재 확보분 — 별도 심화 조사 예정)

| 모델 | 지표 | 값 |
|---|---|---|
| Claude Fable 5 | AA Intelligence Index | 60 |
| Claude Opus 4.8 | AA Intelligence Index | 56 |
| GPT-5.5 (xhigh) | AA Intelligence Index | 55 |
| GLM-5.2 (max) | AA Intelligence Index | 51 (오픈웨이트 1위) |
| DeepSeek V4 Pro | AA Intelligence Index | 44 |
| MiniMax-M3 | AA Intelligence Index | 44 |
| Claude Sonnet 4.6 | SWE-bench Verified | 79.6% |
| Claude Opus 4.6 | SWE-bench Verified | 80.8% |
| Kimi K2.6 | SWE-Bench Pro | 58.6 (> GPT-5.4 57.7) |

> 다음 단계: SWE-bench Verified / SWE-Bench Pro / Terminal-Bench / LMArena 등 **벤치마크 전수 표**를 별도 문서로 작성.

---

## 미해결 / 보강 필요 (TODO)

- [ ] **GLM 경량 변형**(Air 등) 누락 확인 — Z.AI 공식/OpenRouter 재확인
- [ ] **xAI 고속 라인**(4.1 Fast, 4 Fast, Code Fast 1) 가격 미공개분 확보
- [ ] **GPT-5.5 가격 출처 불일치**(In 3 vs 5 / Out 18 vs 30) — OpenAI 공식가 확정
- [ ] **OpenAI Codex 라인**(5.3-Codex 등) 스펙·가격 — OpenRouter 미노출, 공식 확인
- [ ] 벤치마크 전수 표 (별도 문서)

---

## 출처

**카탈로그/가격 (교차검증)**
- OpenRouter — [models API](https://openrouter.ai/api/v1/models), provider 페이지([mistralai](https://openrouter.ai/mistralai)·[moonshotai](https://openrouter.ai/moonshotai)·[minimax](https://openrouter.ai/minimax)·[x-ai](https://openrouter.ai/x-ai))
- [models.dev](https://models.dev/)
- [Artificial Analysis — Models](https://artificialanalysis.ai/models)

**Reasoning 제어 (공식 문서)**
- [Claude — Extended/Adaptive thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking) · [Effort](https://platform.claude.com/docs/en/build-with-claude/effort)
- [OpenAI — Using GPT-5.5](https://developers.openai.com/api/docs/guides/latest-model) · [Reasoning](https://developers.openai.com/api/docs/guides/reasoning)
- [Gemini 3 Developer Guide](https://ai.google.dev/gemini-api/docs/gemini-3) · [Thinking](https://ai.google.dev/gemini-api/docs/thinking)
- [xAI — Reasoning](https://docs.x.ai/developers/model-capabilities/text/reasoning)
- [Alibaba — Deep thinking via API](https://www.alibabacloud.com/help/en/model-studio/deep-thinking) · [DeepSeek — Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode)

**모델 출시/특징**
- [Claude Timeline (Fable 5)](https://www.scriptbyai.com/anthropic-claude-timeline/) · [Introducing GPT-5.5](https://openai.com/index/introducing-gpt-5-5/) · [Kimi K2.6 Tech Blog](https://www.kimi.com/blog/kimi-k2-6) · [Best Chinese LLMs 2026 (BenchLM)](https://benchlm.ai/blog/posts/best-chinese-llm) · [Mistral Codestral 25.08](https://mistral.ai/news/codestral-25-08/)
