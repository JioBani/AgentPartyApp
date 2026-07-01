# 승인 · 샌드박스 · 권한 모델 상세

출처: https://developers.openai.com/codex/agent-approvals-security ,
/codex/concepts/sandboxing ; 로컬 `codex --help`, `codex features list` ;
`src/core/codexAdapter.ts`. 검증일 2026-07-01.

## 한 줄 정의

Codex의 안전 모델은 **직교하는 두 축**이다:
- **샌드박스 모드** = Codex가 *기술적으로 할 수 있는* 것(무엇을 만질 수 있나).
- **승인 정책** = Codex가 *언제 멈춰 사람에게 물어보나*.

이 둘의 조합을 사용자에게는 **Read Only / Auto / Full Access** 3프리셋으로 노출.
Claude Code의 단일 permission mode(default/acceptEdits/plan/…)와 달리 **2축**이라
매핑에 주의가 필요하다.

## 샌드박스 모드 (`-s/--sandbox`, config `sandbox_mode`)

- `read-only` — 워크스페이스 파일 읽기 + 응답만. 편집/명령/네트워크는 승인.
- `workspace-write` — 워크스페이스 내 읽기+쓰기 + 일상 명령 자동. 워크스페이스
  **밖** 쓰기나 네트워크는 승인.
- `danger-full-access` — 샌드박스 제거(전체 파일시스템+네트워크). "권장 안 함".

## 승인 정책 (`-a/--ask-for-approval`, config `approval_policy`)

- `untrusted` — known-safe read만 자동, 변경/파괴적 명령(파괴적 git 등)은 물음.
- `on-request` — 기본. Codex가 상승이 필요할 때 물음.
- `never` — 절대 안 물음(제한적 샌드박스와 함께 써야 안전).
- **granular**(객체 형태) — 카테고리별 fail-closed. 예:
  `approval_policy = { granular = { sandbox_approval = true, rules = false } }`.

관련: `approvals_reviewer = "user" | "auto_review"`(승인 심사 주체, 기본 user).
`default_permissions`(named profile `:read-only`/`:workspace`/`:danger-full-access`)
는 `sandbox_mode`와 **상호배타** — GUI에서 둘을 동시에 노출하면 안 됨.

## 사용자 프리셋 (composer/`/permissions`)

- **Read Only** — read + 응답만. 그 외 물음.
- **Auto**(기본) — `workspace-write` + `on-request`. 프로젝트 내 편집 자동,
  밖/네트워크 프롬프트.
- **Full Access** — `danger-full-access`. 샌드박스·프롬프트 모두 off. "caution".

## 승인 프롬프트의 모습

- **명령 승인**: 실행할 명령(+이유/cwd) + 선택지. 확인된 문구(커뮤니티/GitHub
  출처, verbatim 아님): `Yes`(1회) / `Yes, and don't ask again this session` /
  `No`. **Smart Approvals**(v0.120+)는 프리픽스 매칭 시 3번째 "yes" =
  `prefix_rule()`을 `~/.codex/rules/default.rules`에 기록해 영구 자동승인. 승인
  피로 억제의 핵심.
- **파일변경/패치 승인**: 적용 전 파일별 컬러 diff → accept/decline. workspace-
  write에서 프로젝트 내 편집은 자동(사후 `/diff`).
- **request-user-input**(0.141+): 자동 해소 카운트다운. 사용자 상호작용 시 정지.

## Guardian / auto-review

`approvals_reviewer = "auto_review"`(informal명 guardian_approval, stable).
승인 요청을 reviewer 서브에이전트에 라우팅 → 데이터 유출/자격증명 탐침/파괴적
행위 위험 심사 후 진행. 사람 개입 빈도 감소. 거부 시 `/approve`로 1회 override.

프로토콜:
- notification: `item/autoApprovalReview/started`, `.../completed`,
  `guardianWarning`, `item/guardianApprovalReview*`.
- request: `thread/approveGuardianDeniedAction`(거부된 액션 승인).

## Windows 샌드박스 (이 프로젝트 관련)

- config `[windows] sandbox = "unelevated"|"elevated"`,
  `sandbox_private_desktop`(기본 true, private desktop에서 실행).
- 현재 로컬 config.toml: `[windows] sandbox = "elevated"`.
- 프로토콜: `windowsSandbox/readiness`, `windowsSandbox/setupStart`,
  notification `windowsSandbox/setupCompleted`, `windows/worldWritableWarning`.
- **알려진 버그**: Windows 샌드박스 ACL drift(openai/codex#9062). 사용자
  글로벌 지침에 `/codex-fix-sandbox` 복구 절차가 있음(`FAILED read-only sandbox`
  또는 rollout이 `--write`에도 read-only일 때). GUI는 샌드박스 상태를 숨기지
  말고 표시하고 복구 경로를 안내해야 한다.

## 프로토콜 승인 request 매핑 (하네스)

서버가 request로 밀고, 클라가 `result`로 응답:

| 서버 request 메서드 | 응답 형태 |
|---|---|
| `execCommandApproval` | `{ decision: "approved" \| "denied" }` |
| `applyPatchApproval` | `{ decision: "approved" \| "denied" }` |
| `item/commandExecution/requestApproval` | `{ decision: "accept" \| "decline" }` |
| `item/fileChange/requestApproval` | `{ decision: "accept" \| "decline" }` |
| `item/permissions/requestApproval` | 권한 상승(네트워크/외부경로) — 미구현(P1) |
| `item/tool/requestUserInput` | 사용자 값 입력 — 미구현(P1) |
| `mcpServer/elicitation/request` | MCP elicitation — 미구현(P1) |

현재 `codexAdapter.ts`의 `approvalDecision()`이 앞 4개를 매핑. 뒤 3개는 미처리.

## AgentParty permission mode 매핑

현재 어댑터(`sandboxModeFor`/`approvalPolicyFor`):

| AgentParty mode | approvalPolicy | sandbox_mode |
|---|---|---|
| default / plan | on-request | read-only |
| acceptEdits / auto | on-request | workspace-write |
| bypassPermissions / dontAsk | never | danger-full-access |

문제/개선점(→ `05` backlog):
- Claude Code의 단일 mode를 2축에 억지로 눌러담아, **Codex의 Read Only/Auto/
  Full Access 프리셋과 사용자 표현이 어긋난다.** Codex member는 2축(샌드박스 ×
  승인) 또는 3프리셋을 직접 노출하는 것이 정확하다.
- guardian(auto_review) 옵션이 UI에 없다 — `approvalsReviewer`가 하드코딩
  `"user"`. auto_review 토글 추가 필요.
- `plan` mode를 read-only에 매핑하지만 Codex에는 별도 `/plan`(plan 모드)가 있어
  개념 충돌. Codex member의 "plan"은 sandbox가 아니라 plan 기능으로 보는 게 맞다.
- `setPermissionMode`가 로컬 상태만 바꾸고 다음 turn 파라미터에만 반영 — 실행 중
  전환 시 명확한 status 이벤트/재확인 필요.

## AgentParty 시사점

- Codex member의 Runtime/permission UI는 **2축 컨트롤**(무엇을 할 수 있나 ×
  얼마나 자주 묻나) + **guardian 토글**로 설계. 3프리셋 shortcut 제공.
- 승인 카드: 정확한 명령/diff + `once / for-session / rule(prefix) / decline` +
  guardian이 심사한 경우 그 사실 표시 + request-user-input 카운트다운.
- 샌드박스 상태(특히 Windows elevated/ACL 이슈)를 member header에 표시.
- blocked(승인 대기) member를 sidebar badge / global "Needs input" inbox로.
</content>
