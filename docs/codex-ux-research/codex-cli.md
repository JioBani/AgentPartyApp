# Codex CLI (대화형 TUI) 기능 및 UX 조사

이 문서는 사용자에게 보이는 Codex CLI 제품을 다룬다. 터미널 상호작용, 명령
표면, 승인/샌드박스 표시, 모델, transcript 렌더링을 중심으로 정리한다.
프로토콜 내부는 `01-app-server-protocol.md`, 설정은 `04-config-extensibility.md`.

로컬 확인 버전: `codex-cli 0.142.4`. 웹 검증일: 2026-07-01.

## 제품 형태

`codex`(서브커맨드 없이)는 현재 디렉터리에서 **대화형 터미널 코딩 세션**(TUI)을
연다. 서브커맨드를 주면 각각 다른 동작(exec/review/resume/cloud/mcp/plugin/…).

사용자 관점 핵심 모델:

- 터미널은 채팅 입력창이면서 실시간 실행 콘솔이다(Claude Code와 유사).
- Codex는 현재 저장소, 추가 허용 디렉터리(`--add-dir`), MCP 서버, 플러그인,
  스킬, `AGENTS.md`에 접근한다.
- 도구 사용(셸/파일편집)은 **샌드박스**로 격리되고, 정책상 필요한 경우 **승인**을
  거친다. 승인/샌드박스는 서로 다른 두 축이다(`02` 문서).
- 세션은 디렉터리/세션ID로 재개(`resume`)하거나 분기(`fork`)할 수 있고 이름을
  붙일 수 있다.
- 커스텀 동작은 `~/.codex/config.toml`, `AGENTS.md`, slash command, 스킬,
  플러그인, 훅, MCP, 서브에이전트에서 온다.

## 실행 및 세션 모드

대화형:

- `codex` — 대화형 세션 시작. `[PROMPT]` 인자로 첫 메시지 지정 가능.
- `-C, --cd <DIR>` — 작업 루트 지정.
- `-m, --model <MODEL>` — 모델 지정(예: `gpt-5.5`, `gpt-5.4-mini`).
- `-i, --image <FILE>...` — 초기 프롬프트에 이미지 첨부.
- `-s, --sandbox read-only|workspace-write|danger-full-access` — 샌드박스 정책.
- `-a, --ask-for-approval <policy>` — 승인 정책(문서 기준. help에는 `-s` 노출).
- `-p, --profile <NAME>` — config 프로파일 오버레이(`$CODEX_HOME/<name>.config.toml`).
- `-c key=value` — config 값 오버라이드(TOML 파싱). 예: `-c model="o3"`.
- `--enable <FEATURE>` / `--disable <FEATURE>` — feature flag 토글.
- `--oss` + `--local-provider lmstudio|ollama` — 로컬 오픈소스 모델.
- `--add-dir <DIR>` — 워크스페이스 외 쓰기 허용 디렉터리 추가.
- `--skip-git-repo-check` — git repo 밖에서도 실행.
- `--dangerously-bypass-approvals-and-sandbox` — 승인·샌드박스 전부 우회(위험).
- `--remote <ADDR>` — TUI를 원격 app-server에 연결(`ws://`, `unix://`).

재개/분기(별도 서브커맨드):

- `codex resume [SESSION_ID] [PROMPT]` — 재개. 인자 없으면 picker.
  `--last`(최근 세션 바로), `--all`(다른 cwd 세션까지), `--include-non-interactive`.
- `codex fork [SESSION_ID] [PROMPT]` — transcript 보존하며 독립 스레드로 분기.
- `codex archive|unarchive|delete <id|name>` — 보관/복원/영구삭제.

첫 실행:

- 자격증명이 없으면 전체 화면 **로그인 게이트**: ChatGPT 계정(OAuth 브라우저
  핸드오프) 또는 API 키. `codex login` / `codex logout` / `codex login status`.
- 처음 보는 디렉터리에서는 **프로젝트 신뢰(trust) 프롬프트**가 뜬다. 신뢰한
  폴더는 `workspace-write` 샌드박스가 자동 적용되고 프로젝트 스코프 config/훅이
  로드된다. 신뢰는 `config.toml`의 `[projects."<path>"] trust_level` 로 영속.

## 화면 구조

위→아래:

- **헤더/배너(상단)**: 제품/버전, 활성 모델, 작업 디렉터리, 현재 승인/샌드박스
  모드. 첫 프롬프트 전에 "지금 어떤 상태인지" 요약.
- **transcript 영역(본문, 스크롤)**: 사용자 메시지, reasoning 요약, plan/TODO,
  셸 실행+live output, 파일 diff, 도구 호출, 웹검색, 이미지가 시간순으로 쌓인다.
  markdown + 컬러 diff 렌더.
- **composer(하단 입력)**: 멀티라인 입력. `@`로 mention 메뉴, `/`로 slash 메뉴.
- **status line/footer(맨 아래 1줄)**: 설정 가능한 지속 푸터. 기본 항목 model,
  approval, context_usage. 추가로 sandbox, cwd, session_id, spinner. `/statusline`
  또는 `tui.status_line`로 재정렬. `null`로 끄면 한 줄 회수.

## Composer 입력 UX

- **Enter로 전송.** 단, **턴 실행 중 Enter는 진행 중인 턴에 지시를 주입(steer)**
  한다(중단이 아니라 방향 수정). **Tab은 다음 턴 follow-up으로 큐잉**(비중단).
  → 프로토콜상 `turn/steer`(Enter) vs 큐(Tab). AgentParty도 이 구분 재현 권장.
- **멀티라인**: `Ctrl+J`(가장 호환성 높은 개행 키; 일부 터미널은 Shift+Enter).
  `Ctrl+G`로 `$EDITOR`에서 초안 편집 후 복귀.
- **이미지 첨부**: `-i` 플래그(콤마/반복). transcript/composer에 placeholder로
  표시. 입력용(스크린샷/목업)이자, 세션 내 이미지 생성/편집도 지원.
- **파일 `@mention`(mentions_v2)**: `@` 입력 시 **파일·플러그인·스킬을 아우르는
  통합 fuzzy 메뉴**(0.142에서 통합). 선택하면 후속 턴이 그 파일을 구체적으로
  타겟. `/mention` slash로 파일/폴더 고정도 가능.
- **history/draft**: Up/Down으로 초안 히스토리(텍스트+이미지 placeholder 복원).
  `Ctrl+R`/`Ctrl+S` 역방향 검색. 빈 composer에서 `Esc,Esc`로 이전 전송 메시지
  수정(연타 시 더 뒤로).

## Slash Command (TUI 내부 `/` 메뉴)

`/` 입력 → fuzzy 필터 팝업 → 선택 실행. 0.142 기준 주요 명령(그룹별):

모델/동작:
- `/model` — 모델 + reasoning effort(low/medium/high) 선택 팝업.
- `/fast` — Fast 서비스 티어 토글/확인(카탈로그 지원 시).
- `/permissions` — 승인/샌드박스 프리셋 전환(Read Only / Auto / Full Access).
  `/approvals`는 alias(팝업 목록에서는 빠짐).
- `/approve` — auto-review가 거부한 직전 액션 1회 재시도.
- `/plan` — plan 모드(구현 전 전략 제시).
- `/goal` — 지속 목표 set/pause/resume/view/clear(`thread/goal/*`).
- `/personality` — 커뮤니케이션 스타일(friendly/pragmatic/none).

세션 관리:
- `/new` — 같은 프로세스에서 새 대화.
- `/resume` — 저장된 세션 picker로 복원.
- `/fork` — 현재 대화를 독립 스레드로 복제.
- `/side`(alias `/btw`) — 일시적 side 대화.
- `/clear` — 화면 리셋(같은 세션 새 채팅).
- `/archive` / `/delete` — 현재 세션 보관 / 영구 삭제.
- `/quit`(alias `/exit`) — 종료.

코드/프로젝트:
- `/diff` — untracked 포함 git 변경 표시(커밋 전 리뷰).
- `/review` — 워킹트리 동작변경/테스트공백 분석(코드리뷰).
- `/compact` — 이전 턴 요약으로 context 회수.
- `/copy` — 최근 완료 출력 클립보드 복사.
- `/mention` — 파일/폴더 고정.
- `/init` — 현재 디렉터리에 `AGENTS.md` scaffold 생성.

설정/도구:
- `/ide` — 열린 파일/선택/IDE context를 다음 프롬프트에 포함.
- `/vim`, `/keymap`, `/theme`, `/statusline`, `/title` — 편집/외양 커스텀.
- `/mcp` — 이번 세션에서 쓸 MCP 서버/도구 목록.
- `/apps` — 커넥터 브라우즈, `$app-slug`로 삽입.
- `/plugins` — 설치/발견 가능 플러그인 브라우저(OpenAI Curated / Workspace /
  Shared with me 섹션).
- `/skills` — 로컬 스킬 선택.
- `/memories` — 메모리 주입/생성 토글.
- `/hooks` — 훅 lifecycle 보기/신뢰/비활성.
- `/agent` — 활성 서브에이전트 스레드 전환/조종.
- `/sandbox-add-read-dir` — (Windows) 샌드박스 읽기 디렉터리 추가.

진단/인터페이스:
- `/status` — 세션 설정(모델, 승인정책, writable roots, 토큰 사용량).
- `/usage` — 계정 토큰 활동(일/주/누적) + rate-limit reset redemption.
- `/debug-config` — config 레이어/정책 소스 진단.
- `/ps` / `/stop` — 실험적 백그라운드 터미널 보기 / 취소.
- `/experimental` — 실험 기능 토글(재시작 유발 가능).
- `/feedback` — 로그/진단 제출.
- `/logout` — 자격증명 삭제.

> AgentParty 시사점: Claude Code 조사와 동일하게, `/`는 command palette로
> 재현하되 Codex 명령 taxonomy(모델/세션/코드/설정/진단)를 반영해야 한다.
> 어댑터의 `CODEX_COMMANDS`는 현재 9개(model/approvals/new/init/compact/diff/
> mention/status/mcp)뿐 — 위 목록으로 확장 필요(P1).

## 승인 & 샌드박스 UX

`02-approvals-sandbox-permissions.md`에서 상세. 화면 요약:

- 2축: **샌드박스 모드**(무엇을 할 수 있나: read-only / workspace-write /
  danger-full-access) × **승인 정책**(언제 멈춰 물어보나: untrusted / on-request
  / never). 사용자에게는 **Read Only / Auto / Full Access** 3프리셋으로 노출.
- **명령 승인 프롬프트**: 실행할 명령(+ 이유/cwd)과 선택지 표시. 확인된 문구(
  커뮤니티/GitHub 출처): `Yes`(1회) / `Yes, and don't ask again this session` /
  `No`. Smart Approvals(v0.120+)는 프리픽스 규칙(`prefix_rule()` → `default.rules`)
  으로 영구 자동승인하는 3번째 "yes"를 제공.
- **파일변경/패치 승인**: 적용 전 컬러 diff를 보여주고 accept/decline.
  workspace-write 기본에서는 프로젝트 내 편집은 자동 적용(사후 `/diff` 리뷰).
- **Guardian / auto-review**: `approvals_reviewer="auto_review"`면 승인 요청을
  reviewer 서브에이전트에 라우팅(데이터 유출/자격증명 탐침/파괴적 행위 심사).
  거부 시 `/approve`로 1회 override. 프로토콜: `item/autoApprovalReview/*`,
  `thread/approveGuardianDeniedAction`.
- **request-user-input**(0.141+): 자동 해소 카운트다운. 사용자가 상호작용하면
  카운트다운 정지 → 무인 실행은 안 멈추고, 지켜보는 사용자는 안 쫓김.

## 모델 / Effort / Fast / Reroute

- `/model`: 모델 목록 + reasoning effort(low/medium/high). 런치 `-m`.
  effort 매핑: 어댑터는 `xhigh/max → high`, 그 외 그대로 전달.
- `/fast`: Fast 서비스 티어(저지연). ChatGPT 인증에서만.
- rate limit / reroute: footer status + `/status` + `/usage`. limit 도달 시
  `/usage`에서 reset 크레딧 사용, `gpt-5.4-mini`로 전환 안내. 모델 리라우트는
  숨기지 않고 표시(프로토콜 `model/rerouted`).

## Transcript 렌더링(TUI가 그리는 것)

시간순 인라인:
- **reasoning 요약** — 원문 CoT가 아니라 "무엇을 하려는지" 요약 블록.
- **plan / TODO** — plan 모드/`goal`. 단계 인라인 승인/거부.
- **셸 실행 + live output** — 명령 표시 후 stdout/stderr 실시간 스트림.
- **파일 diff/patch** — 파일별 컬러 unified diff. 종합은 `/diff`.
- **MCP 도구 호출** — 인라인(도구명+인자/결과). `/mcp`로 목록.
- **웹검색** — 결과 인라인(기본 캐시, `--search`로 라이브).
- **이미지 생성/뷰** — 생성/편집 이미지 직접 표시, 입력 이미지는 placeholder.

전체 item 타입과 렌더링 요구는 `03-transcript-items-rendering.md`.

## 단축키

| 키 | 동작 |
|---|---|
| Enter | 전송. 턴 실행 중: 현재 턴에 지시 주입(steer) |
| Tab | 턴 실행 중: 다음 턴 follow-up 큐잉(비중단) |
| Ctrl+J | 개행(호환성 최상; 일부는 Shift+Enter) |
| Esc | 활성 작업 중단 |
| Esc, Esc | 빈 composer에서 이전 메시지 수정(연타로 더 뒤로) |
| Up/Down | composer 초안 히스토리 |
| Ctrl+R / Ctrl+S | 히스토리 역검색 / 다음 |
| Ctrl+G | `$EDITOR`에서 초안 편집 |
| Ctrl+L | 터미널 UI clear(context 유지) |
| Ctrl+T | transcript overlay |
| Ctrl+C | 취소; 2회 종료 |
| Ctrl+D | 종료; 2회 강제 종료 |
| y / n | 승인 프롬프트 approve/reject(remappable) |

(승인 y/n 및 Ctrl+T/Alt+R은 커뮤니티/GitHub 출처 — 의도된 시맨틱으로 취급.)

## 상태 / 진단

- footer: model, approval, context_usage(설정 가능).
- 토큰: footer + `/status` + `/usage`.
- context/compaction: `/compact` 수동, **auto_compaction**(stable, 기본 on)이
  한도 근접 시 자동 요약. 0.142는 스레드 간 rollout 토큰 예산 추적 추가.
- 오류: transcript에 가시 표시(no silent fallback). `--json`에 `error` 이벤트.

## 비대화형 모드

- `codex exec "<prompt>"`(alias `codex e`) — TUI 없이 스크립트 실행. 진행 로그는
  **stderr**, 최종 메시지는 **stdout**. 주요 옵션: `--ephemeral`(세션 미저장),
  `-s`/`-a`, `-o/--output-last-message <file>`, `--output-schema <schema.json>`
  (최종 응답을 JSON Schema로 강제 — 구조화 출력), `--json`(JSONL 이벤트 스트림),
  `--add-dir`, `--skip-git-repo-check`, `--ignore-rules`, `--ignore-user-config`,
  `--color`. `codex exec resume`/`codex exec review` 하위 명령도 있음.
- `codex review [PROMPT]` — 비대화형 코드리뷰. `--uncommitted`(staged/unstaged/
  untracked), `--base <branch>`, `--commit <sha>`, `--title <title>`.
- `--json` 이벤트: `thread.started`, `turn.started`/`turn.completed`,
  `item.started`/`item.completed`(+ agentMessage/reasoning/mcp/webSearch 세분),
  `error`. TUI가 시각화하는 것의 기계판독 미러 → GUI 구독 표면.

> AgentParty는 라이브 member는 **app-server**(01 문서)로 붙는 게 정석이지만,
> "1회성 배치 작업(dispatch/QA)"에는 `codex exec --json`이 더 단순할 수 있다.
> 하네스는 app-server 기반으로 통일하되, exec는 job-row/배치 옵션으로 검토.

## 로컬 CLI 서브커맨드 요약 (`codex --help` 0.142.4)

`exec`(비대화 실행), `review`(비대화 리뷰), `login`/`logout`(인증),
`mcp`(외부 MCP 관리), `plugin`(플러그인), `mcp-server`(Codex를 MCP 서버로),
`app-server`(app server + generate-ts/json-schema), `remote-control`(daemon),
`app`(데스크톱 앱 실행/설치), `completion`, `update`, `doctor`(진단),
`sandbox`(샌드박스 내 명령 실행), `debug`(models/app-server/prompt-input),
`apply`(agent diff를 `git apply`), `resume`/`fork`/`archive`/`delete`/`unarchive`
(세션), `cloud`(Codex Cloud), `exec-server`, `features`(flag 조회/토글).

## AgentParty 체크리스트(CLI 관점)

- searchable command palette(Codex 명령 taxonomy + AgentParty 명령).
- composer: `@`-mention, 이미지 첨부, 초안 history, steer(Enter)/queue(Tab) 구분.
- 승인 카드: 명령/diff 정확 표시 + once/for-session/rule/decline + guardian 표시.
- session header: model, effort, 승인/샌드박스 프리셋, cwd, auth, MCP,
  context/토큰, reroute/rate-limit, safe/debug.
- 세션 lifecycle: resume/fork/archive/delete/naming을 일급 UI로.
- transcript: 03 문서의 전체 item 타입 매핑.
</content>
