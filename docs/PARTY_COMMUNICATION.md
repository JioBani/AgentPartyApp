# Party Communication Technical Design

Status: implemented for local AgentParty sessions.

AgentParty owns the party runtime. The Electron main process creates members,
starts their harness sessions, stores party state, and routes all party messages.
The UI, local automation HTTP API, and harness-facing party tools all converge on
the same AppController methods.

## Goals

- Keep the agent-facing contract small: send to a member, create/start/remove a
  member, list the party, and inspect model options.
- Keep identity app-bound. A spawned member never supplies its own from identity;
  the app binds identity when it creates the session.
- Avoid hidden fallbacks. Missing sessions, failed tool setup, failed MCP startup,
  and provider errors are surfaced through session events, logs, or command
  results.
- Make new harnesses cheap to add by keeping the receive boundary stable.

## Process Model

```text
Electron main process
  AppController
  PartyApplicationService
  SessionManager
  HarnessSession adapter
      |
      +-- Claude Code child session
      +-- Codex app-server child process
```

The app is the source of truth. Child harnesses may request work, but party state
changes are always executed by the app.

## Boundaries

### Boundary 1: receiving messages

All harnesses implement HarnessSession.sendUserTurn(text). Party message delivery
is therefore harness-agnostic:

```text
AppController.sendPartyMessage(...)
  -> PartyApplicationService.sendMessage(...)
  -> SessionManager.sendUserTurn(targetSessionId, channelPayload)
  -> HarnessSession.sendUserTurn(text)
```

This is why Codex support did not require a new party-routing layer.

### Boundary 2: agent-driven party tools

Claude Code exposes party operations through the in-process SDK MCP server in
src/core/partyBridge.ts. Tool handlers are identity-bound closures created by
PartyApplicationService.

Codex currently uses persistent codex app-server JSON-RPC sessions. Party identity
and routing instructions are injected as session context/turn content, and
channel messages arrive through the same sendUserTurn boundary. A direct
Codex-native tool binding can be added later without changing party state or
message routing.

## Codex Harness

Codex is available through src/core/codexAdapter.ts.

- One codex app-server process is kept alive per AgentParty session.
- The adapter calls initialize, then starts or resumes one app-server thread.
- Each user turn is sent with turn/start on that existing thread.
- App-server notifications are normalized into the shared renderer event stream.
- Delta notifications that duplicate completed items are opted out during
  initialization, so final assistant text is rendered once.

This replaces the old codex exec --json/per-turn resume approach. codex exec
remains useful for one-shot batch jobs, but it is not the AgentParty interactive
harness.

## Member Lifecycle

- Creating a party creates main and attempts to init-start it so slash commands
  and skills can populate the palette before the first chat.
- Opening a non-main member only opens its panel.
- Starting a member creates a harness session at the selected project root.
- Sending to a member with no active session records a visible delivery failure
  instead of silently dropping the message.
- Removing a member closes its session, removes it from party state, and deletes
  its member directory.

## Public Control Surface

Every user-facing party action is available through the local automation API and
the UI uses the same controller path:

- POST /api/parties
- POST /api/parties/:id/select
- POST /api/party/members
- POST /api/party/members/:name/open
- POST /api/party/members/:name/start
- POST /api/party/members/:name/send
- POST /api/party/members/:name/close
- POST /api/party/members/:name/remove
- POST /api/party/messages

Keep src/shared/apiSpec.ts and docs/API.md updated whenever this surface changes.

## Test Expectations

- Deterministic full-process smoke: npm run test:e2e.
- Real Codex mini app-server path: npm run test:e2e:live-codex.
- UI changes should be verified with an actual rendered app window or /api/capture
  where possible.
