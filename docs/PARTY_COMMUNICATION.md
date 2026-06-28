# Party Communication — Technical Design

Status: **agent side implemented (Claude Code, local engine); UI wizard pending**

Implemented: `core/partyBridge.ts` (Boundary 2 interface + `buildPartyToolDefs`),
the `agentparty-app` in-process MCP server in `claudeAdapter` (5 tools,
auto-allowed via `canUseTool`), identity-bound bridge in
`PartyApplicationService`, reasoning persisted on members, and party broadcast on
agent-driven mutations (SessionManager `party` event → `AppController`). Verified
by `npm run test:party-bridge` (30 assertions, in `test:ui`) and **live e2e**
(`scripts/qa-wsl-party-live.mjs`, billed — not in suite): a real Sonnet agent in
the WSL engine called `mcp__agentparty-app__list-models`, was auto-allowed (no
approval prompt), and reported the catalog count back.
Scope: inter-session communication for Agent Party (members talking to each
other, and users/agents managing parties and members).

This document captures the architecture we agreed on before implementation. It
deliberately starts from requirements, *not* from the legacy VS Code extension —
that design is explicitly discarded (see "Why not the legacy design").

---

## 1. Requirements

**User-facing (UI):**
- Create / delete a party
- Create / delete a member
- View member status

**Agent-facing (a "skill"):**
- Create a member
- Delete a member
- View member status
- **Send a message** to another member

Hard constraints from the product owner:
- The agent-facing surface must be *dead simple*: the caller only supplies
  **who to send to, what to send, and a few options** — never ports, paths,
  identity, or any knowledge of how the plumbing works.
- Launching the app means **all infrastructure is already up**.
- **Minimize reliance on the model's "memory"** (no port discovery, no
  identity-guessing). The app already hosts every member and intercepts all of
  its IO, so the capability should be handed *inward*, not reached *outward*.
- Member creation must accept: **name, role, harness, model, reasoning**.

---

## 2. Core principle

> **The app is not something we bolt collaboration onto. The app *is* the
> runtime.** It spawns every member, owns the single in-memory source of truth,
> and intercepts every tool call. So "collaboration" is not external
> messaging — it is a function call inside one process.

The legacy extension was heavy because its members were *mutually foreign
processes*; all its machinery (per-member channel-servers, a disk registry,
port hunting, a GUI bridge, identity resolution) existed only to answer "who am
I?" and "where is the other one?". In this app those questions never arise.

---

## 3. Process model (be precise about this)

Hosting a member spawns a child process. Evidence:
`claudeAdapter.ts` passes `pathToClaudeCodeExecutable` to `sdk.query()` — the
SDK launches the `claude` CLI as a child and drives it over a stdio control
protocol.

```
Process A: Electron main (our app)            Process B: claude CLI (the agent)
──────────────────────────────────            ─────────────────────────────────
 sdk.query() caller = "SDK client"             model loop, Read/Edit/Bash
 AppController, PartyState                      *decides* to call tools
 party tool handlers (our JS)   ◀── IPC ───▶    sends "run this tool" upward
```

- **A ↔ B is genuine IPC** (stdio pipe, JSON control protocol, serialization).
  This is true for *any* tool mechanism.
- The control protocol is **bidirectional**, but control still flows A → B: A
  spawns B, defines the menu of tools, gates every call (`canUseTool`), and can
  kill B. What flows B → A is a **scoped service request** ("please run `send`"),
  not control of A. (Restaurant analogy: B is a customer ordering off a menu A
  wrote; A's kitchen cooks.)

---

## 4. The key decision: in-process MCP vs. general (stdio) MCP

Both look identical to the agent (a `send` tool). The difference is **where the
handler runs and how many boundaries it must cross to reach app state.**

| | General MCP (stdio/remote) | In-process MCP (SDK) |
|---|---|---|
| Handler runs in | a **third, separate process** | **Process A (our app)** |
| Reaching AppController | impossible directly → needs HTTP/port/file | **direct closure access** |
| Identity ("who am I") | unknown → must be re-derived | bound at construction |
| Boundaries to app state | 2 (agent→server, server→app) | 1 (agent→app); then in-memory |
| Lifecycle | spawn/supervise/restart/cleanup | lives & dies with the app |
| Reusable by other clients | yes | no — this app only |

The app **itself becomes the MCP server**. A request arrives over one IPC hop
and is then executed *in place* by our own code against `AppController` /
`PartyState` — it is **not** forwarded to yet another process. That removed
"second boundary" is exactly what deletes ports, registries, identity plumbing,
and discovery files.

**Decision:** in-app members use **in-process MCP** (`createSdkMcpServer`). It
is the only option that satisfies "minimize model memory" — the handler already
lives where identity and state are.

General/out-of-process MCP is reserved for callers we did **not** spawn
(external terminal agents), which physically cannot enter our memory. That is a
separate, later track.

---

## 5. Two abstraction boundaries (the whole extensibility story)

Get these two seams right and the harness becomes pluggable; the core never
changes.

```
        ┌──────────── core (harness-agnostic, never changes) ──────────┐
        │  AppController.sendMessage / createMember / removeMember / …  │
        │  PartyState (single in-memory source of truth) · UI · HTTP    │
        └──────────────────────────────────────────────────────────────┘
              ▲ receive                              ▲ send/manage
   ┌──────────┴──────────┐                ┌──────────┴───────────┐
 Boundary 1               │              Boundary 2              │
 HarnessSession           │              PartyToolBinding        │
 .sendUserTurn(text)      │              "how this harness       │
 = put a message into     │               exposes party tools    │
   a member's session     │               to its agent"          │
        │                 │                       │              │
   Claude   Codex (planned)               Claude            Codex (planned)
   done     impl sendUserTurn         in-process MCP     stdio bridge → HTTP
```

- **Boundary 1 — receiving — already exists.** `HarnessSession` (`harness/types.ts`)
  forces every harness to implement `sendUserTurn(text)`. Delivering a message
  *into* any member is therefore identical across harnesses.
- **Boundary 2 — sending/managing — new.** A small `PartyToolBinding` interface,
  e.g. `attach(session, identity: { party, member })`. Claude implements it with
  `createSdkMcpServer`; Codex would implement it with a stdio bridge. The core
  only knows `binding.attach(...)`.

The **handlers themselves are written once** and shared:
```ts
partyTools = {
  send:         (from, to, content) => appController.sendMessage(to, content, from),
  createMember: (input)            => appController.createPartyMember(workspace, input),
  removeMember: (name)             => appController.removePartyMember(workspace, name),
  list:         ()                 => appController.partySnapshot(workspace),
  listModels:   ()                 => appController.listModels(workspace),  // discovery
}
```

`listModels` exists so the agent can **set harness / model / reasoning itself**
on `createMember`: it returns the available harnesses (with `claude-code`
implemented and `codex` marked planned) and the model catalog with each model's
reasoning options (effort / thinking / budget) and metadata (perf, cost,
context). The agent discovers valid ids and option sets *before* creating,
instead of guessing — keeping "zero model-memory reliance" intact. It reads the
same catalog (`modelCatalog` / `buildModelRoutes`) the UI and routing use.
Per harness, only **how they're exposed** (Boundary 2) differs — never **what
they do** (handlers) or **where they land** (core).

---

## 6. Per-harness matrix

| | receive (message in) | send/manage (tool call) | identity |
|---|---|---|---|
| **Claude Code** (now) | `sendUserTurn` | in-process MCP — zero plumbing | closure (we spawned it) |
| **Codex** (planned, not built) | `sendUserTurn` — **identical** | stdio bridge → HTTP API | `AGENT_PARTY_MEMBER` env we inject at spawn |
| **External agent** (later) | n/a (not our session) | stdio MCP / HTTP + installed skill | env / explicit |

Note: Codex is `status: "planned"` in `harness/types.ts` today; only
`claude-code` (+ mock) is implemented. "Send to a Codex member" already works
the moment a Codex `HarnessSession` exists, because receiving is harness-agnostic.

---

## 7. Data model

```
Party    = a namespace of members (id, name)
Member   = a persistent named identity
           { name, role, harness, model, reasoning, sessionId? }
Session  = the live agent (app-hosted via sdk.query); SessionManager: id → adapter
Message  = { partyId, from, to, content, delivered, targetSessionId }
```

- Authority is the **in-memory `PartyState`**; `partyRepository` persists it to
  `.agent_party_app/` for durability.
- `member.sessionId` is the link from a member to its live session (if "open").

---

## 8. Operation flows (everything routes through AppController)

`send` — the interesting one — **already exists** end-to-end as
`partyApplicationService.sendMessage` (today only UI/HTTP can call it):

```
agent: send({ to:"reviewer", content:"…" })
  → in-process handler stamps from = this session's member ("main")
  → AppController.sendMessage("reviewer", "…", "main")        // same method the UI uses
  → partyApplicationService.sendMessage(...)
  → if target has a live session: sessionManager.sendUserTurn(targetSessionId,
        "<channel source=\"agentparty\" from=\"main\">…</channel>")  // wrapping convention (kept)
     else: RETURN AN ERROR ("member off / not found") — see decisions
```

**`send` is fire-and-forget** (async bus): it returns delivered, it does **not**
wait for the recipient's reply. The reply comes back later as the recipient's
own `send`. When the target has no live session or does not exist, `send`
**returns a clear error** rather than queuing or auto-starting — the caller
decides what to do (e.g. `member-create` it).

`member-create` **creates and auto-starts** the member's session in one call, so
the new member is immediately live and sendable (consistent with the
"offline → error" send policy). `member-remove` / `list` / `listModels` map the
same way to existing `AppController` methods. **The only genuinely new work** is
exposing these to the agent via Boundary 2; routing, state, UI, and HTTP are
reused.

---

## 9. Identity — why the agent never states who it is

We spawned the member's session, so its `ClaudeAdapter` instance knows it is
e.g. `team-alpha/main` at construction time. The in-process handler is a closure
over that fact, so `from` is a **hard-coded truth**, not agent input. The agent
cannot spoof it (security), cannot forget it (reliability), and need not know it
(simplicity). This is where "zero model-memory reliance" comes from.

---

## 10. What is reused vs. new

| Capability | Status | Work |
|---|---|---|
| Party create/select | exists | add delete |
| Member create/remove/status | exists | add `reasoning` field |
| Message routing (`sendMessage`) | **exists** | reuse as-is |
| UI for the above | mostly exists | forms/delete polish |
| **Agent can call the above** | **missing** | **the real work: PartyToolBinding + in-process MCP** |

---

## 11. Why not the legacy design

The legacy `agentparty` MCP (`.mcp.json` → `bun channel-server.ts`) is a general
stdio server bolted onto foreign processes. Its identity resolution, disk
registry, port hunting, and GUI bridge are all costs of being *foreign to the
app*. Our app is the host, so all of that is deleted rather than reimplemented.

---

## 12. Decisions

Resolved:
- [x] **Tool namespace:** `agentparty-app` → `mcp__agentparty-app__send`,
      `…__member-create`, `…__member-remove`, `…__list`, `…__list-models`.
- [x] **Message wrapping:** keep
      `<channel source="agentparty" from="…">…</channel>` (reuse `buildChannelPayload`;
      members' CLAUDE.md already documents handling it).
- [x] **`send` semantics:** fire-and-forget; does not wait for a reply.
- [x] **Target off / not found:** **return an error** ("member is off / not
      found") — no queuing, no auto-start. Caller decides (e.g. create it).
- [x] **Self-send / nonexistent member:** error (never silently dropped).
- [x] **`member-create`:** creates **and auto-starts** the session in one call.
      The **agent sets harness / model / reasoning itself**, discovered via
      `list-models`.
- [x] **Harness scope:** expose **both** `claude-code` and `codex`; selecting
      `codex` returns a "not implemented yet" error (only `claude-code` is built).
- [x] **`list-models` tool (new):** in-process discovery of available harnesses
      + model catalog + per-model reasoning options, so the agent can fill
      `member-create` correctly.
- [x] **Party create/delete:** UI only (not an agent tool); delete cascades
      members + sessions.
- [x] **External-agent track:** deferred (non-goal, §13).

Resolved (round 2):
- [x] **Return shapes:** rich. `list-models` returns harnesses (with
      implemented/planned) + each model's id/label/provider/perf/cost/context and
      reasoning option sets. `list` returns name/role/status/harness/model.
- [x] **Member-create UI:** a **modal step wizard** (name → harness → model →
      reasoning → role/confirm), not a single all-at-once form. Reuses the
      catalog / RuntimeModal reasoning controls per step.

Still open:
- [ ] Status display location/format; delete confirmation UX (during UI round).
- [ ] Queuing policy is moot for now (off = error); revisit if an async inbox is
      wanted later.

---

## 13. Non-goals (for the first cut)

- External (non-app-spawned) agents driving the party — deferred.
- Codex binding — deferred until a Codex `HarnessSession` exists.
- Cross-party messaging — members address their own party only.
