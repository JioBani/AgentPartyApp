# Mobile Link reactivation boundary

Mobile Link is intentionally detached from the desktop product as of v0.10.0.
The desktop does not ship its protocol dependency, start a gateway, publish
`/api/mobile/*`, expose mobile IPC, or render mobile settings.

The implementation is preserved, not rewritten or replaced:

- Desktop gateway code: `src/main/mobile/`, `src/main/mobileLink.ts`, and
  `src/main/mobilePipe.ts` (excluded by `tsconfig.main.json`).
- Shared desktop-side shapes: `src/shared/mobileProtocol.ts`.
- Historical QA and device runners: `scripts/*mobile*.mjs`.
- Last integrated snapshot before detachment: Git commit `4011a82` (the parent
  history of the v0.10.0 detachment commit also contains every mobile change).
- The server-side protocol package remains owned by the AgentPartyServer
  repository. This detachment does not modify or delete it.

## Reactivation checklist

Reactivate through one reviewable feature branch. Do not restore only the UI or
only the dependency; that would recreate a half-enabled product.

1. Restore or upgrade `@agentparty/protocol` in AgentPartyServer and add a
   reproducible package source (never a required dangling local junction).
2. Re-enable the gateway adapter in the main process and remove the three
   Mobile Link exclusions from `tsconfig.main.json`.
3. Restore the shared AppController methods and register the mobile route table
   once so HTTP and any remote transport use the same handlers.
4. Restore preload IPC, the Settings tab, and the connected-device indicator.
5. Restore the mobile API section in `docs/API.md` and expose every restored
   user capability through the automation API.
6. Run the archived unit/contract suites, real desktop E2E, and at least one
   real-device pairing/session test before release.

Existing `settings.json` mobile preferences are retained on disk but hidden and
immutable while the feature is detached. They can seed a future migration after
the reactivated implementation validates their schema.
