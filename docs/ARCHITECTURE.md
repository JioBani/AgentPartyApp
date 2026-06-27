# AgentParty App Architecture

The app follows a pragmatic clean architecture split. The goal is to keep behavior easy for AI agents and humans to find, modify, and verify.

## Layers

### Shared contracts

- `src/shared/types.ts`: renderer, IPC, and HTTP payload shapes.
- `src/shared/apiSpec.ts`: single source for the automation API endpoint list.

Change this layer when a public contract changes.

### Core runtime

- `src/core`: provider routing, normalized Claude/Codex event types, and harness-facing utilities.

This layer should not know about Electron, React, IPC, or HTTP.

### Application use cases

- `src/main/application/appController.ts`: one method per app capability.

IPC and HTTP both call this controller. If a feature can be triggered from the UI, it should also be triggerable from the automation API through the same controller path.

### Infrastructure adapters

- `src/main/main.ts`: Electron lifecycle, menu, window creation, IPC channel registration.
- `src/main/automationApi.ts`: local HTTP parsing and route dispatch.
- `src/main/sessionManager.ts`: live harness process/session ownership.
- `src/main/settings.ts`, `src/main/authService.ts`, `src/main/partyRepository.ts`, `src/main/logger.ts`: local persistence and app infrastructure.
- `src/main/application/partyApplicationService.ts`: internal AgentParty party/member/message orchestration. `Party` is the aggregate root. Creating a party creates an idle `main` member, opening a member does not start a harness, and the first chat message starts the member session at the project root before sending input.
- `src/main/runtimeMode.ts`: process mode checks such as E2E.

Adapters should stay thin. They can parse input, call application use cases, and translate output.

E2E mode must not call paid or user-owned external provider APIs. Provider verification is mocked when `AGENTPARTY_E2E=1`; party message E2E checks use unbound members so no harness turn is sent.

### Renderer

- `src/renderer`: React views and design system.
- `src/preload/preload.ts`: safe IPC bridge.

Renderer code should not duplicate business behavior. It requests state or commands through the preload API.

## Feature Change Checklist

1. Add or modify the application method in `AppController`.
2. Expose the capability through IPC in `main.ts` if the renderer needs it.
3. Expose the same capability through HTTP in `automationApi.ts` if it is user-visible or automation-relevant.
4. Add the endpoint to `src/shared/apiSpec.ts` and document it in `docs/API.md`.
5. Add focused E2E coverage in `scripts/e2e-smoke.js` or a more specific test.
6. After implementation, review the changed code against these rules:
   - AI-readable names and small responsibility boundaries.
   - A future behavior change should touch as few files and repeated lines as possible.
   - Extension points should use explicit contracts or maps instead of scattered string conditionals.
   - Workarounds should not hide errors; failures must be logged or surfaced.

If the review finds a violation, refactor before considering the work complete.
