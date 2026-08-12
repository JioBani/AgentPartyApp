# 04 — Claude Code VS Code 확장 2.1.220 ⭐

**웹뷰 = DOM 이라 우리 Electron 앱과 가장 조건이 같다.** 수치는 전부 computed style 실측.
캡처: `claude-vscode-palette.png`

---

## 핵심 1 — 팔레트가 슬래시 명령 전용이 아니다

`/` 를 치면 뜨는 팝업 **하나**에 섹션 6개, 총 **133행**이 들어 있다.

```
## Context         Attach file… · Mention file from this project… ·
                   Clear conversation · Rewind
## Model           Switch model… (Opus (1M context)) · Effort (High) · Thinking ·
                   Switch models when a message is flagged · Account & usage… ·
                   Toggle fast mode
## Customize       Output styles · Agents · Hooks · Memory · Permissions ·
                   MCP servers · Manage plugins · Open Claude in Terminal
## Slash Commands  /__remote-workflow · /agents · /artifact-capabilities · …
                   (104개, 알파벳순)
## Settings        Switch account · General config… ·
                   Enable Remote Control for all sessions
## Support         View help docs · Report a problem · v2.1.220
```

> **F-05 가 묶으려는 [P-2]·[P-10]·[P-11]·[P-20] 이 그대로 이 구조에 들어간다.**
> `Model` 섹션 = P-2(모델 카탈로그) + P-20(하네스·모델 빠르게 고르기).
> `Customize` 섹션 = F-07(플러그인 관리) · 권한 UI 의 입구.
> **우리가 고안할 구조가 아니라 베낄 구조다.**

명령이 아닌 **액션**(`Attach file…`)과 명령(`/model`)이 **한 목록에 섞여 있다.**
사용자가 "무엇을 하고 싶다"로 접근하면 그게 명령인지 설정인지 구분할 필요가 없다.

---

## 핵심 2 — 행에 설명을 그리지 않는다

```html
<div class="commandItem_G_S7FQ"
     title="Run the workflow script delivered in this session environment…">
  <div class="commandContent_G_S7FQ">
    <span class="commandLabel_G_S7FQ">/__remote-workflow</span>
  </div>
</div>
```

- **설명 전용 엘리먼트가 DOM 에 아예 없다** (`querySelector('[class*=Description]')` → null)
- 설명은 **`title` 툴팁**뿐이다
- **폭 1272px 넓은 패널에서도 그렇다** → 좁아서 생략한 게 아니라 **설계 결정**이다
- 현재값만 라벨 옆 괄호에 흐린 색으로 — `Effort (High)` · `Switch model… (Opus (1M context))`

> ⚠️ **같은 제품이 CLI 와 정반대로 판단했다.** CLI 는 설명을 인라인으로 다 보여준다.
> "Claude 처럼"에는 정답이 하나가 아니다.

---

## 치수 — computed style 실측

| 대상 | 값 |
|---|---|
| `menuPopup` | `position:absolute` · **max-height 470px** · bg `rgb(32,33,34)` · border `1px solid rgb(42,43,44)` |
| `commandList` | `overflow-y:auto` · **max-height 300px** · scrollHeight **3738** |
| `commandItem` | height **27px** · padding `4px 8px` · `display:flex` · gap 8px |
| `commandLabel` | **13px** / weight 400 / `rgb(237,237,237)` |
| `sectionHeader` | **11.7px** / weight 400 / `rgb(191,191,191)` / padding `4px 12px` / **대문자화 없음** |
| 선택 행 | bg `rgba(255,255,255,0.13)` · radius **4px** |

### 읽어낼 것

- 300 ÷ 27 = **한 번에 약 11행**. 나머지는 스크롤
- **결과 개수 상한이 없다** — `/c` 입력 시 **126행**을 전부 렌더한다. 잘라내지 않는다
- 팝업 자체는 470px 까지 가능한데 목록은 300px 로 더 조인다 →
  **입력창을 가리지 않으려는 여유**로 보인다(추정)
- 섹션 헤더는 **대문자화하지 않고 흐린 색·작은 글자**로만 구분한다
- 선택 표시는 테두리가 아니라 **은은한 흰색 오버레이 13% + radius 4px**

---

## 매칭 규칙 — CLI 와 다르다

| 입력 | 결과 |
|---|---|
| `/review` | 7행: `/review` → `/code-review` → `/ultrareview` → `/codex:review` → `/security-review` → `/codex:adversarial-review` → **`/simplify`** |
| `/set` | 10행: `/config` `/codex:setup` `/clear` `/effort` `/model` `/color` `/goal` `Hooks` `Permissions` `Effort(High)` |
| `/cdrv` | **0행** |
| `/c` | **126행** (상한 없음) |

### 확정된 것

- **설명까지 검색한다.** `/simplify` 는 이름에 `review` 가 없다. 설명이
  `Review the changed code for reuse, simplification, efficiency…` 다
- **설명 매칭은 부분 문자열이다.** `/set` 결과 대부분이 이름에 `set` 이 없고
  설명이 `Set …` 으로 시작하거나 `settings` 를 포함한다
- **퍼지(부분수열) 아님.** `/cdrv` → 0행
- **순서**: 완전 일치 → 이름 일치 → 설명 일치. 이름 일치들 사이에서는
  짧은 이름이 앞으로 보인다(`code-review` 11자 → `codex:adversarial-review` 24자)
- **섹션 구분은 필터 중에도 유지된다**
- 결과가 명령이 아닌 액션(`Hooks`·`Permissions`·`Effort(High)`)도 함께 걸린다

### 미해결 (2차적)

`/review` 에서 설명에 `review` 를 가진 항목이 더 있는데 7행만 나왔다.
설명 일치의 정확한 점수식·임계값은 확정하지 못했다. 설계에 영향이 작아 더 파지 않았다.

---

## 조작

- ↑↓ 이동 · Enter 선택 · Esc 닫기 (네 표면 공통)
- 첫 행이 기본 선택 상태(`activeCommandItem`)로 뜬다
- 검색 입력이 **별도 필드가 아니다.** 컴포저에 이어서 친 글자가 그대로 필터가 된다
