# AgentParty App Architecture

The app follows a pragmatic clean architecture split. The goal is to keep behavior easy for AI agents and humans to find, modify, and verify.

For the current module index and end-to-end call flows, see
[`CODEMAP.md`](CODEMAP.md).

## Layers

### Shared contracts

- `src/shared/types.ts`: renderer, IPC, and HTTP payload shapes.
- `src/shared/apiSpec.ts`: the shape of the automation API's self-description. The endpoint and method lists inside it are derived from the capability table below, not written by hand.
- `src/shared/appUpdate.ts`: release feed address and the update status/release contract.

Change this layer when a public contract changes.

### Core runtime

- `src/core`: provider routing, normalized Claude/Codex event types, and harness-facing utilities.
- `src/core/claudeAdapter.ts`, `src/core/codexAdapter.ts`: concrete harness adapters behind the shared `HarnessSession` contract. Codex uses `codex app-server` JSON-RPC, keeps one app-server process per AgentParty session, and normalizes thread/turn notifications into the same renderer event stream.

This layer should not know about Electron, React, IPC, or HTTP.

### Application use cases

- `src/main/application/appController.ts`: one method per app capability.
- `src/main/application/sessionActions.ts`: named session action dispatch for `/api/sessions/:id/:action`.
- `src/main/application/partyDomain.ts`: pure party/member/message creation and normalization rules.

IPC and HTTP both call this controller. If a feature can be triggered from the UI, it should also be triggerable from the automation API through the same controller path.

### Infrastructure adapters

- `src/main/main.ts`: Electron lifecycle, menu, window creation, IPC channel registration.
- `src/main/api`: the capability table — one `(method, params) → handler` list, grouped by domain under `api/routes/`, that the local HTTP server and a paired phone's RPC both dispatch. A capability registered here cannot behave differently on the two transports because there is only one handler.
- `src/main/automationApi.ts`: local HTTP transport — window/party scope resolution, parameter merging, and status codes.
- `src/main/automation`: shared HTTP mechanics and the QA-only route adapter (QA scaffolding fabricates state for tests, so it stays out of the capability table and off the mobile link).
- `src/main/sessionManager.ts`: live harness process/session ownership.
- `src/main/settings.ts`, `src/main/authService.ts`, `src/main/partyRepository.ts`, `src/main/logger.ts`: local persistence and app infrastructure.
- `src/main/application/partyApplicationService.ts`: internal AgentParty party/member/message orchestration. `Party` is the aggregate root. Creating a party creates `main` and immediately init-starts its session so slash commands and skills can be discovered for the palette. Opening non-main members does not start a harness; their first chat message starts the member session at the project root before sending input.
- `src/main/updateService.ts`: app self-update against the public releases repo — check/download/install state and the published release list.
- `src/main/runtimeMode.ts`: process mode checks such as E2E.
- `src/main/engine/partyActions.ts`: named member action dispatch for `/api/party/members/:name/:action`.

Adapters should stay thin. They can parse input, call application use cases, and translate output.

E2E mode must not call paid or user-owned external provider APIs. Provider verification is mocked when `AGENTPARTY_E2E=1`; `main` init is allowed for skill discovery, and party message E2E checks should use non-main unbound members when no harness turn should be sent.

### Renderer

- `src/renderer`: React views and design system.
- `src/preload/preload.ts`: safe IPC bridge.

Renderer code should not duplicate business behavior. It requests state or commands through the preload API.

## Feature Change Checklist

1. Add or modify the application method in `AppController`.
2. Expose the capability through IPC in `main.ts` if the renderer needs it.
3. Add one entry to the capability table under `src/main/api/routes/` if the capability is user-visible or automation-relevant. That single entry serves the HTTP endpoint, its `GET /api/spec` declaration, and the mobile-link RPC method; set `remote: false` on it for desktop-local surfaces (window chrome, screen capture) that make no sense from a phone.
4. Document the endpoint in `docs/API.md`.
5. If the capability pushes state to the renderer, register the push channel in `main.ts` and subscribe in `preload.ts` + `App.tsx` (see `update:status`).
6. Add focused E2E coverage in `scripts/e2e-smoke.js` or a more specific test.
7. After implementation, review the changed code against these rules:
   - AI-readable names and small responsibility boundaries.
   - A future behavior change should touch as few files and repeated lines as possible.
   - Extension points should use explicit contracts or maps instead of scattered string conditionals.
   - Workarounds should not hide errors; failures must be logged or surfaced.

If the review finds a violation, refactor before considering the work complete.
