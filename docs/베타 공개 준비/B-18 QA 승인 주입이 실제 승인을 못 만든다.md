# B-18. QA 승인 주입이 실제 승인 상황을 만들지 못한다

**판정: 차단 (검증 수단 결함)** · 출처: [B-13](B-13%20권한%20승인%20UI%20QA.md) QA 중 발견 (2026-08-08)
**소유자: `approval-capture`** · 작업 브랜치 `qa/b18-approval-capture` (워크트리 `C:\Project\AgentPartyApp-b18`)
**방침 확정 (사용자, 2026-08-08): ⓐ 노가다 — 세 하네스의 승인 카드 모양을 전수 실측하고 그 실값으로 목업을 만든다.**

---

## 진행 상황 요약 (다음 사람이 여기부터 읽으면 된다)

| 단계 | 상태 |
|---|---|
| 워크트리 + 툴체인 | ✅ `C:\Project\AgentPartyApp-b18`, `node_modules` 심링크(재설치 안 함), `npm run build` 통과 |
| 코드 경로 지도 | ✅ 아래 §2 |
| **Codex 프로토콜 계약 실측** | ✅ **완료. 결함 8건 확정** — §3 |
| **Claude Code 계약 실측** | ✅ **완료. 결함 4건 확정** — §3b |
| Cursor 계약 실측 | ⬜ 미착수 (코드상 승인 요청 자체가 없음 — §4) |
| **Codex 실트래픽 녹화(fixture 8종)** | ✅ **완료** — §3c · `scripts/fixtures/approvals/` |
| **Claude Code 실트래픽 녹화(fixture 6종)** | ✅ **완료** — §3d |
| Cursor 실트래픽 녹화 | ⬜ 미착수 |
| **`QaInteractionInput` 확장 (승인 주입)** | ✅ **완료** — §7 |
| **제품 결함 수정 9건** | ✅ **완료** — §6 |
| **수동 e2e (실제 호출)** | ⬜ **미착수 — 다음 사람이 여기부터** §8 |

**브랜치**: `qa/b18-approval-capture` · 커밋 5개 · 재생 검증 `npm run test:approval-shapes` (14종 통과)

### 🔴 가장 중요한 것 — **Codex 승인 카드는 애초에 뜨지도 않았다**

결함이 **두 개 겹쳐 있었고, 둘 다 있어야 승인이 동작한다.** 원인은 같다 —
**app-server 는 요청 번호를 0부터 매기는데 `id: 0` 은 falsy 다.**

**① 라우팅에서 통째로 버려졌다 (더 근본)**
`readMessage` 가 `if (message.id && message.method)` 로 걸러서 **`id: 0` 인 요청이
알림 처리 경로로 흘러 사라졌다.** 그게 세션의 **첫 서버 요청 = 승인 프롬프트**다.
→ `approval_request` 이벤트가 안 나가서 **카드가 안 뜨고**, 응답도 안 보내서 **턴이 영원히 멈춘다.**

실측(수정 전): Codex 가 `item/commandExecution/requestApproval`(`id: 0`)을 보냄 →
어댑터 원본 로그에는 `in` 으로 찍히는데 **아무 일도 안 일어남** → 명령이 `started` 인 채로 턴이 안 끝남.

**② 응답 id 를 문자열로 보냈다**
`String(message.id)` 한 값을 그대로 회신해서 서버가 `"0"` 을 `0` 과 매칭하지 못한다.

| 응답 id | 결과 | 녹화본 |
|---|---|---|
| `0` (원본 유지) | 41프레임, `turn/completed`, 명령 실행됨 | `codex-command-once.jsonl` |
| `"0"` | **30프레임, 타임아웃, 응답 이후 아무것도 안 옴** | `codex-command-once-stringid-hang.jsonl` |

**✅ 둘 다 고쳤다.** `readMessage` 는 truthiness 대신 `!== undefined/null` 로,
`respond()` 는 원본 id 를 `wireIds` 에 보관했다가 그대로 회신.

> ### ⚠️ 방법론 교훈 — 이걸 놓칠 뻔했다
> ①은 **오프라인 작업으로는 절대 안 나왔다.** 내 녹화 스크립트는 자체 프로토콜 클라이언트라
> `id: 0` 을 올바르게 처리했고, 그래서 ②만 보였다.
> **실제 `CodexAdapter` 를 실제 app-server 에 붙여보고 나서야** ①이 드러났다.
> → `scripts/e2e-live-codex-approval-roundtrip.mjs` 를 만들었다(실제 어댑터 + 실제 하네스).
> `--regress` 로 수정을 되돌리면 **멈추는 것까지 단언**한다. 두 방향 다 `gpt-5.6-luna` 로 확인.

> **기존 테스트가 못 잡은 이유**: `fake-codex-appserver.mjs` 의 `APPROVAL_ID = "srv-approval-1"` 은
> **문자열**이라 숫자 id 를 한 번도 안 보낸다. **§3 D2 와 같은 뿌리다.**

---

## 1. 원래 문제 (2026-08-08 최초 기록, 그대로 유효)

[B-13](B-13%20권한%20승인%20UI%20QA.md) 은 *"QA 모드에 승인 요청 주입이 있으니 그걸로 확인하라"* 고 적었다.
실측해보니 범위가 훨씬 좁다.

| 기대 | 실제 |
|---|---|
| 승인 요청을 주입할 수 있다 | `QaInteractionInput` 은 **`type: "askUserQuestion"` 하나뿐** (`src/main/engine/engineConnection.ts:75-79`) |
| 실제 멤버에 쏠 수 있다 | **mock 세션에서만**. 실제 멤버는 `Session '<id>' is not a mock session.` (`src/main/sessionManager.ts:684-690`) |
| 승인 카드 모양이 나온다 | 주입되는 건 `toolName: "AskUserQuestion"` 짜리 **질문 카드** — 모양이 다르다 |

### ⚠️ [#21] 의 재발이다

[#21] 에서 `qaKillHarness` 가 실제 프로세스를 죽이지 않고 mock 상태를 주입했고, 그래서 하네스 2개의 결함이 안 잡혔다.
그때의 해법이 지금 따라야 할 본보기다 (`src/main/application/appController.ts:1375-1398`):

```ts
if (!pid) {
  // Refuse rather than simulate. The previous version injected the status
  // string Claude happens to use, which handed the test the answer: the
  // other adapters never produce that value, and no e2e could reveal it.
  // A QA tool that cannot do the real thing must say so (#21).
  throw new Error(`Member '${name}' reports no harness process id, ...`);
}
process.kill(pid);
```

**§3 에서 이 재발이 실제로 일어나 있었음이 확인됐다.** 아래를 볼 것.

---

## 2. 코드 경로 지도 (확인됨)

| 지점 | 위치 |
|---|---|
| 정규화된 승인 이벤트 | `src/core/events.ts:140` — `{type:"approval_request", requestId, toolName, input, title?, description?, suggestions?, codex?, at}` |
| 해소 이벤트 | `src/core/events.ts:141` — `{type:"approval_resolved", requestId, decision:"allow"\|"deny", at}` |
| Codex 카드 메타 | `src/shared/codexApproval.ts:24-40` — `CodexApprovalMeta` |
| Codex 요청 수신 | `src/core/codexAdapter.ts:1000-1023` — **원본 `message.params` 를 그대로 `approvalMeta()` 에 넘긴다** |
| Codex 응답 | `src/core/codexAdapter.ts:565-577` → `approvalResult()` |
| Claude 요청 수신 | `src/core/claudeAdapter.ts:840-879` — SDK `canUseTool` 콜백 |
| Claude 응답 | `src/core/claudeAdapter.ts:523-558` |
| Cursor 응답 | `src/core/cursorAdapter.ts:394-400` — **error 이벤트만 낸다** |
| 카드 렌더 | `src/renderer/workbench/Transcript.tsx:730-768` — `CodexApprovalBlock` |
| 원본 트래픽 녹화 | `src/core/rawLogger.ts` — `settings.debugEnabled` 일 때 `<storageDir>/logs/*.ndjson`. Claude 는 `permission_request`/`permission_response` 를 직접 찍는다 (`claudeAdapter.ts:851`, `:547`) |

---

## 3. 🔴 Codex 프로토콜 실측 — 결함 7건 확정 (2026-08-08)

### 측정 방법 (재현 가능)

**설치된 실제 Codex 바이너리가 자기 스키마를 직접 뱉게 했다.** 과금 없음, 오프라인.

```
codex --version          # codex-cli 0.145.0
codex app-server generate-ts --out <dir>
```

`src/shared/codexApproval.ts:7-9` 주석은 이미 *"verified against `codex app-server generate-ts`"* 라고
적고 있다. **그 대조를 0.145.0 에 대해 다시 했고, 어긋난 곳이 나왔다.**

> **이건 "실트래픽 녹화"가 아니라 "계약(스키마) 실측"이다.** 하네스가 실제로 보낸 값이 아니라,
> 하네스가 보내겠다고 선언한 타입이다. 아래 결함은 전부 **스키마 확정 · 실트래픽 미확인** 이다.
> 실트래픽 녹화는 다음 단계이며, 그때 각 항목에 ✅/정정을 붙인다.

### 결함 목록

#### 🔴 D1. Codex 파일 변경 승인 카드에 **diff 도 작업 디렉터리도 실제로는 안 온다**

실제 `item/fileChange/requestApproval` 의 params 전체:

```ts
FileChangeRequestApprovalParams = {
  threadId: string, turnId: string, itemId: string, startedAtMs: number,
  reason?: string | null,
  grantRoot?: string | null,   // 이 세션 동안 이 루트 아래 쓰기를 허용해달라는 요청
}
```

**`diff` 도 `unifiedDiff` 도 `cwd` 도 없다.**
그런데 `approvalMeta()` (`codexApproval.ts:169`) 는 `params.unifiedDiff ?? params.diff` 를,
`:167` 은 `params.cwd` 를 읽는다 → **둘 다 항상 `undefined`.**

→ **B-13 이 확인하려던 "파일 diff" 와 "작업 디렉터리"가 Codex 파일 변경 카드에서 원천적으로 비어 있다.**

#### 🔴 D2. **그런데 기존 테스트는 통과한다 — [#21] 의 재발이 여기서 실제로 확인됐다**

`scripts/fake-codex-appserver.mjs:225-232` 가 손으로 쓴 값:

```js
params: { threadId: "thr-fake", turnId: "turn-1", itemId: "it-1", startedAtMs: 0,
          reason: "패치 적용", diff: "--- a/x\n+++ b/x\n@@\n-old\n+new" },
```

**실제 Codex 가 절대 보내지 않는 `diff` 필드를 가짜 서버가 보내고 있다.**
`qa-codex-approval` · `e2e-codex-approval` · `demo-codex-approval` 은 전부 이 가짜 서버 위에서 돈다.

> **테스트가 관찰한 게 아니라 답을 알려준 경우다.** [#21] 의 `qaKillHarness` 와 같은 모양이고,
> B-18 이 경고한 바로 그 일이 이미 일어나 있었다.

#### 🔴 D3. 레거시 `execCommandApproval` 은 **명령 원문이 배열**이라 카드가 빈다

```ts
ExecCommandApprovalParams = { conversationId, callId, approvalId: string|null,
  command: Array<string>,   // ← 문자열이 아니다
  cwd: string, reason: string|null, parsedCmd: Array<ParsedCommand> }
```

`approvalMeta():166` 은 `typeof params.command === "string"` 일 때만 받는다 → 배열이면 `undefined`.
→ **레거시 경로에서 "명령 원문"이 안 나온다.**
(v2 `item/commandExecution/requestApproval` 의 `command?: string | null` 은 문자열이라 정상.)

#### 🔴 D4. 레거시 거부 응답이 **프로토콜 위반**

```ts
ReviewDecision = "approved" | {approved_execpolicy_amendment:{...}}
               | "approved_for_session" | {network_policy_amendment:{...}}
               | { "denied": { rejection: string } }      // ← 객체다
               | "timed_out" | "abort"
```

`reviewDecision()` (`codexApproval.ts:129`) 은 **맨 문자열 `"denied"`** 를 돌려준다. 유니온에 없는 값이다.

#### 🔴 D5. `isOther` 를 버려서 **"기타/직접 입력"(1-10-2)이 렌더 불가**

```ts
ToolRequestUserInputQuestion = { id, header, question,
  isOther: boolean,     // ← 우리가 안 읽는다
  isSecret: boolean, options: Array<ToolRequestUserInputOption> | null }
```

`normalizeUserInputQuestions()` (`codexApproval.ts:181-190`) 는 `id/header/question/isSecret/options` 만 옮긴다.
→ **기능정의서 1-10-2 의 "기타/직접 입력" 항목이 Codex 에서 표현되지 않는다.**

#### 🟡 D6. `autoResolutionMs` 를 버린다 — 질문에 **시한이 있는데 화면에 안 보인다**

`ToolRequestUserInputParams = { threadId, turnId, itemId, questions, autoResolutionMs: number|null }`.
사용자가 답을 안 하면 자동으로 해소된다는 뜻인데 카드에 남은 시간 표시가 없다.

#### 🟡 D7. 카드에 쓸 수 있는데 버리는 실데이터

| 필드 | 어디 | 무엇 |
|---|---|---|
| `commandActions: Array<CommandAction>` | v2 command | Codex 가 파싱해 준 친절한 표시용 (`read`/`listFiles`/`search`/`unknown` + 경로·쿼리) |
| `grantRoot` | fileChange(v2·레거시) | **"항상 허용될 규칙"의 파일 버전** — 어느 루트에 동의하는지 |
| `fileChanges: {[path]: FileChange}` | 레거시 applyPatch | 파일별 변경 (D1 의 레거시 대응물) |
| `networkApprovalContext`, `proposedNetworkPolicyAmendments` | v2 command | 네트워크 승인 맥락 |
| `parsedCmd` | 레거시 exec | 파싱된 명령 |
| `approvalId` | v2 command·레거시 exec | 한 `itemId` 에 콜백이 여러 개일 때 라우팅 구분자 ⚠️ 우리는 JSON-RPC `id` 로 키를 잡으므로 문제 없을 수 있다 — **미확인** |
| `strictAutoReview` | permissions **응답** | 이번 턴의 모든 후속 명령을 검토 — **Guardian 의 응답측 손잡이** |

### ✅ 대조 결과 맞는 것 (오해 방지용으로 남긴다)

- **v2 결정값은 전부 정확하다** — `"accept"` / `"acceptForSession"` /
  `{acceptWithExecpolicyAmendment:{execpolicy_amendment}}` / `"decline"` 이 실제 유니온과 일치.
- `ExecPolicyAmendment = Array<string>` 이므로 `approvalMeta():163` 의 `Array.isArray` 검사와
  `canAlways` 는 **정상 동작한다.** → **"동일 command prefix 항상 허용" 버튼은 실제로 뜬다.**
  (조사 중 한 번 "안 뜬다"고 잘못 판단했다가 스키마 확인으로 정정했다.)
- `FileChangeApprovalDecision = "accept"|"acceptForSession"|"decline"|"cancel"` — prefix 규칙 없음.
  `fileChangeDecision()` 이 `always` → `acceptForSession` 으로 낮추는 것은 **옳다.**
- `PermissionGrantScope = "turn"|"session"` — 우리 매핑과 일치.
- `ToolRequestUserInputAnswer = { answers: Array<string> }` — 우리 응답 모양과 일치.
- `normalizeUserInputQuestions` 의 `multiSelect: false` 하드코딩은 **Codex 에 대해서는 옳다.**
  실제 스키마에 다중 선택 필드가 없다. (**Claude 는 다르다 — 미확인**)

### 🟡 D8. `mapUserInputAnswers` 가 답을 쉼표로 쪼갠다

`codexApproval.ts:231` 이 `raw.split(",")`. 응답 타입이 `Array<string>` 이라 배열을 만들어야 하는 건 맞지만,
**쉼표가 들어간 자유 입력 답(D5 의 "기타")이 두 개로 쪼개진다.**

---

## 3c. ✅ Codex 실트래픽 녹화 — 8종 (2026-08-08)

### 방법

`scripts/record-approval-traffic.mjs` — **앱을 띄우지 않고** `codex app-server` 를 직접 구동한다.
핸드셰이크는 `codexAdapter.ts` 와 동일(`initialize` → `initialized` → `thread/start` → `turn/start`,
줄바꿈 구분 `{id,method,params}`, JSON-RPC 2.0 아님). 받은 프레임은 하네스 프로토콜 그 자체라
앱을 경유한 것과 동일하고, 포트·userData·실행 중인 앱을 건드리지 않는다.

- 모델 `gpt-5.4-mini`, 프롬프트는 한 줄. codex-cli **0.145.0**.
- 재생 검증: `scripts/qa-approval-shapes.mjs` (오프라인·무과금, 서브에이전트 관례와 동일)
- ⚠️ 승인이 안 뜬 시나리오는 **조용히 통과시키지 않고 NOT CAPTURED 로 보고하고 실패**한다.

| fixture | 무엇 |
|---|---|
| `codex-command-once.jsonl` | 명령 승인 → `accept` → 실행됨 |
| `codex-command-session.jsonl` | → `acceptForSession` → 실행됨 |
| `codex-command-always.jsonl` | → `acceptWithExecpolicyAmendment` → 실행됨 |
| `codex-command-decline.jsonl` | → `decline` → `declined` (`exec command rejected by user`) |
| `codex-file-write.jsonl` | 파일 생성 요청도 **명령 승인**으로 왔다 (아래 참조) |
| `codex-command-once-stringid-hang.jsonl` | 문자열 id 로 답했을 때의 멈춤 (증거) |
| `codex-no-approval-trusted-read.jsonl` | 음성 대조 — `git status` 는 승인 없이 실행 |
| `codex-untrusted-no-reason.jsonl` | `approvalPolicy: untrusted` 일 때의 카드 |

### 실측 결과

#### ✅ 결정 범위 4가지는 **전부 실제로 작동한다**

`once/session/always/decline` → `accept`/`acceptForSession`/`acceptWithExecpolicyAmendment`/`decline`
네 가지 모두 실제 서버가 받아들였고, 명령이 실제로 실행/거부된 것까지 확인했다.
**B-13 의 "Codex 결정 범위 4가지" 항목은 동작 자체는 정상이다.**

#### 🔴 `availableDecisions` — 생성 스키마에 없는 필드가 실제로 온다

모든 요청에 `availableDecisions` 가 실려 온다. **`codex app-server generate-ts` 에는 이 필드가 없다.**
값은 항상 `["accept", {acceptWithExecpolicyAmendment}, "cancel"]` — **`acceptForSession` 과 `decline` 이 빠져 있다.**

⚠️ **그런데 실측상 `acceptForSession` 도 `decline` 도 정상 동작한다.** 즉 이 목록은 **실제보다 적게 보고**한다.
→ **이 목록을 믿고 버튼을 만들면 멀쩡한 선택지가 사라진다.** 지금 안 쓰는 게 결과적으로 맞다.
(스키마만 봤으면 "우리가 틀렸다"고 잘못 고칠 뻔한 자리다.)

#### 🔴 D1 확인 — **실제 트래픽 어디에도 diff 가 없다**

녹화 8종 전부 `diff`·`unifiedDiff` 없음. `approvalMeta().diff` 는 전부 `undefined`.
**"파일 변경 승인"을 시켜도 gpt-5.4-mini 는 patch 도구가 아니라 셸 명령(`Set-Content`)을 썼다.**
→ ⚠️ **`item/fileChange/requestApproval` 은 아직 못 잡았다.** D1 의 v2 fileChange 부분은
**스키마 근거만 있고 실트래픽 미확인**이다. (정직하게 남긴다)

#### 🟡 명령 원문이 PowerShell 래퍼다

`command` 값: `"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -Command 'echo one > b18a.txt'`
사용자가 읽고 싶은 건 `echo one > b18a.txt` 인데, **그건 `commandActions[0].command` 에 이미 파싱돼 있고 우리는 버린다**(D7).
`proposedExecpolicyAmendment` 도 같은 래퍼 토큰이라 **"항상 허용될 규칙"이 사실상 그 명령 하나짜리다** —
*"동일 command prefix 항상 허용"* 이라는 설명과 실제가 다르다.

#### 🔴 `approvalPolicy` 에 따라 카드 내용이 달라진다 (B-06·B-13 과 직결)

| | `on-request` | `untrusted` |
|---|---|---|
| 승인 요청 | 온다 | **온다** (내 최초 추측은 틀렸다 — 정정) |
| `reason` | **있다** (모델이 왜 필요한지 문장으로 설명) | **없다** (`undefined`) |
| 승인 후 | 명령이 실제로 실행됨 | **여전히 실패** — 샌드박스가 쓰기를 막음 |

→ **`untrusted` 사용자는 "요청 사유"가 빈 카드를 보고, 허용을 눌러도 실패한다.**
승인과 샌드박스 승격이 별개라서다. **신규 사용자가 가장 안전한 설정을 고를 때 정확히 이 경로를 밟는다.**

#### 🟡 신뢰 목록은 승인 없이 실행된다

`git status` 는 `approvalPolicy` 와 무관하게 승인 없이 실행됐다(음성 대조로 녹화).
→ QA 시 "승인 카드가 안 뜬다"가 결함이 아닐 수 있다. **명령 선택이 중요하다.**

---

## 3d. ✅ Claude Code 실트래픽 녹화 — 6종 (2026-08-09)

### 방법

Claude Code 는 가로챌 외부 프로토콜이 없다. **승인 경계가 SDK 의 `canUseTool` 콜백 자체**다
(`claudeAdapter.ts:840`). 그래서 어댑터와 같은 옵션으로 실제 `query()` 를 열고
**콜백이 받는 `options` 객체를 통째로** 기록했다. (아는 키만 기록했으면 Codex 의 `availableDecisions` 처럼
모르는 필드를 놓친다.) 모델 `claude-haiku-4-5-20251001`.

| fixture | 무엇 |
|---|---|
| `claude-bash.jsonl` | Bash 쓰기 명령 승인 → allow |
| `claude-bash-deny.jsonl` | 같은 것 → deny |
| `claude-file-edit.jsonl` | Edit 도구 승인 (작업공간 안) |
| `claude-file-write.jsonl` | Write 도구 승인 |
| `claude-write-outside-cwd.jsonl` | 작업공간 **밖** 쓰기 — 사유가 붙는 변종 |
| `claude-no-approval-trusted-read.jsonl` | 음성 대조 — `git status` 는 콜백에 오지도 않음 |

### 🔴 C1 확인 — 그리고 **생각보다 심각하다**

`suggestions` 는 그냥 오는 정도가 아니라 **읽을 수 있는 prefix 규칙**이 들어 있다:

```json
{ "type": "addRules",
  "rules": [{ "toolName": "Bash", "ruleContent": "echo one *" }],
  "behavior": "allow",
  "destination": "localSettings" }
```

- `ruleContent: "echo one *"` — **B-13 이 요구한 "항상 허용될 규칙" 그 자체다.** 사용자에게 그대로 보여주면 된다.
- `destination: "localSettings"` — 세션이 아니라 **디스크에 저장**되는 영구 규칙이다.
- Edit/Write 에는 `{type:"setMode", mode:"acceptEdits", destination:"session"}` 와
  `{type:"addDirectories", ...}` 가 온다.

**우리는 이걸 이벤트에 싣기만 하고 응답에서 버린다**(`claudeAdapter.ts:530-537` 이 `updatedPermissions` 를
안 보내고 `decisionClassification` 을 `"user_temporary"` 로 고정). SDK 에는 `user_permanent` 도 있다.

> ⚠️ **Codex 보다 Claude 쪽이 더 낫다.** Codex 의 `proposedExecpolicyAmendment` 는
> **명령 전체**(powershell 래퍼 포함)라 사실상 그 명령 하나짜리인데,
> Claude 는 `echo one *` 라는 **진짜 prefix** 를 준다.
> *"동일 command prefix 항상 허용"* 이라는 기능정의서 문구에 실제로 맞는 건 **Claude 쪽**이다.

### 🔴 C2 확인 — `blockedPath` 에 실제 값이 온다

`blockedPath: "C:\...\agentparty-b18-claude-ws\b18a.txt"` — **어느 경로 때문에 막혔는지**가 정확히 온다.
`scrubPermissionOptions` 는 원본 로그에 남기지만 `emitEvent` 는 안 싣는다 → **화면에 안 나온다.**

### ✅ SDK 타입은 정확하다 (Codex 와 다른 점)

`optionKeys` 는 `signal · suggestions · blockedPath · decisionReason · title · displayName · description ·
toolUseID · agentID` 정확히 9개. **선언 안 된 필드가 없다.**
→ Codex 는 스키마에 없는 `availableDecisions` 를 보내는데, Claude SDK 는 타입이 곧 실제다.

### 🟡 요청 사유가 평소엔 비어 있다

| 상황 | `decisionReason` |
|---|---|
| 작업공간 안 Edit/Bash | **없음** |
| 작업공간 **밖** 쓰기 | `"Path is outside allowed working directories"` |

→ **Codex `untrusted` 와 같은 모양이다** — 평범한 승인에서는 "요청 사유" 칸에 쓸 게 없다.
`description` 은 있다: Bash 는 모델이 쓴 설명(`"Write \"one\" to file b18a.txt"`), Edit/Write 는 파일명.
`title` 은 항상 없어서 카드는 `displayName`(`Bash`/`Edit`/`Write`)으로 떨어진다.

### ✅ 파일 diff — **Claude 는 된다**

Edit 의 `input` 이 `{file_path, old_string, new_string, replace_all}` 이라 **before/after 가 다 있다.**
Codex 와 정반대다(§3c: Codex 승인 요청엔 diff 가 아예 없다).
→ **1-10-1 의 "파일 diff" 는 Claude 에서는 지금 데이터로 만들 수 있다.**

### 🟡 안전한 읽기는 콜백에 오지도 않는다

`git status` 는 `permissionMode: "default"` 에서도 `canUseTool` 을 아예 안 거쳤다(음성 대조 녹화).
→ Codex 와 같다. **QA 때 명령 선택이 결과를 좌우한다.**

---

## 3b. 🔴 Claude Code 계약 실측 — 결함 4건 확정 (2026-08-08)

### 측정 방법

설치된 SDK 의 타입 선언을 직접 읽었다. 과금 없음.
`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (`CanUseTool` :188-230, `PermissionResult` :2029-2041,
`PermissionUpdate` :2048-2077, `PermissionDecisionClassification` :1989)
↔ `src/core/claudeAdapter.ts:840-879` (수신) · `:523-558` (응답).

**계약 실측이며 실트래픽 미확인**이다. (§3 과 같은 단서)

#### 🔴 C1. Claude Code 의 **"항상 허용될 규칙"이 미구현이다 — SDK 는 다 지원하는데 버린다**

SDK 가 `canUseTool` options 로 `suggestions?: PermissionUpdate[]` 를 주고, 주석이 이렇게 말한다:

> *"Typically if presenting the user an option 'always allow' or similar, then this full set of
> suggestions should be returned as the `updatedPermissions` in the PermissionResult."*

`PermissionUpdate` 는 `addRules`/`replaceRules`/`removeRules`(+`behavior`,`destination`) ·
`setMode` · `addDirectories`/`removeDirectories` 이고,
`destination` 은 `'userSettings'|'projectSettings'|'localSettings'|'session'|'cliArg'` 다.
`PermissionDecisionClassification` 에는 **`'user_permanent'` 가 있다.**

우리 코드:
- `claudeAdapter.ts:859` — `suggestions` 를 **받아서 이벤트에 싣기는 한다.**
- `claudeAdapter.ts:530-537` — 그런데 응답에서 **`updatedPermissions` 를 절대 안 보내고**
  `decisionClassification` 을 **`"user_temporary"` 로 하드코딩**한다.

→ **Claude Code 승인은 사실상 "이번 한 번"밖에 없다.** 규칙 저장 수단이 SDK 에 완비돼 있고
데이터도 이미 도착해 있는데 쓰지 않는다. **B-13 의 "항상 허용될 규칙" 항목이 Claude 에서 미충족.**

#### 🔴 C2. `blockedPath` 를 UI 에 안 준다

SDK 주석: *"The file path that triggered the permission request... e.g. when a Bash command tries to
access a path outside allowed directories."* — **B-13 의 "작업 디렉터리/경로 맥락"에 해당하는 유일한 필드다.**

`scrubPermissionOptions()` (`:1866-1877`) 는 **원본 로그에는 `blockedPath` 를 남긴다.**
그런데 `emitEvent` (`:852-861`) 는 안 싣는다. → **로그에는 있고 화면에는 없다.**

#### 🟡 C3. `agentID` 를 UI 에 안 준다

서브에이전트 안에서 올라온 승인인지 구분이 안 된다. C2 와 같은 자리(로그엔 있고 이벤트엔 없음).

#### 🟡 C4. `deny` 의 `interrupt?: boolean` 미사용

거부하면서 턴을 끊는 선택지가 없다.

### ✅ 맞는 것

- 취소(`options.signal` abort) 처리 있음 (`:863-877`) — 거부로 해소하고 pending 을 정리한다.
- party 도구는 승인 프롬프트 없이 자동 허용 (`:844-846`) — 의도된 동작이고 주석에 근거가 있다.
- 정규화 이벤트에 `suggestions` 가 실제로 실린다 — **UI 가 쓰기만 하면 되는 상태**다(C1).

---

## 4. 하네스별 차이 (현재까지 · 전부 계약 실측, 실트래픽 미확인)

| | Claude Code | Codex | Cursor |
|---|---|---|---|
| 대화형 승인 요청 | SDK `canUseTool` 콜백 | JSON-RPC 서버→클라이언트 요청 5종 | **없음** |
| 하네스가 지원하는 결정 범위 | allow / deny / **규칙(updatedPermissions)** | once / session / always(prefix 규칙) / decline | 해당 없음 |
| **우리가 실제로 쓰는 범위** | allow / deny **만** (C1) | 4종 전부 | 해당 없음 |
| 명령 원문 | Bash `input.command` — **깨끗한 원문** ✅ | v2 `command` 는 **powershell 래퍼** 🟡 / 레거시 배열 ❌(D3) | 해당 없음 |
| 작업 디렉터리 | `blockedPath` 실값 옴 · **UI 에 안 감**(C2) | v2 command 만 `cwd` · **fileChange 엔 없음**(D1) | 해당 없음 |
| 파일 diff | **가능** — Edit `input.old_string/new_string` ✅ | **승인 요청에 없음**(D1) | 해당 없음 |
| 항상 허용될 규칙 | **진짜 prefix** `"echo one *"` + 영구 저장 · **미구현**(C1) | 명령 전체 토큰 (prefix 아님) · 구현됨 | 해당 없음 |
| 요청 사유 | 평소 **없음** · 작업공간 밖일 때만 | `on-request` 만 있음 · `untrusted` 는 **없음** | 해당 없음 |
| 안전한 읽기 | 콜백에 안 옴 | 승인 없이 실행 | 해당 없음 |
| 승인 시점 | 도구 호출마다 | 도구 호출마다 | **턴 시작 시 CLI 플래그로 선결** |

> **셋은 "같은 것을 다르게" 보내는 게 아니라 서로 다른 것을 보낸다.**
> diff 는 Claude 만, prefix 규칙은 Claude 가 제대로·Codex 가 이름만, 결정 범위 4종은 Codex 만,
> Cursor 는 승인 자체가 없다. **목업을 하나로 뭉뚱그리면 셋 다 틀린다.**

**Cursor** (`src/core/cursorAdapter.ts:394-400`): print 모드(`stream-json`)에 대화형 승인이 없다.
`respondApproval` 은 error 이벤트만 낸다. 승인은 `--auto-review` / `--force` / `--trust` 로 **미리** 정해진다.
→ **Cursor 에는 승인 카드가 존재할 수 없다.** (코드 확인 · 실트래픽 미확인)

⚠️ 이것이 사실이면 [B-06](B-06%20하네스별%20권한%20렌더링.md)·B-13 의 "세 하네스 각각 승인 화면 확인"은
**Cursor 에 대해 애초에 불가능**하다. 확인 후 B-13 에 반영해야 한다.

---

## 5. 남은 일

1. **`item/fileChange/requestApproval` 녹화** — 아직 못 잡았다. gpt-5.4-mini 가 patch 도구 대신
   셸을 쓴다. 더 큰 모델이나 여러 파일 수정을 시켜 유도해야 한다. **D1 의 핵심 근거가 여기 달려 있다.**
2. **Claude Code 실트래픽 녹화** — `blockedPath`·`suggestions`·`agentID` 가 실제로 오는지.
   `scrubPermissionOptions` 가 원본 로그에 남기므로 `debugEnabled` 로 받을 수 있다.
3. **Cursor 실측** — 승인 요청이 정말 없는지 확인(코드상 없음, §4).
4. **사용자 질문(1-10-2) 녹화** — 단일/다중 선택 · 선택지 설명 · 기타(`isOther`) · 비밀 입력(`isSecret`) ·
   다중 질문. Codex 는 `item/tool/requestUserInput` 로 온다.
5. **`QaInteractionInput` 확장** — 승인 종류까지. **실제 멤버에 못 쏘면 조용히 성공하지 말고
   이유를 말하며 실패할 것** ([#21] · `qaKillHarness` 본보기).
6. **`fake-codex-appserver.mjs` 를 실측값으로 교체** — 지금 값은 신뢰할 수 없다.
   최소한 **id 를 숫자로** 바꿔야 위의 멈춤 결함이 다시 안 숨는다.
7. **카드 렌더링 확인** — fixture 주입으로 실제 앱 화면을 본다(B-13 의 나머지 절반).

## 6. 제품 결함 (사용자 결정: **B-18 안에서 같이 고친다**)

| | 무엇 | 상태 |
|---|---|---|
| **`id: 0` 라우팅 누락** | **Codex 승인 카드가 아예 안 뜨고 턴이 멈춤** | ✅ **고침** (실제 어댑터로 검증) |
| **응답 id 문자열화** | 서버가 응답을 못 매칭해 턴이 멈춤 | ✅ **고침** |
| **C1** | Claude "항상 허용될 규칙" 미구현 (SDK 는 지원) | ✅ **고침** — 규칙 문구까지 표시 |
| **C2/C3** | Claude `blockedPath`·`agentID` 가 UI 로 안 감 | ✅ **고침** |
| **Codex 사유 미표시** | `reason && !command` 조건이라 **명령 승인에선 사유가 한 번도 안 나왔다** | ✅ **고침** |
| **래퍼 명령** | 명령 원문이 PowerShell 래퍼로 보임 | ✅ **고침** — 읽는 형태 우선, 실행 형태 병기 |
| **Claude 파일 diff** | Edit 의 before/after 미표시 | ✅ **고침** (1-10-1 충족) |
| **D3** | 레거시 `execCommandApproval` 명령 원문이 배열이라 카드가 빔 | ✅ **고침** |
| **D4** | 레거시 거부 응답 `"denied"` 가 프로토콜 위반 | ✅ **고침** → `{denied:{rejection}}` |
| **D5** | Codex `isOther` 를 버림 | ✅ **고침** — 다만 방향이 반대였다(아래) |
| **D1** | **Codex** 승인 카드에 파일 diff 가 없음 | ⬜ **하네스가 안 보낸다.** fileChange 녹화 필요 |
| **untrusted 빈 사유** | 사유 없는 카드 + 허용해도 실패 | 🟡 카드는 빈 줄 안 그림. **문구/안내는 미정** |

### D5 정정 — 방향이 반대였다

처음엔 *"`isOther` 를 버려서 기타 입력을 못 만든다"* 고 적었는데 **틀렸다.**
질문 카드는 `기타 (직접 입력)` 을 **무조건** 띄우고 있었다.
즉 **Codex 가 "직접 입력 불가"라고 한 질문에도 자유 입력을 권하고 있었다** — 거부당할 답을 유도한다.
이제 `isOther` 가 그 선택지를 결정한다(기본값은 허용 — AskUserQuestion 은 항상 직접 입력을 받는다).

`multiSelect: false` 하드코딩은 **결함이 아니다.** Codex 스키마에 다중 선택 자체가 없다.

---

## 7-0. 📁 디자인 인계용 캡처 — [`승인 카드 캡처/`](승인%20카드%20캡처/)

**전수 캡처 21장 + [INDEX.md](승인%20카드%20캡처/INDEX.md)** (대기 6 · 해소 4 · 질문 5 · 시트 6).
`node scripts/demo-approval-cards.mjs` 로 재생성된다(과금 없음, 실행할 때마다 폴더를 비우고 다시 씀).

**INDEX.md 에 실측한 것과 못 한 것이 나뉘어 있다.** 못 잡은 케이스는 **비워 뒀다** —
못 본 모양으로 카드를 그리면 그게 곧 추측을 스펙으로 굳히는 것이라서다(이 이슈의 주제 그대로).

⚠️ Cursor 제외 **실측 못 한 6종**:
Codex 권한상승 · 명령(규칙없음) · 사용자입력 · elicitation · generic, Claude 서브에이전트.
이 중 앞의 셋은 시도해볼 만하고, 사용자입력·elicitation 은 외부 조건이 필요하며,
generic 은 모르는 method 폴백이라 정상 트래픽에 원래 안 나온다.

---

## 7. QA 목업 — 이제 실제 호출 없이 승인 카드를 볼 수 있다

```
POST /api/qa/members/:name/interaction
{ "type": "approval", "scenario": "codex-command-once" }
```

시나리오 12종이 **녹화본에서 생성**된다 (`build-approval-scenarios.mjs` →
`src/shared/approvalScenarios.ts`). 손으로 쓴 값이 없고, 재생 검증이
**생성 모듈이 녹화본과 바이트 단위로 동일한지** 단언해 목업이 조용히 가짜가 되는 것을 막는다.

| scenario | 카드가 받는 것 |
|---|---|
| `codex-command-once` | 명령·cwd·사유·prefix 규칙 + 결정 4종 |
| `codex-untrusted-no-reason` | **사유가 없는** 카드 |
| `claude-bash` | `blockedPath` + `"echo one *"` 규칙 |
| `claude-file-edit` | `old_string`/`new_string` → **diff 렌더** |

### 구조 — 목업이 두 번째 정본이 되지 않게

요청→카드 매핑을 두 어댑터에서 `src/shared/approvalRequest.ts` 로 뽑았다.
**어댑터와 목업이 같은 함수를 쓴다.** 전에는 목업이 손글씨 사본이었고,
그게 실제 Codex 가 안 보내는 `diff` 로 카드를 "검증"하게 된 경로다.

### 못 하는 건 못 한다고 한다 ([#21] 규칙)

- 없는 시나리오 → 사용 가능한 목록을 대고 실패
- **실제 멤버에 주입 → 거부.** 하네스가 발급한 적 없는 요청이라 버튼이 답할 대상이 없다.
  → **원래 브리핑의 "실제 멤버에도 쏠 수 있는지"에 대한 답은 "못 쏜다, 그리고 그게 맞다"** 이다.
  진짜 승인은 진짜 턴에서만 나온다.

---

## 8. 검증 현황

### ✅ 자동으로 실측 검증한 것

| 무엇 | 어떻게 |
|---|---|
| Codex 승인 **실제 어댑터 왕복** | `npm run test:e2e:codex-approval-live` — 실제 `CodexAdapter` + 실제 app-server. 승인 후 **턴이 끝나는 것**까지. `--regress` 로 되돌리면 멈추는 것도 단언 |
| Claude **항상 허용 규칙 저장** | `npm run test:e2e:claude-always-allow` — 실제 `ClaudeAdapter` 2턴. 규칙이 **디스크에 남는지**로 단언 |
| 카드 내용 (양 하네스) | `npm run test:approval-shapes` — 녹화 14종 재생 + 카드 DOM |
| 승인 주입 API | `npm run test:interaction` — 엔진 경로로 실제 주입, 거부 2종 포함 |
| **WSL 원격 엔진** | `node scripts/qa-wsl-remote.mjs` — Windows → wsl.exe stdio → distro 엔진. 주입·거부 전파 확인 |
| WSL 엔진 번들 | `node scripts/qa-wsl-engine.mjs` — Electron-free 유지 확인 |

### 🔴 C1 실측 결과 — **"항상 허용"은 침묵을 약속할 수 없다**

실제 세션 2턴으로 확인했다.

**되는 것**: `항상 허용` 을 고르면 작업공간의 `.claude/settings.local.json` 에
`{"permissions":{"allow":["Bash(echo one *)"]}}` 가 **실제로 저장된다.**
`이번만 허용` 은 아무것도 안 남긴다. **이 차이는 결정적이고, 그래서 이걸로 단언한다.**

**⚠️ 안 되는 것**: **새 세션에서도 다시 묻는다.** 다만 *명령* 때문이 아니라 **경로** 때문이다 —
요청에 `blockedPath` 가 실려 오고, 그 해법인 `addDirectories` 는 `destination: "session"` 이라
**애초에 영구 저장이 불가능하다.**
→ **이 카드의 어떤 선택지도 "다시 안 물음"을 약속할 수 없다.**
버튼 설명을 *"앞으로 묻지 않습니다"* → *"'…' 규칙을 저장합니다. 다른 이유(경로 등)로는 다시 물을 수 있습니다"* 로 고쳤다.

> ### ⚠️ 방법론 교훈 2 — 검증이 엉뚱한 이유로 통과할 뻔했다
> 처음엔 *"같은 명령을 다시 시켜 안 물으면 합격"* 으로 짰다. **그건 아무것도 증명하지 않는다** —
> 실측하니 **아무것도 저장 안 해도 같은 세션에서는 다시 안 묻는다**(Claude 가 세션 내에서 기억).
> `--regress`(이번만 허용) 대조군이 이걸 잡아냈다. **대조군이 없었으면 "고쳤다"고 잘못 보고했다.**

### ⬜ 남은 것 — 사람이 실제 앱에서 (다음 사람이 여기부터)

위는 전부 **어댑터/엔진 레벨**이다. **실제 앱 UI 에서 사람이 누르는 것**은 아직 안 했다.

### 목업으로 화면 확인 (과금 없음)
1. 앱을 격리 userData 로 띄우고 mock 멤버를 시드
2. 위 API 로 시나리오를 하나씩 주입해 카드 4종을 눈으로 확인
3. 특히 **`claude-bash` 의 `항상 허용 (규칙)` 버튼과 규칙 문구**, **`claude-file-edit` 의 diff**

### 실제 호출 e2e (과금)
1. Claude 멤버(`permissionMode: default`)에 **쓰기 명령**을 시킨다
   — ⚠️ `git status` 류는 승인이 안 뜬다(양쪽 하네스 모두 실측 확인)
2. `항상 허용 (규칙)` 을 누르고 **작업공간의 `.claude/settings.local.json` 에 규칙이 생기는지** 확인
   → ⚠️ **"다시 안 묻는지"로 판단하지 마라.** 위 교훈 2 참고 — 같은 세션에서는 아무것도 저장 안 해도 안 묻는다.
   어댑터 레벨은 자동 검증됨. 여기선 **버튼→저장** UI 경로만 본다
3. Codex 멤버(`approval: on-request`, `sandbox: read-only`)에 쓰기 명령
   → 카드가 뜨고 승인 후 턴이 끝나는지. **어댑터 레벨은 자동 검증됨**(위) — 여기선 **UI 경로**를 본다
4. 결정 4종을 각각 눌러 실제로 실행/거부되는지

### 그 외 남은 것
- **`item/fileChange/requestApproval` 녹화** — gpt-5.4-mini 는 patch 도구 대신 셸을 쓴다.
  더 큰 모델이나 여러 파일 수정을 유도해야 한다. **D1 의 근거가 여기 달려 있다.**
- **Cursor 실측** — 코드상 승인 경로 없음. 확인만 하면 된다
- **사용자 질문(1-10-2) 녹화** — `item/tool/requestUserInput` 실트래픽. `isOther`·`isSecret`·
  `autoResolutionMs` 를 실값으로 확인
- **`fake-codex-appserver.mjs` 교체** — 지금도 숫자 id 를 안 보내고 `diff` 를 지어낸다.
  **이걸 안 고치면 같은 계열 결함이 또 숨는다**

## 9. WSL 확인 (2026-08-10)

**했다.** 지원 플랫폼이 Windows + WSL 이고, 내 변경이 **엔진 번들에 새 모듈을 넣었기 때문**에 필요했다.
엔진 서버는 ESM 으로 번들돼 **distro 의 맨 node** 가 돌리는데, 모듈 그래프에 Electron 의존이 하나만 있어도
**로드 시점에 죽고 작업공간이 "없음"으로 조용히 렌더**된다.

- Ubuntu-22.04 / node v22.22.2 에서 `dist/engine-server.mjs` **import 성공 + 서버 기동 확인**
- 번들 **Electron-free 유지** (`qa-wsl-engine`)
- **Windows → wsl.exe stdio → distro 엔진**으로 승인 주입 성공, 엔진이 `pendingApprovalCount` 로 **실제 등록**
- **거부가 RPC 경계를 넘어 rejection 으로 전파**되고 사유도 보존됨
  → 이게 안 되면 **WSL 에서만 "가짜 승인 금지" 가드가 조용히 무력화**된다

⚠️ 주의: 주입된 승인은 **저장되는 transcript 가 아니라 라이브 이벤트**다(렌더러가 접는다).
처음에 transcript 를 뒤지는 단언을 썼다가 틀렸다. 관찰 가능한 건 **세션 스냅샷의 `pendingApprovalCount`** 다.

## 10. 범위 밖 — 새 항목 후보

- 🔴 **`npm run test:askq` 가 master 에서 크래시한다** (`Cannot read properties of undefined (reading 'map')`).
  내 브랜치와 master 출력이 **동일**함을 diff 로 확인했다. 내 변경과 무관하다.
- 🔴 **`npm run test:render` 의 `a busy member's toolbar shows Stop` 이 master 에서 실패**한다. 위와 같음.

→ 둘 다 `test:ui` 묶음이 지금 **깨진 채로 방치**돼 있다는 뜻이다. 누가 소유할지 정해야 한다.

- 🟡 **`qa-wsl-remote.mjs` 가 이미 깨져 있었다** — 파티 저장소가 분리(`parties.json` + `parties/<id>/party.json`)됐는데
  테스트는 옛 `state.json` 을 찾고 있었다. 내가 편집하던 파일이라 **테스트만** 고쳤다(제품 동작 변경 없음).
  같은 이유로 깨진 WSL 스크립트가 더 있는지는 안 봤다.

## 연관

- [B-13](B-13%20권한%20승인%20UI%20QA.md) — 이게 풀려야 B-13 의 나머지 절반을 할 수 있다
- [B-06](B-06%20하네스별%20권한%20렌더링.md) — Cursor 에 승인 카드가 없다는 §4 가 사실이면 재검토 필요
- [#21] — 같은 실패의 전례와 해법
