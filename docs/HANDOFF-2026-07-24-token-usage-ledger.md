# Handoff — Token Usage dashboard, phase 1: the per-turn usage ledger

- **Date:** 2026-07-24
- **Branch / worktree:** `feat/token-usage-dashboard` (branched from `master`),
  worktree at `C:/Project/AgentPartyApp-token-usage`.
- **Design source:** `docs/디자인 핸드오프/design_handoff_token_usage/` (the
  `Token Usage.dc.html` is the pixel source) + `docs/디자인 핸드오프/token_usage_brief.md`
  (brief §6: "구현 전이다. 데이터 수집 계층부터 새로 만든다").
- **Scope of this phase:** the **data-collection layer only**. No UI yet — that
  is phase 2, deliberately deferred so the real data's shape (magnitudes,
  trigger mix, compact cadence) informs the UI rather than the mock design
  driving it.

## TL;DR

The app previously had only the **account-global rate-limit meter** (한도 게이지).
Per-turn cost was computed and then thrown away — nothing attributed spend to a
party / member / trigger over time. This phase adds a **persistent, append-only
per-turn usage ledger**: every completed turn is recorded with its token split,
cost, identity, and trigger, then range-queried and rolled up behind
`GET /api/token-usage`. Verified end to end through the real app + HTTP.

## Data flow

```
harness turn ends (claude / codex / cursor / mock)
  → turn_complete event   ← NEW: now carries `usage` (token split + context)
  → sessionManager.bind() intercepts it
  → recordTurnUsage(): assembles a TurnUsageRecord from
        session.identity (partyId, member) + session.lastSnapshot (model, effort)
      + event.usage (tokens) + event.cost (cost) + trigger
  → UsageLedger.append() → <workspace>/.agent_party_app/usage/turns.jsonl (append-only)

query: GET /api/token-usage?range=5h&bucket=5&party=<id>&trigger=<t>
  → AppController.getTokenUsage → engine.getTokenUsage (engine-scoped, WSL-safe)
  → UsageLedger.read(range) → aggregateUsage() (pure)
  → { buckets[], parties[], members[], triggers[], totals, recordCount }
```

## Files

New:
- `src/shared/tokenUsage.ts` — `TurnUsageRecord`, `TokenTrigger`,
  `TurnTokenBreakdown`, and the **pure** `aggregateUsage()` (buckets +
  party/member/trigger rollups) and `estimatedTurnCostUsd()` (list-price ≈$).
  No I/O, so it's headless-testable and reusable by the renderer in phase 2.
- `src/main/usageLedger.ts` — append-only JSONL persistence + range read + count.
- `scripts/e2e-token-usage.mjs` — full-process E2E (QA mock harness).

Changed (by layer):
- **Capture:** `core/events.ts` (added `usage` to `turn_complete`),
  `core/claudeAdapter.ts` / `codexAdapter.ts` / `cursorAdapter.ts`
  (populate the token split at each emission site), `main/harness/mockHarness.ts`
  (synthetic split so QA/E2E accrue records).
- **Record:** `main/sessionManager.ts` (ManagedSession gains
  `identity`/`lastSnapshot`/`pendingTrigger`; `recordTurnUsage` on
  `turn_complete`; `sendUserTurn` takes an optional trigger; `createMockSession`
  takes identity), `main/application/partyApplicationService.ts` (member-to-member
  delivery tags `party-message`; mock start passes identity).
- **Expose:** `engine/engineConnection.ts` + `localEngine.ts` +
  `transport/remoteEngineClient.ts` (`getTokenUsage`), `application/appController.ts`,
  `automationApi.ts` (route + `tokenUsageQueryFrom`), `main.ts` (IPC),
  `preload/preload.ts` (`getTokenUsage`), `shared/apiSpec.ts`, `docs/API.md`.

## Design principles honored

- **Honest data (brief §4/§8):** a token field is populated only when the
  harness reports it — a missing field means "not reported", **never 0** (Codex
  exposes no cache split). A turn whose origin isn't known records
  `trigger:"unknown"`, never a fabricated `"user"`. An empty range returns
  `recordCount:0` so the UI can show "아직 없음" instead of a fake 0%.
- **실측 vs 환산 kept separate:** `costUsd` is the harness/provider-reported bill
  (실측); `estCostUsd` is a derived list-price conversion (환산). Subscription
  turns (Claude/Codex) carry no bill, so they're comparable only via `estCostUsd`
  — mixing the two would misrepresent the numbers.
- **Route parity (AGENTS.md):** UI and HTTP go through the one
  `AppController.getTokenUsage`; the query is engine-scoped so a WSL workspace's
  turns are read on their own host.

## Verification

`node scripts/e2e-token-usage.mjs` — launches the real app (QA, mock harness, no
model calls), seeds a mock party, drives 6 turns via the party message API, then
asserts `GET /api/token-usage`:

```
empty ledger → recordCount 0 (honest)  ·  6 turns logged
token split in=1551 / out=646          ·  estCost ≈$0.0155
party rollup present, members {backend:3, frontend:2, reviewer:1}
party-scoped buckets keyed by member   ·  triggers: user tagged, no overhead mis-tag
```

Full `npm run typecheck` (renderer + main) is clean.

> Note on the worktree: `node_modules` is a junction to the main tree's
> (`New-Item -ItemType Junction`), so `npm run build` / `typecheck` work without a
> separate install.

## Gotcha fixed this phase

The range preset was first named `?window=`, which **collides** with the
API-wide `?window=` used to select the target app window (`targetWindowId`). A
`?window=5h` request set `windowId="5h"`, which resolved to no window and fell
back to the default workspace — so writes landed in the e2e workspace while
reads hit the repo root, and the query always returned 0. Renamed to `?range=`.

## Known limitations / follow-ups (NOT yet addressed)

1. **Multi-process concurrent writes.** The ledger is a single JSONL written with
   `appendFileSync` — serialized *within* a process, but the app supports
   editing one workspace from **multiple instances**. `partyRepository` solves
   this with per-party files + temp-file atomic rename; the ledger does **not**
   follow that established pattern yet, so two processes appending at once can
   interleave/corrupt lines. No prior storage-design doc was found (the brief
   covers bucketing/metrics only), so this decision is open. **Decide before
   heavy real-world use.**
2. **No rollover / sharding** — the file grows unbounded and every query full-
   scans it. Consider day- or party-sharded files.
3. **Rapid queued sends** to one member: only the turn active when a send lands
   is tagged; extra `turn_complete`s from the queue drain record `unknown`. Real
   harnesses are typically 1 send = 1 turn, so this is minor.
4. **`gate-review` and `subagent` triggers are not instrumented yet** — the gate
   reviewer is a headless router call and subagent turns are isolated, so neither
   currently flows through `recordTurnUsage`.

## Next (phase 2)

Feed the real ledger, look at the actual magnitudes, then build the UI. Screen
registration: add to the `ViewId` union in `renderer/app/appState.ts` and a
`navItems` entry in `App.tsx` (the 52px nav rail already exists). Theme tokens
(`--bg-0` …) are already in `renderer/theme/themes.ts`; reuse
`renderer/theme/memberColors.ts` (`hexA`, `memberColor`) for chart series colors.
