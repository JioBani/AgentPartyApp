# AI 모델 라인업 (코딩 에이전트 관점)

> 조사 시점: **2026-06-27** · 작성: `team/analyst`
> 범위: 코딩 에이전트 작업에 쓸 만한 현재 모델 라인업 (비용 제외, 웹 검색 기반)
> ⚠️ 모델 버전은 빠르게 갱신됨. 실사용 전 각 provider 공식 문서로 재확인할 것.

---

## 1. Anthropic (Claude)

코딩 에이전트 분야 강세. 툴 사용·멀티스텝 에이전트 안정성이 강점.

| 모델 | 출시 | 포지션 / 특징 |
|---|---|---|
| **Claude Fable 5** | 2026-06-09 | Opus 위 신규 **Mythos급** 티어. 상시 adaptive thinking, 1M 컨텍스트, 128K 출력. 최상위 플래그십 |
| **Claude Opus 4.8** | 2026-05-28 | 정직성·신뢰성 강화 (자기 코드 결함 누락 비율 Opus 4.7 대비 ~4배 ↓) |
| **Claude Sonnet 4.6** | 2026-02 | 코딩 주력 워크호스. SWE-bench Verified **79.6%**, Opus급 코딩 품질의 97~99% |

---

## 2. OpenAI (GPT)

| 모델 | 출시 | 포지션 / 특징 |
|---|---|---|
| **GPT-5.5 / 5.5 Pro** | 2026-04-23~24 | 에이전트 코딩·컴퓨터 유즈·지식작업 강화. 토큰 효율 대폭 개선 |
| **GPT-5.3-Codex** | 이전 분기 | 에이전트 코딩 특화 라인 (Codex 통합). 직전 5.2-Codex 후속 |

---

## 3. Google (Gemini)

| 모델 | 출시 | 포지션 / 특징 |
|---|---|---|
| **Gemini 3.5 Flash** | 2026-05-19 (GA) | "지속적 frontier 성능". near-Pro급 코딩을 Flash 속도/비용으로. 병렬 에이전트 루프 최적화. `gemini-flash-latest`의 실제 모델 |
| Managed Agents (API) | 2026-06 (preview) | 격리 샌드박스 자율·stateful 에이전트 |

---

## 4. xAI (Grok)

| 모델 | 출시 | 포지션 / 특징 |
|---|---|---|
| **Grok 4.3** | 2026 롤아웃 중 | 4.20의 4-에이전트 아키텍처(coordinator/research/logic/contrarian) 계승 |
| **Grok Build** | 2026 (베타) | 터미널 코딩 에이전트. `/goal` 장시간 자율 모드 |
| Grok 5 | 학습 중 (Q2'26 추정) | 미확정 |

---

## 5. Moonshot AI (Kimi) — 오픈웨이트

| 모델 | 출시 | 포지션 / 특징 |
|---|---|---|
| **Kimi K2.6** | 2026-04-20 | **오픈웨이트 최초 SWE-Bench Pro에서 GPT-5.4 추월** (58.6 vs 57.7). 네이티브 **300 서브에이전트 스웜**, 멀티파일 편집 강점 |

---

## 6. Zhipu AI (GLM) — 오픈웨이트

| 모델 | 출시 | 포지션 / 특징 |
|---|---|---|
| **GLM-5.1** | 2026 | 오픈 코딩 벤치 상위권(~83). **MIT 라이선스** = 엔터프라이즈 파인튜닝/상용 배포 차별점 |
| GLM-5 (Reasoning) | 2026 | 추론 특화 병행 라인 |

---

## 7. DeepSeek — 오픈웨이트

| 모델 | 출시 | 포지션 / 특징 |
|---|---|---|
| **DeepSeek V4 / V4 Pro(Max)** | 2026 | 셀프호스팅 성능/추론비용 비율 최강. 오픈 코딩 리더보드 **1위(~87)** |

---

## 8. Alibaba (Qwen) — 오픈웨이트

| 모델 | 출시 | 포지션 / 특징 |
|---|---|---|
| **Qwen 3.6 Plus** | 2026 | 1M 컨텍스트. 까다로운 에이전트 코딩용 최상위 오픈웨이트. 첫 시도 툴콜 정확도 **94%** |

---

## 9. Mistral

| 모델 | 출시 | 포지션 / 특징 |
|---|---|---|
| **Devstral 2** | 2026 | 에이전트 코딩 모델 (멀티스텝 엔지니어링, 파일 편집, TDD 반복). **Vibe CLI**와 함께 |
| **Codestral 25.08** | 2025-08 | 인라인 코드 보완 특화 (sub-200ms, 80+ 언어, 32k 컨텍스트) |

---

## 코딩 에이전트 관점 요약

| 구분 | 선두 모델 |
|---|---|
| 종합 플래그십 | Claude Fable 5, GPT-5.5, Claude Opus 4.8 |
| 코딩 주력 (밸런스) | Claude Sonnet 4.6, Gemini 3.5 Flash |
| 에이전트 코딩 특화 | GPT-5.3-Codex, Grok Build, Devstral 2 |
| 오픈웨이트 선두 | DeepSeek V4 (성능 1위), Kimi K2.6 (서브에이전트), GLM-5.1 (MIT), Qwen 3.6 Plus (1M·툴콜) |

**주목할 변화**: 오픈/중국계 모델이 서구 클로즈드 모델과 대등하거나 일부 코딩 벤치에서 추월(Kimi K2.6의 SWE-Bench Pro). 셀프호스팅 코딩 에이전트 선택지가 실전급으로 상승.

---

## 출처

- [Best Claude Models 2026](https://www.remoteopenclaw.com/blog/best-claude-models-2026) · [Claude Timeline (Fable 5)](https://www.scriptbyai.com/anthropic-claude-timeline/)
- [Introducing GPT-5.5](https://openai.com/index/introducing-gpt-5-5/) · [GPT-5.3-Codex](https://openai.com/index/introducing-gpt-5-3-codex/)
- [Gemini 3.5 Flash (Google AI)](https://ai.google.dev/gemini-api/docs/models) · [Gemini Updates June 2026](https://sumatosolutions.com/blog-google-ai-updates-2026-gemini-flash-agentic-app-builder/)
- [xAI Release Notes](https://releasebot.io/updates/xai) · [xAI Grok Build (eWeek)](https://www.eweek.com/news/xai-grok-build-coding-agent/)
- [Kimi K2.6 Tech Blog](https://www.kimi.com/blog/kimi-k2-6) · [Best Open-Source LLMs Agentic Coding 2026 (MindStudio)](https://www.mindstudio.ai/blog/best-open-source-llms-agentic-coding-2026)
- [Best Chinese LLMs 2026 (BenchLM)](https://benchlm.ai/blog/posts/best-chinese-llm) · [Kilo Best Coding Models 2026](https://kilo.ai/open-source-models)
- [Mistral Codestral 25.08](https://mistral.ai/news/codestral-25-08/) · [What's New in Mistral 2026](https://beginnersinai.org/whats-new-mistral-2026/)
