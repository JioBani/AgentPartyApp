# OpenRouter 프로바이더 라우팅 조사

> 조사 시점: **2026-07-04** · 작성: `team/openrouter-scout`
> 목적: OpenRouter의 프로바이더 개념, 프로바이더별 가격 차이, 최저가 고정 방법과
> 트레이드오프, 그리고 이 프로젝트(AgentPartyApp) 적용 방안을 정리한다.
> 출처: 하단 [출처](#출처) 참조. 프로바이더별 실가격은 수시 변동 — 반드시 각 모델 페이지로 재검증할 것.

---

## 1. 프로바이더란 — 왜 같은 모델이 값이 다른가

OpenRouter의 모델 slug(예: `z-ai/glm-5.2`)는 실제 모델이 아니라 **여러 인퍼런스
프로바이더로 향하는 라우팅 앞단**이다. 같은 가중치라도 이를 서빙하는 업체
(DeepInfra, Fireworks, Together, Novita, Groq, 모델 제작사 직영 등)가 각기 다른
하드웨어·양자화 수준·마진으로 돌리므로, **동일 모델·동일 요청이라도 프로바이더별로
가격·품질·속도·컨텍스트 한계가 다르다.**

**기본 동작 (설정 무입력 시):** OpenRouter는 가용 프로바이더에 **로드밸런싱**하되
가격 역제곱 가중(cheaper일수록 지수적으로 우선)으로 저가 쪽에 기운다. 단 항상
최저가는 아니고 안정성(가용성/outage 감지)을 섞는다.

---

## 2. 가격 스프레드 — 얼마나 차이 나는가

같은 모델의 프로바이더 간 가격차는 크다.

**Llama 3.3 70B** (OpenRouter 튜토리얼 실측):

| 프로바이더 | Input $/M | Output $/M |
|---|---|---|
| DeepInfra | 0.10 | 0.32 |
| Novita | 0.135 | 0.40 |
| Groq | 0.59 | 0.79 |
| Together | 1.04 | 1.04 |

→ **input 최대 ~10배, output ~3배+** 차이.

**DeepSeek V4 Pro** (검색 결과 기준, 같은 weights):
DeepInfra 직영 input $1.30 · Fireworks $1.74 · Together $2.10.

> 요약: 최저가 프로바이더 고정만으로 동일 모델에서 **2~10배** 비용 절감이 가능한
> 경우가 있으나, 그만큼 품질·가용성 트레이드오프가 붙는다(§4).

---

## 3. 최저가 프로바이더 고정 방법

요청 본문의 `provider` 객체 또는 model slug suffix로 제어한다.

| 방법 | 형태 | 의미 |
|---|---|---|
| slug suffix `:floor` | `"z-ai/glm-5.2:floor"` | `sort:"price"` 와 동일 — 최저가 우선 |
| slug suffix `:nitro` | `"z-ai/glm-5.2:nitro"` | `sort:"throughput"` — 최고 처리량 우선 |
| 가격 정렬 | `provider: { "sort": "price" }` | 최저가순 정렬 (로드밸런싱 끔) |
| 단일 고정 | `provider: { "order": ["deepinfra"], "allow_fallbacks": false }` | 이 프로바이더만, 실패 시 대체 안 함 |
| 가격 상한 | `provider: { "max_price": { "prompt": 1, "completion": 2 } }` | $/M 초과 프로바이더 제외(초과 시 요청 실패) |
| 화이트리스트 | `provider: { "only": ["deepinfra","novita"] }` | 허용 프로바이더만 |
| 블랙리스트 | `provider: { "ignore": ["together"] }` | 특정 프로바이더 제외 |
| 양자화 필터 | `provider: { "quantizations": ["fp16","bf16"] }` | 저정밀 endpoint 배제 |

### `provider` 객체 전체 필드

| 필드 | 타입 | 기본값 | 동작 |
|---|---|---|---|
| `order` | `string[]` | — | 프로바이더 순차 시도. 로드밸런싱 끔 |
| `allow_fallbacks` | `boolean` | `true` | `false` 면 지정 프로바이더만, 실패 시 요청 실패 |
| `require_parameters` | `boolean` | `false` | 요청한 파라미터(tool_calling/JSON 등) 지원 프로바이더만 |
| `data_collection` | `"allow"\|"deny"` | `"allow"` | `"deny"` = 로그 미수집 프로바이더만 |
| `zdr` | `boolean` | — | Zero-Data-Retention endpoint 전용 |
| `only` | `string[]` | — | 허용 프로바이더 화이트리스트 |
| `ignore` | `string[]` | — | 제외 프로바이더 블랙리스트 |
| `quantizations` | `string[]` | — | `int4/int8/fp4/fp6/fp8/fp16/bf16/fp32/unknown` 필터 |
| `sort` | `string\|object` | — | `"price"/"throughput"/"latency"`. 로드밸런싱 끔 |
| `preferred_min_throughput` | `number\|object` | — | tokens/sec 임계값(퍼센타일 `p50~p99` 지정 가능) |
| `preferred_max_latency` | `number\|object` | — | 초 단위 임계값(퍼센타일 지정 가능) |
| `max_price` | `object` | — | `{"prompt":1,"completion":2}` ($/M) |

**핵심 주의:** `sort` 또는 `order` 를 지정하는 순간 **로드밸런싱이 꺼진다.**

### 예시 요청 body

```json
{
  "model": "deepseek/deepseek-v4-pro",
  "provider": {
    "sort": "price",
    "allow_fallbacks": true,
    "quantizations": ["fp16", "bf16"],
    "require_parameters": true,
    "preferred_min_throughput": { "p90": 50 }
  }
}
```

---

## 4. 최저가 고정의 트레이드오프

| 트레이드오프 | 내용 | 방어책 |
|---|---|---|
| **양자화 품질** | 최저가 endpoint가 FP8/INT8/FP4 양자화본인 경우가 많아 미묘한 품질 저하. (단, 잘 만든 양자화는 full-precision과 맞먹기도) | `quantizations:["fp16","bf16"]` |
| **가용성/장애** | `allow_fallbacks:false` 단일 고정 시 그 프로바이더가 죽으면 요청 자체 실패. 자동 failover 상실 | `allow_fallbacks:true` 유지 |
| **처리량/지연** | 최저가 ≠ 최속. 혼잡 시 포화·지연 | `preferred_min_throughput` / `preferred_max_latency` 병용 |
| **컨텍스트 길이** | 프로바이더별 max context가 달라 긴 입력이 잘릴 수 있음 | 긴 컨텍스트 작업 시 프로바이더 확인 |
| **기능 지원** | 일부 저가 프로바이더는 tool-calling/structured output/이미지 미지원 | `require_parameters:true` |
| **프라이버시** | 저가 프로바이더가 학습용 로그 수집 가능 | `data_collection:"deny"` 또는 `zdr:true` (선택지↓, 가격↑ 가능) |
| **비용 실패** | `max_price` 상한 초과 시 응답 없이 실패(무료티어는 실패도 쿼터 소모) | 상한을 여유 있게 |

**권장 균형 조합** (완전 단일 고정보다 안전):

```
sort:"price" + allow_fallbacks:true + quantizations:["fp16","bf16"] + require_parameters:true
```

= "가능한 한 싸게, 단 정밀도·기능 보장, 죽으면 대체".

---

## 5. 이 프로젝트(AgentPartyApp) 적용

**현황:** 임베디드 라우터 [`src/core/routerShim.ts`](../../src/core/routerShim.ts) 의
`forwardToOpenRouter` 는 OpenRouter `chat/completions` 로 포워딩할 때 **`provider`
필드를 전혀 보내지 않는다.** 즉 현재는 **OpenRouter 기본 로드밸런싱(저가 편향)**
상태이며, 프로바이더 고정·양자화 필터·가격 상한이 걸려 있지 않다.

**개선안 (per-model 로직을 코드에 두지 않는 원칙 준수):**

1. 모델 단일 소스 [`src/shared/modelCatalog.json`](../../src/shared/modelCatalog.json)
   각 OpenRouter 항목에 선택적 `providerRouting` 필드(위 `provider` 객체 스키마)를
   추가한다.
2. [`modelCatalog.ts`](../../src/shared/modelCatalog.ts) 에 타입/접근자를 추가.
3. `routerShim.ts` 의 request body에 카탈로그에서 읽은 `provider` 를 그대로 주입.

이렇게 하면 프로바이더 정책이 모델별로 JSON에서 선언되고, 라우터는 per-model
분기 없이 그대로 전달만 한다(현 아키텍처 유지).

> 참고: [no-silent-fallback 원칙] — 프로바이더 다운/양자화 강등 등이 발생하면
> 조용히 넘기지 말고 로그/비용 stats로 표면화해야 한다. OpenRouter 응답의 실제
> 서빙 프로바이더·양자화는 generation stats로 확인 가능(현재 비용만 조회 중).

---

## 출처

- [Provider Routing — OpenRouter Docs](https://openrouter.ai/docs/guides/routing/provider-selection)
- [Lowest-Cost LLM Inference Guide — OpenRouter Blog](https://openrouter.ai/blog/tutorials/how-to-get-the-lowest-cost-llm-inference-on-openrouter/)
- [How OpenRouter Model Routing Works — OpenRouter Blog](https://openrouter.ai/blog/insights/model-routing/)
