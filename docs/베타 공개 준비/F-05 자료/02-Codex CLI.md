# 02 — Codex CLI 0.145.0

원본 캡처: `codex-cli-slash.txt` · `codex-cli-at.txt` · `codex-cli-at-filter-doc.txt`

## 핵심 — 트리거를 둘로 쪼갠다

**`/` 에는 built-in 명령만 있다. 스킬·플러그인은 `@` 로 간다.**
`/skills` 를 실행하면 Codex 가 직접 안내한다:

```
  Skills
  Choose an action
› 1. List skills            Tip: press @ to open this list directly.
  2. Enable/Disable Skills  Enable or disable skills.
```

> Codex 가 "많은 항목" 문제를 푸는 **1차 수단은 네임스페이스 분리**다.
> 한 목록에 다 넣지 않는다. 그래서 어느 목록도 60개가 되지 않는다.

우리 앱의 Codex 멤버 팔레트는 60행(built-in 9 · skill 41 · plugin 8 · AgentParty 2)을
**한 목록에 합쳐서** 보여준다. 원본은 그러지 않는다.

---

## 표면 1 — `/` (명령)

```
› /

  /model                 choose what model and reasoning effort to use
  /fast                  1.5x speed, increased usage
  /ide                   include current selection, open files, and other
                         context from your IDE
  /permissions           choose what Codex is allowed to do
  /keymap                remap TUI shortcuts
  /vim                   toggle Vim mode for the composer
  /sandbox-add-read-dir  let sandbox read a directory: /sandbox-add-read-dir
                         <absolute_path>
  /experimental          toggle experimental features
```

### 행 구성

- `/이름` **21열 고정** + 설명
- 설명이 길면 이름 열만큼 **들여쓰기해 다음 줄로** 접힌다
- **출처 배지 없음 · 그룹 헤더 없음 · 아이콘 없음** (built-in 만 있으니 필요가 없다)
- `/sandbox-add-read-dir` 의 설명이 `let sandbox read a directory: /sandbox-add-read-dir
  <absolute_path>` — **인자 형식을 설명 문장 안에 적어 둔다.** 별도 인자 필드가 아니다
- 한 번에 **8행** 표시, ↑↓ 로 스크롤

### 정렬

알파벳순이 **아니다.** 고정 큐레이션 순서:

```
model · fast · ide · permissions · keymap · vim · sandbox-add-read-dir · experimental ·
approve · memories · skills · import · hooks · … · resume · fork · app · init · compact ·
plan · goal · agent · … · status · usage · title · statusline · theme · pets · mcp · plugins
```

자주 쓰는 것(`model`·`fast`·`permissions`)이 앞, 관리성(`theme`·`pets`·`mcp`·`plugins`)이 뒤.

### 매칭 — 엄격하다

| 입력 | 결과 | 뜻 |
|---|---|---|
| `/model` | `/model` 1행 | 이름 일치 |
| `/reasoning` | 팝업 사라짐 (0행) | `/model` 설명에 "reasoning" 이 있는데도 안 걸림 → **설명 미검색** |
| `/srd` | `no matches` | `sandbox-add-read-dir` 의 부분수열인데 안 걸림 → **퍼지 아님** |

---

## 표면 2 — `@` (스킬·플러그인·파일) ⭐

**여기가 "많은 항목 중 고르기"의 진짜 레퍼런스다.**

```
› @
> Browser            Control the in-app browser with ChatGPT              Plugin
  Default templates  Default templates for documents, spreadsheets, and…  Plugin
  Documents          Create and edit document artifacts                   Plugin
  PDF                Read, create, and verify PDF files                   Plugin
  Presentations      Create and edit presentations                        Plugin
  Spreadsheets       Create and edit spreadsheet files                    Plugin
  Template Creator   Create or update templates for documents, spreadsh…  Plugin
  claude-party       local-claude-party                                   Plugin

  enter insert · esc close · ←/→ [All Results]   Filesystem Only    Plugins
```

### 거르는 수단 세 가지

1. **범위 탭** — 하단에 `[All Results] / Filesystem Only / Plugins`, **←/→ 로 전환**
2. **우측 정렬 타입 배지** — `Plugin` · `Skill` · `File` · `Dir`
3. **타이핑 필터**

### 행 구성 — 3열 고정

| 열 | 내용 |
|---|---|
| 1 | 이름. 출처가 있으면 괄호로 붙인다 — `party-doctor (claude-party)` |
| 2 | **문맥에 따라 값이 바뀐다** — 스킬·플러그인이면 *설명*, 파일·디렉터리면 *경로*. 넘치면 `…` |
| 3 | 타입 배지 (우측 정렬) |

하단에 **항상 키 힌트 줄**이 있다: `enter insert · esc close · ←/→ <탭들>`
한 번에 8행, 스크롤.

### 매칭 — 퍼지다 (`/` 와 다르다)

```
› @doc
> party-doctor (claude-party)  Run Claude Party environment diagnostics…  Skill
  docs                         ./                                         Dir
  API.md                       docs\                                      File
  mockups                      docs\                                      Dir
  기획 노트.md                  docs\                                     File
```

```
› @xlsx
> build_benchmark_xlsx.py              scripts\                           File
  CodexPermissionControl.tsx           src\renderer\workbench\            File
  02-approvals-sandbox-permissions.md  docs\codex-ux-research\            File
```

`CodexPermissionControl.tsx` 가 `xlsx` 로 걸린다 — Code**x** … Contro**l** … **s** … .t**sx**.
**부분수열(퍼지) 매칭**이다. 파일은 경로까지 매칭 대상.

**랭킹은 스킬·플러그인이 파일보다 위.** `@doc` 에서 Skill 이 1위, 그다음 Dir/File.

> ⚠️ **한 제품 안에서도 표면마다 매칭 규칙이 다르다.**
> `/`(명령) = 접두·엄격 — 오타로 엉뚱한 명령을 실행하면 안 되니까.
> `@`(자산) = 퍼지 — 이름을 정확히 모르는 것을 찾는 자리니까.
> **규칙이 표면의 목적을 따라간다.**

## 기타 관측

- `/plugins` = `browse plugins` — **플러그인은 별도 브라우저**가 또 있다(F-07 관련)
- `/skills` = 목록 보기 / **켜고 끄기** 두 갈래. 즉 스킬 on/off 가 존재한다
- 부팅 화면이 `Tip: Use /skills to list available skills or ask Codex to use one.` 로
  스킬 입구를 안내한다
