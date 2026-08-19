# AgentParty Code Map

Last verified against the source tree: 2026-07-28.

This document answers “where does this behavior live?” `ARCHITECTURE.md`
defines the dependency rules; this map records the current entry points,
ownership boundaries, and runtime flows.

## Runtime map

```text
Renderer (React)
  src/renderer/main.tsx
    -> src/renderer/App.tsx
    -> src/renderer/workbench/*
    -> window.agentParty
         |
         v
Preload / IPC contract
  src/preload/preload.ts
         |
         v
Electron main
  src/main/main.ts
    -> AppController                    shared UI/HTTP use-case boundary
    -> SessionManager                   live harness session ownership
    -> EngineRegistry / EngineConnection
    -> WindowRegistry                   window-to-workspace resolution
         |
         +-> local engine -> Claude / Codex / Cursor adapters
         |
         `-> remote engine transport -> WSL engine server

Automation client
  HTTP -> src/main/automationApi.ts -> the same AppController methods
```

## Source ownership

| Area | Primary files | Owns |
| --- | --- | --- |
| Shared contracts | `src/shared/types.ts`, `src/shared/apiSpec.ts` | Cross-process payloads and the shape of the discoverable API spec |
| Capability table | `src/main/api/methodRegistry.ts`, `src/main/api/routes/*` | The one `(method, params) → handler` list that local HTTP and the mobile link both dispatch |
| Shared policy/model logic | `src/shared/modelCatalog.ts`, `modelIdentity.ts`, `codexPolicy.ts`, `cursorPolicy.ts`, `messageGate.ts` | Pure validation, normalization, and public policy shapes |
| Provider adapters | `src/core/claudeAdapter.ts`, `codexAdapter.ts`, `cursorAdapter.ts` | Provider process/protocol lifecycle and normalized session events |
| Provider support | `src/core/modelRegistry.ts`, `costing.ts`, `codexModelDiscovery.ts`, `subscriptionProxy.ts` | Routing, pricing, discovery, and subscription proxy contracts |
| Party bridge | `src/core/partyBridge.ts`, `cursorPartyPlugin.ts` | Agent-callable party tools and Cursor plugin integration |
| App use cases | `src/main/application/appController.ts` | Public application capabilities shared by UI, HTTP, and Discord |
| Party aggregate | `src/main/application/partyApplicationService.ts`, `partyDomain.ts` | Party/member/message rules, runtime binding, and persisted member settings |
| Named actions | `src/main/application/sessionActions.ts`, `src/main/engine/partyActions.ts` | Extensible session/member action dispatch |
| Session runtime | `src/main/sessionManager.ts`, `src/main/harness/*` | Live sessions, snapshots, events, approvals, and harness factories |
| Engine topology | `src/main/engine/*`, `src/main/engine/transport/*` | Local/remote engine selection, RPC, WSL transport, and engine server |
| Persistence | `src/main/partyRepository.ts`, `settings.ts`, `usageLedger.ts` | On-disk party, settings, and usage state; harness CLIs own their credentials |
| External surfaces | `src/main/automationApi.ts`, `src/main/automation/*`, `discordBridgeService.ts`, `discordControl.ts` | HTTP transport (scope resolution, parameter merging, status codes), the QA-only route adapter, and Discord integration into `AppController` |
| App self-update | `src/shared/appUpdate.ts`, `src/main/updateService.ts` | GitHub release feed, update state machine, and the shared status contract (see docs/RELEASE.md) |
| Electron wiring | `src/main/main.ts`, `windowRegistry.ts`, `preload/preload.ts` | Process lifecycle, windows, IPC registration, and renderer bridge |
| Renderer shell | `src/renderer/App.tsx`, `src/renderer/app/*` | App state, event reduction, navigation, and secondary views |
| Workbench UI | `src/renderer/workbench/*` | Member panels, transcript, composer, approvals, gates, and runtime controls |
| Usage UI | `src/renderer/usage/*` | Token aggregation presentation and cost formatting |
| 디자인 목업 | `src/renderer/preview/*`, `src/shared/partyGroupsGallery.ts` | A built-but-unlinked page that renders the party-group and member-cwd screens from fixtures, so their design can be reviewed without creating a member or mounting a WSL distro |
| 파티 그룹 · 멤버 cwd | `src/shared/partyGroups.ts`, `memberLocation.ts`, `workspaceUri.ts` | App-global party grouping and a member's immutable execution location (env + cwd), sharing one serializer with `WorkspaceLocation` |

## Main flows

### User or automation command

1. A renderer interaction calls `window.agentParty` through
   `src/preload/preload.ts`, or an automation client calls
   `src/main/automationApi.ts`.
2. Both paths invoke a method on
   `src/main/application/appController.ts`.
3. Session commands go to `SessionManager`; party commands go to
   `PartyApplicationService`; engine-scoped commands use `EngineConnection`.
4. State changes are emitted by the owning service and broadcast by
   `src/main/main.ts` to affected windows.

### Party member message

1. `AppController.sendMemberMessage` selects the workspace/party application.
2. `PartyApplicationService.sendUserMessage` validates the member, gate, and
   attachments, and ensures a live member session exists.
3. `SessionManager.sendUserTurn` delegates to the selected harness adapter.
4. Adapter events are normalized to the shared session event contract.
5. The renderer reduces those events in
   `src/shared/transcriptEvents.ts` and renders them in
   `src/renderer/workbench/Transcript.tsx`.

The agent-facing party primer (`buildPartyPrimer` in `src/shared/partyPrimer.ts`,
re-exported from `src/core/partyBridge.ts`) teaches the tool surface, the
member-to-member communication discipline and the queue-versus-interrupt timing
so behavior does not depend on model memory; `scripts/qa-party-bridge.mjs` locks
it. It is a LIST OF SECTIONS, each of which the user can rewrite or switch off in
Settings → 런타임 → 파티 프롬프트 (`AppSettings.partyPrimer`, `GET/POST
/api/party/primer`); `SessionManager.createAdapter` resolves the customization
once and hands the finished text to whichever adapter starts the member. Each
section can also be translated into Korean for review
(`src/core/primerTranslator.ts` → `POST /api/party/primer/translate`); the saved
translation stores a hash of the English it came from, so an edited section
reports its translation stale instead of quietly drifting. That call and the
Message Gate reviewer share one headless transport
(`src/core/headlessModelCall.ts`: subscription-proxy vs router routing, reasoning
fields per wire, measured usage). Which SLOT each harness has for it differs, and
`PARTY_PRIMER_DELIVERY` records that next to the text: system prompt (Claude
Code), developer instructions (Codex), or — where the protocol has neither slot —
in front of the first user turn (Cursor's `cursor-agent`, and Grok's ACP
`session/new`, whose params are only `{cwd, mcpServers}`). Codex
installs it once through `thread/start.developerInstructions` and reapplies the
same thread-scoped override on `thread/resume`, so `turn/start.input` carries
only the user's message and the primer never repeats as conversation history.
Claude appends it to the session system prompt.

### Local versus WSL engine

1. `EngineRegistry` resolves the engine for a serialized workspace location.
2. Windows workspaces use `LocalEngine`.
3. WSL workspaces use `transport/wslEngine.ts` and
   `transport/remoteEngineClient.ts`.
4. The remote process starts at `transport/engineServerEntry.ts` and exposes
   the same engine contract over `transport/rpc.ts`.

### Model and runtime selection

1. Catalog identity and defaults live under `src/shared`.
2. `src/core/modelRegistry.ts` builds routable model entries.
3. `AppController` exposes the current model/harness state.
4. Runtime changes are applied by `SessionManager` and persisted back to the
   owning party member by `PartyApplicationService`.

## Public capability checklist

For every user-visible capability, update all applicable points:

1. `AppController` method.
2. Renderer IPC registration in `src/main/main.ts` and
   `src/preload/preload.ts`.
3. One entry in the capability table under `src/main/api/routes/`. This
   publishes the HTTP endpoint, its `GET /api/spec` declaration, and the mobile
   RPC method in a single edit — set `remote: false` on the entry to keep a
   desktop-local surface off the phone.
4. Contract documentation in `docs/API.md`.
5. Real-app E2E coverage when behavior crosses process or UI boundaries.

UI, HTTP, and Discord adapters must not reimplement the use case.

## Test map

| Test type | Location / command | Intended coverage |
| --- | --- | --- |
| Type and build checks | `npm run typecheck`, `npm run build` | Both TypeScript programs, renderer bundle, main build, engine bundle |
| Focused QA | `scripts/qa-*.mjs`, `npm run test:ui` | Pure contracts, adapters, renderer behavior, and narrow regressions |
| Product E2E | `scripts/e2e-*.mjs`, `npm run test:e2e` | Real Electron process driven through UI or automation HTTP |
| Live provider E2E | `scripts/e2e-live-*.mjs` | Explicit real-provider/model verification; may use paid credentials |

Fixed-port, isolated-user-data E2E tests should use
`scripts/lib/electron-e2e.mjs` for process launch, workspace binding, HTTP
requests, clean shutdown, and failure cleanup.

Keep a focused QA test and an E2E test when they protect different boundaries.
Remove one when it repeats the same inputs, path, and assertions without adding
a process, protocol, or user-visible contract boundary. One-off reproducers and
contract experiments should be removed after their regression is represented
by a maintained test.

## Generated and local-only paths

`dist/`, `dist-renderer/`, `release/`, `release-out/`, `release-pkg/`, and
`node_modules/` are build/dependency outputs, not source ownership boundaries.
Workspace discovery and QA state under `.agentparty/`, `.agent_party_app/`, or
temporary QA workspaces must not be treated as product source.
