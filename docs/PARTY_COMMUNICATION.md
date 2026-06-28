# Party Communication — Technical Design

Status: **design agreed, implementation pending**
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
}
```
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
        "<channel from=\"main\">…</channel>")                 // wrapping convention
     else: queue on the member (delivered=false)
```

`member-create` / `member-remove` / `list` map the same way to existing
`AppController` methods. **The only genuinely new work** is exposing these to
the agent via Boundary 2; routing, state, UI, and HTTP are reused.

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

## 12. Open decisions (to be finalized)

- [ ] Tool namespace name the agent sees (avoid colliding with legacy
      `agentparty`). Candidates: `party`, `roster`, `partyline`, `agentparty-app`.
- [ ] Message wrapping into the target session: keep
      `<channel source="agentparty" from="…">…</channel>` convention or a new marker.
- [ ] Queuing policy when the target member has no live session.
- [ ] Behavior for self-send / send to a nonexistent member.
- [ ] Scope: external-agent (HTTP + installed skill) track — now or later.
- [ ] Per-feature decisions for member-create (reasoning UI reuse), delete
      confirmations, status shape.

---

## 13. Non-goals (for the first cut)

- External (non-app-spawned) agents driving the party — deferred.
- Codex binding — deferred until a Codex `HarnessSession` exists.
- Cross-party messaging — members address their own party only.
