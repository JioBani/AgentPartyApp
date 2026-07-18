# Handoff: Codex 권한 설정 (CodexPolicy) 재설계

## Overview
AgentParty(멀티 에이전트 데스크톱 워크벤치, Electron) 안에서 **Codex 멤버 한 명의 실행 권한(CodexPolicy)** 을 세션 시작 전/중에 설정하는 UI입니다. 워크벤치 패널 툴바의 **라이트닝(⚡) pill** 을 누르면 뜨는 **팝오버**로 동작합니다.

기존 UI(프리셋 3버튼 + Sandbox 드롭다운 + Approval 드롭다운 + Guardian 토글)는 기능은 정확했지만 각 항목의 의미·결과를 이해하기 어려웠습니다. 이 재설계는 **개발자(Codex/Claude Code를 자주 쓰는 기술 사용자)** 를 대상으로, canonical 값을 앞세우고 밀도 높게 정리했습니다. 두 개의 독립 컴포넌트를 다룹니다:

1. **Permissions 팝오버** — sandbox × approval 두 축 + guardian 토글 설정
2. **Approval 카드** — 승인이 필요한 순간 transcript에 뜨는 결정 카드

## About the Design Files
이 번들의 파일은 **HTML로 만든 디자인 레퍼런스**입니다 — 의도한 룩과 동작을 보여주는 프로토타입이며, **그대로 가져다 쓰는 프로덕션 코드가 아닙니다.** 사내 템플릿 런타임(`support.js`, `.dc.html` 포맷)에서 돌아가며, **이 런타임은 이식하지 마세요.**

할 일: **이 디자인을 실제 코드베이스에 재현**하는 것입니다. 타깃은 **Electron 앱**입니다. 렌더러에 프레임워크(React/Vue 등)가 이미 있으면 그 패턴/컴포넌트 라이브러리를 쓰고, 없으면 **React + TypeScript**를 권장합니다. 팝오버는 실제 앱에서 라이트닝 pill에 앵커된 popover/menu 컴포넌트로 구현하세요.

## Fidelity
**High-fidelity.** 색상·타이포·간격·인터랙션이 최종본입니다. 픽셀 충실하게 재현하되, 팝오버 위치·포커스 트랩·키보드 접근성은 앱의 popover 컴포넌트 규약을 따르세요.

프로토타입은 라이트/다크 두 테마를 `data-theme` 속성으로 토글합니다(기본 다크). 앱의 기존 테마 시스템에 매핑하세요.

---

## 도메인 사실 (반드시 정확히 부합해야 함 — 구현의 계약)

권한은 **독립된 두 축 + 별도 토글 1개**로 구성됩니다. 두 축은 자유롭게 조합됩니다(3×3 = 9가지). 이 중 **3개만 이름 붙은 프리셋**입니다.

### 축 ① `sandbox` — Codex가 기술적으로 접근 가능한 범위
| 값 | 한국어 라벨 | 의미 |
|---|---|---|
| `read-only` | 읽기 전용 | 워크스페이스 파일 읽기 + 응답만. 편집·명령 실행·네트워크 불가(하려면 승인 필요). |
| `workspace-write` | 작업 폴더 | 워크스페이스 안 읽기·쓰기 및 일상 명령 자동. 워크스페이스 밖 쓰기·네트워크는 불가(승인 필요). *(현재 구현: 쓰기 범위 = 워크스페이스만, 네트워크 기본 OFF)* |
| `danger-full-access` | 전체 접근 | 샌드박스 제거. 전체 파일시스템 + 네트워크 접근 가능. |

### 축 ② `approval` — Codex가 언제 멈춰 사람에게 승인을 요청하는지
| 값 | 한국어 라벨 | 의미 |
|---|---|---|
| `untrusted` | 매번 확인 | 안전하다고 알려진 읽기만 자동, 변경·파괴적 명령은 매번 승인 요청. |
| `on-request` | 경계에서 (기본) | 샌드박스 벽을 넘어야 할 때만 승인 요청. |
| `never` | 안 함 | 승인을 절대 요청하지 않음. 벽에 막히는 동작은 요청 없이 실패. |

### 프리셋 (두 축의 조합, 3개 + Custom)
| 프리셋 | sandbox | approval |
|---|---|---|
| **Read Only** | `read-only` | `on-request` |
| **Auto** (기본값) | `workspace-write` | `on-request` |
| **Full Access** | `danger-full-access` | `never` |
| **Custom** | 위 3개와 일치하지 않는 나머지 6가지 조합 | |

> 프리셋을 고르면 두 축이 해당 값으로 세팅됩니다. 축을 직접 바꿔 프리셋과 어긋나면 상태는 **Custom**이 됩니다(라이트닝 pill 라벨이 `custom`으로 표시). 즉 프리셋은 2축 공간의 이름 붙은 좌표일 뿐입니다.

### `guardian` 토글 (독립, 프리셋과 무관)
- **OFF (기본)**: 승인 요청이 사람에게 바로 전달된다.
- **ON**: 승인 요청을 먼저 리뷰어 서브에이전트가 심사한다 — 데이터 유출/자격증명 탐침/파괴적 행위 위험을 판단해, 안전하면 사람 개입 없이 통과, 위험하면 차단. 차단 시 사용자가 **1회 override** 가능.

### 기본 상태
`sandbox=workspace-write`, `approval=on-request`, `guardian=off` (= 프리셋 **Auto** + Guardian OFF).

---

## 위험도(risk) 계산 규칙
각 축 값에 위험 점수를 매겨 합산(0~4)합니다:

```
sandboxRisk = { 'read-only':0, 'workspace-write':1, 'danger-full-access':2 }
approvalRisk = { 'untrusted':0, 'on-request':1, 'never':2 }
sum = sandboxRisk[sandbox] + approvalRisk[approval]   // 0..4
```

| sum | level | 라벨 | 색상 토큰 |
|---|---|---|---|
| 0–1 | ok | 안전 | `--success` |
| 2 | mid | 보통 | `--accent` |
| 3 | live | 주의 | `--live` |
| 4 | bad | 위험 | `--danger` |

- 미터는 4칸, 채워지는 칸 수 = `max(sum, 1)`, 색상 = level 색상.
- 색상 코딩은 축 세그먼트에도 동일 적용: `read-only`/`untrusted` = `--success`(초록), `workspace-write`/`on-request` = `--accent`(파랑), `danger-full-access`/`never` = `--danger`(빨강). 선택된 세그먼트만 채색.

### 경고 배너 규칙
- `full = (sandbox === 'danger-full-access')`
- `strong = full && approval === 'never' && !guardian`
- **표시 조건**: `full || sum >= 4`
- 문구:
  - `strong` → 제목 `no guardrails`, 본문 "full-access + never + guardian off. 파괴적 동작을 막을 게 없음." (색 `--danger`)
  - `full`(strong 아님) → 제목 `sandbox off`, 본문 "전체 FS·네트워크 노출." (색 `--danger`)
  - 그 외(`sum>=4`) → 제목 `high-risk combo`, 본문 "넓은 접근 + 낮은 승인 빈도." (색 `--live`)
- 경고 표시 중 `guardian` OFF면 **"guardian 켜기"** CTA 버튼 노출(클릭 시 guardian=on).

---

## Screens / Views

### 1) Permissions 팝오버
**Purpose**: 한 Codex 멤버의 CodexPolicy를 설정.

**앵커/트리거**: 패널 툴바의 라이트닝 pill. pill은 현재 프리셋 이름(또는 `custom`)과 위험도 색상 점을 표시.

**팝오버 컨테이너**: width 440px, `background:--bg-2`, `border:1px solid --border`, `border-radius:13px`, `box-shadow:0 24px 60px -20px rgba(0,0,0,.6)`, `overflow:hidden`. 등장 애니메이션 `opacity/translateY(-4px)/scale(.98) → 정상`, 0.18s ease.

위→아래 구조 (내부 padding `14px 15px`, 섹션 세로 gap 14px):

1. **헤더** (padding `12px 15px`, 하단 `1px solid --border-subtle`): 방패 아이콘(`--accent`, 14px) + "Permissions"(13px/700) + 오른쪽 멤버명 `backend`(mono 10px, `--text-3`).
2. **프리셋 3장** (가로 flex, gap 7px): 각 카드 `flex:1`, padding `9px 10px 10px`, radius 9px.
   - 상단 행: 색상 사각 점(7×7, radius 2px, tone색) + 이름(12.5px/700, `--text-0`) + 선택 시 체크 아이콘(tone색).
   - 하단: 조합 공식 mono 8.5px `--text-3` (예: `workspace-write + on-request`).
   - 선택 상태: `background = tone-dim`, `border = tone색`, `box-shadow: 0 0 0 1px tone색`. 미선택: `bg --bg-2`, `border --border`.
3. **Sandbox 세그먼트**: 소제목 `SANDBOX · 접근 범위`(10px/700 uppercase, `--text-3` + 보조 `--text-2`). 3세그 컨트롤: 트랙 `--bg-input`, `border --border`, radius 8px, padding 4px, gap 4px. 각 세그 `flex:1`, padding `7px 3px`, radius 6px, 세로 스택 = canonical 값(mono 10px/600) + 한국어 라벨(9.5px). 선택 시 `bg tone-dim / border tone / 텍스트 tone`. 아래에 선택값 설명 한 줄(11px `--text-2`, 좌측 `2px solid tone색` 보더, padding-left 9px).
4. **Approval 세그먼트**: 소제목 `APPROVAL · 승인 시점`. 구조는 Sandbox와 동일.
5. **정책 readout + 위험도** (padding `10px 12px`, `bg --bg-1`, `border --border-subtle`, radius 9px): 좌측 mono 11px `sandbox=<v> approval=<v> guardian=<on|off>` (키 `--text-3`, 값 = tone색/`--accent`/`--text-2`). 우측 위험도 미터(4칸, 16×5px, gap 2px) + 라벨(11px/700 level색).
6. **경고 배너** (조건부, 위 규칙): flex, padding `10px 12px`, `bg warnDim`, `border 1px solid warnCol`, radius 9px. 경고 삼각형 아이콘 + 제목(mono 11.5px/700 warnCol) + 본문(11px `--text-1`). CTA 버튼(조건부): height 26px, `bg --accent`, 텍스트 흰색, "guardian 켜기".
7. **Guardian 행** (padding `11px 13px`, `bg --bg-1`, `border = on? --accent-bd : --border`, radius 9px): 방패+체크 아이콘(on `--accent` / off `--text-3`) + `guardian`(mono 12px/700) + 상태 `on`/`off`(mono 10px) + 설명(10.5px `--text-2`) + 우측 토글 스위치. 스위치: 38×21px, radius 999px, 트랙 `on --accent / off --bg-4`, 노브 17×17 흰색 원 `translateX(0 → 17px)`, transition 0.16s.
   - 설명 off: "approval 요청이 사용자에게 직행."
   - 설명 on: "reviewer 서브에이전트가 approval을 선심사 — 안전 통과 / 위험 차단(1회 override)."
8. **풋터** (조건부: 기본값이 아닐 때): 우측 정렬 `reset → Auto` 버튼(outline, mono 10.5px). 클릭 시 기본 상태로 복귀.

> 기본값 판정: `sandbox==='workspace-write' && approval==='on-request' && !guardian`.

### 2) Approval 카드
**Purpose**: 승인이 필요한 순간 멤버 transcript에 뜨는 결정 카드.

**요청 종류 스위처** (프로토타입 데모용 — 실제 앱에서는 들어오는 요청이 종류를 결정): 6개 mono 칩 — `command +rule`, `command`, `fileChange`, `permissions`, `userInput`, `elicitation`. 선택 칩 `bg --accent-dim / border --accent-bd / 텍스트 --accent`.

**카드 컨테이너**: 멤버 색(예 backend `#5b8cff`) 액센트. `border:1px solid rgba(91,140,255,.42)`, radius 11px, `bg --bg-2`, `box-shadow:0 0 0 3px rgba(91,140,255,.1)`.

위→아래:
1. **Guardian 스트립** (상단, `border-bottom --border-subtle`): 방패 아이콘 + mono 10px 텍스트.
   - guardian ON: "guardian: 선심사 통과 (safe)" (색 `--success`, bg `--success-dim`)
   - guardian OFF: "guardian: off — 직행" (색 `--text-2`, bg `--bg-3`)
2. **헤더**: 멤버색 방패 배지(20×20, radius 5px, `bg rgba(mc,.14)`) + "Approval required"(12.5px/700) + 우측 요청종류 칩(mono 10px, `--accent`, `bg --accent-dim`, radius 5px).
3. **설명**(12px `--text-1`) — 종류별 문구 (아래 데이터 참조).
4. **디테일 영역** (종류별):
   - `command`: `<pre>$ <cmd></pre>` (`bg --bg-0`, mono 11.5px) + `cwd <path>`(mono 10px `--text-3`).
   - `fileChange`: 파일 경로 헤더 + diff 블록. 삭제줄 `--danger` on `--danger-dim`, 추가줄 `--success` on `--success-dim`, 컨텍스트 `--text-3`. mono 11.5px.
   - `permissions`: 행 2개(`network → api.stripe.com`, `write · outside workspace → /etc/hosts`), 각 `bg --bg-0` border 카드 + `--live` 아이콘.
   - `userInput` / `elicitation`: 라벨(mono 10px) + 비활성 입력 박스("value…").
5. **버튼 행** (결정 전): mono 11.5px/600 버튼들. `decline`은 좌측(`margin-right:auto`로 분리), 나머지는 우측 그룹.
6. **결정 후 상태**: 버튼 자리에 결과 배지(체크/X 아이콘 + 결정 이름 mono) + `undo` 버튼. `always`면 "rule saved → auto-approve" 부가 라인.

**버튼 스타일**:
| key | 라벨 | bg | 텍스트 | border |
|---|---|---|---|---|
| `decline` | decline | transparent | `--danger` | `--border` |
| `once` | once | `#5b8cff`(멤버색) | `#fff` | 멤버색 |
| `session` | session | transparent | `--text-1` | `--border` |
| `always` | always | `rgba(91,140,255,.12)` | 멤버색 | `rgba(91,140,255,.42)` |

**종류별 제공 버튼 (반드시 이 규칙대로)**:
| 요청 종류 | 버튼 |
|---|---|
| `command` (규칙 제안 있음) | decline / once / session / always |
| `command` (규칙 없음), `fileChange`, `permissions`, `elicitation` | decline / once / session |
| `userInput` | decline / once |

**결정 의미**:
- `once`: 이 요청만 허용.
- `session`: 세션 동안 다시 안 물음.
- `always`: 같은 명령 패턴을 영구 규칙으로 저장 → 이후 자동 승인. **`command`(규칙 제안 있음)에서만 제공.**
- `decline`: 거부.

### 3) (보조) 9-조합 리스크 맵
개발자/데모용 참고 뷰. approval(행) × sandbox(열) 3×3 그리드. 각 셀은 위험도 색으로 tint, 명명 프리셋 셀은 `RO`/`Auto`/`Full` 태그 표시, 현재 선택 셀은 solid 하이라이트. 셀 클릭 시 해당 조합으로 점프. 실제 앱 UI엔 필수 아님 — 팝오버에 넣어도, 뺴도 됩니다.

---

## 요청 종류별 데이터 (프로토타입 샘플)
```
command +rule : desc "auth 스위트 실행 — 만료 토큰이 401 반환하는지 확인."
                cmd  "npm test -- auth/refresh.spec.ts"  cwd "~/refactor-auth"  (rule 제안 O)
command       : desc "dist 캐시 삭제 후 재빌드."
                cmd  "rm -rf ./dist && npm run build"    cwd "~/refactor-auth"  (rule 제안 X)
fileChange    : desc "refresh.ts catch 블록 축소 — 만료 토큰만 처리, 나머지 rethrow." (diff)
permissions   : desc "샌드박스 밖 자원 접근 위한 권한 상승."  (network + external write)
userInput     : desc "도구가 값을 요청."          inputLabel "deploy target env"
elicitation   : desc "MCP 서버(github) 입력 요청."  inputLabel "repo (owner/name)"
```

---

## Interactions & Behavior
- **프리셋 클릭** → `sandbox`·`approval` 동시 세팅. 프리셋과 어긋나면 자동으로 Custom.
- **세그먼트 클릭** → 해당 축 값 변경. 정책 readout·위험도·경고·pill 라벨 실시간 갱신.
- **guardian 토글** → on/off. 경고 CTA로도 켤 수 있음.
- **reset → Auto** → 기본 상태 복귀(기본값 아닐 때만 노출).
- **요청종류 칩 클릭** → 카드 디테일·버튼 세트 교체, 진행 중이던 결정 초기화.
- **결정 버튼 클릭** → 결정 확정 상태로 전환(버튼 → 결과 배지 + undo).
- **undo** → 결정 취소, 버튼 재노출.
- transition: 배경/보더 색 변화 0.12s, 토글 0.16s, 팝오버 등장 0.18s.
- **적용 시점**: "변경은 다음 동작부터 적용" — 즉시 stage되어 다음 요청부터 반영. 세션 재시작 불필요(모델 변경과 달리).

## State Management
UI가 읽고 쓰는 상태:
```ts
type Sandbox  = 'read-only' | 'workspace-write' | 'danger-full-access';
type Approval = 'untrusted' | 'on-request' | 'never';

interface CodexPolicy {          // 멤버별 저장 대상
  sandbox: Sandbox;              // default 'workspace-write'
  approval: Approval;            // default 'on-request'
  guardian: boolean;             // default false
}

// 파생(저장 안 함): activePreset(policy) → 'read-only'|'auto'|'full'|null(custom)
//                   risk(policy) → { sum, level, color, label }

// 승인 카드 상태(요청마다):
interface ApprovalRequest {
  type: 'command'|'fileChange'|'permissions'|'userInput'|'elicitation';
  ruleSuggested?: boolean;       // command에서만 의미
  // + 종류별 payload(cmd/cwd, diff, resources, inputLabel …)
}
type Decision = 'once' | 'session' | 'always' | 'decline';
```
- 정책은 멤버별로 영속화(persist). 프리셋/위험도는 정책에서 파생 계산.
- 승인 결정 `always`는 규칙 저장소(멤버 or 세션 스코프)에 명령 패턴으로 기록.

## Design Tokens
CSS custom properties. 두 테마, `data-theme`로 전환(기본 다크).

### Dark (default)
```
--bg-0:#0a0b0e  --bg-1:#0e1014  --bg-2:#14171d  --bg-3:#1b1f27  --bg-4:#222731
--bg-input:#0c0e12
--border-subtle:#1c2028  --border:#262b35  --border-strong:#333a46
--text-0:#e7e9ee  --text-1:#aeb4c0  --text-2:#79808d  --text-3:#535965
--accent:#5b8cff  --accent-dim:rgba(91,140,255,.13)  --accent-bd:rgba(91,140,255,.32)  --accent-fg:#fff
--live:#e0a14e    --live-dim:rgba(224,161,78,.13)
--success:#54b585 --success-dim:rgba(84,181,133,.13)
--danger:#e0635d  --danger-dim:rgba(224,99,93,.13)
```
### Light
```
--bg-0:#e7e8eb  --bg-1:#f3f4f6  --bg-2:#ffffff  --bg-3:#eef0f3  --bg-4:#e6e9ed
--bg-input:#ffffff
--border-subtle:#e2e5ea  --border:#d3d7df  --border-strong:#c0c5ce
--text-0:#171a1f  --text-1:#454b56  --text-2:#6c7480  --text-3:#9aa1ac
--accent:#3f6fe6  --accent-dim:rgba(63,111,230,.1)  --accent-bd:rgba(63,111,230,.28)
--live:#b9791d    --live-dim:rgba(185,121,29,.1)
--success:#2f8f5e --success-dim:rgba(47,143,94,.1)
--danger:#cf4b45  --danger-dim:rgba(207,75,69,.1)
```
멤버 채널 색(고정): backend `#5b8cff` · frontend `#a07bff` · reviewer `#54b585` · tester `#e0a14e` · db-migrate `#3ac6d6` · docs `#e06b9c`. 승인 카드/멤버 강조는 해당 멤버 색을 사용. 멤버색 tint는 `rgba(r,g,b,a)`로 생성.

### Typography
- Sans: **Geist**. Mono: **Geist Mono** (canonical 값·경로·명령·상태·시각에 사용).
- 팝오버 기준 크기: 제목 13px/700, 세그 값 mono 10px/600, 라벨 9.5px, readout mono 11px, 설명 10.5~11px, uppercase 소제목 10px/700 letter-spacing .5px.
- **Electron: Geist/Geist Mono를 로컬 @font-face로 번들**(오프라인). 프로토타입의 Google Fonts `<link>`는 제거.

### Radii / shadow
팝오버 13px · 카드 11px · 프리셋/필드 6~9px · pill 7px · 배지 5px. 팝오버 그림자 `0 24px 60px -20px rgba(0,0,0,.6)`.

## Assets
- 래스터 없음. 모든 아이콘 **inline SVG**(stroke 기반, 1.7~1.9): 방패(shield), 방패+체크(guardian), 경고 삼각형, 라이트닝, stop(사각형), 체크, X, 네트워크(globe), 폴더, 새로고침(reset), 달(테마). 앱의 아이콘 라이브러리 동등 아이콘으로 대체 가능.
- 폰트: Geist, Geist Mono.

## Files
- `Codex Permissions.dc.html` — **주 레퍼런스 (전문가/개발자용, 밀도 높은 최종본).** 라이트닝 pill + Permissions 팝오버 + Approval 카드 + 9-조합 리스크 맵. 우상단 테마 토글.
- `Codex Permissions (guided).dc.html` — 초심자 친화 버전(더 긴 설명·평이한 카피). 톤 비교/대안 참고용.
- `support.js` — 프로토타입 런타임. `.dc.html`을 브라우저에서 열 때만 필요. **이식 금지.**

브라우저에서 `Codex Permissions.dc.html`을 열면 인터랙션을 그대로 확인할 수 있습니다.
