# Codex 모델 라우팅 (모델·프로바이더 선택)

이 문서는 Codex 하네스에서 "어떤 모델을 어떤 백엔드로 라우팅할지"를 정할 때 필요한
사실을 정리한다. 현재 `src/core/codexAdapter.ts`는 model 문자열만 그대로 넘기고
UI에 gpt-5.4 하나만 노출 중 — 이 문서를 근거로 모델 선택 UI(Phase 1) 및 커스텀
프로바이더 라우팅(Phase 2)의 범위를 정한다.

출처/확인일: **2026-07-03**. 로컬 `codex-cli 0.142.4`의
`codex app-server generate-json-schema` 산출물 + `codex debug models` +
`~/.codex/models_cache.json` 실측, 공식 문서 및 OpenRouter 문서 교차검증(하단).

## 한 줄 결론

Codex는 모델 라우팅을 **네이티브로 강하게 지원**한다. 단 두 층으로 나뉜다:
- **(A) 계정 카탈로그** — `model/list`가 열거하는, 인증된 계정이 OpenAI 서버에서
  쓸 수 있는 모델(gpt-5.5 등). 서버 주도, 프로바이더 개념 없음.
- **(B) 커스텀/로컬 프로바이더** — `config.toml`의 `[model_providers.*]`로 정의하는
  OpenAI-호환 서드파티/로컬 엔드포인트. **`model/list`에 안 나온다**(슬러그를
  사용자가 직접 알아야 함).

프로토콜에 `model` + `modelProvider` + `serviceTier` 파라미터가 이미 있어 어댑터
확장만으로 둘 다 지원 가능하다.

## 1. `model/list` request — 계정 카탈로그 열거

- 요청 파라미터 `ModelListParams`: `cursor`(페이지네이션), `includeHidden`(기본
  picker에서 숨겨진 모델까지), `limit`(페이지 크기).
- 응답 `ModelListResponse`: `{ data: Model[], nextCursor: string|null }`.
- `Model` 주요 필드:
  - `id`, `model`(모델 슬러그), `displayName`, `description`
  - `defaultReasoningEffort`, `supportedReasoningEfforts[]`
    (각 `{ reasoningEffort, description }`)
  - `serviceTiers[]`(`{ id, name, description }` — 예: `Fast` "1.5x speed"),
    `defaultServiceTier`
  - `inputModalities`(text/image), `supportsPersonality`
  - `hidden`, `isDefault`, `availabilityNux`(신규 모델 안내 메시지),
    `upgrade`/`upgradeInfo`(마이그레이션 안내)
- **중요: `Model`에 `provider` 필드가 없다.** 즉 `model/list` = 인증 계정이
  OpenAI 서버에서 쓸 수 있는 카탈로그이며 서버가 결정한다(로컬
  `~/.codex/models_cache.json`에 캐시; 캐시 키: fetched_at/etag/client_version).
- 로컬 실측(`codex debug models`, 2026-07-03): **gpt-5.5, gpt-5.4, gpt-5.4-mini,
  codex-auto-review** 4개. 각 항목에 context_window, reasoning tiers,
  service_tiers, supports_reasoning_summaries 등 상세 포함.

→ **Phase 1의 핵심 소스.** `model/list`만 붙여도 계정 카탈로그 전체 + 추론레벨 +
Fast tier를 UI에 노출할 수 있다(현재 gpt-5.4 하드코딩 1개에서 벗어남).

## 2. `modelProvider/capabilities/read` request — 능력 플래그

- 응답 `ModelProviderCapabilitiesReadResponse`:
  `{ imageGeneration: boolean, namespaceTools: boolean, webSearch: boolean }`.
- **모델 목록이 아니라** "현재 프로바이더가 이 기능을 지원하나" 능력 플래그.
  커스텀 프로바이더는 image generation/web search 미지원인 경우가 흔하므로,
  해당 UI(이미지 생성/웹검색)를 켤지 게이팅하는 용도로 쓴다.

## 3. 커스텀 모델 프로바이더 (`config.toml`)

최상위 키:
- `model = "<slug>"`
- `model_provider = "<id>"`(기본 `"openai"`)

`[model_providers.<id>]` 테이블:
- `name` — 표시 이름
- `base_url` — API base URL
- **`wire_api`** — 프로토콜. **현재 `responses`만 지원**(아래 ★ 주의)
- `env_key` — 프로바이더 API 키를 담은 환경변수명
- `experimental_bearer_token` — 직접 bearer(비권장, `env_key` 권장)
- `requires_openai_auth`(bool, 기본 false) — OpenAI 인증 사용 여부
- `http_headers` / `env_http_headers` — 정적/환경변수 기반 헤더
- `query_params` — 추가 쿼리 파라미터
- `supports_websockets`, `stream_idle_timeout_ms`(기본 300000),
  `stream_max_retries`(5), `request_max_retries`(4)
- command-backed 토큰: `auth.command` / `auth.args` / `auth.cwd` /
  `auth.timeout_ms`(5000) / `auth.refresh_interval_ms`(300000)

built-in 프로바이더 `openai` / `ollama` / `lmstudio`는 **예약어(override 불가)**.
openai의 base_url만 바꾸려면 최상위 `openai_base_url`. 로컬 모델은 `--oss` +
`--local-provider lmstudio|ollama`(config `oss_provider`). Amazon Bedrock은
`[model_providers.amazon-bedrock] aws.profile / aws.region`.

### ★ wire_api 주의 (커스텀 라우팅 최대 함정)

- **현재 `responses`만 지원.** OpenAI가 chat/completions 경로를 **2026-02에
  제거**했다. `wire_api = "chat"`(또는 구버전 설정)은 **기동 실패**한다.
- 2025년에 작성된 대부분 가이드가 `wire_api="chat"`으로 써놔서 지금 깨진 config의
  최대 원인. 우리가 붙일 때 대상 엔드포인트는 **OpenAI Responses API 포맷을
  지원해야만** 라우팅된다.
- OpenRouter 예:
  ```toml
  model = "openai/gpt-5.3-codex"     # 정확한 슬러그(provider 접두사 포함)
  model_provider = "openrouter"
  [model_providers.openrouter]
  base_url = "https://openrouter.ai/api/v1"
  wire_api = "responses"
  env_key = "OPENROUTER_API_KEY"
  ```
- 커스텀 프로바이더 모델은 `model/list`에 없으므로 **사용자가 슬러그를 직접
  입력**하는 필드가 필요하다.

## 4. thread / turn 단위 전환 규칙 (프로토콜 실측)

| 파라미터 | ThreadStartParams | ThreadResumeParams | TurnStartParams |
|---|---|---|---|
| `model` | O | O | O ("이 턴 및 이후 턴") |
| `modelProvider` | O | O | **X (없음)** |
| `serviceTier` | O | O | O ("이 턴 및 이후 턴") |

- **모델(같은 프로바이더 내)·serviceTier(Fast 등)는 턴 단위로 즉시 전환** 가능 —
  프로세스 재시작 불필요.
- **프로바이더 전환은 thread 레벨에서만**(`thread/start` 또는 `thread/resume`) →
  프로바이더를 바꾸려면 새 thread를 start하거나 resume로 재바인딩한다. 프로세스는
  유지 가능하고, `config/value/write`까지는 불필요.
- 현재 어댑터는 `turn/start`에 `model`만 넘기고 `modelProvider`/`serviceTier`는
  안 넘긴다 → 여기에 추가하는 것이 커스텀 라우팅/Fast tier의 핵심 훅.

## 5. 인증 제약 (ChatGPT 구독 vs API 키)

- ChatGPT 로그인 자격증명은 **built-in `openai` 프로바이더(OpenAI 서버) 전용**.
- 커스텀 프로바이더는 **그 프로바이더 자체 키**가 필요(`env_key` /
  `experimental_bearer_token` / `auth.command`)하며 별도 과금. 즉 "ChatGPT
  구독으로 OpenRouter 라우팅"은 **불가** — 프로바이더 키를 따로 넣어야 한다.
- 프로젝트 스코프 config(`<repo>/.codex/config.toml`)는 provider/auth 키를
  **override 못 함** — 머신 레벨 `~/.codex/config.toml`에서만. `requires_openai_auth`,
  `forced_login_method`(`chatgpt|api`)로 인증 방식 통제.
- `--oss` 로컬 모델(ollama/lmstudio)은 인증 불필요.

## 6. OpenRouter 라우팅 확정값 (Phase 2 레퍼런스)

worker2 Phase 2용으로 Codex → OpenRouter 경로를 정밀 확정. 확인일 2026-07-03,
OpenRouter 공식 문서 + Codex custom-provider 문서 + 로컬 codex 0.142.4 대조.
(로컬 PoC 왕복 교차검증은 worker2 진행 중 — 아래 ★표시 항목은 PoC로 재확인 예정.)

- **엔드포인트/base_url**: OpenRouter는 **Responses API를 지원(beta)** —
  `POST https://openrouter.ai/api/v1/responses`. config엔 `base_url =
  "https://openrouter.ai/api/v1"`(끝 `/v1`, `/responses`는 붙이지 말 것). ★codex가
  엔드포인트 경로(`/responses`)를 자동 append(built-in openai 프로바이더와 동일
  패턴). beta라 breaking change 가능 + **stateless**(codex가 매 턴 히스토리를
  실어보내므로 정상).
- **model 슬러그**: `provider/model-name` 형식, **provider 접두사 필수**. 예
  `openai/o4-mini`, `z-ai/glm-4.6`, `moonshotai/kimi-k2`. codex는 `model` 값을
  프로바이더에 **그대로 전달**(가공 없음) → 정확한 슬러그는 OpenRouter 카탈로그에서
  확인. `model/list`에 안 나오므로 UI 직접 입력. (틸드 `~` 접두는 auto-latest 별칭
  변형일 뿐 필수 아님.)
- **modelProvider**: config `[model_providers.<id>]`의 id와 정확히 일치
  (관례상 `"openrouter"`). thread/start `modelProvider="openrouter"` =
  `model_provider="openrouter"` = `[model_providers.openrouter]`.
- **reasoning effort**: OpenRouter Responses API가 reasoning 지원, codex는
  Responses 페이로드에 `reasoning.effort`를 네이티브로 실음 → **매핑됨(무시 아님)**.
  단 **대상 모델이 reasoning 모델일 때만 유효**(비-reasoning 모델은 무시/오류 가능).
- **인증(ChatGPT 로그인 없이)**: `env_key="OPENROUTER_API_KEY"` +
  `requires_openai_auth=false`(커스텀 기본값)면 **ChatGPT 로그인/auth.json 없이
  기동**. codex가 런타임에 env var를 읽어 Bearer로 전송(키 `sk-or-...`). 인증
  방식은 상호배타(env_key / auth.command / requires_openai_auth 중 하나). env/auth
  키는 **머신 레벨** `~/.codex/config.toml`에서만(인라인 `-c`도 가능).
- **함정**:
  - Responses API가 **beta** — 모델/프로바이더별 지원 편차. 모든 OR 모델이
    `/responses`에서 tool calling·streaming을 동일 지원하지 않음. ★codex는
    apply_patch/shell 등 **tool calling 의존**이 커서, tool call 미흡 모델은 루프가
    깨짐 → PoC로 "파일 편집 1턴" tool call 왕복 확인 필수.
  - **SSE streaming**: 일부 프로바이더가 completion은 되나 SSE 실패 →
    `stream_idle_timeout_ms`(기본 300000) 상향, `stream_max_retries`(5)/
    `request_max_retries`(4) 조정.
  - **rate limit**: `model/rerouted` reroute 알림은 OpenAI 서버 전용이라 OR
    라우팅엔 안 옴 → OR측 429는 turn 에러로 표면화(no silent fallback로 표시).
  - **prompt logging**: OpenRouter는 기본 프롬프트 미로깅(opt-in 시에만).

확정 config 예(PoC용, 인라인):
```
-c model_provider="openrouter"
-c model_providers.openrouter.base_url="https://openrouter.ai/api/v1"
-c model_providers.openrouter.wire_api="responses"
-c model_providers.openrouter.env_key="OPENROUTER_API_KEY"
# env: OPENROUTER_API_KEY=sk-or-...
# thread/start: model="z-ai/glm-4.6"(실제 OR 슬러그), modelProvider="openrouter", effort=원하는값
```

§6 추가 근거(확인 2026-07-03):
- https://openrouter.ai/docs/api/reference/responses/overview — Responses API beta,
  `POST /v1/responses`, stateless, reasoning/tool calling
- https://openrouter.ai/docs/cookbook/coding-agents/codex-cli — base_url,
  model_provider=openrouter, env_key, 슬러그 provider 접두사
- https://codex.danielvaughan.com/2026/04/23/codex-cli-custom-model-providers-configuration-guide/
  — env_key만으로 기동, requires_openai_auth 상호배타, model 값 그대로 전달,
  streaming 캐비엇

## AgentParty 구현 범위 권고

**Phase 1 (즉효·저비용 — worker2 진행 중):**
- `model/list`(필요 시 `includeHidden`) 라이브 디스커버리 → 계정 카탈로그 전체 +
  `supportedReasoningEfforts` + `serviceTiers`(Fast)를 모델 선택 UI에 노출.
- `turn/start`에 `model`·`serviceTier` 전달로 턴 단위 전환. Claude 하네스급 모델
  선택 확보.

**Phase 2 (커스텀 라우팅) — ✅ OpenRouter 구현 완료 (2026-07-03):**
- 카탈로그의 OpenRouter 모델 전부를 Codex 하네스 라우트로 노출
  (`src/core/modelRegistry.ts` `codexOpenRouterRoute`). 슬러그는 카탈로그
  `orModelId`(예 `z-ai/glm-5.2`)라 **직접 입력 필드 불필요**.
- 프로바이더는 `~/.codex/config.toml`을 건드리지 않고 **인라인 `-c` 오버라이드**로
  세션마다 주입(`src/shared/codexProviders.ts` `codexProviderConfigArgs` →
  `codexAdapter.ensureProcess`). `wire_api="responses"` 강제(하드코딩) — chat 불가.
- `thread/start`·`thread/resume`에 `modelProvider:"openrouter"` 전달
  (`resolveModelProvider`); 모델→프로바이더는 슬러그로 유도(`codexProviderForModel`).
- 인증/과금: `OPENROUTER_API_KEY`를 app-server 프로세스 env에 주입. 키 없이
  OpenRouter 모델 선택 시 `thread/start` 전 **명시적 에러**(no silent fallback) +
  위저드 과금 안내. 비용은 카탈로그 per-token 가격으로 추정 표기
  (`costing.ts` OpenRouterCostProvider).
- PoC(GLM-5.2 왕복) + full-process e2e 검증 완료. QA: `scripts/qa-codex-models.mjs`.
- **한계**: Responses API가 beta라 tool calling/streaming 모델별 편차 가능;
  Anthropic 구독 모델은 이 경로로도 불가.

**부가:** `modelProvider/capabilities/read`로 image generation/web search UI 게이팅.

## 7. OpenRouter 라우팅 운영 노트 (실측 2026-07-04)

Phase 2 QA 중 실제 codex 0.142.4 + OpenRouter로 확인한 동작들:

- **assistant 응답 중복 (수정됨)**: codex는 한 메시지 item(동일 itemId)을
  `item/started`(버퍼 프로바이더는 여기서 이미 전체 텍스트) → `item/completed`
  두 시점에 보낸다. 어댑터가 양쪽에서 emit하면 화면·비용표시가 2배가 된다. 단
  **모델은 1회 생성**(동일 itemId, outputTokens 1회분)이라 실제 과금은 정상.
  → `normalizeItem`이 agentMessage·reasoning을 **`item/completed`에서만 emit**.
  QA: `scripts/qa-codex-dedup.mjs`(실제 어댑터+렌더러 파이프라인).

- **"Model metadata not found" 경고 (차분한 info 배너)**: codex는 내장 모델
  레지스트리에 없는 OpenRouter 슬러그(minimax/deepseek 등)에 대해 `warning`
  notification으로 "fallback metadata … can degrade performance"를 보낸다.
  **`-c model_context_window=…`를 줘도 이 경고는 사라지지 않고**(레지스트리 엔트리
  자체가 없어서 — 값만 override로는 해결 안 됨), 그 키는 auto-compaction을 깨는
  codex 버그(#16068) 위험이 있어 **주입하지 않는다**. 이 경고는 **모델이 바뀌는
  게 아니라**(no-silent-fallback 규칙이 겨냥하는 model-selection fallback이 아님)
  codex 내부 토큰 예산용 기본값일 뿐이다. 에러가 아니므로 `classifyDiagnostic`이
  **severity=info**(accent 색 + Info 아이콘, warning/error와 시각 구분)로 분류하고
  detail 첫머리에 "에러가 아닙니다 … 응답은 정상"을 둬서 정보 알림으로 읽히게 한다.
  임의 3rd-party 모델을 codex로 태울 때의 본질적 현상.

- **minimax/deepseek thread 지연**: 메타데이터 fallback이 아니라 **OpenRouter
  프로바이더측 latency**(GLM은 빠른 프로바이더, minimax/deepseek는 느리거나 cold).
  경고와 지연은 별개 현상.

- **request_user_input 비활성 (정상)**: 모델이 "Default 모드라 request_user_input
  도구가 비활성"이라 말하는 건 **예상된 동작**이다. codex가 이 도구를 feature
  flag로 OFF(`request_permissions_tool`/`default_mode_request_user_input`/
  `exec_permission_approvals` 모두 under-development=false; "not supported in exec
  mode")했기 때문. AgentParty 버그 아님. 실제 승인은 이 도구가 아니라 표준 승인
  request로 처리된다:
  - 조건: `approvalPolicy="on-request"`(또는 untrusted) + 막는 sandbox(read-only,
    또는 workspace-write에서 워크스페이스 밖/네트워크) + `approvals_reviewer="user"`.
  - 그러면 `item/commandExecution/requestApproval`(명령) /
    `item/fileChange/requestApproval`(패치) / `item/permissions/requestApproval`
    (권한상승)이 서버→클라로 온다. 어댑터가 이미 처리(승인 카드).
  - AgentParty codex 멤버 기본 정책(`DEFAULT_CODEX_POLICY`)이
    workspace-write + on-request + guardian off라 이 조합을 이미 충족. 단
    workspace-write는 워크스페이스 **안** 편집은 자동 적용(승인 안 물음) — Auto
    모드의 의도된 동작. 승인을 강제로 보려면 preset을 Read Only로.

## 근거 (확인일 2026-07-03, §6–§7 갱신 2026-07-04)

- https://developers.openai.com/codex/config-reference — `model`,
  `model_provider`, `[model_providers.*]` 스펙
- https://developers.openai.com/codex/config-advanced — 인증/프로젝트 스코프 제약
- https://openrouter.ai/blog/tutorials/codex-cli-openrouter/ ,
  https://openrouter.ai/docs/cookbook/coding-agents/codex-cli — wire_api=responses,
  슬러그 규칙
- https://codex.danielvaughan.com/2026/04/23/codex-cli-custom-model-providers-configuration-guide/
  — chat/completions 제거 이력
- 로컬 실측: `codex app-server generate-json-schema`(`Model`,
  `ModelListResponse`, `ModelListParams`, `ThreadStartParams`,
  `ThreadResumeParams`, `TurnStartParams`,
  `ModelProviderCapabilitiesReadResponse`), `codex debug models`,
  `~/.codex/models_cache.json`
- 프로토콜 request 전체 목록은 `01-app-server-protocol.md` 참조.
</content>
