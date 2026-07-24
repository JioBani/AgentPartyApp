# Cursor cross-harness proxy TODO

Status: IMPLEMENTED (2026-07-24) — in AgentParty's own embedded router, not CLIProxyAPI
Recorded: 2026-07-24

## Implementation (what actually shipped)

The gateway is AgentParty's own `EmbeddedHarnessRouter` (`src/core/routerShim.ts`),
NOT a CLIProxyAPI plugin: the router already dispatches per catalog target, runs
on both hosts (desktop and distro engine — so the bridge naturally executes
where the cursor-agent login lives), and adding a target kind kept everything in
this codebase. Pieces:

- `src/core/cursorAcp.ts` — minimal ACP JSON-RPC client over `cursor-agent acp`
  stdio + a per-conversation warm-session pool (session/new costs ~5-7s).
  Conversation key = the harness's per-session router token
  (`agentparty-native-session:<id>`), giving exact session affinity for free.
- `src/core/cursorHarnessBridge.ts` — Anthropic Messages ⇄ ACP state machine
  with FULL tool round-trips: the harness's tools are mirrored to the agent as
  MCP tools via a relay stub (`scripts/agentparty-acp-mcp-relay.mjs`, spawned by
  cursor-agent, calling back over loopback `/acp-bridge/*`); an agent tools/call
  becomes a `tool_use` response block; the harness's `tool_result` resolves the
  held relay call while the ACP turn stays in flight. SSE synthesis included.
- Catalog: provider `"cursor"` + `cursorAcpModelId` (variants are baked into the
  ACP id, e.g. `grok-4.5[effort=high,fast=true]`) → router target kind
  `cursor-subscription`. First entry: "Grok 4.5 (Cursor)".

Measured constraints that shaped the design:

- Cursor's MCP client times out a tools/call at ~60s, silently RETRIES, and
  sends no `progressToken` (keepalive impossible; the timeout lives in the
  native core — no config knob found). The bridge therefore holds a relay call
  ≤45s and answers "STILL RUNNING — call again"; the model re-calls until the
  real result arrives. A 130s execution verified end-to-end.
- `session/new` returns the LIVE model catalog (31 models incl. every variant),
  which satisfies "discover live model IDs" with zero scraping.
- Parallel tool calls arrive within milliseconds of each other → batched into
  one multi-`tool_use` response (250ms window).
- Verified through the real app (WSL distro engine, real Cursor Pro login):
  Claude Code harness member on "Grok 4.5 (Cursor)" ran Read/Write/Bash/Grep/
  Edit chains, error results round-tripped, streaming + cancel + session reuse
  all pass. Stub QA: `scripts/qa-cursor-acp-bridge.mjs` (fake cursor-agent).

Still open (deliberately):

- Model advertisement is not yet gated on cursor-agent auth: an unauthenticated
  host fails with an explicit ACP error instead of hiding the model.
- ~~Images~~ RESOLVED: ACP accepts base64 image prompt blocks (verified live —
  grok answered a generated red PNG with "red"); the bridge forwards Anthropic
  image blocks as ACP image blocks and the catalog declares vision.
- Cost/usage attribution for bridge turns (Cursor plan usage covers it).
- The double-agent semantic (cursor-agent's own persona around the bridged
  system prompt) is mitigated by a preamble, not eliminated.

Everything below this line is the original research record.

---

## Goal

Expose Cursor subscription models, including Cursor Grok 4.5 reasoning and Fast
variants, through the same local CLIProxyAPI gateway already used for Codex and
Claude subscription cross-harness routing. Do not add a second user-facing proxy
port or an independently managed proxy service.

## Recommended implementation

- Add a Cursor `ProviderExecutor` plugin to CLIProxyAPI.
- Use the official Cursor Agent CLI's persistent ACP transport internally.
- Reuse the existing Cursor login rather than implementing or storing a second
  Cursor credential format.
- Keep CLIProxyAPI as the only HTTP compatibility gateway.
- Route OpenAI Responses, OpenAI Chat Completions, and Anthropic Messages
  through the same protocol translation and model-routing layer.
- Run cross-harness requests in an isolated chat-only workspace by default.
  Reject Cursor-side file/tool permission requests so the calling harness owns
  tool execution and approval.
- Keep AgentParty's native Cursor harness path separate; it may continue using
  Cursor agent mode and AgentParty's normal permission/message bridge.
- Surface authentication, model availability, ACP startup, timeout, and
  translation failures explicitly. Do not fall back silently to another model
  or provider.

## Prior-art assessment

- `anyrobert/cursor-api-proxy` (MIT): preferred reference for Cursor CLI/ACP
  execution and OpenAI/Anthropic compatibility. Do not import it wholesale
  without resolving its dependency audit findings and Windows path test.
- `alfons-fhl/Cursor-Plan2API` (MIT): reference for Grok 4.5 model variants,
  session handling, and wider endpoint coverage.
- `AmazingAng/auth2api`: research reference only. Its Cursor path uses
  reverse-engineered, non-public `api2.cursor.sh` Connect-RPC/protobuf APIs and
  currently has no explicit license. Do not copy or ship that implementation.

## Evidence already collected

Using the installed Cursor Agent CLI and the current Cursor Pro login,
`cursor-api-proxy` was built in a temporary directory and called through its
HTTP compatibility API:

- `POST /v1/chat/completions`
  - model: `cursor-grok-4.5-high-fast`
  - exact response: `BRIDGE_OK`
- `POST /v1/messages`
  - model: `cursor-grok-4.5-high-fast`
  - exact response: `ANTHROPIC_BRIDGE_OK`
- Upstream test suite: 233 of 234 tests passed. The single failure was a
  Windows path-separator assertion.
- `npm audit` reported four dependency findings (one low, two high, one
  critical), so dependencies must be audited before reuse.

These calls prove basic Cursor Pro cross-harness proxying is feasible. They do
not prove full Claude Code or Codex behavioral parity.

## Required product work

- Implement Cursor provider lifecycle and ACP session pooling in the unified
  gateway.
- Discover live Cursor model IDs and preserve exact reasoning/Fast variants.
- Map model settings without guessing:
  - reasoning: Low, Medium, High
  - service tier: Standard, Fast
- Preserve streaming cancellation and backpressure.
- Define deterministic multi-turn/session affinity.
- Translate tool calls and tool results without flattening away call IDs.
- Prevent double execution when both Cursor agent mode and the client harness
  expose tools.
- Propagate usage and provider errors with visible diagnostics.
- Add AppController methods for every user-visible operation, register their
  automation endpoints in `src/shared/apiSpec.ts`, and document them in
  `docs/API.md`.

## Acceptance criteria

- One local compatibility gateway and one public proxy port.
- Cursor is advertised only when the CLI is installed, authenticated, and the
  selected model is live.
- Real-provider E2E passes for every Grok 4.5 reasoning/Fast variant requested
  by the catalog.
- Real Claude Code cross-harness E2E covers:
  - non-streaming and streaming text
  - multi-turn context
  - tool use/result round trip
  - permission denial and approval ownership
  - interrupt/cancel and recovery
  - cross-member message delivery
- Real Codex cross-harness E2E covers the equivalent Responses API workflow.
- No silent model/provider fallback.
- Native Cursor harness behavior remains unchanged.
- Changed code passes the repository's architecture and AI-readability review.
