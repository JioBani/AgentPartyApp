# Codex IDE 확장 & 데스크톱 앱 UX 조사

이 문서는 Codex의 **GUI 표면**(IDE 확장, 데스크톱 앱)을 다룬다. AgentParty가
GUI로 재현해야 하는 Codex 동작에 가장 가깝다. SDK/프로토콜 내부는 `01` 문서.

웹 검증일: 2026-07-01. 출처는 문서 하단.

---

# Part A. Codex IDE 확장 (VS Code / Cursor / Windsurf / JetBrains)

## 제품 형태

VS Code Marketplace의 `openai.chatgpt`("Codex – OpenAI's coding agent", 무료,
설치 ~1100만+). 같은 패키지가 Cursor·Windsurf 등 VS Code 계열에 동작. JetBrains
(IntelliJ/PyCharm/WebStorm/Rider), Xcode는 별도 통합.

**본질: IDE 확장은 CLI/데스크톱 앱과 동일한 에이전트 코어(`codex app-server`)의
프론트엔드다.** 확장은 `codex` app-server 프로세스를 띄워 구동하며,
`chatgpt.cliExecutable`로 경로 override(개발용). config(`~/.codex/config.toml`),
MCP 서버, 프로젝트 `AGENTS.md`, 세션(`~/.codex/sessions/`)이 CLI와 **공유**된다.
→ CLI에서 시작한 세션을 IDE에서 resume 가능(반대도).

## 설치 & 로그인 & 배치

- 로그인: **ChatGPT 계정**(Plus/Pro/Business/Edu/Enterprise, 크레딧 포함, 권장)
  또는 **API 키**. JetBrains는 **JetBrains AI** 구독도 인증원으로 허용.
- 배치: VS Code에서 **기본 우측 사이드바**의 전용 Codex 패널(아이콘). 좌측
  액티비티 바로 드래그 가능. `chatgpt.openOnStartup`로 시작 시 포커스.

## 에이전트 패널 UX

세로 채팅 뷰: 위 transcript, 아래 composer. **composer 바로 아래 컨트롤 스트립.**

- **작업 시작**: 자연어 지시 입력 후 전송. 열린 파일 + 현재 선택이 자동 context
  라 짧게 써도 됨. Agent 모드에서 메시지 전송 = 작업 시작(별도 의식 없음).
- **모델 선택기**: composer 아래. 기본은 현행 GPT-5-Codex급, 다른 모델 선택 가능.
- **reasoning effort**: `low`/`medium`/`high`. 문서 가이드 "medium에서 시작,
  깊이가 필요할 때만 high".
- **승인 모드 선택기**(composer 아래 3택):
  - **Chat** — 읽기전용 논의, 자동 편집/명령 없음.
  - **Agent**(기본) — 워킹디렉터리 내 읽기/편집/명령 자동, 밖/네트워크는 승인.
  - **Agent (Full Access)** — 파일시스템/네트워크 무제한, 승인 없음. "Exercise
    caution" 경고 표시.
- **context 첨부**: `@filename` mention, 열린 파일/선택 자동 포함, 이미지는
  **composer에 드래그드롭**(VS Code는 Shift 누른 채). `$imagegen`로 이미지 생성
  (gpt-image-2, 사용량 3~5배). 로컬 작업은 웹검색 기본 on(캐시).

## Codex가 작업을 보여주는 방식(IDE transcript)

실행 중 **item** 시퀀스로 스트리밍:
- 스트리밍 reasoning/status 텍스트.
- 멀티스텝 plan/to-do 진행.
- **명령 실행 item** — 터미널 통합으로 명령 실행+출력을 워킹디렉터리에서.
  `web_search` item도 인라인.
- **파일변경/diff item** — 핵심 리뷰 표면(아래).

### Diff / 파일변경 리뷰(핵심)

- 변경은 **에디터 네이티브 비교 뷰**(VS Code diff viewer)로 인라인 렌더.
- 가장 완전한 형태(클라우드 결과 + `/review`)에서는:
  - 파일명 클릭 → 에디터에서 열기.
  - 파일 배경 클릭 → diff 접기/펼치기.
  - 라인에서 Cmd+click → 에디터 해당 라인으로 점프.
  - **diff/파일/hunk 단위 stage 또는 revert**(커밋 전 액션 버튼).
- **주의(알려진 갭)**: 로컬 Agent 모드 편집은 문서상 "적용 전 diff 프리뷰"지만,
  2026 커뮤니티 다수 보고는 CLI의 red/green diff보다 로컬 per-hunk accept/reject
  루프가 약하다고 지적. **AgentParty가 재현할 때는 per-file/per-hunk
  Accept/Reject + Apply-to-worktree를 1급 요구사항으로 잡아야 한다.**

## IDE 내 승인 프롬프트

Agent 모드에서 자동 허용 범위를 벗어나면 transcript 인라인(또는 모달) 프롬프트:
워크스페이스 밖 편집, 네트워크, 상승/신뢰불가 명령, 파괴적 MCP/툴 호출. **무엇을**
하려는지(명령/타겟) + approve/reject. Full Access에서는 무프롬프트. config 매핑:
`on-request`(사용자에게 물음) / `auto_review`(자동 리뷰어) / `never`.

> 정확한 버튼 문구는 공식 문서 미명시(CLI의 approve/reject-per-change를 미러).
> 승인창이 안 닫히는 버그 보고(openai/codex#11482)가 있어, dismiss/advance
> 상태머신을 견고하게 만들 것.

## 로컬 ↔ 클라우드 위임(IDE에서 가장 정제된 흐름)

- **"Run in the cloud"** 컨트롤로 현재 작업을 클라우드 환경에 위임.
- 시작점 선택: **`main`에서**(새 아이디어) 또는 **로컬 변경에서**(진행 중 작업 계속).
- IDE 안에서 진행 모니터링(transcript 갱신).
- 완료 시 클라우드 diff 프리뷰, follow-up(로컬↔클라우드 context 보존), **diff
  로컬 적용**. 클라우드 작업을 로컬에서 열기도 가능.
- 워크플로: 작은 편집은 로컬 인터랙티브, 긴 작업은 클라우드 오프로드 후 diff pull.

## context 인지 / 리뷰 / 세션

- 워크스페이스 스코프. 프로젝트 `AGENTS.md`를 CLI와 **동일하게** 반영.
- `@file` mention + 열린 파일/선택 암묵 context.
- **CodeLens**: `chatgpt.commentCodeLensEnabled`면 TODO 주석 위에 "Complete with
  Codex" 액션이 gutter에 나타남 → 에디터에서 바로 위임.
- **`/review`**(composer) 또는 Command Palette "Codex: Review Code" → 리뷰 pane에
  인라인 코멘트. GitHub 변형(`@codex review`)은 P0/P1만 강조.
- 멀티 스레드: `Cmd/Ctrl+N`으로 새 스레드. `~/.codex/sessions/`에 영속,
  **surface 간 resume 가능**(CLI↔IDE↔데스크톱↔클라우드).

## VS Code vs Cursor vs JetBrains

- **VS Code/Cursor/Windsurf**: 동일 확장, 동일 우측 사이드바 패널·전체 기능.
  Cursor 전용 UI 분기는 문서화 없음(같은 확장).
- **JetBrains**: 별도 통합 — 독립 Codex 사이드바 대신 **기존 JetBrains AI 채팅
  인터페이스에 Codex를 임베드**. JetBrains AI 구독을 인증원으로 추가.
- **Windows**: 네이티브 샌드박스 또는 **WSL2**(`chatgpt.runCodexInWindows
  SubsystemForLinux`).
- **Xcode**: 별도/서드파티 통합으로 언급.

### 확장 전용 VS Code 설정
`chat.fontSize`, `chat.editor.fontSize`, `chatgpt.cliExecutable`,
`chatgpt.commentCodeLensEnabled`, `chatgpt.localeOverride`,
`chatgpt.openOnStartup`, `chatgpt.runCodexInWindowsSubsystemForLinux`.
모델/승인/샌드박스는 설정이 아니라 `~/.codex/config.toml`에서.

---

# Part B. Codex 데스크톱 앱 (`codex app`)

## 제품 형태

"Codex 스레드를 병렬로 작업하는 집중형 데스크톱 경험 — worktree 지원,
automations, Git 기능 내장." OpenAI는 "agentic coding의 command center"로 포지셔닝.

- 배포: **설치 프로그램**(macOS Apple Silicon/Intel, Windows + MS Store). CLI에
  `codex app` 경로가 있지만 주 배포는 인스톤러. `codex app` 서브커맨드는 앱을
  실행하거나, 없으면 설치 프로그램을 연다.
- 로그인: ChatGPT 계정 또는 API 키(API 키는 일부 기능 제한). Plus/Pro/Business/
  Edu/Enterprise 필요.
- 본질: 데스크톱 앱도 **`codex app-server`의 GUI 클라이언트**. app-server가 턴을
  구동하고 `threadId`/`turnId` 스코프로 승인 요청을 emit, 앱은 활성 턴 인라인에
  승인을 표시.

## UI 레이아웃 (AgentParty Workbench와 직접 대응)

- **프로젝트 사이드바** — 코드베이스별 프로젝트 추가, 전환, 스레드 pin/archive.
- **활성 스레드 영역** — 대화/composer.
- **Review(diff) pane** — 로컬/worktree git diff. **Codex가 처리할 인라인 코멘트
  추가**, **청크/파일 단위 stage 또는 revert**, 앱에서 직접 **commit/push/PR 생성**
  (로컬·worktree 작업).
- **통합 터미널** — 우상단 터미널 아이콘 또는 `Cmd+J`.
- **Artifacts 패널** — plan, sources, task summary; PDF/스프레드시트/문서/프레젠
  테이션 프리뷰.

## 스레드 실행 모드(composer에서 선택) — AgentParty 하네스에 중요

- **Local** — 현재 프로젝트 디렉터리에서 직접 작업.
- **Worktree** — git worktree로 변경 격리(병렬 변경 무충돌).
- **Cloud** — 원격 실행(§Cloud와 동일한 클라우드 작업).

> 이 3택은 Claude Code Agent view의 worktree isolation 개념과 대응. AgentParty
> member 생성 wizard의 "Isolation: shared workspace | worktree" 축과 그대로 매핑.

## 추가 기능

- 병렬 스레드 side-by-side.
- **Automations** — 독립 스케줄 작업 + "thread automations"(대화 context 보존
  반복 점검).
- **in-app 브라우저** — dev 서버 프리뷰/코멘트(auth/쿠키/확장/기존 탭 없음).
- **computer use** — macOS 데스크톱 앱을 보고 클릭/입력(권한 필요).
- **음성 받아쓰기** — `Ctrl+M` 홀드.
- **pop-out 창** — "stay on top" 옵션.

---

# AgentParty 시사점 (IDE/데스크톱 종합)

데스크톱 앱은 AgentParty가 지향하는 multi-panel Workbench와 개념이 거의 1:1이다.
Claude Desktop Code 탭 조사(`docs/claude-code-ux-research/04-*`)의 pane 목록과
합치면 Codex도 동일하게 요구:

- **pane 타입**: Member Chat(스레드), Diff(review pane — 인라인 코멘트 + stage/
  revert + commit/push/PR), Terminal(통합 터미널), Preview(in-app 브라우저),
  Tasks(automations + 서브에이전트), Artifacts(plan/sources/문서 프리뷰).
- **실행 모드 축**: Local / Worktree / Cloud를 member/session 생성 시 선택.
- **모델/effort/승인모드**를 composer 아래 지속 컨트롤로(모달만이 아니라).
- **diff 리뷰가 1급**: per-file/per-hunk accept/reject, apply-to-worktree,
  인라인 코멘트→Codex 반영, commit/push/PR. (현재 AgentParty에 diff pane 없음.)
- **로컬↔클라우드 위임**을 member 액션으로(“Run in cloud”, 결과 diff pull).
- CLI·IDE·데스크톱·클라우드가 세션을 공유하므로, AgentParty도 `~/.codex/sessions`
  기반 resume을 member lifecycle에 노출하면 다른 Codex surface와 상호운용된다.

## 출처 (검증 2026-07-01)

- https://developers.openai.com/codex/ide , /codex/ide/features , /codex/ide/settings
- https://developers.openai.com/codex/app , /codex/app/features , /codex/app/review
- https://developers.openai.com/codex/agent-approvals-security
- https://developers.openai.com/codex/integrations/github
- https://marketplace.visualstudio.com/items?itemName=openai.chatgpt
- https://github.com/openai/codex (`codex-rs/app-server`)
- (2차/갭 보고) community.openai.com/t/1375304, /1373366, /1355908;
  github.com/openai/codex issues #2998, #11482
</content>
