# Handoff — Transcript saves starved the engine RPC pipe; a stop request bricked a member

- **Date:** 2026-07-20
- **Follow-up to:** [HANDOFF-2026-07-09-logging-lag-and-stuck-member.md](HANDOFF-2026-07-09-logging-lag-and-stuck-member.md)
- **Reported as:** "SEL-6877에서 채팅을 입력했는데 반응이 없어" — and, before that, a ping
  whose reply took ~3 minutes with no reasoning output at all.
- **Environment:** Windows 11 desktop + WSL2 engine (Ubuntu-20.04), workspace
  `wsl+Ubuntu-20.04:/home/spdlqj8876/sellmate-dockerize`, party `SEL-6877`
  (`party-1784079299098-7432bdc616e07`).

## TL;DR

Two independent defects, both now fixed, plus a third that blocked recovery.

1. **A user turn waited 33 s behind transcript traffic.** The renderer re-sent
   every open member's ENTIRE transcript on every debounced save. On a WSL
   workspace those saves share ONE stdio RPC pipe with `sendUserTurn`, so a turn
   queued behind ~30 MB of transcript JSON. No reasoning appeared because the
   turn had not reached the harness yet.
2. **A stop request could wedge a member permanently.** Only the harness's
   turn-end signal cleared `interrupting`, and `interrupting` counts as a busy
   turn — so a turn the harness never closed blocked every later send forever.
3. **`respawn` crashed**, so the documented recovery for (2) did not work.

## Evidence (live, 2026-07-20)

Automation API `http://127.0.0.1:48931`, log
`%APPDATA%\AgentParty\logs\agentparty-2026-07-20T01-47-35-560Z.ndjson`.

### The 33-second turn

| event | timestamp |
|---|---|
| `party:message` → `req` (IPC received) | `01:51:05.998` |
| `req` snapshot `lastUserMessageAt` (turn dispatched) | `01:51:38.898` |
| `party:message` → `main` (IPC received) | `01:51:16.666` |
| `main` snapshot `lastUserMessageAt` (turn dispatched) | `01:51:51.169` |

32.9 s and 34.5 s — two members delayed near-identically, i.e. contention on a
shared resource. Ruling out the alternatives:

- **Not adapter-level queueing.** `req`'s transcript has no `queued` status
  block; the `sent: 핑` block follows the `user` block directly.
- **Not a main-thread freeze.** Desktop log lines flow continuously through the
  whole window (saves every 1–10 s).
- **It is the pipe.** Live transcript sizes: `main` 0.23 MB, `req` 0.57 MB,
  `explore` 3.8 MB, **`impl` 25.2 MB** — ~30 MB re-sent per save round, through
  the single `wsl.exe` stdio channel that also carries `sendUserTurn`.
  `writeLine` ignored `stream.write()`'s backpressure signal, so it buffered
  without bound.

The amplifier was the save effect's dependency: it keyed on the whole
`logsBySession` map and then looped over ALL members, so one member streaming
re-persisted every other member. The log shows `req` pinned at 803 blocks while
being re-sent every round.

### The wedged member

`main` (`resume-1784512070310`) snapshot, ~2.5 minutes after the user pressed stop:

```json
{ "status": "interrupting", "turnState": "interrupting",
  "lastError": "[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use",
  "queuedTurnCount": 0, "turnCount": 3 }
```

`session:interrupt` fired at `01:53:23`, `:24`, `:25`, `:36` (stop pressed four
times) and the status never moved. `ede_diagnostic` comes from the Claude CLI
binary, not from AgentParty — the turn ended malformed (`stop_reason=tool_use`
with no tool_use content), so the SDK never delivered the `result` that is the
ONLY thing that cleared `interrupting`.

Codex had the identical defect (`codexAdapter.interrupt`), which is what stranded
`survey4` in the 07-09 handoff.

### The broken recovery

```
01:59:46  party:respawn  args: ["main", null]
01:59:46  party:respawn failed: Cannot read properties of null (reading 'selectedHarnessId')
```

Electron serializes an omitted invoke argument as `null`, so the TypeScript
default `input: StartPartyMemberInput = {}` never fired.

## Fixes

### 1. Anchored transcript appends

- `TranscriptSave { afterId?, blocks }` / `TranscriptSaveResult { applied, reason? }`
  in `src/shared/types.ts`, threaded through preload → IPC → AppController →
  EngineConnection → PartyApplicationService → PartyRepository.
- `buildTranscriptSave` (`src/renderer/app/transcriptEvents.ts`) diffs by
  **block identity**. Blocks are rebuilt immutably by `applyEvents`, so the
  identity-equal prefix is exactly what is already on disk; only the suffix ships.
- `PartyRepository.writeTranscript` resolves `afterId` against a write-through
  mirror of the file (no re-read per save) and **refuses** an append it cannot
  anchor rather than writing a fragment as the whole history. The renderer then
  resends in full. Index-based splicing is unsafe here because `TRANSCRIPT_CAP`
  trims the head, so renderer and file indices disagree (`impl` had 826 blocks
  live vs 800 stored).
- The save effect skips any member whose blocks array is identity-unchanged, so
  one member's streaming no longer touches the others at all.
- Saves are serialized per member through a promise chain, so two overlapping
  saves cannot land out of order and persist the older transcript last.

### 2. Manual force stop (both adapters)

`forceStop()` returns the session to idle and drains anything queued behind a
turn the harness will never close. It is deliberately local: it does not stop or
kill the harness, so it is cheap and non-destructive. Exposed as
`POST /api/sessions/:id/force-stop` and `POST /api/party/members/:name/force-stop`,
and in the UI as the composer's Stop control, whose label becomes **강제 종료**
once a Stop has sat unacknowledged for `FORCE_STOP_AFTER_MS` (5 s). Calling stop
with no live turn also clears a previously stranded one.

**Nothing escalates on a timer.** An earlier revision auto-cleared after 15 s;
that was removed because a slow-but-healthy interrupt would be torn out from
under the harness while the old turn was still alive, and a late `result` could
then arrive after a queued turn had already been dispatched. The human decides
when a Stop has gone unanswered — the failure is visible (the member stays busy
and the label changes), so nothing is hidden by making it manual. When the
harness process itself is gone, `respawn` remains the stronger remedy.

### 3. `null` optional arguments

`optionalArg()` at the IPC boundary in `main.ts` (where the `undefined → null`
conversion happens), plus explicit `?? {}` normalization in `respawnMember` /
`startMember`, which are public API reachable from HTTP too.

### 4. A stale approval block hid the stop control

Found while verifying the above: `req` never showed a stop button, and the
sidebar read `0 working`, even mid-turn.

`hasPendingApproval` scanned the transcript for an unresolved `approval` block
*even when a live session reported `pendingApprovalCount: 0`*, and approval
outranks "working" in `deriveStatus` — so `busy` was permanently false. `req`
carried an unresolved `AskUserQuestion` block from 10:25, when the app was killed
with the prompt open; it persisted to disk and returned on every restore, pinning
the member in "approval" for good.

A live session's count is now authoritative; the transcript is consulted only for
a member with no live session, where it is the only record there is. Verified in
the real app: with the same stale block present, a running turn shows `working`,
`1 working`, and a red **Stop** control, and returns to `idle` when it ends.

## Tests

- `npm run test:transcript-append` — delta building + engine anchoring, including
  the refusal path and cold-cache anchoring.
- `npm run test:interrupt-recovery` — drives ClaudeAdapter against a fake SDK
  whose `interrupt()` resolves but which never emits `result`; asserts nothing
  auto-escalates and that the manual force stop releases the turn and flushes the
  queue.
- `npm run test:stall-status` — extended with the approval-vs-busy precedence.

All registered in `test:ui`.

## Still open

- **Transcript bloat (07-09 rec #4).** `impl` is 25.2 MB over 826 blocks —
  ~30 KB per block. `TRANSCRIPT_CAP` caps block COUNT, not bytes, so a few huge
  tool outputs still dominate. The append protocol keeps them off the wire but
  the file is still rewritten whole on each save. A byte budget (or storing large
  tool outputs by reference) is the real fix.
- **`writeLine` backpressure.** It still ignores `stream.write()`'s return value.
  Appends make overflow far less likely, but a genuine flood would still buffer
  without bound.
- **Logger (07-09 rec #2).** Still synchronous `appendFileSync`, no rotation.
- **Pre-existing, unrelated test failures** on `master`: `qa-model-catalog`
  ("exactly 11 OpenRouter models … got 22") and `qa-engine-rpc`
  ("server engine persisted state.json" — the repository writes the split layout
  now, not `state.json`). Both fail on a clean checkout.
