# Handoff: Token Usage — 비용 · 컨텍스트 대시보드 (AgentParty)

## Overview
AgentParty의 **Token Usage** 화면. 목적은 "구독(Claude/Codex) 사용량을 최적화하기 위한 판단 근거"를 만드는 것.
- **어떤 세션/파티/멤버가 비쌌나(비용)**, 그리고 **왜 비쌌나(모델·effort)** 를 한 화면에서 읽는다.
- **컨텍스트 보유량 ↔ 비용의 상관관계**를 같은 시간축에서 본다.
- 모델/effort/하네스를 바꿨을 때 예산이 어떻게 움직이는지 시계열로 판정한다.

1급 지표는 **비용(cost)** 이다. 토큰은 **입력(↑)·출력(↓)** 으로 분리해 보조 표기한다. 절대 청구액이 아니라 **실측 토큰 × 공개 리스트 단가**로 환산한 상대 비교값(`≈$`).

## About the Design Files
이 번들의 `Token Usage.dc.html`는 **HTML로 만든 디자인 레퍼런스**(의도한 룩앤필·동작을 보여주는 프로토타입)이며 그대로 배포할 프로덕션 코드가 아니다. 내부 "DC" 런타임(React 기반, `support.js`) 위에서 동작하므로, **대상 코드베이스의 환경(여기서는 Electron)** 에서 그 환경의 패턴·라이브러리로 **재구현**하는 것이 과제다.

**가장 정확한 시각적 소스는 이 HTML 파일 자체다.** Chromium(브라우저/Electron 렌더러)에서 `Token Usage.dc.html`을 열면 픽셀 단위로 최종 렌더가 보인다. 캡처(`captures/`)는 조립된 전체 화면을 담은 참고 이미지다.

### Stack: Electron
- 렌더러가 Chromium이므로 `color-mix(in srgb, …)`, 인라인 SVG, CSS grid/flex, `font-variant-numeric: tabular-nums` 모두 **네이티브 지원**. 폴리필 불필요.
- 폰트(Geist, Geist Mono)는 오프라인 동작을 위해 **로컬 번들 권장**(Google Fonts 링크 대신 앱에 동봉).
- 권장 구현: React + 인라인 스타일 또는 CSS Modules. 차트는 SVG를 직접 그린다(외부 차트 라이브러리 없이 구현됨 — 그대로 SVG로 옮기면 충실도가 가장 높다).

## Fidelity
**High-fidelity (hifi).** 색상·타이포·간격·인터랙션이 최종 값이다. 픽셀 단위로 재현할 것.

---

## Design Tokens

### Color (CSS custom properties)
라이트가 기본(`:root`), 다크는 `[data-theme="dark"]` 오버라이드.

| Token | Light | Dark |
|---|---|---|
| `--bg-0` | `#e7e8eb` | `#0a0b0e` |
| `--bg-1` | `#f3f4f6` | `#0e1014` |
| `--bg-2` (카드) | `#ffffff` | `#14171d` |
| `--bg-3` | `#eef0f3` | `#1b1f27` |
| `--bg-4` (트랙) | `#e6e9ed` | `#222731` |
| `--bg-input` | `#ffffff` | `#0c0e12` |
| `--border-subtle` | `#e2e5ea` | `#1c2028` |
| `--border` | `#d3d7df` | `#262b35` |
| `--border-strong` | `#c0c5ce` | `#333a46` |
| `--text-0` | `#171a1f` | `#e7e9ee` |
| `--text-1` | `#454b56` | `#aeb4c0` |
| `--text-2` | `#6c7480` | `#79808d` |
| `--text-3` | `#9aa1ac` | `#535965` |
| `--accent` | `#3f6fe6` | `#5b8cff` |
| `--accent-dim` | `rgba(63,111,230,.1)` | `rgba(91,140,255,.13)` |
| `--accent-bd` | `rgba(63,111,230,.28)` | `rgba(91,140,255,.32)` |
| `--accent-fg` | `#ffffff` | `#ffffff` |
| `--live` (경고/실측) | `#b9791d` | `#e0a14e` |
| `--live-dim` | `rgba(185,121,29,.1)` | `rgba(224,161,78,.13)` |
| `--live-bd` | `rgba(185,121,29,.3)` | `rgba(224,161,78,.34)` |
| `--success` | `#2f8f5e` | `#54b585` |
| `--danger` | `#cf4b45` | `#e0635d` |
| `--grid` (차트 그리드) | `rgba(20,25,35,.07)` | `rgba(255,255,255,.06)` |

프로바이더 점 색: Claude `#c96442`, Codex `#10a37f`, OpenRouter `#7c6cf0`.

### Typography
- 본문/UI: **Geist** (400·500·600·700), `--sans: 'Geist', 'Geist Fallback', sans-serif`.
- 수치: **Geist Mono** (400·500·600·700), `--mono: 'Geist Mono', ui-monospace, monospace`. 모든 수치는 `font-variant-numeric: tabular-nums`(클래스 `.tu-num`)로 자릿수 정렬 + 우측 정렬.
- 스케일(px): 페이지 타이틀 19/600, 섹션 제목 13.5–14/600, 카드 라벨 11/700 uppercase(letter-spacing .5px), 큰 수치 30–44/600, 본문 11–12.5, 캡션 10–10.5.

### Radius / Shadow
- 카드/섹션 radius **14px**, 칩/버튼 **6–9px**, 작은 배지 **4–5px**.
- 카드 그림자 없음(보더로 구분). 팝오버: `0 16px 40px -10px rgba(0,0,0,.5)`. 드롭다운: `0 20px 50px -14px rgba(0,0,0,.55)`.
- 루트 컨테이너 radius 10px, `box-shadow:0 30px 80px -30px rgba(0,0,0,.45)`(프리뷰용 — 앱 내장 시 불필요).

### 모델 퍼스널 컬러 (봉별 표 배경/차트 계열 아님, 표 셀 인코딩용)
opus `#6d5ae6`, sonnet `#2f9e8f`, haiku `#8b8f99`, gpt-5 `#c98a3a`, gpt-5-mini `#d8b06a`, fable `#c25b8f`.
셀 배경 채움색 = `color-mix(in srgb, <모델색> 30%, var(--bg-2))` (테마 적응, 글씨 가독 유지).

### effort → 높이(%) 매핑 (봉별 셀 채움 높이, 타임라인 농도)
`min:22, low:40, med:60, high:80, max:100`.
effort 명도/농도용 믹스(타임라인 레인): `{min:38, low:52, med:66, high:82, max:100}` % of member color.

### 비용 계산 (파생값, 추정 아님)
per‑1M 리스트 단가: opus `in15/out75`, sonnet `3/15`, haiku `0.8/4`, gpt‑5 `1.25/10`, gpt‑5‑mini `0.25/2`.
`cost = in_tokens/1e6*rate.in + out_tokens/1e6*rate.out`. 기본 출력 비중 18%. 차트 봉별 비용은 그 시점 (모델×effort)의 출력비중 `{min:.08, low:.12, med:.18, high:.3, max:.42}`로 계산 → **모델·effort가 바뀌면 비용 막대가 실제로 점프**한다.
표기: 구독(Claude/Codex)=환산 비용 `≈$`, OpenRouter=실비용 `$`.

---

## Screens / Views

### 1. Dashboard (기본)  — `captures/01-dashboard-full.png` (light), `02-dashboard-dark.png` (dark)
좌측 세로 **Nav rail**(폭 52px, `--bg-0`, 34px 아이콘, 활성 항목은 `--accent-dim` 배경 + 좌측 2.5px accent 바) + 우측 콘텐츠(헤더 고정 + 본문 스크롤).

**a. 헤더** — 타이틀 "Token Usage" + 서브타이틀, 우측에 `비교 모드` 버튼과 테마 토글(달 아이콘). 뒤로가기 버튼은 드릴인일 때만.

**b. 한도 게이지 카드** (`--live-bd` 보더, 좌상단 `--live-dim` 그라디언트 오버레이)
- 라벨 "한도 소진율 · 실측 Claude"(live 점 pulse).
- **5시간**과 **주간**을 함께 표시(탭 아님). 각 행: 왼쪽 라벨+큰 % 수치(5시간=`--live`, 주간=`--text-1`), 오른쪽 진행 바(높이 9px, radius 5px, 트랙 `--bg-4`) + "N 후 리셋" 캡션. 5시간=63%, 주간=41%.
- **참고선 성격**(세션에 배분하지 않음).

**c. 타임라인 차트 — "비용(막대) × 컨텍스트 보유(점선)"** (핵심 시각화)
- SVG. 좌축 = 비용 `$`(선형), 우축 = 컨텍스트 `k`(0–200k). 그리드 5칸.
- **막대**: 시간 버킷별 비용, 계열(멤버 또는 파티) **정체성 색**으로 스택. 유휴 버킷은 막대 없음.
- **점선(dash 5 3)**: 계열별 **컨텍스트 보유량**(같은 색). 톱니 형태로 쌓이다 **compact 지점에서 급락**, 그 지점에 **○ 마커**(계열색 테두리, `--bg-2` 채움).
- 우상단 컨트롤: **스코프 드롭다운**(전체·활성 파티 스택 / 특정 파티 선택; 검색 + 활성/보관 목록, 이름 같아도 `#id`로 분리), **계열 범례**(호버 시 강조), **컨텍스트 보유 (k) 토글 버튼**(점선 스와치; 켜짐=accent, 끔=중립 — 점선/우축 on·off).
- 간격 버튼: `1분 3분 5분 15분 30분 1시간 4시간 1일`(기본 5분).
- 서브카피: "막대=비용, 점선=컨텍스트 보유량 · 같은 시간축에서 상관관계를 봅니다". 버킷 호버 시 "시각 · ≈$비용 · N tok".

**d. 모델·effort 타임라인 레인** (파티 선택 시에만; 전체 스코프면 안내문)
- 멤버당 가로 띠. **색=멤버 정체성, 농도=effort, 좌측 세로선=모델·effort 변경 지점**, 각 구간에 "모델 effort" 라벨. 위 비용 막대와 x축 정렬.

**e. 카탈로그** (가로 스크롤 파티 카드)
- 카드마다: 파티명 + `#id` + (보관 배지) + 비용 `≈$` + ↑입력 ↓출력. 아래 멤버 행(색 점 + 이름 + 비용 + ↑↓토큰).
- 파티/멤버 클릭 = 차트에서 **on/off**(끄면 흐림 + 취소선). 우측 `이전 파티 검색` 버튼 → **팝업**(검색 입력 + 과거·지운 파티 목록, 각 항목 클릭 시 카탈로그·차트에 추가, 추가 개수 배지). "Claude 5시간 소진률(실측)" 표식.

**f. 봉별 실제 수치 표** (전치 표: 행=계열, 열=시간 버킷; 가로 스크롤, `max-height:288px`)
- 셀: 비용 값(우측 정렬, tabular). **배경 = 미니 막대**: 아래에서부터 effort 높이만큼 채움(모델색 30% 틴트), 인접 버킷과 **부드러운 곡선(SVG cubic)** 으로 이어짐.
- **모델·effort 변경 봉엔 핀 배지**(둥근 사각 24×19, `--live-dim` 배경/`--live-bd` 보더, ⇄ 아이콘; 활성 시 accent). 클릭 → **그 위치에 팝오버**: 멤버·시각, `이전(모델 effort) → 이후(모델 effort)`.
- 우상단 모드 토글: `비용 / 한도 %`. 하단 합계·한도 소진%(누적) 행. 범례: "배경=모델색, 채움 높이=effort(low→max)".

**g. 누가 — 파티 ▸ 멤버 표** (계층·정렬·검색)
- 헤더 컬럼(정렬 가능): 파티/멤버 · 활성 시간 · 턴 · **비용·토큰** · 점유율(막대) · 시간당 · 캐시 · 오버헤드 · ~추정 한도%.
- 파티 행 클릭 = 펼치기(멤버 행). 멤버 행 클릭 = **드릴인**. 파티 행: 색 점 + 이름 + `#id` + 상태 배지(활성=success/보관=중립) + 기간 + 멤버 수. 멤버 행: 모델·effort 칩(+티어 바 `▰▱`) + (혼합 배지).
- 비용 셀은 `≈$`(굵게) + 아래 ↑입력 ↓출력(작게). 기울임·`~` 열은 **추정값**(실측 아님). 툴바: 파티 수/활성/보관, 검색, `보관 파티 포함` 토글.

### 2. 세션/멤버 드릴인 (`view = 'member'`)
Table A 멤버 행 클릭으로 진입. (HTML에서 프롭 `view`를 `member`로 두거나 멤버 행을 클릭해 확인)
- 상단: 멤버 칩(색·이름·`session #id`·파티·프로바이더 배지) + 스탯 카드(환산 비용 + ↑입력↓출력 / 지배 모델·effort·티어 / 캐시 적중 / 출력 비중) + "이 세션 대화로 이동" 버튼(accent).
- **모델·effort 구간**: 세션이 (모델×effort) 구간들의 합임을 가로 막대로. 칸 너비 = 그 구간 비용, 색 농도 = effort, 좌측 세로선 = 변경.
- **세션 내 컨텍스트 증가 곡선**: SVG. 기울기=비용 동인. compact 지점 세로 점선 + "compact" 라벨(끊긴 뒤 캐시 재구축).
- **비싼 턴**: # · 요약 · 모델·effort · 출력 바 · 비용(+↑↓토큰).
- **빈 상태**: "이전 incarnation · 아직 없음" — `session_id`가 다르면 다른 세션, 값은 지어내지 않고 "아직 없음".

---

## Interactions & Behavior
- **테마 토글**: `data-theme` `light`↔`dark`.
- **스코프**: `'all'`(활성 파티 스택, 상위 6 + "기타 N개") ↔ 파티 `id`(그 파티 멤버). 드롭다운 검색은 이름+`#id`.
- **계열 on/off**: 카탈로그/컨텍스트 토글이 `hiddenParties`/`hiddenMembers`를 바꿔 차트·표에서 제외.
- **컨텍스트 오버레이 on/off**: `ctxOn`(점선 + 우축 k 토글).
- **핀 팝오버**: 클릭 시 핀의 화면 좌표를 계산해 섹션 기준 절대 위치로 팝오버 표시(오버플로 클리핑 회피). 바깥 클릭/✕/재클릭으로 닫힘.
- **정렬**: 컬럼 클릭(기본 점유율 desc), 방향 토글. **검색/보관 토글**: 파티 필터. **파티 펼치기**: `tExpanded`.
- 전환 애니메이션: 진입 `st-rise .2–.22s`, 팝오버 `tu-open .18s`, live 점 `tu-pulse 1.6s`.
- **정체성 규칙(중요)**: 파티는 이름이 아니라 **`#id`(재생성=새 id)** 로 구분, 멤버 세션은 **`session_id`** 로 구분. 같은 이름이라도 절대 병합하지 말 것. 지운 파티도 "보관"으로 기록 유지.
- **실측/파생/가정 구분**: 토큰·프로바이더 소진률=실측, 비용=결정적 파생, "비용비율≈소진비율"=가정(화면에 명시). 빈 값은 0%가 아니라 "아직 없음".

## State Management
`theme`, `view('dashboard'|'member')`, `scope('all'|partyId)`, `interval`, `hover`, `hoverBucket`, `brush`(선택적 구간), `hiddenParties`, `hiddenMembers`, `ctxOn`, `pinOpen`/`pinX`/`pinY`, `tExpanded`/`tSort`/`tDir`/`tQuery`(Table A), `catPickerOpen`/`archPinned`(카탈로그 팝업), `dm`(드릴인 대상), `sortKey`/`sortDir`, `showArchived`.

## Data Model (mock)
- **세션 = 한 멤버의 한 실행**. 파티(`id`,`name`,`status`,`col`) ▸ 멤버(`name`,`color`,`model`,`effort`) ▸ (모델×effort) 구간(`f`fresh입력/`cr`캐시읽기/`cw`캐시쓰기/`o`출력 raw 토큰).
- 멤버의 시간대별 모델·effort 스케줄(`MSCHED`: `{u:끝비율, m:모델, e:effort}` 배열) → 봉별 색/높이/핀/비용을 구동.
- 컨텍스트 곡선: 활성 구간 누적 상승 → 임계에서 compact 리셋(톱니). 실측 계측 연결 시 대체.

## Assets
- 외부 이미지 없음. 모든 아이콘은 인라인 SVG(stroke 기반, `stroke-width` 1.6–2.2).
- 폰트: Geist / Geist Mono — **Electron에 로컬 번들**(현재는 Google Fonts 링크).
- Anthropic/브랜드 자산 없음.

## Files
- `Token Usage.dc.html` — 디자인 소스(브라우저에서 열어 최종 렌더·인터랙션 확인).
- `captures/01-dashboard-full.png` — 전체 대시보드(라이트, 파티 선택 스코프, 전 컴포넌트 조립).
- `captures/02-dashboard-dark.png` — 동일 화면 다크 테마.
- 드릴인/핀 팝오버/카탈로그 팝업 등 인터랙션 상태는 HTML을 열어 확인.
