# Codex 하네스 로드맵 (사용자 관점 우선순위)

이 문서는 조사한 Codex 기능을 **사용자가 겪는 불편이 큰 순서**로 나열한다.
각 항목은 "구현을 어떻게 하나"가 아니라 **사용자가 무엇을 하려는데 지금은 어떻게
보이고, 되면 어떻게 보이는가**를 기준으로 쓴다. 단, Codex 도메인 용어(sandbox
mode / approval policy / guardian / steer / thread / worktree / plan / goal /
memories / personality / MCP 등)는 풀어쓰지 않고 그대로 쓴다 — 작업자가 Codex
제품과 바로 매핑할 수 있어야 하기 때문. 구현 지점·프로토콜·API는 `01`~`05`에
있으니 여기서 반복하지 않는다.

각 항목:
- **사용자가 하려는 것** — 사용자의 목표.
- **지금** — 현재 화면에서 겪는 불편.
- **되면(화면)** — 완료 후 사용자가 보게 될 모습.
- **우선순위 이유** — 왜 이 위치인가(사용자 가치 기준).

우선순위 대원칙: **지금 없으면 Codex member를 제대로 못 쓰는 것 → 있으면 훨씬
편한 것 → Codex라서 특별한 것** 순. 엔지니어링 난이도가 아니라 사용자가 막히는
정도로 정렬했다.

---

## 1군 — 지금 없으면 Codex member를 "제대로 못 쓰는" 것

### 1. sandbox mode × approval policy를 프리셋으로 고르기
- **사용자가 하려는 것**: member를 켜기 전에 "이 member가 어디까지 손댈 수 있고
  (sandbox), 언제 멈춰 물어볼지(approval)"를 정하고 싶다.
- **지금**: Claude Code용 단일 permission mode를 그대로 눌러담아, Codex의 실제
  2축(**sandbox mode** `read-only`/`workspace-write`/`danger-full-access` ×
  **approval policy** `untrusted`/`on-request`/`never`)과 어긋난다. 고른 것과
  실제 behavior가 달라 보이고, **guardian(`auto_review`)** 은 화면에 아예 없다.
- **되면(화면)**: member Runtime에 **Read Only / Auto / Full Access** 프리셋을
  기본으로 보여주고, 필요하면 sandbox mode와 approval policy를 따로 조절.
  **guardian(auto_review) 토글**(위험 행동을 reviewer가 먼저 심사). member
  header에 현재 프리셋/2축 상태가 항상 보인다.
- **우선순위 이유**: 승인·샌드박스는 사용자가 member를 신뢰하고 풀어주는 문제라
  가장 먼저 정확해야 한다. 여기가 어긋나면 일을 못 맡긴다.

### 2. 승인 프롬프트를 정확히 보고 고르기 (once / session / prefix rule / decline)
- **사용자가 하려는 것**: member가 approval로 멈추면 정확히 어떤 command / 어떤
  file change(diff)인지 보고, 매번 같은 걸 또 묻지 않게 하고 싶다.
- **지금**: allow/deny 두 버튼뿐. Codex의 **"Yes / Yes, and don't ask again this
  session / No"** 와 Smart Approvals의 **prefix rule**(같은 명령 패턴 영구
  자동승인) 선택지가 없다. `item/tool/requestUserInput`(member가 값을 물어봄)·
  `item/permissions/requestApproval`(네트워크/외부 경로 상승)도 처리 못 함.
- **되면(화면)**: 승인 카드에 실행할 command 또는 file diff가 그대로 보이고
  **이번만 / 이번 session / prefix rule로 자동승인 / decline(대안 지시)** 을
  고른다. guardian이 심사한 경우 그 결과가 표시되고, request-user-input의
  auto-resolve 카운트다운은 사용자가 손대면 멈춘다. decision은 transcript에 남는다.
- **우선순위 이유**: 1과 짝. approval이 불편하면 사용자는 결국 Full Access로
  풀어버려 안전장치가 무의미해진다.

### 3. member의 작업을 transcript item으로 보이기
- **사용자가 하려는 것**: member의 plan, 실행 중인 command, file change, 어느
  MCP 서버 도구인지, web search, image generation을 지켜보고 싶다.
- **지금**: agentMessage/reasoning/기본 도구만 보인다. **plan, commandExecution의
  live output·exitCode·cwd, fileChange diff, mcpToolCall의 source, webSearch,
  imageGeneration, subAgentActivity** 같은 ThreadItem이 화면에서 사라진다(`03`).
- **되면(화면)**: 멀티스텝은 **plan 카드**(단계 상태), 셸은 commandExecution이
  live output·exitCode와 함께, 변경은 fileChange의 파일별 diff(+/-), MCP 호출은
  **`mcp:<server>` badge** 와 함께 보인다.
- **우선순위 이유**: member를 "지켜볼 수 있어야" 신뢰가 생긴다. 여러 member를
  동시에 굴리는 AgentParty에서는 "지금 뭐 하는지"가 핵심 가치다.

### 4. `/` 로 Codex slash command·skill·plugin 찾아 쓰기
- **사용자가 하려는 것**: `/model`·`/plan`·`/review`·`/goal`·`/diff`·`/mcp`·
  `/skills`·`/plugins` 등을 외우지 않고 `/`로 찾아 실행하고 싶다.
- **지금**: 어댑터가 9개 command만 노출해 실제 Codex TUI(`codex-cli.md`)와 괴리.
- **되면(화면)**: `/`를 누르면 Codex command·skill·plugin이 뜨고 각 항목에 설명과
  source badge(Codex / skill / plugin / AgentParty)가 붙는다. disabled면 이유가
  보인다.
- **우선순위 이유**: 기능 발견 창구. 없으면 좋은 기능도 못 찾는다.

### 5. reroute·rate limit·warning을 숨기지 않기 (no silent fallback)
- **사용자가 하려는 것**: `model/rerouted`, rate limit, guardianWarning /
  configWarning, sandbox·auth·MCP 문제를 **바로** 알고 싶다.
- **지금**: warning류가 잘 안 보이거나 로그에 묻힌다. 왜 느린지/막혔는지 모른다.
- **되면(화면)**: reroute·rate limit·warning이 transcript status 블록과 member
  header badge로 뜬다(severity/category 구분). Windows sandbox 문제는 복구 안내로
  연결.
- **우선순위 이유**: 프로젝트의 "조용한 실패 금지" 원칙 직결. 안 보이면 member가
  고장인지 일하는 중인지 구분 못 한다.

---

## 2군 — 있으면 사용자가 훨씬 편한 것

### 6. 실행 중 turn을 steer 하기
- **사용자가 하려는 것**: member가 turn을 도는 도중 "그거 말고 이렇게"라고
  끼어들고 싶다.
- **지금**: 실행 중 입력은 무조건 queue로 밀린다. steer가 안 된다.
- **되면(화면)**: 실행 중 Enter는 진행 중 turn에 지시를 주입(**steer**), 다음
  turn으로 미루려면 별도 queue 동작으로 나뉜다(TUI Enter/Tab 동작 재현).
- **우선순위 이유**: 긴 turn일수록 중간 steer가 시간을 크게 아낀다.

### 7. thread를 resume·fork·archive·rename·delete 하기
- **사용자가 하려는 것**: 이전 thread를 resume하거나, 지금 thread를 fork해 다른
  시도를 하거나, 이름을 붙이고, 끝난 건 archive하고 싶다.
- **지금**: resume만 부분 지원. fork·rename·archive·delete가 없다.
- **되면(화면)**: member에서 fork·rename·archive·delete가 일반 액션으로 보인다.
  Codex thread는 `~/.codex/sessions`로 CLI·IDE·데스크톱과 공유되므로, 여기서
  이어간 thread가 다른 Codex surface에서도 열린다.
- **우선순위 이유**: 여러 시도를 굴리는 사용자에게 thread 관리는 일상 동작이다.

### 8. subagent / collab agent 활동을 Tasks pane으로 보기
- **사용자가 하려는 것**: Codex가 multi_agent로 띄운 subagent가 뭘 하는지 보고
  싶다(이건 독립 party member가 아니다).
- **지금**: `subAgentActivity`·`collabAgentToolCall`이 화면에 없어 member와
  헷갈린다.
- **되면(화면)**: member 안에 **Tasks / subagent** 목록(agentPath, 모델, 상태)이
  따로 있고 stop 가능. "party member(독립 thread)"와 "subagent(한 thread 내부
  worker)"가 라벨로 구분된다(`05` 매핑).
- **우선순위 이유**: Codex 병렬 작업을 안 보여주면 member가 멈춘 줄 안다.

### 9. fileChange를 Diff pane에서 review 하고 부분 적용
- **사용자가 하려는 것**: member의 fileChange를 파일별로 훑고, per-hunk로 골라
  적용하고, inline comment로 다시 고치게 하고 싶다.
- **지금**: 변경이 transcript에 흘러갈 뿐 모아서 review하는 화면이 없다.
- **되면(화면)**: Diff pane에서 file/hunk 단위 accept/reject, apply-to-worktree,
  inline comment→member 반영. `/review`(`review/start`)로 리뷰 코멘트를 받는다.
- **우선순위 이유**: 코딩 member 결과를 신뢰하려면 "골라 받는" 통제가 필요하다.
  Codex IDE에서도 로컬 per-hunk review가 약해 특히 값어치 있다.

### 10. MCP·plugin·skill·hooks·account를 관리 UI로 다루기
- **사용자가 하려는 것**: 어떤 MCP 서버/plugin/skill/hook이 켜져 있는지 보고
  toggle하고, OAuth login하고, config를 바꾸고 싶다 — `config.toml`을 손대지 않고.
- **지금**: 관리 화면이 없어 사용자가 파일을 직접 만져야 한다.
- **되면(화면)**: MCP 서버 목록(connected/failed/needs-auth)+toggle+OAuth login,
  plugin 브라우저(install/uninstall/Shared with you), skill 목록, hooks(신뢰
  심사 포함), account/auth 상태, 주요 config 편집이 패널로 보인다(`04`).
- **우선순위 이유**: 확장 기능을 화면으로 못 켜면 결국 안 쓴다.

---

## 3군 — Codex라서 특별한 것 (차별화)

### 11. Codex Cloud에 task 위임
- **사용자가 하려는 것**: 오래 걸리는 작업은 로컬 대신 **Codex Cloud**에 던져
  백그라운드로 돌리고, 결과 diff만 받아 반영하고 싶다.
- **지금**: 로컬 실행만 가능.
- **되면(화면)**: member 액션 **"Run in cloud"**(from local changes / from main
  선택) → task 진행 모니터(QUEUED…AWAITING_USER_FEEDBACK…COMPLETED) → 결과 diff를
  `codex cloud apply`로 로컬 적용하거나 PR로. **best-of-N(`--attempts` 1~4)**,
  environment/secrets 선택.
- **우선순위 이유**: Claude Code에 없는 Codex 고유 강점이지만 외부 연동이라 뒤.
  앞의 review/thread 기능이 갖춰진 뒤라야 결과를 제대로 다룬다.

### 12. PR / CI status를 결과물로 보기
- **사용자가 하려는 것**: member가 연 PR과 CI 통과 여부를 한눈에 보고 싶다.
- **지금**: PR/CI 개념이 화면에 없다.
- **되면(화면)**: member row PR badge, transcript "PR opened" 카드, CI passed/
  failed. `@codex` GitHub review 결과도 여기로.
- **우선순위 이유**: Cloud/GitHub 위임의 결과 표현이라 11 다음.

### 13. worktree isolation
- **사용자가 하려는 것**: 여러 member가 같은 repo를 동시에 고칠 때 서로 안 꼬였으면
  한다.
- **되면(화면)**: member 생성 시 **shared workspace / worktree** 선택, header에
  branch/worktree badge, delete/archive 시 uncommitted changes 경고(데스크톱 앱
  Local/Worktree/Cloud 모드 대응).
- **우선순위 이유**: 병렬 편집이 많을 때 가치가 크지만 그 전엔 없어도 됨.

### 14. browser use · computer use · image generation 켜고 쓰기
- **사용자가 하려는 것**: dev 서버를 in-app browser로 미리보고, computer use로
  화면을 조작하고, `$imagegen`으로 이미지를 만들고 싶다.
- **되면(화면)**: 능력 toggle + 권한 상태 안내(Screen Recording/Accessibility
  등) + 임베디드 preview pane(comment 가능) + imageGeneration/imageView 인라인
  표시(`04`).
- **우선순위 이유**: 특정 작업에만 필요한 부가 능력.

### 15. goals · memories · personality 다루기
- **사용자가 하려는 것**: member에 **goal**(지속 목표)을 주고 진행을 추적하고,
  **memories**로 선호/컨벤션을 기억시키고, **personality**를 고르고 싶다.
- **되면(화면)**: composer 위 **goal 배너**(pause/resume/edit/clear), 무엇이
  저장/주입되는지 보이는 memories 관리, personality selector(friendly/pragmatic/
  none).
- **우선순위 이유**: 있으면 좋은 개인화. 핵심 워크플로 뒤.

---

## 한눈에 보는 순서

| # | 사용자에게 돌려주는 것 | 군 |
|---|---|---|
| 1 | sandbox × approval 프리셋 + guardian | 1 (필수) |
| 2 | 정확히 보고 고르는 approval 카드 (once/session/prefix rule/decline) | 1 (필수) |
| 3 | member 작업을 transcript item으로 보이기 | 1 (필수) |
| 4 | `/`로 slash command·skill·plugin 찾기 | 1 (필수) |
| 5 | reroute·rate limit·warning 숨기지 않기 | 1 (필수) |
| 6 | 실행 중 turn steer | 2 (편의) |
| 7 | thread resume·fork·archive·rename·delete | 2 (편의) |
| 8 | subagent/collab Tasks pane | 2 (편의) |
| 9 | Diff pane review·부분 적용 | 2 (편의) |
| 10 | MCP·plugin·skill·hooks·account 관리 UI | 2 (편의) |
| 11 | Codex Cloud task 위임 | 3 (차별) |
| 12 | PR·CI status | 3 (차별) |
| 13 | worktree isolation | 3 (차별) |
| 14 | browser/computer use·image generation | 3 (차별) |
| 15 | goals·memories·personality | 3 (차별) |

**최소 실사용선**: 1군(1~5)이 되면 "Codex member를 믿고 일을 맡길 수 있는"
수준. 2군(6~10)으로 하루 종일 쓰기 편해지고, 3군(11~15)이 Codex를 고르는 이유가
된다.

---

## 작업자를 위한 시스템 선행 메모 (이 부분만 시스템 관점)

위 사용자 가치들의 토대가 되어 1군 전에 깔아두면 이후가 안정적인 순수 시스템
작업 두 가지. 사용자에게 직접 안 보인다.

- **app-server 프로토콜 타입 확보**: 어댑터가 응답을 `any`로 수기 파싱 중 →
  `codex app-server generate-ts`로 타입을 뽑아 교체해두면 3·4번(transcript
  item/slash command) 작업이 프로토콜 변경에 안 흔들린다(`01`).
- **하네스 capability 노출**: Codex 고유(2축 permission·guardian·Cloud·subagent
  ·steer 등)를 UI가 하네스별로 분기하도록 harness 정보에 지원 플래그를 실어
  둔다. Claude엔 없는 컨트롤을 잘못 띄우지 않게 하는 안전장치.

각 기능의 붙일 지점·프로토콜·API parity(모든 기능은 `AppController`+`apiSpec.ts`+
`docs/API.md` 경유)는 `01`~`05`와 프로젝트 지침을 따른다.
</content>
