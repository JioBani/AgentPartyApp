# 03 — Claude Code CLI 2.1.226

원본 캡처: `claude-cli-slash.txt` · `claude-cli-filter-review.txt`

## 핵심 — 한 목록에 다 넣고, 설명을 인라인으로 보여준다

Codex 와 정반대다. built-in · 스킬 · 플러그인 명령이 `/` **한 목록**에 섞인다.
대신 **행마다 설명을 인라인으로** 붙여서, 목록이 길어도 각 행이 무엇인지는 알 수 있게 했다.

```
/deep-research          [dynamic workflow] Deep research harness —
                                           fan-out web searches, fe…
/codex:rescue           (codex) Delegate investigation, an explicit
                        fix request, or follow-up rescue work to th…
/code-review (review)   Review the current diff, or a PR
                        number/branch/path target, for correctness …
/model                  Set the AI model for Claude Code (currently
                        Opus 5 (1M context))
/bug                    Report a bug or share your conversation
/cd                     Move this session to a new working directory
/chrome                 Open Claude in Chrome settings
/clear                  Start a new session with empty context;
                        previous session stays on disk (resumable w…)
```

## 행 구성

- `/이름` **32열 고정** + 설명
- **별칭을 이름 옆 괄호로** — `/code-review (review)`
- **출처·종류를 설명 앞 태그로** 붙인다:
  - `[dynamic workflow]` — 종류를 **대괄호**로
  - `(codex)` · `(claude-party)` — 플러그인명을 **소괄호**로
  - built-in 은 태그 없음
- **설명에 현재 상태를 넣는다** — `/model` → `Set the AI model for Claude Code
  (currently Opus 5 (1M context))`. 값을 보려고 열 필요가 없다
- 설명은 2줄까지 접히고 `…` 로 잘린다
- **배지·아이콘·별도 열 없음. 전부 텍스트 한 줄.**

> 출처를 **별도 열이나 배지로 빼지 않고 설명 문장 앞에 태그로 붙였다.**
> 좁은 폭에서 열을 늘리지 않으려는 선택으로 보인다(추정).

## 정렬

알파벳순으로 관측됐다 — `/bug · /cd · /chrome · /clear …`
(VS Code 확장에서 104개 전체가 알파벳순인 것이 확인됐다 → [04 문서](04-Claude%20Code%20VS%20Code%20확장.md))

## 매칭 — 이름만, 부분 일치, 퍼지 아님

| 입력 | 결과 | 뜻 |
|---|---|---|
| `/model` | `/model` | 이름 일치 |
| `/review` | `/code-review (review)` | **부분 일치는 된다** — 접두만이 아니다 |
| `/reasoning` | `No commands match "/reasoning"` | 설명에 "reasoning" 이 있어도 안 걸림 → **설명 미검색** |
| `/cdrv` | `No commands match "/cdrv"` | `code-review` 부분수열인데 안 걸림 → **퍼지 아님** |

**빈 결과를 명시적으로 알린다** — `No commands match "/reasoning"`.
Codex `/` 도 같다(`no matches`). 조용히 사라지지 않는다.

## 확정하지 못한 것

**터미널이 80x25 로 고정**돼 팝업이 2~4행만 보였다([01-측정 방법](01-측정%20방법.md) 참조).
그래서 다음은 CLI 에서 확정하지 못했다:

- 한 번에 보이는 최대 행 수
- 필터가 걸린 상태에서 매칭되지 않는 행이 1개 더 보이는 프레임이 두 번 관측됐다
  (`/model` 에 `/loop`, `/review` 에 `/claude-party:party-send`).
  **중간 렌더 프레임일 가능성이 높아 단정하지 않는다.**
  참고로 VS Code 확장은 설명까지 검색하므로 같은 현상이 거기서는 정상 동작이다

이 수치들은 DOM 으로 측정 가능한 VS Code 확장에서 확정했다.
