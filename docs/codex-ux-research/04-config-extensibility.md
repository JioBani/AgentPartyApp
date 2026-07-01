# Codex 설정 & 확장 시스템 (config · AGENTS.md · MCP · 플러그인 · 스킬 · 훅 · 서브에이전트 · goals · memories · personality · 능력 · 인증)

출처: https://developers.openai.com/codex/config-reference , /config-advanced ,
/mcp , /plugins , /hooks , /subagents ; 로컬 `codex features list`,
서브커맨드 help, `~/.codex/config.toml`. 검증일 2026-07-01.

GUI 래퍼의 역할: 파일 기반 설정(`~/.codex/config.toml`, `AGENTS.md`,
`hooks.json`, `auth.json`, agents/skills/plugins 디렉터리)을 1급 UI로 노출하고,
런타임 프로토콜 이벤트(툴 호출, 훅, 서브에이전트, goal 진행)를 라이브 상태로
반영. app-server가 대부분을 request로 노출하므로(`01` 문서) API parity 쉬움.

## 0. config 레이어

`$CODEX_HOME`(기본 `~/.codex`) 루트. 나중에 로드될수록 우선.

| 레이어 | 경로 | 비고 |
|---|---|---|
| 사용자 config | `~/.codex/config.toml` | 전역 기본 |
| 사용자 훅 | `~/.codex/hooks.json` | |
| 사용자 에이전트/스킬 | `~/.codex/agents/`, skills dirs | |
| 인증 | `~/.codex/auth.json` | |
| 프로파일 | `[profiles.<name>]` + `$CODEX_HOME/<name>.config.toml` | `-p`로 선택 |
| 프로젝트 config | `<repo>/.codex/config.toml` | **신뢰된 프로젝트만** |
| 프로젝트 훅 | `<repo>/.codex/hooks.json` | 신뢰 시만 |
| 프로젝트 에이전트 | `<repo>/.codex/agents/` | |
| 프로젝트 지침 | `<repo>/AGENTS.md`(+중첩) | 항상 읽음 |
| 플러그인 매니페스트 | 플러그인 dir | skills/hooks/mcp/apps |

**GUI 원칙**: 머신 로컬 provider/auth 키·알림 설정은 프로젝트/프로파일 레이어가
override 못 함 → "머신 전용" 설정과 "프로젝트 override 가능" 설정을 시각 구분.
프로토콜: `config/read`, `config/value/write`, `config/batchWrite`,
`configRequirements/read`, `permissionProfile/list`.

## 1. `config.toml` 주요 키

```toml
model = "gpt-5.5"
model_reasoning_effort = "medium"      # minimal|low|medium|high|xhigh
model_reasoning_summary = "auto"       # auto|concise|detailed|none ("show thinking")
approval_policy = "on-request"         # untrusted|on-request|never|{granular=...}
sandbox_mode = "workspace-write"       # read-only|workspace-write|danger-full-access
approvals_reviewer = "user"            # user|auto_review (guardian)
personality = "pragmatic"              # none|friendly|pragmatic
web_search = "cached"                  # disabled|cached|live
[history]
persistence = "save-all"               # save-all|none
[projects."/abs/repo"]
trust_level = "trusted"                # trusted|untrusted
[windows]
sandbox = "elevated"                   # unelevated|elevated
[features]
memories = false
goals = true
hooks = true
multi_agent = true
[profiles.ci]
sandbox_mode = "read-only"
model = "gpt-5.4"
```

- `model_reasoning_summary` → GUI "show thinking" verbosity.
- 승인×샌드박스 2축이 가장 중요(`02` 문서). GUI는 2축 picker + 평문 설명.
- `[projects."<path>"] trust_level` → per-workspace "신뢰" 토글(훅/프로젝트
  config 로드 게이트).
- 프로파일 = 명명된 프리셋(툴바 드롭다운), `-p ci`. 머신/auth 키는 override 불가.

현재 로컬 config.toml: `model="gpt-5.5"`, `personality="pragmatic"`,
`approvals_reviewer="user"`, `[windows] sandbox="elevated"`, 다수 프로젝트
`trust_level="trusted"`, 마켓플레이스 3개, 플러그인 5개.

## 2. AGENTS.md

- 프로젝트 지속 지침(Codex판 "house rules"). repo root + 중첩(하위트리 적용),
  개인 지침과 병합. `/init`로 scaffold 생성. 커밋 대상.
- GUI: "project instructions" 에디터(AGENTS.md 바인딩) + `/init` 액션 + 개인/
  프로젝트 지침 구분. `## Review guidelines` 섹션은 코드리뷰가 반영.

## 3. MCP 서버

```toml
[mcp_servers.context7]           # stdio
command = "npx"
args = ["-y", "@upstash/context7-mcp"]
env_vars = ["LOCAL_TOKEN"]
[mcp_servers.figma]              # streamable HTTP
url = "https://mcp.figma.com/mcp"
bearer_token_env_var = "FIGMA_OAUTH_TOKEN"
```
- 서버별: `enabled`, `startup_timeout_sec`, `tool_timeout_sec`,
  `enabled_tools`/`disabled_tools`, `default_tools_approval_mode`
  (auto|prompt|approve), OAuth 콜백 옵션, 헤더.
- CLI: `codex mcp add <name> -- <cmd...>` 또는 `--url`, `--env`,
  `--bearer-token-env-var`, `--oauth-client-id`; `codex mcp list|get|remove|
  login|logout`.
- 프로토콜: `mcpServerStatus/list`, `mcpServer/tool/call`,
  `mcpServer/resource/read`, `mcpServer/oauth/login`, `config/mcpServer/reload`;
  notification `mcpServer/startupStatus/updated`, `mcpServer/oauthLogin/completed`.
- **MCP apps**: 서비스 커넥터(Gmail/Slack/Drive/GitHub)로 Plugins/Apps UI에 노출.
- GUI: 서버 목록(running/failed) + enable 토글 + tool allow/deny + OAuth 버튼 +
  per-tool 승인모드. 툴 호출은 transcript에 `mcp:<server>` badge(`03`).

## 4. 플러그인 & 마켓플레이스

- **플러그인 = 번들**: skills + hooks + MCP servers + apps + prompts/config.
- CLI: `codex plugin add|list|remove`, `codex plugin marketplace add|list|
  upgrade|remove`. TUI `/plugins`(마켓 브라우저: 검색/설치/제거/토글).
- config: `[plugins."<name>@<marketplace>"] enabled = true/false`,
  per-plugin MCP override.
- **plugin_sharing**(stable): 워크스페이스 공유("Shared with you"/"Created by
  you"). 프로토콜 `plugin/share/list|save|checkout|delete|updateTargets`,
  `plugin/list|installed|install|uninstall|read`, `marketplace/*`.
- GUI: 플러그인 매니저(브라우즈/설치/제거/토글) + 컴포넌트 분해(어떤 skill/hook/
  MCP/app 추가하는지) + Shared/Created 구분 + 번들 훅도 훅 신뢰 심사 대상.

## 5. 스킬

- 재사용 지침 세트. 개인/repo/플러그인 출처. 호출: composer에서 `$` → `$skill-
  name`, enabled 스킬은 slash 목록에도. 프로토콜 `skills/list`,
  `skills/config/write`, `skills/extraRoots/set`, notification `skills/changed`.
- GUI: 스킬 카탈로그(출처별) + per-skill enable + `$` picker + 스레드별 활성 표시.

## 6. 훅

- 이벤트: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
  `PermissionRequest`, `SubagentStart/Stop`, `PreCompact/PostCompact`, `Stop`.
  런타임 `hook/started`, `hook/completed` notification.
- config: `~/.codex/hooks.json` / inline `[hooks]` / 프로젝트 `.codex/hooks.json`
  (신뢰 시만) / 플러그인 번들. 구조: event → matcher(regex) → handlers(command).
- I/O: stdin JSON(session_id, cwd, hook_event_name, model, turn_id,
  permission_mode). 종료코드 0=성공, 2=block(PreToolUse deny 등). output JSON
  `continue:false`, `stopReason`, `systemMessage`(UI 경고).
- **신뢰 모델**: 비-managed 명령 훅은 실행 전 **정확한 정의를 신뢰**해야(해시 기록,
  편집 시 재심사). `--dangerously-bypass-hook-trust`로 우회(위험). 프로토콜
  `hooks/list`, TUI `/hooks`.
- GUI: 훅 매니저(이벤트/matcher/command/출처) + 신뢰 심사 다이얼로그(정의+해시) +
  `hook/started→completed` 라이브 표시 + `systemMessage` 경고. 조용히 우회 금지.

## 7. multi_agent / collaboration (서브에이전트)

- **무엇**: Codex가 전문 서브에이전트를 병렬로 spawn(각자 모델/지침), 동시 작업 후
  결과 통합. 명시 요청 시만 spawn.
- 정의: `~/.codex/agents/`(개인) / `.codex/agents/`(프로젝트) TOML(`name`,
  `description`, `developer_instructions`). 캡: `[agents] max_threads=6`,
  `max_depth=1`, `job_max_runtime_seconds`. `[features] multi_agent=true`(기본).
- TUI `/agent`로 활성 스레드 전환/조종/중지/닫기.
- 프로토콜: item `collabAgentToolCall`(spawn/send/followup/interrupt, 복수
  `receiverThreadIds`/`agentsStates`), `subAgentActivity`(agentPath, kind).
- GUI: agent-roster 패널(서브에이전트=path 가진 스레드, 모델/상태) + 전환/조종/
  중지 + `subAgentActivity` 라이브 피드 + `agents/*.toml` 에디터.
- **주의(개념 충돌)**: Codex 서브에이전트(한 스레드 내부 worker)와 AgentParty
  party member(독립 세션)를 혼동 금지 — `05` 매핑표 참조.

## 8. goals

- **무엇**: 스레드 지속 목표(follow-up으로 계속 steer). 프로토콜
  `thread/goal/set|get|clear`, notification `thread/goal/updated|cleared`.
- UX: `/plan`으로 계획 → `/goal`로 목표 설정. 앱은 목표 진행을 composer **위에**
  표시(pause/resume/edit/clear 버튼). `[features] goals=true`.
- GUI: composer 위 "current goal" 배너 + pause/resume/edit/clear.

## 9. memories

- **무엇**: 과거 작업의 지속 context(선호/컨벤션/반복 패턴/함정). 기본 off
  (`[features] memories=false`), 켜면 `[memories] use_memories=true`로 새 세션에
  관련 메모리 주입. per-thread 토글. browser use도 이 설정 존중.
- 저장: `~/.codex/memories/`, `memories_1.sqlite`(로컬 확인).
- GUI: 메모리 매니저(보기/편집/삭제) + 전역 on/off + per-thread 토글. 조용히
  주입되므로 **무엇이 저장/주입되는지 가시화**(투명성 = no-silent 정책).

## 10. personality

- 옵션: `friendly`/`pragmatic`/`none`. `personality="..."` 또는 설정 selector,
  `[features] personality=true`(기본). 톤 변경. custom instructions는 개인
  `AGENTS.md`에 기록(프로젝트 지침과 병합).
- GUI: 3택 selector + custom instructions 텍스트영역(톤 전용 안내).

## 11. 에이전트 능력

- **browser_use**(stable): 번들 Browser 플러그인이 로컬 dev 서버/파일 프리뷰/공개
  페이지 구동. Codex Chrome 확장으로 로그인 브라우저 작업. 새 사이트 상호작용 전
  물음(allow/blocklist). Memories 설정 존중.
- **computer_use**(stable): Computer Use 플러그인 필요. macOS는 Screen Recording+
  Accessibility 권한, Windows는 활성 데스크톱. 네이티브 앱/시뮬레이터 테스트.
- **in_app_browser**(stable): 임베디드 브라우저로 dev 서버 프리뷰/코멘트(auth/
  쿠키/확장/기존 탭 없음).
- **image_generation**(stable): `$imagegen`/자연어, gpt-image-2, 사용량 3~5배.
- GUI: 능력 토글(플러그인/권한 게이트) + 권한 상태 패널 + allow/blocklist 에디터 +
  임베디드 프리뷰 pane(코멘트) + 인라인 이미지 출력.

## 12. 인증

- 방법: **ChatGPT 계정**(`codex login`, 브라우저 PKCE OAuth, 로컬 콜백 포트
  1455), **API 키**(`codex login --with-api-key`, stdin), **device code**(SSH/
  컨테이너/WSL2, `--device-auth`), `--with-access-token`.
- 상태: `codex login status`(자격증명 생성/삭제 없이 모드 표시). 스레드 내
  `/status`.
- 저장: `$CODEX_HOME/auth.json`(access/refresh 토큰, 세션 메타). 백엔드
  keyring/file/auto. ChatGPT 토큰 자동 갱신.
- **ChatGPT vs API 키 차이**: API 키는 Codex **Cloud 불가**, **Fast Mode 불가**,
  상위 티어 모델 차단. → GUI는 API 키 모드에서 이 제약을 **경고로 표시**(조용히
  기능 강등 금지). 프로토콜 `account/read|login/start|logout|usage/read|
  rateLimits/read`.

## 13. `codex doctor`

- 진단 리포트: 설치/config/auth/runtime/git/terminal/network/app-server/local
  state/thread inventory. `--summary`, `--json`, `--all`, `--no-color`, `--ascii`.
- GUI: "Diagnostics/Health" 화면(`codex doctor --json` 렌더). Windows 샌드박스/
  auth 실패는 ACL drift 복구 경로(`/codex-fix-sandbox`)와 연결.

## 크로스커팅 GUI 요구 요약

1. config 에디터(그룹: Model / Approvals+Sandbox / Personality / Projects·Trust
   / Windows / Profiles / Features / Web·History), 머신전용 vs override 가능 표시.
2. 프로파일 = 툴바 프리셋(`-p`).
3. 신뢰 인지: 프로젝트 신뢰 게이트, 훅 신뢰 심사(해시), 조용한 우회 금지.
4. 라이브 프로토콜 반영: 툴 호출, `hook/*`, `subAgentActivity`, `goal` 진행.
5. 매니저: MCP / Plugins·Apps(Shared/Created) / Skills / Subagents(agents/) /
   Hooks / Memories / Auth.
6. 능력 토글 + 권한 상태(browser/computer/in-app/image).
7. Diagnostics(`codex doctor --json`).
8. no silent fallback — 모든 능력 제약(API 키 제한, 샌드박스 거부, 비활성 기능)을
   가시 경고로.

## 출처 (검증 2026-07-01)

- https://developers.openai.com/codex/config-reference , /config-advanced ,
  /config-basic , /config-sample , /mcp , /plugins , /plugins/build , /hooks ,
  /subagents , /agent-approvals-security , /concepts/sandboxing , /cli/reference ,
  /changelog , /llms-full.txt
- https://github.com/openai/codex (PR #27007 subAgentActivity; issue #9062)
- (2차) codex.danielvaughan.com(auth/플러그인/훅), blakecrosley.com/guides/codex,
  toolsbase.dev/en/reference/codex-commands — 정확한 flag는 빌드별
  `--help`/`codex features list`로 재확인.
</content>
