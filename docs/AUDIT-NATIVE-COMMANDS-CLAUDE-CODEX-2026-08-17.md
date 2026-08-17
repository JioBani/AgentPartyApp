# AgentParty 네이티브 명령·스킬 실행 감사

- 감사일: 2026-08-17
- 대상: AgentPartyApp의 Claude Code 및 Codex 멤버 composer 명령 팔레트
- 설치 버전: Claude Code 2.1.232, Codex CLI 0.147.0
- 판정 범위: 명령이 목록에 보이는지만이 아니라, 선택 후 네이티브 동작이 실행되고 사용자가 결과를 확인할 수 있는지까지 포함

## 1. 요약

| 분류 | Claude Code | Codex |
|---|---|---|
| 실제 실행과 의도한 결과·피드백까지 확인 | `/context`, `/goal`, `/compact` | `/compact` |
| SDK/프로토콜상 실행 가능, 명령별 제품 E2E 미완료 | 22개 네이티브 명령과 동적으로 발견된 Claude 스킬·MCP prompt | 없음 |
| 호출은 되지만 결과·피드백이 불충분 | `/usage`, `/clear` | 현재 확정된 항목 없음 |
| 실행되지 않음 | SDK `system/init`에 없는 CLI 전용 명령. 대표적으로 `/model`, `/permissions`, `/mcp`, `/status` | `/compact`를 제외한 현재 Codex TUI slash command 전체 |
| 잘못된 문법으로 노출 | 없음 | 발견된 스킬 21개와 플러그인 9개를 `/name`으로 노출 |
| AgentParty가 만든 가짜 명령 | 4개 | 2개 |

핵심 결론은 다음과 같다.

1. Claude Code는 Agent SDK가 `system/init`으로 보고한 비대화형 명령만 실행할 수 있다. CLI picker를 여는 `/model` 같은 명령은 AgentParty에서 실행할 수 없다.
2. Codex는 TUI가 아니라 app-server를 사용한다. AgentParty가 `/status` 같은 문자열을 `turn/start` 일반 텍스트로 보내므로 네이티브 명령이 아니라 모델 요청으로 처리된다.
3. Codex에서 정상 연결된 네이티브 명령은 현재 `/compact` 하나뿐이다.
4. 기존 command-palette QA는 명령이 입력창에 삽입되는지만 검사하고 실제 실행 결과나 상태 변화를 검사하지 않는다.

## 2. 판정 기준

### A. 정상적으로 실행되는 명령

다음 조건을 모두 만족해야 한다.

- 선택한 명령이 모델에게 평문 요청으로 전달되지 않고 네이티브 명령 또는 전용 AppController/app-server 작업으로 실행된다.
- 명령이 의도한 세션·설정·파일·컨텍스트 상태를 변경하거나 조회한다.
- 성공 또는 실패가 transcript, 상태 카드, modal, toast 등 사용자에게 보이는 형태로 표시된다.

### B. 정상적으로 실행되지 않는 명령

다음 중 하나에 해당한다.

- CLI TUI에만 존재하는 명령을 SDK/app-server 일반 입력으로 보낸다.
- 명령을 보냈지만 모델이 자연어 요청으로 해석한다.
- AgentParty 팔레트에는 있지만 실행 action 또는 RPC가 없다.
- 스킬·플러그인의 네이티브 invocation 문법이나 구조화 metadata를 사용하지 않는다.

### C. 호출은 되지만 결과·피드백이 불충분한 명령

SDK 호출이나 백엔드 상태 변경은 발생하지만 사용자가 기대한 결과를 얻었는지 확인하기 어렵다.

- transcript에는 일반적인 `turn complete`만 남는다.
- SDK 컨텍스트는 초기화됐지만 기존 AgentParty transcript는 그대로 남는다.
- 결과가 SDK `result` 필드에만 있고 renderer가 해당 내용을 표시하지 않는다.
- 명령 이름은 사용량·상태 조회를 암시하지만, 실제 결과에는 사용률·한도·리셋 시각 같은 핵심 정보가 없다.

### D. 그 외

- 계정, OS, feature flag에 따라 원래 CLI에서도 조건부로 나타나는 명령
- 제거됐지만 공식 표에 호환성 정보로 남은 명령
- AgentParty에 별도 대체 UI가 있으나 slash command 자체는 동작하지 않는 경우
- 동적 사용자 스킬, MCP prompt, 플러그인 명령
- 현재 실측하지 않아 프로토콜 지원만 확인된 명령

## 3. 정상적으로 실행되는 명령

### 3.1 Claude Code — 실제 호출까지 확인

| 명령 | 실측 결과 | 사용자 피드백 |
|---|---|---|
| `/context` | SDK가 실제 context usage를 계산 | 모델, 총 토큰, 도구·MCP·memory·skill별 사용량이 assistant 메시지로 표시됨 |
| `/goal` | 현재 goal 조회 | goal이 없다는 상태와 사용법이 assistant 메시지로 표시됨 |
| `/compact` | Claude SDK compaction 실행 | `compact_state` 카드로 running/done/failed가 표시됨 |

`/compact`는 `compact_boundary`, `compact_result`, `compact_error`를 별도 `compact_state`로 변환하므로 일반 명령보다 피드백 경로가 명확하다.

### 3.2 Claude Code — SDK가 실행 가능하다고 보고한 명령

아래 명령은 현재 `system/init`과 `initializationResult().commands`에 포함된다. Claude 공식 SDK 명세상 이 목록은 비대화형 환경에서 dispatch 가능한 명령이다. 다만 이번 감사에서 각 명령의 최종 부작용까지 제품 E2E로 전수 검증하지는 않았다.

`/batch`, `/claude-api`, `/code-review`, `/config`, `/debug`, `/deep-research`, `/design-sync`, `/fewer-permission-prompts`, `/heapdump`, `/init`, `/insights`, `/loop`, `/reload-skills`, `/review`, `/run`, `/run-skill-generator`, `/schedule`, `/security-review`, `/simplify`, `/team-onboarding`, `/usage-credits`, `/verify`

별도 분류된 `/usage`, `/clear`를 포함하면 현재 공식 명령표와 SDK 목록의 교집합은 27개다.

동적으로 `system/init`에 포함되는 사용자·프로젝트 스킬, 플러그인 스킬, `/mcp__<server>__<prompt>`도 Claude SDK의 정식 slash-command 경로를 사용한다. 따라서 목록에 보고된 항목은 구조상 정상 실행 경로를 가진다.

### 3.3 Codex

| 명령 | 실행 경로 | 사용자 피드백 |
|---|---|---|
| `/compact` | `thread/compact/start` RPC | `compact_state` running/done/failed 카드와 실패 diagnostic |

Codex `/compact`는 composer에서 일반 텍스트로 보내지 않고 `actions.compact()`로 분기되는 현재 유일한 네이티브 command action이다.

## 4. 정상적으로 실행되지 않는 명령

### 4.1 Codex — `/compact`를 제외한 네이티브 slash command

다음 명령은 현재 AgentParty에서 전용 dispatcher가 없다. 팔레트에 있거나 사용자가 직접 입력하더라도 `turn/start.input[].text`로 보내져 모델 요청이 된다.

`/permissions`, `/ide`, `/keymap`, `/vim`, `/setup-default-sandbox`, `/sandbox-add-read-dir`, `/agent`, `/subagents`, `/apps`, `/plugins`, `/hooks`, `/clear`, `/rename`, `/archive`, `/delete`, `/copy`, `/diff`, `/exit`, `/quit`, `/experimental`, `/approve`, `/memories`, `/skills`, `/import`, `/feedback`, `/init`, `/logout`, `/mcp`, `/mention`, `/model`, `/fast`, `/plan`, `/goal`, `/personality`, `/ps`, `/stop`, `/fork`, `/app`, `/side`, `/btw`, `/raw`, `/resume`, `/new`, `/review`, `/status`, `/usage`, `/debug-config`, `/statusline`, `/title`, `/theme`, `/pets`, `/pet`

실제 Codex app-server에 `/status`를 보낸 결과, session status를 표시하지 않고 모델이 다음처럼 응답했다.

> 확인 중입니다. 현재 브랜치, 워크트리 변경사항, 진행 중인 테스트/프로세스를 점검하겠습니다.

그 뒤 모델은 실제로 브랜치, working tree, 프로세스를 조사했다. 이는 `/status`가 명령으로 처리되지 않고 일반 자연어 작업으로 처리됐다는 직접 증거다.

### 4.2 Codex — 하드코딩된 9개 명령의 상태

| 팔레트 항목 | 판정 | 이유 |
|---|---|---|
| `/compact` | 정상 | 전용 action과 RPC가 있음 |
| `/model` | 실패 | picker/action 없이 `/model `을 composer에 삽입 |
| `/approvals` | 실패·구식 이름 | 현재 네이티브 이름은 `/permissions`; 전용 action도 없음 |
| `/new` | 실패 | 새 thread/session을 만들지 않고 평문 전송 |
| `/init` | 실패 | Codex TUI의 init workflow를 호출하지 않고 평문 전송 |
| `/diff` | 실패 | diff UI/RPC 없이 평문 전송 |
| `/mention` | 실패 | 구조화된 file mention 없이 평문 전송 |
| `/status` | 실패 | 실측상 모델이 저장소 상태 조사 작업으로 오해 |
| `/mcp` | 실패 | MCP manager/status RPC 없이 평문 전송 |

### 4.3 Claude Code — 현재 SDK에서 실행할 수 없는 공식 CLI 명령

Claude Agent SDK는 터미널 없이 동작 가능한 명령만 `system/init`에 제공한다. 다음 공식 명령은 현재 SDK 목록에 없어서 AgentParty에서 네이티브 명령으로 dispatch할 수 없다.

`/add-dir`, `/advisor`, `/agents`, `/autocompact`, `/autofix-pr`, `/background`, `/branch`, `/btw`, `/bug`, `/cd`, `/chrome`, `/color`, `/copy`, `/cost`, `/dataviz`, `/design-login`, `/desktop`, `/diff`, `/doctor`, `/effort`, `/exit`, `/export`, `/fast`, `/feedback`, `/focus`, `/fork`, `/help`, `/hooks`, `/ide`, `/import`, `/install-github-app`, `/install-slack-app`, `/keybindings`, `/list-agents`, `/login`, `/logout`, `/mcp`, `/memory`, `/mobile`, `/model`, `/passes`, `/permissions`, `/plan`, `/plugin`, `/powerup`, `/pr-comments`, `/privacy-settings`, `/radio`, `/recap`, `/release-notes`, `/reload-plugins`, `/remote-control`, `/remote-env`, `/rename`, `/resume`, `/rewind`, `/sandbox`, `/scroll-speed`, `/setup-bedrock`, `/setup-vertex`, `/skills`, `/stats`, `/status`, `/statusline`, `/stickers`, `/stop`, `/subtask`, `/tasks`, `/teleport`, `/terminal-setup`, `/theme`, `/tui`, `/ultrareview`, `/upgrade`, `/voice`, `/web-setup`, `/workflows`

실제로 Claude SDK에 `/model`을 보낸 결과는 다음과 같았다.

> `/model isn't available in this environment.`

공식 명령표에는 총 106개 행이 있으며, 현재 SDK 목록과 겹치지 않는 행은 79개다. 위 목록에서는 제거된 `/vim`, `/ultraplan`을 별도로 제외했다. 또한 계정·플랫폼·feature flag에 따라 CLI 자체에서도 숨겨지는 조건부 명령이 포함되어 있으므로, 모든 사용자가 CLI에서 항상 77개를 본다는 뜻은 아니다.

## 5. 호출은 되지만 결과·사용자 피드백이 불충분한 명령

### 5.1 Claude Code `/usage` — 호출 성공만 확인, 실사용 판정 실패

`/usage`를 Claude SDK에 보내면 오류 없이 assistant 메시지가 반환된다. 그러나 실측된 내용은 최근 24시간·7일의 사용 **특성에 관한 서술형 분석**이었다. 다음과 같이 사용자가 사용량 명령에서 기대하는 핵심 정보는 확인되지 않았다.

- 현재 5시간·주간 사용률 또는 남은 한도
- 각 한도의 리셋 시각
- 한도 초과 또는 임박 여부
- 수치가 어느 계정·구독을 기준으로 하는지

따라서 “응답이 보인다”는 것은 확인됐지만, Claude Code 네이티브 `/usage`와 동등하게 사용할 수 있다고 보기는 어렵다. 이 감사에서는 `/usage`를 정상 명령에서 제외하고 **호출은 되지만 결과가 불충분한 명령**으로 판정한다.

AgentParty에는 별도의 account-global usage meter와 `GET /api/usage` 경로가 있으므로, `/usage`를 지원하려면 같은 authoritative snapshot을 보여 주는 전용 action으로 연결하거나 사용자에게 해당 화면을 명확히 안내해야 한다.

### 5.2 Claude Code `/clear` — 확정

`/clear`는 SDK 내부 conversation context를 초기화한다. 실측 결과도 성공 result를 반환했다. 그러나 assistant 내용은 `(no content)`뿐이었다.

현재 AgentParty는 기존 화면 transcript를 지우거나 “새 대화가 시작됨” 경계를 만들지 않는다. 따라서 사용자는 다음을 구분하기 어렵다.

- 실제 Claude context가 초기화됐는지
- 이전 transcript가 계속 모델 context에 남아 있는지
- 단순히 빈 응답이 반환된 것인지

필요한 피드백은 최소한 다음과 같다.

- “Claude conversation context가 초기화되었습니다” system card
- 이전 transcript와 새 conversation을 구분하는 명확한 boundary
- 이전 session ID 또는 resume 가능 여부 안내

### 5.3 Claude SDK `result`만 반환하는 명령 — 구조적 위험

Claude adapter는 `turn_complete.result`를 이벤트에 담지만 transcript reducer는 실제 result 문자열을 표시하지 않고 `turn complete` 상태만 추가한다.

`/context`, `/goal`은 동일 내용을 assistant snapshot으로도 보내므로 현재 화면에서 보인다. `/usage`도 assistant 메시지는 보이지만, 앞 절처럼 필요한 사용량 수치가 충분하지 않다. 미래 명령이나 특정 조건의 명령이 assistant snapshot 없이 `result`만 반환하면 실행 결과 자체가 사라진다.

따라서 다음 회귀 테스트가 필요하다.

- 성공 result만 있고 assistant message가 없는 fixture
- 실패가 아닌 안내 메시지가 result에만 있는 fixture
- 명령별 state change와 사용자-visible feedback을 함께 검증

### 5.4 Codex

현재 감사에서 “네이티브 동작은 실행됐으나 피드백만 없는” Codex slash command는 확정되지 않았다.

- `/compact`는 성공·실패 카드가 있다.
- 나머지는 실행 후 피드백이 없는 것이 아니라 네이티브 명령 자체가 실행되지 않는다.

## 6. 그 외의 분류

### 6.1 Codex 스킬 21개 — 기능은 존재하지만 팔레트 invocation이 잘못됨

현재 `skills/list`에서 발견된 항목:

`browser:control-in-app-browser`, `claude-party:party-doctor`, `claude-party:party-init`, `claude-party:party-member-close`, `claude-party:party-member-create`, `claude-party:party-member-list`, `claude-party:party-member-remove`, `claude-party:party-member-resume`, `claude-party:party-send`, `documents:documents`, `pdf:pdf`, `presentations:Presentations`, `spreadsheets:Spreadsheets`, `spreadsheets:excel-live-control`, `template-creator:template-creator`, `imagegen`, `openai-docs`, `plugin-creator`, `review-agent`, `skill-creator`, `skill-installer`

AgentParty는 이 항목을 `/imagegen`, `/openai-docs` 같은 slash command로 변환한다. Codex 네이티브 TUI는 `@` picker를 사용하고, 구조화된 mention/context를 prompt에 넣는다. 따라서 현재 팔레트 항목은 스킬을 명시적으로 활성화하지 않는다.

모델이 자연어를 보고 우연히 같은 스킬을 자동 선택할 수는 있지만, 그것은 팔레트 명령이 정상 연결됐다는 증거가 아니다.

### 6.2 Codex 플러그인 9개 — 플러그인을 명령으로 잘못 취급

현재 `plugin/installed`에서 발견된 항목:

`claude-party`, `documents`, `pdf`, `spreadsheets`, `presentations`, `template-creator`, `browser`, `openai-templates`, `plugin-management`

플러그인은 스킬, MCP, hooks, apps 등을 포함하는 bundle이다. 플러그인 이름 자체를 `/documents`, `/browser`처럼 실행 가능한 명령으로 만들 수 없다. `/plugins` manager 또는 플러그인이 제공하는 실제 skill/app/tool을 연결해야 한다.

### 6.3 AgentParty가 추가한 가짜 slash command

| 런타임 | 항목 | 현재 동작 |
|---|---|---|
| Claude | `/member-create`, `/member-open`, `/send-to`, `/split-panel` | composer에 문자열 삽입 후 모델에게 전송 |
| Codex | `/member-create`, `/send-to` | composer에 문자열 삽입 후 모델에게 전송 |

이 명령들은 AgentParty 기능이지만 `AppController` action으로 등록되어 있지 않다. 모델이 문자열의 의도를 이해하고 별도 MCP tool을 호출해야만 우연히 동작할 수 있다.

### 6.4 대체 UI는 있으나 slash command는 동작하지 않는 경우

| 네이티브 명령 | AgentParty의 대체 기능 | 판정 |
|---|---|---|
| Claude/Codex `/model` | runtime/model 선택 UI 및 model completion | 대체 기능은 있음. `/model` 호환은 없음 |
| Claude/Codex `/permissions` | composer permission control | 대체 기능은 있음. slash 호환은 없음 |
| Claude `/plan` | permission mode control | 일부 대체. `/plan <prompt>` semantics는 없음 |
| Claude/Codex `/mcp` | MCP modal 및 reconnect/auth actions | 일부 대체. slash manager는 없음 |
| Claude/Codex `/resume` | AgentParty session history/resume | 일부 대체. native picker는 없음 |
| Claude/Codex `/status` | member header, diagnostics, usage meter | 상태 일부는 노출. native status 결과와 동일하지 않음 |

대체 UI가 있다는 사실과 네이티브 slash command가 동작한다는 판정은 분리해야 한다.

### 6.5 조건부·제거된 Claude 명령

- 조건부: `/desktop`, `/passes`, `/setup-bedrock`, `/setup-vertex`, `/teleport`, `/upgrade` 등은 OS, 계정, provider 또는 feature flag에 따라 CLI에서도 보이지 않을 수 있다.
- 제거됨: `/vim`, `/ultraplan`은 공식 표에 migration 정보로 남아 있지만 현재 구현 대상이 아니다.
- 별칭: `/cost`, `/stats` 등은 실제 SDK command inventory에 canonical command만 나타날 수 있으므로 alias별 추가 실측이 필요하다.

## 7. 근본 원인

### 7.1 Codex

1. `CODEX_COMMANDS`를 실제 app-server capability가 아니라 정적 배열로 정의한다.
2. `skills/list`와 `plugin/installed` 결과를 동일한 `HarnessCommand`로 합친다.
3. renderer가 모든 항목 앞에 `/`를 붙인다.
4. `/compact` 외에는 `PaletteRun`이 전부 `insert`다.
5. 전송 시 명령 종류를 구분하지 않고 `turn/start`의 일반 text item으로 보낸다.

### 7.2 Claude Code

1. Agent SDK가 dispatch 가능한 command inventory를 제공하는 구조는 올바르다.
2. CLI-only interactive command를 AgentParty action/modal로 변환하는 compatibility layer가 없다.
3. live inventory가 오기 전 static fallback에는 `/model`, `/permissions`, `/mcp`, `/resume` 같은 실행 불가능 항목이 들어 있어 초기화 race 동안 잘못 노출될 수 있다.
4. `turn_complete.result`의 사용자-visible 본문을 transcript reducer가 버린다.

### 7.3 QA

기존 QA는 다음만 확인한다.

- `/` 입력 시 목록 표시
- `/model` 선택 시 composer에 `/model ` 삽입
- `/compact` 선택 시 local action 호출

확인하지 않는 것:

- 명령 실행 후 model, permission, session, context 상태 변화
- native picker/modal 표시
- app-server RPC method 호출 여부
- 모델 턴이 불필요하게 발생했는지
- 성공·실패 feedback이 사용자 화면에 남았는지

## 8. 권장 수정 순서

1. 명령 definition에 `executionKind`를 추가한다: `app-action`, `app-server-rpc`, `claude-sdk-command`, `codex-mention`, `unsupported`.
2. Codex built-in command를 실제 app-server RPC와 AppController method에 각각 연결한다.
3. Codex skill/plugin을 slash command에서 제거하고 `@` 기반 asset picker로 분리한다.
4. Claude CLI-only 명령은 AgentParty modal/action으로 구현된 것만 노출한다.
5. `/clear`에 conversation boundary와 성공 피드백을 추가한다.
6. `turn_complete.result`가 assistant snapshot 없이 도착해도 transcript에 표시한다.
7. AgentParty 가짜 명령을 모델 프롬프트가 아니라 AppController action으로 실행한다.
8. 실제 AgentParty 프로세스와 실제 Claude/Codex runtime을 사용해 명령별 상태 변화와 피드백을 검증하는 E2E를 추가한다.

## 9. 코드 근거

- Codex 정적 명령 배열: `src/core/codexAdapter.ts:101`
- Codex skill/plugin discovery: `src/core/codexAdapter.ts:885-904`
- Codex 일반 text 전송: `src/core/codexAdapter.ts:935-950`
- Claude SDK command inventory 반영: `src/core/claudeAdapter.ts:953-968`
- Claude command result 처리: `src/core/claudeAdapter.ts:1115-1160`
- transcript가 `turn_complete.result` 대신 상태만 표시: `src/shared/transcriptEvents.ts:95-98`
- live inventory 뒤 AgentParty 명령 강제 추가: `src/renderer/workbench/paletteModel.ts:164-179`
- command 선택 시 문자열 삽입: `src/renderer/workbench/useCommandPalette.ts:60-68`
- `/model ` 삽입만 검사하는 QA: `scripts/qa-command-palette.mjs:140-145`

## 10. 2026-08-18 구현 반영

이 감사 결과를 바탕으로 command palette를 실행 정책의 단일 진실 공급원으로 변경했다. 목록에 보이는 항목은 이제 다음 세 상태 중 하나다.

### 10.1 AgentParty 기능으로 정상 실행

| 명령 | Claude Code | Codex | AgentParty 동작 |
|---|---:|---:|---|
| `/model` | 지원 | 지원 | Runtime 모델·추론 설정 modal |
| `/effort` | 지원 | 해당 없음 | Runtime 모델·추론 설정 modal |
| `/permissions` | 지원 | 지원 | 멤버 권한 설정 modal |
| `/approvals` | 해당 없음 | 호환 별칭 | 멤버 권한 설정 modal |
| `/plan` | 지원 | 미지원 | Claude 권한 설정 modal |
| `/mcp` | 지원 | 지원 | MCP 서버 관리 modal |
| `/status` | 지원 | 지원 | 현재 멤버의 세션 상태 modal |
| `/usage` | 지원 | 지원 | AgentParty Usage 화면 |
| `/resume` | 지원 | 지원 | AgentParty Sessions 화면 |
| `/new` | 해당 없음 | 지원 | 기존 hard restart 동작 |
| `/compact` | 지원 | 지원 | 기존 native compact action |
| `/stop` | 지원 | 지원 | 현재 턴 interrupt action |
| `/autocompact` | 지원 | 지원 | 자동 압축 설정 modal |
| `/doctor` | 지원 | 지원 | Runtime 환경 진단 화면 |

이 항목들은 composer에 slash 문자열을 넣거나 모델에게 평문으로 보내지 않는다. palette 선택 또는 명령 직접 입력 시 동일한 앱 action/UI로 분기한다.

### 10.2 노출은 유지하지만 실행 불가

- Claude/Codex 정적 CLI-only 명령은 `disabled` badge, 비활성 행, `AgentParty에서는 지원하지 않는 명령입니다.` 사유를 표시한다.
- Codex `skills/list` 및 `plugin/installed` 항목은 목록에 유지하되 각각 `AgentParty에서는 지원하지 않는 스킬입니다.`, `AgentParty에서는 지원하지 않는 플러그인입니다.`를 표시한다. app-server·SDK 같은 내부 transport 이름은 사용자 문구에 노출하지 않는다.
- `/member-create`, `/member-open`, `/send-to`, `/split-panel`처럼 실제 AppController action이 없던 AgentParty 가짜 명령도 동일하게 비활성화했다.
- 마우스 선택과 Enter/Tab 적용을 모두 차단한다. 사용자가 명령을 직접 완성해 Send를 눌러도 모델에게 전송하지 않고 composer 내부에 오류를 표시한다.

### 10.3 의도적으로 유지한 예외

- Claude `/clear`는 이번 변경에서 그대로 유지했다. SDK context clear의 화면 transcript/경계 피드백 문제는 별도 과제다.
- Claude `/context`와 SDK가 실제 `system/init` inventory로 보고한 동적 command/skill/MCP prompt는 기존 native dispatch를 유지한다.
- Cursor는 이번 Claude Code/Codex 감사 범위 밖이다. 기존 local action인 `/compress`와 AgentParty로 연결된 action만 유지하고, 나머지 정적 fallback은 안전하게 비활성화했다.

### 10.4 검증

- palette model/DOM 회귀 검사: 지원 action 실행, 비활성 행·사유 표시, 직접 입력 우회 차단, Codex skill/plugin 비활성화를 확인한다.
- 실제 AgentParty 앱을 격리된 QA workspace로 실행해 `/model`, `/permissions`, `/status`, `/mcp` UI와 `/diff` 차단을 직접 조작했다.
- 실제 화면 PNG를 확인해 command palette의 disabled 상태와 modal의 패딩·간격·비율을 검토했다. 이 과정에서 상태 modal의 공용 2열 grid 상속과 footer 버튼 정렬 우선순위 결함을 발견해 수정했다.

## 11. 외부 기준 문서

- OpenAI, Codex developer commands: https://developers.openai.com/codex/cli/slash-commands
- Anthropic, Claude Code commands: https://code.claude.com/docs/en/commands
- Anthropic, Slash Commands in the Agent SDK: https://code.claude.com/docs/en/agent-sdk/slash-commands
