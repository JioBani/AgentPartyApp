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

#### Delivery timing (queued vs interrupt)

A member handles ONE turn at a time. A party message delivered while the recipient
is mid-turn is **queued**: it is only read after the current turn finishes — for a
Codex member, at its next tool call. This is the single most common source of an
agent feeling its turns are "tangled": it sends a message and expects an instant
reply, but the recipient is still finishing earlier work and picks the message up
in order once free. The message is not lost.

When a message genuinely cannot wait, `send`/`broadcast` accept `interrupt: true`
(and the `interrupt` tool exists standalone) to stop the recipient's current turn
first so the message is handled immediately. `member-status` reports whether a
member is busy, so an agent can decide between queueing and interrupting. The
agent-facing primer (`buildPartyPrimer`) teaches all of this so the behavior does
not depend on model memory; it is locked by `scripts/qa-party-bridge.mjs`.
Codex installs that primer once through `thread/start.developerInstructions`
(and reapplies the same thread-scoped override on `thread/resume`); ordinary
`turn/start.input` contains only the user's message, so the primer never repeats
as conversation history. Claude appends it to the session system prompt.

### Boundary 2: agent-driven party tools

Claude Code exposes party operations through the in-process SDK MCP server in
src/core/partyBridge.ts. Tool handlers are identity-bound closures created by
PartyApplicationService.

`member-create` accepts an explicit initial `permissionMode` or `codexPolicy`.
`member-permission` lets a member change another member's persisted permission;
both Claude and Codex tool implementations route it through the same
`PartyApplicationService.setMemberPermission` method.
`send`/`broadcast` also accept `force: true` + `forceReason` to bypass the
**Message Gate** (the delivery-time reviewer of a member's OUTGOING messages —
see `docs/MESSAGE_GATE.md`); a gate rejection comes back as `{ok:false, error:<reason>}`
so the sender rewrites. `gate-set` lets a member set another member's gate
(`mode` inherit|on|off, `rule`, `reviewer {model,effort}`; `null` clears an axis
to inherit) via `PartyApplicationService.setMemberGate`. The session primer
(`buildPartyPrimer`) teaches all of this so a member knows its outgoing messages
may be reviewed and how to respond. `list-models` reports each
route's concrete `executionHarness` and the permission schema/defaults. A
cross-routed model never changes this value: Claude Code + GPT keeps Claude
permission modes, while Codex + Claude keeps Codex sandbox/approval policy.
The same invariant applies to the wire contract: Claude Code always emits
Anthropic Messages and Codex always emits Responses. Provider/model routing may
change credentials and the concrete model id, never the harness conversation,
tool, or interruption protocol.

Codex uses persistent codex app-server JSON-RPC sessions. Current Codex builds
load model-visible tools through `mcp_servers.*`, so AgentParty starts each
Codex party session with an inline `mcp_servers.agentparty-app` stdio MCP
configuration. That local MCP server routes every tool call back into the app's
local automation HTTP API, which reaches the same AppController /
PartyApplicationService paths as the UI. It supplies the spawning party id in
the `x-agentparty-party` header, so switching the desktop window to another
party cannot redirect a live Codex member's tools to the wrong party.

## Codex Harness

Codex is available through src/core/codexAdapter.ts.

- One codex app-server process is kept alive per AgentParty session.
- The adapter calls initialize, then starts or resumes one app-server thread.
- Party tools are registered as a per-session `agentparty-app` MCP server via
  Codex inline `-c mcp_servers.agentparty-app.*` config, without editing the
  user's `~/.codex/config.toml`.
- The `agentparty-app` MCP server is a local stdio process that calls the app's
  automation API, so UI, HTTP, Claude tools, and Codex tools converge on the
  same controller/service methods.
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
- POST /api/party/members/:name/permission
- POST /api/party/members/:name/gate        (Message Gate override: mode/rule/reviewer)
- POST /api/parties/:id/gate                (party-wide Message Gate: enabled/rule)
- POST /api/party/members/:name/close
- POST /api/party/members/:name/remove
- POST /api/party/messages                  (member send is gated; force/forceReason to bypass)

Keep src/shared/apiSpec.ts and docs/API.md updated whenever this surface changes.

## Test Expectations

- Deterministic full-process smoke: npm run test:e2e.
- Real Codex mini app-server path: npm run test:e2e:live-codex.
- UI changes should be verified with an actual rendered app window or /api/capture
  where possible.
