# Codex UX / 하네스 조사

이 폴더는 AgentParty가 **OpenAI Codex**를 하네스로 감쌀 때 이해하거나
재현해야 할 사용자 관점의 Codex 제품 동작과, 실제 통합에 필요한
`codex app-server` 프로토콜 표면을 정리한다.

이 조사의 목적은 단순 기능 목록이 아니다. 각 기능이 **무엇인지**, 사용자
화면에 **어떻게 보이는지**, 그것을 AgentParty 프론트/백엔드에서 **어떤 작업으로
반영해야 하는지**를 추가 질문 없이 판단할 수 있을 정도로 분해하는 것이다.
이 문서를 보고 다른 세션이 Codex 하네스를 붙이는 작업을 할 수 있어야 한다.

`docs/claude-code-ux-research/`가 Claude Code 하네스 조사이고, 이 폴더는
그와 짝을 이루는 Codex 조사다. Claude Code 문서의 깊이·구조를 의도적으로 맞췄다.

## 조사 범위 / 문서 목록

- `codex-cli.md`: Codex CLI(대화형 TUI)의 제품 형태, 세션 모델, composer,
  slash command, 승인/샌드박스 UX, 모델/effort, transcript 렌더링, 단축키,
  `codex exec` / `codex review` 비대화형 모드.
- `codex-ide-desktop.md`: Codex IDE 확장(VS Code/Cursor/JetBrains)과 Codex
  데스크톱 앱(`codex app`)의 GUI 표면. AgentParty가 GUI로 재현해야 하는
  Codex 동작에 가장 가깝다.
- `codex-cloud-github.md`: Codex Cloud(`chatgpt.com/codex`), GitHub 코드리뷰
  (`@codex`), 모바일/페어링, 로컬↔클라우드 핸드오프.
- `01-app-server-protocol.md`: **하네스 통합의 핵심.** `codex app-server`
  JSON-RPC 2.0 프로토콜 — client request / server notification / server
  request(승인) 메서드 전체 목록, 스레드/턴/아이템 lifecycle, 현재
  `src/core/codexAdapter.ts` 구현과의 대조.
- `02-approvals-sandbox-permissions.md`: 승인 정책 × 샌드박스 2축 모델,
  guardian(auto_review), Windows 샌드박스, AgentParty permission mode 매핑.
- `03-transcript-items-rendering.md`: `ThreadItem` 전체 taxonomy와 각 블록의
  렌더링 요구사항.
- `04-config-extensibility.md`: `config.toml`, `AGENTS.md`, MCP, 플러그인/
  마켓플레이스, 스킬, 훅, 서브에이전트(multi_agent), goals, memories,
  personality, browser/computer use, image gen, 인증, `codex doctor`.
- `05-agentparty-codex-harness-backlog.md`: 현재 AgentParty/`codexAdapter`와
  대조한 누락 기능, Claude Code↔Codex 개념 매핑표, API parity, P0~P2 backlog.
- `06-implementation-roadmap.md`: 사용자 관점 우선순위 로드맵(1군 필수 → 2군 편의
  → 3군 차별). "사용자가 무엇을 하려는데 어떻게 보이는가" 기준으로 정렬.
- `07-model-routing.md`: 모델·프로바이더 라우팅 — `model/list` 응답 스키마,
  `modelProvider/capabilities/read`, `model_providers` 스펙(wire_api=responses
  주의), thread/turn 단위 전환 규칙, ChatGPT/API 키 인증 제약, OpenRouter 확정값.
- `08-subagent-activity.md`: 서브에이전트 활동 정보 — Codex(collabAgentToolCall/
  subAgentActivity/thread-list) vs Claude Code(Agent tool_use + parent_tool_use_id
  + task_progress) 비교, "몇 개·무엇을 하는지" UI를 위한 공통 추상화·최소 작업.
  (두 하네스 공통 주제)

## 로컬 확인

- 설치된 로컬 CLI: `codex-cli 0.142.4` (`where codex` →
  `C:\Users\Dev\AppData\Roaming\npm\codex.cmd`).
- `codex --help` 및 모든 서브커맨드 help(`exec/review/login/mcp/plugin/
  resume/fork/cloud/sandbox/doctor/apply/mcp-server/app-server/features/
  remote-control/debug`)로 로컬 기능 표면을 확인했다.
- `codex features list`로 0.142.4의 feature flag 상태를 확인했다(stable:
  apps, browser_use, computer_use, image_generation, goals, personality,
  hooks, plugins, multi_agent, guardian_approval, fast_mode, in_app_browser,
  mentions_v2, auto_compaction, plugin_sharing, collaboration_modes 등).
- `codex app-server generate-json-schema --out <dir>`로 app-server 프로토콜의
  JSON Schema 전체를 추출해 메서드/알림/아이템 목록을 확정했다(재생성 방법은
  `01-app-server-protocol.md` 참조).
- 이미 존재하는 코드: `src/core/codexAdapter.ts`(app-server JSON-RPC 어댑터),
  `scripts/e2e-live-codex.mjs`(실 Codex 라이브 e2e), `~/.codex/config.toml`.

## 웹 조사(최신 검증일 2026-07-01)

학습지식이 아니라 웹으로 최신 검증했다. 주요 출처:

- Codex 개요/CLI: https://developers.openai.com/codex , /codex/cli ,
  /codex/cli/slash-commands , /codex/cli/reference , /codex/cli/features
- 승인/샌드박스: https://developers.openai.com/codex/agent-approvals-security ,
  /codex/concepts/sandboxing
- 비대화형: https://developers.openai.com/codex/noninteractive
- IDE: https://developers.openai.com/codex/ide , /codex/ide/features ,
  /codex/ide/settings , VS Code Marketplace(`openai.chatgpt`)
- 데스크톱 앱: https://developers.openai.com/codex/app , /codex/app/features ,
  /codex/app/review
- Cloud/환경/GitHub: https://developers.openai.com/codex/cloud ,
  /codex/cloud/environments , /codex/integrations/github ,
  /codex/use-cases/github-code-reviews
- 설정/확장: https://developers.openai.com/codex/config-reference ,
  /codex/config-advanced , /codex/mcp , /codex/plugins , /codex/hooks ,
  /codex/subagents
- 프로토콜/repo: https://github.com/openai/codex (`codex-rs/app-server`)
- changelog: https://developers.openai.com/codex/changelog

각 문서 하단에 문서별 출처를 다시 명시한다. 공식 문서가 정확한 화면 문구까지
명시하지 않는 항목(예: 승인 프롬프트 버튼 문구)은 커뮤니티/GitHub 출처임을
해당 위치에 표시했다.

## 한 줄 결론(AgentParty 관점)

Codex는 Claude Code와 개념이 상당 부분 대응되지만, **통합 방식이 다르다.**

- Claude Code 하네스는 CLI stream-json을 파싱하는 쪽에 가깝다.
- Codex 하네스는 `codex app-server`(장수명 stdio JSON-RPC 2.0 프로세스)에
  붙어 스레드/턴/아이템 이벤트를 구독하고 승인 요청에 응답하는 구조다. 이미
  `src/core/codexAdapter.ts`가 이 방식으로 초기 구현되어 있으며, 이 조사는
  그 어댑터를 "완전한 제품 parity"까지 끌어올리기 위한 요구사항서다.
</content>
</invoke>
