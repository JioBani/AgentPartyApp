# Cursor cross-harness proxy TODO

Status: deferred
Recorded: 2026-07-24

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
