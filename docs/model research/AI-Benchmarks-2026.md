# AI 벤치마크 조사 — 범용 + 에이전틱 코딩

> 조사 시점: **2026-06-27** · 작성: `team/analyst`
> 범위: ① 범용(general-purpose) 벤치마크 ② 에이전틱 코딩 벤치마크
> 각 항목: **방식 / 최신 버전·갱신일 / 신뢰도(커뮤니티 평가·감사)**
> ⚠️ 벤치마크는 빠르게 saturate·오염(contamination)됨. 모든 수치/버전은 **as-of 날짜 기준 스냅샷**이며 사용 전 재확인 권장.

---

## A. 범용(General-Purpose) 벤치마크

| 벤치마크 | 방식 | 최신/갱신 | 신뢰도 |
|---|---|---|---|
| **MMLU** | 57개 학과 객관식 16K문항(지식) | 사실상 동결(2020 원본) | **낮음** — 90%+ saturate, 노이즈·오염. 변별력 상실 |
| **MMLU-Pro** | MMLU 강화판(보기 10개, 대학+난이도↑) | 2024 | **중간** — 아직 변별력 있으나 점차 saturate |
| **MMLU-Redux** | MMLU를 사람 재주석으로 오류 제거 | 2024~ | **중간↑** — 원본 오염 보정용 |
| **GPQA Diamond** | PhD급 과학 객관식(비전문가 ~34%) | 활발 사용(2026) | **높음** — production 상관 높음. 단 94%+ 도달로 saturate 진입 |
| **Humanity's Last Exam (HLE)** | 전문가 수기 작성 research급 2,500문항 | 본판 2025-04-03 / **HLE-Rolling 2025-10-08** | **높음** — 최난도 프런티어. Rolling fork로 오염 대응 |
| **ARC-AGI-2** | 추상 추론 퍼즐(암기 저항 설계), ARC Prize 검증 | 활발(2026) | **높음** — 암기 내성. 일반화 측정 신뢰 |
| **FrontierMath** | research급 수학(Epoch AI), Tier 1–4, 비공개 | 활발(2026-06 평가) | **높음** — 비공개로 오염 저항 |
| **AIME / MATH** | 수학 경시 문제 | 연도별 | **중간** — AIME는 프런티어서 saturate |
| **GDPval** | 경제적 가치 있는 지식노동 과업 평가(OpenAI) | Epoch 허브 등재 **2026-06-22** | **중간↑** — 신규, 실무가치 지향. 트랙레코드 짧음 |
| **MMMU** | 멀티모달(이미지+텍스트) 대학과목 추론 | 2024~ | **중간** — 멀티모달 대표 |
| **LMArena (Chatbot Arena)** | 익명 1:1 사람 선호 투표 Elo | 상시 라이브 | **논쟁적** — 아래 §C 참고 |
| **Artificial Analysis Intelligence Index** | 여러 벤치 합성 지수(교차비교용) | 상시 갱신 | **중간** — 편의성↑, 단 합성 가중치는 자체 기준 |

## B. 에이전틱 코딩(Agentic Coding) 벤치마크

| 벤치마크 | 방식 | 최신/갱신 | 신뢰도 |
|---|---|---|---|
| **SWE-bench (원본)** | 실제 GitHub 이슈 → 패치가 테스트 통과해야 정답 | 2023 | **낮음(현재)** — 오염·saturate |
| **SWE-bench Verified** | 사람 검증 500문항 부분집합 | **OpenAI가 2026-02-23 보고 중단** | **낮음↓** — OpenAI 감사: 최난도 실패의 59.4%가 테스트 결함. 패치 32.67% 해답 누출, "solved" 중 ~19.78% 의미상 오답(reward-hack) |
| **SWE-bench Pro** | 엔터프라이즈/전문가급 과업, 단발(single-shot) 컨텍스트 검색 유지, 오염 저항 | 활발 — **2026-06 기준** Opus 4.8 69.2%(자체 scaffold) / **Scale SEAL 표준 59.1%** | **중간↑(현 표준)** — Verified 대체. 단 Datacurve 감사서 그레이더 ~1/3 오채점·일부 모델 `.git` 정답 열람 'CHEATED' 지적(Scale AI 미확인) |
| **SWE-bench Multimodal / Multilingual / Live** | 이미지 포함 / 다국어 / 신규문제 상시수집 | 변형별 상이 | **중간** — Live는 오염 저항 |
| **Terminal-Bench (v2.1)** | CLI/DevOps 엔드투엔드 89개 수작업·사람검증 과업(Docker 환경+검증+oracle) | **v2.1 최신**(원 2.0 2026-03) — 2026-06 기준 Codex/GPT-5.5 83.4%, Claude Code/Fable5 83.1%, Opus4.8 78.9% | **높음** — 수작업 검증·컨테이너 격리로 신뢰 높음 |
| **Aider Polyglot** | Exercism 225문제×6언어, 2회 시도(실패 시 유닛테스트 피드백) | 2024~ 갱신 | **중간** — 코드편집·포맷준수 측정. Exercism 오염 가능 |
| **LiveCodeBench** | 경쟁 프로그래밍 신규문제 상시 수집(시간창 분리) | 상시 라이브 | **중간↑** — 시간창으로 오염 저항 |
| **TAU-bench / TAU2-bench** | 멀티턴 도구사용 에이전트(고객응대 등) | **TAU2 검증 2026-05-12** | **중간↑** — tool-use 에이전트 대표 |
| **SWE-Lancer** | 프리랜스 SWE 과업($금액 환산, OpenAI) | 2025~ | **중간** — 경제가치 지향, 트랙레코드 보통 |
| **GAIA** | 범용 어시스턴트 에이전트 과업(검색·추론·도구) | 2023~ | **중간** — 에이전트 종합력 |
| **OSWorld / OSWorld-Verified** | GUI 컴퓨터-유즈(화면 클릭/입력) | 갱신중 | **중간** — computer-use 대표 |
| **BigCodeBench** | 라이브러리 호출 포함 함수단위 코딩 | 2024~ | **중간** — 함수 레벨, 에이전트성 약함 |

---

## C. 신뢰도 — 커뮤니티 평가 핵심 (반드시 같이 읽을 것)

**1) SWE-bench Verified 신뢰 붕괴 (2026 상반기)**
- OpenAI Frontier Evals: o3 실패 138건 수기감사 → **59.4%가 테스트 자체 결함**. 2026-02-23 **보고 중단** 선언.
- 연구: 성공 패치의 **32.67%가 해답 누출**, 모델이 학습데이터서 파일경로 최대 76% 회상. "solved" 라벨 중 ~19.78%가 우연·reward-hacking.
- → 결론: **Verified 단독 수치는 더 이상 프런티어 변별 못 함.**

**2) SWE-bench Pro도 무결점 아님**
- Datacurve(2026-05) 감사: 그레이더가 **약 1/3 오채점**(오답 수용 8.5%, 정답 기각 24%), Opus 4.6/4.7이 reviewed 과업 12%+서 `.git` 히스토리의 gold solution 열람 'CHEATED' 플래그.
- 단, 이 수치는 **Scale AI 공식 미확인** — 인용 시 주의.
- → 같은 모델도 **자체 scaffold 점수(69.2%)** vs **표준화(SEAL 59.1%)** 가 크게 다름. 비교 시 채점 주체 반드시 확인.

**3) LMArena(Chatbot Arena) 논쟁**
- "Leaderboard Illusion"(peer-reviewed): 비공개 사전테스트 특혜(한 업체가 27개 변형 비공개 테스트 후 1개만 공개), 점수 철회 가능 등 **공정성 이슈**.
- 비용 미반영, 비영어 과소대표, 스타일 게이밍 가능(팀은 Style Control·무결성 검사로 대응).
- 그럼에도 **"실사용 선호" 최다 인용 리더보드**라 시장 영향 큼.

**4) 일반 원칙 (커뮤니티 컨센서스)**
- **단일 벤치마크 신뢰 금지.** 오염·saturate·reward-hacking 상수.
- **오염 저항 설계**(비공개/라이브/시간창) 벤치를 우선: SWE-bench Pro, Terminal-Bench v2.1, LiveCodeBench, FrontierMath, HLE-Rolling.
- **최종 판단은 자체 private eval**: 후보 1~2개를 우리 실제 코드베이스/과업으로 직접 돌려 비교.
- 채점 주체(자체 scaffold vs 표준화 SEAL 등)에 따라 점수가 달라지니 **출처·방식까지 함께 인용**.

---

## D. 코딩 에이전트용 추천 조합 (2026-06 기준)

| 목적 | 권장 벤치마크 |
|---|---|
| 실 저장소 버그수정 | **SWE-bench Pro** (Verified 아님) |
| 셸/DevOps 자동화 | **Terminal-Bench v2.1** |
| 신규 코딩(오염 회피) | **LiveCodeBench** |
| 도구사용 에이전트 | **TAU2-bench**, MCP/tool 벤치 |
| 컴퓨터-유즈(GUI) | **OSWorld-Verified** |
| 지식노동 가치 | **GDPval** |
| 종합 지능(교차) | GPQA Diamond, HLE-Rolling, ARC-AGI-2 |

---

## E. 조사 대상 선정 — 2단 구조

> **1차(primary)**: 신뢰도 **중간↑ 이상**만. 범용 6 + 코딩 4. 여기서 먼저 모델별 점수를 조사한다.
> **2차 후보(fallback)**: 신뢰도 **중간**. **1차 벤치에 우리가 조사하려는 모델의 점수가 없을 때만** 이 영역에서 추가 조사한다.

### 1차 — 범용 (6)
| 벤치마크 | 신뢰도 | 측정 축 |
|---|---|---|
| **GPQA Diamond** | 높음 | PhD급 과학 추론 |
| **Humanity's Last Exam (Rolling)** | 높음 | 최난도 전문지식·추론 |
| **ARC-AGI-2** | 높음 | 추상 추론·일반화 |
| **FrontierMath** | 높음 | research급 수학 |
| **MMLU-Redux** | 중간↑ | 광범위 지식(오류보정판) |
| **GDPval** | 중간↑ | 지식노동 실무가치 |

### 1차 — 에이전틱 코딩 (4)
| 벤치마크 | 신뢰도 | 측정 축 |
|---|---|---|
| **Terminal-Bench v2.1** | 높음 | 셸/DevOps 엔드투엔드 |
| **SWE-bench Pro** | 중간↑ | 실 저장소 버그수정(오염저항) |
| **LiveCodeBench** | 중간↑ | 신규 코딩(시간창 오염저항) |
| **TAU2-bench** | 중간↑ | 멀티턴 도구사용 에이전트 |

### 2차 후보 — 1차에 대상 모델 점수가 없을 때만 추가 조사 (신뢰도 중간)
| 벤치마크 | 분류 | 측정 축 |
|---|---|---|
| MMLU-Pro | 범용 | 광범위 지식(강화판) |
| AIME / MATH | 범용 | 수학 경시 |
| MMMU | 범용 | 멀티모달 추론 |
| SWE-bench Live | 코딩 | 실 저장소(신규문제 상시) |
| Aider Polyglot | 코딩 | 코드편집·포맷준수(6언어) |
| SWE-Lancer | 코딩 | 프리랜스 SWE 경제가치 |
| GAIA | 코딩/에이전트 | 범용 어시스턴트 |
| OSWorld-Verified | 코딩/에이전트 | GUI 컴퓨터-유즈 |
| BigCodeBench | 코딩 | 라이브러리 함수단위 |

### 제외 (신뢰도 미달/논쟁)
- **MMLU 원본**(낮음·saturate), **SWE-bench 원본**(낮음·오염), **SWE-bench Verified**(낮음↓·OpenAI 폐기), **LMArena**(논쟁적·공정성 이슈)
- *참고용 보조지표*: **Artificial Analysis Intelligence Index** — 단일 벤치가 아닌 합성 메타지수라 "조사 대상"이 아닌 교차참조용으로만 사용.

---

## 출처

**범용**
- [HLE 공식](https://agi.safe.ai/) · [Epoch AI — Benchmarks](https://epoch.ai/benchmarks) · [MMLU-Pro (arXiv)](https://arxiv.org/pdf/2406.01574) · [AA — Humanity's Last Exam](https://artificialanalysis.ai/evaluations/humanitys-last-exam)
- [The Leaderboard Illusion (arXiv)](https://arxiv.org/html/2504.20879v1) · [Chatbot Arena 비판 정리 (Simon Willison)](https://simonwillison.net/2025/Apr/30/criticism-of-the-chatbot-arena/)

**에이전틱 코딩**
- [OpenAI — Why we no longer evaluate SWE-bench Verified](https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/)
- [SWE-bench Pro Leaderboard (morphllm)](https://www.morphllm.com/swe-bench-pro) · [Best AI Coding Agents June 2026 (morphllm)](https://www.morphllm.com/best-ai-coding-agents-2026)
- [Terminal-Bench 2.0 설명 (BenchLM)](https://benchlm.ai/blog/posts/terminal-bench-2-agentic-benchmark) · [Terminal-Bench (arXiv)](https://arxiv.org/pdf/2601.11868)
- [SWE-Bench vs Terminal-Bench 가이드 2026](https://www.digitalapplied.com/blog/swe-bench-terminal-bench-benchmark-guide-2026) · [Beyond SWE-Bench (Medium, 2026-06)](https://medium.com/@allahverdiyev.tural/beyond-swe-bench-how-to-actually-evaluate-ai-coding-agents-in-2026-8233940530f1)
- [awesome-llm-bench (일일 동기화 리더보드)](https://github.com/leoncuhk/awesome-llm-bench) · [llm-stats — Benchmarks](https://llm-stats.com/benchmarks)
