# Handoff: 서브에이전트 관찰 UI (Subagent Observation UI)

## Overview
AgentParty Workbench에서 하나의 멤버(에이전트 세션)가 위임한 **서브에이전트들**을 관찰하는 UI다.
서브에이전트의 출력을 메인 대화(transcript)에 섞어 흘려보내지 않고, 세션 안에 **고정된 네이티브 패널(dock)**로
목록을 항상 보여주며, 각 항목을 클릭하면 **부모 세션에 종속된 자식 상세 뷰**로 드릴인한다.

핵심 원칙 3가지:
1. **분리** — 서브에이전트 출력은 메인 대화에 인라인으로 찍히지 않는다. 별도의 관찰 가능한 상태로 다룬다.
2. **영속(persistent)** — 목록은 채팅 스크롤과 무관하게 항상 같은 자리에 보인다. 상태 변화/개수 증가는 그 자리에서 갱신되며, 다시 스크롤을 올릴 필요가 없다.
3. **계층(nested)** — 서브에이전트는 세션과 동급이 아니라 세션 안에 딸린 자식이다. 상세 뷰는 항상 부모 세션으로 돌아가는 브레드크럼을 가진다.

## About the Design Files
이 번들의 `Workbench Multi.dc.html`은 **HTML로 만든 디자인 레퍼런스(프로토타입)**다. 의도한 모양과 동작을
보여주기 위한 것이며, 그대로 복사해 배포하는 프로덕션 코드가 아니다.

작업의 목표는 이 HTML 디자인을 **대상 코드베이스(Electron + 렌더러 프레임워크)의 기존 패턴/라이브러리로
재현**하는 것이다. 아래 스펙(수치·색·타이포·상태·상호작용)을 충실히 따르되, 마크업/스타일 구현 방식은
프로젝트의 기존 방식(React/Vue/기타 + CSS 방식)을 따르면 된다.

> 프로토타입은 CSS 변수 토큰 + 인라인 스타일로 작성돼 있다. 클래스/디자인시스템으로 옮길 때 값은 그대로 쓰되
> 구조만 프로젝트 관례에 맞추면 된다.

## Fidelity
**High-fidelity (hifi).** 최종 색상·타이포·간격·상호작용이 확정된 픽셀 단위 목업이다. 아래 수치를 그대로 재현할 것.

## Target Stack (Electron)
- 렌더러(UI)는 이 문서의 컴포넌트 스펙대로 구현.
- **각 서브에이전트 = 메인 프로세스가 관리하는 하위 작업/자식 프로세스**. 메인 프로세스가 서브에이전트의
  라이프사이클(대기 → 실행 → 완료/실패)과 스트리밍 출력을 관리하고, **IPC**로 렌더러에 상태를 push 한다.
- 렌더러는 `subagents[memberId]` 배열을 관찰 가능한 상태로 들고, IPC 이벤트가 올 때마다 in-place 갱신한다.
  절대 transcript에 다시 append 하지 않는다.
- 접힘 상태(`subDockCollapsed`)와 열린 상세(`openSub`)는 세션(멤버) 단위 UI 상태. `electron-store` 또는
  `localStorage`로 영속화 권장.
- 서브에이전트 stdout/이벤트 스트림 → `sub.blocks` (asst 텍스트 / tool 호출 / status / typing)로 매핑.

---

## Component 1 — Subagent Dock (고정 목록 패널)

세션 패널(멤버 대화 카드) 안에서 **툴바 바로 아래, transcript 바로 위**에 위치한다.
`flex: none`이라 transcript가 스크롤돼도 절대 밀리거나 사라지지 않는다.
해당 멤버가 서브에이전트를 하나라도 가진 경우에만 렌더한다.

### Container
- `flex: none; background: var(--bg-0); border-bottom: 1px solid var(--border-subtle);`

### Header (항상 표시, 클릭 시 접기/펼치기 토글)
- 행: `height: 33px; padding: 0 11px; cursor: pointer; display:flex; align-items:center; gap: 8px;`
- hover: `background: var(--bg-2)`
- 구성(좌→우):
  1. **Caret** — 11px chevron. 접힘 `rotate(0deg)` / 펼침 `rotate(90deg)`, `transition: transform .15s`. stroke `var(--text-3)`.
  2. **Branch 아이콘** — 13px, stroke `var(--accent)`. (노드 3개를 잇는 분기 아이콘)
  3. **라벨** — `"서브에이전트"`, `font-size:11.5px; font-weight:600; color:var(--text-0);`
  4. **카운트 배지** — 총 개수. `min-width:16px; height:15px; padding:0 5px; border-radius:8px; background:var(--bg-3); color:var(--text-1); font:700 9.5px var(--mono);`
  5. **상태 점들** (flex:1 영역, 좌측 정렬) — 각 서브에이전트당 6px 원. 색은 상태색(아래). 실행 중이면 pulse 링(`inset:-2.5px; border:1.5px solid <색>; opacity:.5; animation: ap-pulse 1.6s infinite`). 개수만큼 나열, 간격 4px.
  6. **요약 텍스트** (우측) — `font-size:10.5px; font-family:var(--mono); color:var(--text-2);` 예: `2 실행 · 2 완료 · 2 대기` (0인 카테고리는 생략, ` · ` 로 join).

### Expanded list (펼침 상태에서만)
- `max-height: 184px; overflow-y: auto; border-top: 1px solid var(--border-subtle);`
- **개수가 많아도 dock 높이는 고정**이고 넘치면 이 영역 내부에서만 스크롤된다(= transcript와 독립 스크롤).
- 각 행(Row):
  - `padding: 8px 11px 8px 13px; gap: 9px; cursor: pointer; border-top: 1px solid var(--border-subtle); display:flex; align-items:center;`
  - hover: `background: var(--bg-2)`
  - 열려있는(상세가 열린) 행: `background: <member.color 12% alpha>` (예: rgba(224,161,78,.12))
  - 구성(좌→우):
    1. **상태 점** 7px + working이면 pulse 링(`inset:-3px; border:1.5px solid <색>; opacity:.5; animation: ap-pulse 1.6s infinite`)
    2. **이름** — `font:500 12px var(--mono); color:var(--text-0);` (예: `shard-runner`)
    3. **스코프 배지** — `font:10px var(--mono); color:var(--text-3); background:var(--bg-3); padding:1px 5px; border-radius:4px;` (예: `auth/**`, `#a3f2`)
    4. **작업 요약** — `font-size:11.5px; color:var(--text-2);` 1줄 ellipsis. **패널 폭 < 408px(narrow)일 때 숨김.**
    5. (spacer `flex:1`)
    6. **메타** — `font:10.5px var(--mono); color:var(--text-3);` (예: `318 tests · 2m 04s`). **패널 폭 ≥ 600px(wide)일 때만 표시.**
    7. **상태 pill** — `height:19px; padding:0 8px; border-radius:5px; font:600 10.5px;` 라벨/색은 상태별(아래).
    8. **Chevron** 13px, stroke `var(--text-3)`.

### 상태(status) → 색 · 라벨 매핑
| status | 라벨 | 점/텍스트 색 | pill 배경 |
|---|---|---|---|
| `working` | `실행 중` | `member.color` (+pulse) | `member.color` @15% alpha |
| `done` | `완료` | `var(--success)` #54b585 | `var(--success-dim)` |
| `queued` | `대기` | `var(--text-3)` #535965 | `var(--bg-3)` |

### 상호작용
- 헤더 클릭 → 접기/펼치기 토글. 상태는 멤버 단위로 저장(`subDockCollapsed[memberId]`).
- 행 클릭 → 해당 서브에이전트 상세 뷰 열기(`openSub[memberId] = subId`).
- 개수 임계치가 커질 때의 처리(선택): 현재는 "고정 높이 + 내부 스크롤". 원하면 "N개 이상이면 기본 접힘" 또는
  "상위 몇 개만 + 더 보기" 규칙을 추가할 수 있음(디자인상 열려있음).

---

## Component 2 — Subagent Detail (자식 상세 뷰, 드릴인)

행 클릭 시 세션 패널 위에 **오버레이**로 뜬다. 세션의 탭 스트립은 그대로 보여서 "이 세션 안으로 들어왔다"는
계층이 유지된다.

### Overlay
- `position: absolute; left:0; right:0; top:41px; bottom:0; z-index:16; background: var(--bg-1); display:flex; flex-direction:column;`
- `top:41px` = 컬러바(3px) + 탭 스트립(38px). (탭 아래부터 덮어 toolbar/dock/transcript/composer를 가린다.)

### Breadcrumb header
- `height:46px; padding:0 10px 0 8px; border-bottom:1px solid var(--border-subtle); background:var(--bg-0); gap:9px;`
- 구성(좌→우):
  1. **Back 버튼** 28×28, chevron-left 16px, stroke `var(--text-2)`, hover `background:var(--bg-3); color:var(--text-0)`. → 상세 닫기.
  2. **부모 표식** — 부모 멤버 점 7px(`member.color`) + 부모 이름 `11.5px var(--text-2)` + chevron 12px `var(--text-3)`.
  3. **서브에이전트 식별** (flex:1) — 이름 `font:600 13px var(--mono); color:var(--text-0)` (ellipsis) + 스코프 배지(위와 동일 스타일).
  4. **상태 pill** — `height:20px; padding:0 8px; border-radius:5px; font:600 10.5px;` (working이면 5px pulse 점 포함). 색은 상태 매핑과 동일.

### Task band (위임된 작업)
- `padding:11px 14px; border-bottom:1px solid var(--border-subtle); background:var(--bg-2); gap:9px;`
- list 아이콘 13px `var(--text-3)` + 라벨 `"위임된 작업"` (`font:700 10px; letter-spacing:.5px; text-transform:uppercase; color:var(--text-3)`) + 작업 텍스트 `12px/1.5 var(--text-1)`.

### Body (서브에이전트 자체 transcript)
- `flex:1; overflow-y:auto; padding:16px; display:flex; flex-direction:column; gap:14px;`
- 블록 종류(`sub.blocks[].kind`):
  - **asst** — 본문 텍스트 `font-size:12.5px; line-height:1.6; color:var(--text-0);`
  - **tool** — 툴 카드: border `var(--border)`, radius 8px, bg `var(--bg-2)`. 헤더행 height 33px: 체크 아이콘(17px 라운드, `var(--success-dim)`/`var(--success)`) + 툴명 `12px var(--mono)` + 인자 `11.5px var(--mono) var(--text-2)` ellipsis + 소요시간 `10px var(--mono) var(--text-3)`. 본문 `<pre>` `11.5px/1.6 var(--mono) var(--text-2)`, 좁은 패널이면 `white-space:pre-wrap` 아니면 `pre`.
  - **status** — 돋보기 아이콘 12px + `11.5px var(--mono) var(--text-2)` 텍스트.
  - **typing** — bounce 점 3개(5px, `member.color`, `animation: ap-bounce 1.2s infinite` 0/.15s/.3s 지연) + `"작업 중…"`.

---

## State Management
멤버(세션)별로 다음 상태를 둔다.

```
SUBAGENTS[memberId] = [
  {
    id:     string,              // 고유 id
    name:   string,              // 표시 이름 (예: 'shard-runner', 'call-tracer')
    hint:   string,              // 스코프/식별 배지 (예: 'auth/**', '#a3f2')
    status: 'working'|'done'|'queued',
    tools:  string,              // 메타 좌측 (예: '318 tests', '2 failures', '6 files')
    dur:    string,              // 메타 우측 (예: '2m 04s', '1m 12s…', '—')
    task:   string,              // 위임된 작업 설명(상세 뷰 상단)
    blocks: [ {kind, text?, toolName?, arg?, ms?, res?} ... ]   // 자체 transcript
  }
]

// UI 상태
openSub:          { [memberId]: subId }   // 어떤 서브에이전트 상세가 열려있나 (없으면 미열림)
subDockCollapsed: { [memberId]: boolean } // dock 접힘 여부
```

전이(triggers):
- 메인 프로세스가 서브에이전트 spawn → `SUBAGENTS[memberId]`에 `status:'queued'|'working'` 항목 append(IPC).
- 실행 중 stdout/이벤트 → 해당 항목의 `blocks` 추가 + `tools`/`dur` 갱신(IPC, in-place).
- 종료 → `status:'done'`(또는 실패 상태) 갱신.
- 헤더 클릭 → `subDockCollapsed[memberId]` 토글.
- 행 클릭 → `openSub[memberId] = subId`. Back → 삭제.
- **모든 갱신은 dock/detail 컴포넌트가 상태에서 파생 렌더**. transcript에는 요약 한 줄(assistant 메시지)만 남기고 서브에이전트 진행 자체는 찍지 않는다.

## Responsive (패널 폭 기준)
같은 세션 패널이 여러 폭으로 존재할 수 있다(분할/시분할). 폭 임계값:
- **wide ≥ 600px** — dock 행에 작업 요약 + 메타 모두 표시.
- **mid ≥ 408px** — 작업 요약 표시, 메타 숨김.
- **narrow < 408px** — 작업 요약도 숨김(이름 + 스코프 + 상태 pill만). toolbar는 숨지만 **dock은 모든 폭에서 표시**.

## Design Tokens (dark theme 기준)
```
/* backgrounds */    --bg-0:#0a0b0e; --bg-1:#0e1014; --bg-2:#14171d; --bg-3:#1b1f27; --bg-4:#222731;
/* borders */        --border-subtle:#1c2028; --border:#262b35; --border-strong:#333a46;
/* text */           --text-0:#e7e9ee; --text-1:#aeb4c0; --text-2:#79808d; --text-3:#535965;
/* accent(파랑) */    --accent:#5b8cff; --accent-dim:rgba(91,140,255,.13); --accent-bd:rgba(91,140,255,.32);
/* status */         --success:#54b585; --success-dim:rgba(84,181,133,.13);
                     --live(주황):#e0a14e; --danger:#e0635d;
/* type */           --sans:'Geist'; --mono:'Geist Mono';
/* radius */         배지 4px · pill 5px · 카드 8px · dock 없음(직사각, 상/하 보더)
/* animation */      ap-pulse 1.4~1.6s (실행 중 점) · ap-bounce 1.2s (typing)
```
라이트 테마 값은 프로토타입의 `[data-theme="light"]` 블록 참고.

### 멤버(세션) 색 — 상태색이 member.color를 참조하므로 함께 필요
```
backend #5b8cff · frontend #a07bff · reviewer #54b585 · tester #e0a14e · db-migrate #3ac6d6 · docs #e06b9c
```
`working` 상태의 점/pill은 그 서브에이전트가 속한 멤버의 색을 쓴다. `done`은 항상 success 초록, `queued`는 text-3 회색.

## Assets
아이콘은 전부 인라인 SVG(외부 이미지 없음). 폰트는 Google Fonts의 **Geist / Geist Mono**.
서브에이전트 dock/detail에 쓰인 아이콘: 분기(branch) 아이콘, chevron(caret/우/좌), 체크, 돋보기, list, 시계 등 — 모두 프로토타입 파일 안에 SVG로 존재. 코드베이스에 아이콘 세트가 있으면 대응 아이콘으로 치환 가능.

## Files
- `Workbench Multi.dc.html` — 서브에이전트 dock + 자식 상세 뷰가 포함된 전체 워크벤치 프로토타입.
  - 서브에이전트 데이터/로직: `SUBAGENTS`, `openSubAgent`/`closeSubAgent`/`toggleSubDock`, `buildSubBlocks`,
    `panelView()` 내부의 `subDock`/`subDetail` 계산, 그리고 `renderVals()` 반환값.
  - 마크업: `<!-- SUBAGENT DOCK (persistent...) -->`, `<!-- SUBAGENT DETAIL (child view) -->` 주석 구간.
  - 브라우저로 바로 열림. tester 탭을 열면 서브에이전트 6개 예시가 보인다(2 실행 · 2 완료 · 2 대기).
- `support.js` — 프로토타입 런타임(디자인 구동용, 구현 참고 대상 아님).

---

## 구현 상태 & 목업 주도(mock-driven) 사용법

이 핸드오프는 구현되었다. 아키텍처(추상화·격리):

- **정규 이벤트**: `type: "subagent"` 하나로 두 하네스를 통합(`src/core/events.ts`). lifecycle(정체성/상태) + activity(현재 한 줄) + block(자체 transcript) 세 facet.
- **currentAction 교체 지점**: `src/shared/subagentActivity.ts`의 `deriveSubagentAction(tool)` — tool→한글 라벨 map. **나중에 경량 모델 분석기로 교체/보강**(activity.summary 채우기)할 단일 지점. 다른 계층은 `SubagentActivity` 모양만 소비한다.
- **분리**: 서브에이전트 출력은 렌더러에서 별도 슬라이스(`applySubagentEvents`)로 접혀 메인 transcript에 절대 섞이지 않는다.
- **귀속(attribution)**: 실측 녹화로 확정한 실제 채널을 쓴다 — Claude는 `task_started`/`task_progress`/`task_updated`(`task_id`/`tool_use_id`/`last_tool_name`/`patch.status`), Codex는 자식 collab **threadId** 로 라우팅. 로직은 `src/core/subagentTracker.ts`(Claude/Codex 트래커)에 격리·단위테스트되고 어댑터는 위임만 한다. 서브에이전트 출력은 부모 transcript에서 억제된다.
- **녹화·검증**: 라이브 Haiku/gpt-mini 실행에서 뜬 원본 프레임을 `scripts/fixtures/subagents/*.jsonl` 로 저장하고, `scripts/qa-subagent-tracker.mjs` 가 그 실제 트래픽을 트래커에 replay 해 귀속·분리를 검증한다.
- 컴포넌트: `SubagentDock.tsx`(Component 1) + `SubagentDetail.tsx`(Component 2), 뷰모델은 `subagentModel.ts`.

**목업으로 디자인/QA/시연** (실제 서브에이전트를 켜지 않는다):

- 시나리오 정본: `src/shared/subagentScenarios.ts` (`claude-test-shards`, `codex-call-tracer`). 각 하네스의 요청/응답 구조를 반영해 `subagent` 이벤트 스트림으로 확장된다.
- 주입 엔드포인트: `POST /api/qa/members/:name/subagents` `{ "scenario": "claude-test-shards" }` — 실제 하네스와 동일한 정규화·렌더러 fold를 통과. QA 모드(`AGENTPARTY_QA=1`) 필요. (docs/API.md)
- 검증: jsdom `npm run test:subagents`(`scripts/qa-subagents.mjs`), 풀 프로세스 e2e `npm run test:e2e:subagents`(`scripts/e2e-subagents.mjs` — 목업 주입 → 실제 앱 렌더 → 스크린샷).
