# AgentParty Automation API

AgentParty Desktop exposes every app action through a local HTTP API for debugging, E2E tests, and AI-agent automation.

Default base URL:

```text
http://127.0.0.1:47831
```

If the port is already in use, the app binds to a free local port. The current URL is available in the app inspector and from `GET /api/health`.

## Rules

- The API is local only: it binds to `127.0.0.1`.
- Request and response bodies are JSON.
- Every new UI or app capability must add an API endpoint here.
- Every endpoint call is logged to the app log file.

## Discovery

### `GET /api/health`

Returns current app state, router URL, automation URL, and log file path.

### `GET /api/spec`

Returns a machine-readable list of supported endpoints.

### `GET /api/state`

Returns settings, auth provider states, sessions, model routes, harnesses, router status, logs, and AgentParty member state.

Each session's live `snapshot` carries the harness runtime status. Two fields drive
the per-member **context-capacity meter** (all harnesses):

- `contextTokens` — current context-window occupancy in tokens (the last turn's
  prompt + generation). **Non-cumulative**: it drops after a `/compact`, so it
  reflects "how full is the context right now", not a running bill. Absent until
  the first turn reports usage.
- `contextWindow` — the model's window size in tokens, when the harness reports it
  numerically (Codex). When absent, clients resolve the window from the model
  catalog `context` string (`"1M"`, `"200K"` → `parseContextTokens`). When neither
  is known, the meter shows `contextTokens` alone with no ratio — never a guessed
  denominator.

For a member with **no live session yet** (a closed member, or a freshly reopened
app), the live `snapshot` is absent, so the meter falls back to the member's
persisted **last-known occupancy** — `member.lastContextTokens` /
`member.lastContextWindow`, captured from its previous turn. Clients render this
as **stale** (dimmed, `~`-prefixed) so a user can gauge what an old chat will cost
before sending the first message, without mistaking it for a live reading. The
next turn overwrites it with the fresh `snapshot` value.

### `GET /api/logs`

Returns the active log file path.

### `POST /api/capture`

Captures the current Electron window and stores it as a PNG. If `path` is omitted, the file is written next to the current log file.

```json
{ "path": "C:\\tmp\\agentparty-capture.png" }
```

Optional `scrollY` scrolls a long screen before capturing, so a below-the-fold
section (e.g. the Token Usage tables) can be screenshotted over HTTP without
resizing the window. Pass a pixel offset or the string `"bottom"`; `scrollSelector`
overrides the scrolled element (default `.program-scroll`). `scrollX` (pixels or
`"right"`, with `scrollSelector`) scrolls a wide element horizontally — e.g. to
test a frozen first column. Optional `theme`
(`"light"`|`"dark"`) flips the active theme before capturing, for both-theme
fidelity shots. Optional `click` (CSS selector) dispatches a click before
capturing, so an interactive state can be shot — e.g. the Token Usage compare
toggle `[data-tu=compare-toggle]` or a member drill-in row
`[data-tu=member-row][data-member=backend]`.

```json
{ "path": "C:\\tmp\\lower.png", "scrollY": 900, "theme": "dark", "click": "[data-tu=compare-toggle]" }
```

## Settings

### `POST /api/settings`

Updates app settings.

`transcriptFontScale` is the session/transcript text zoom (1 = 100%, clamped
0.6–2.0). In the UI it is driven by Ctrl+wheel over a session view; over HTTP it
is a plain setting, e.g. `{"transcriptFontScale": 1.3}`. It applies on the next
window load (or immediately in the window that changed it).

Member-creation defaults are **per harness** (`harnessDefaults`), not global: each
harness owns its own default model/effort/reasoning and its harness-appropriate
permission config (`permissionMode` for Claude Code, `codexPolicy` for Codex,
and `cursorPolicy` for Cursor). `selectedHarnessId` is the harness a brand-new member defaults to. A new
member is created from ITS harness's defaults (a Codex member gets the Codex
default model + sandbox policy, a Claude member the Claude default + permission
mode). Selecting a GPT model on Claude Code keeps the Claude Code harness and
its `permissionMode`; only the model transport is routed through the local
Codex/ChatGPT subscription proxy.
A legacy settings.json with flat `claudeModel`/`claudeEffort`/
`claudePermissionMode` is migrated into `harnessDefaults["claude-code"]` on load.

`gateDefaults` is the **Message Gate** reviewer default — `{ "model", "effort" }`
only (NO harness; the reviewer runs headless). Any gate-on member that has not
set its own reviewer uses this. Recommended: a cheap/fast model, e.g.
`{ "gateDefaults": { "model": "GPT-5.6 Terra", "effort": "low" } }` — the
built-in default, picked on measured accuracy rather than price. See the Message
Gate endpoints below and `docs/MESSAGE_GATE.md`.

Example:

```json
{
  "selectedHarnessId": "claude-code",
  "harnessDefaults": {
    "claude-code": { "model": "MiniMax M3", "effort": "medium", "permissionMode": "plan" },
    "codex": { "model": "gpt-5.5", "effort": "medium", "codexPolicy": { "sandbox": "read-only", "approval": "on-request", "guardian": false } },
    "cursor": { "model": "Grok 4.5", "effort": "high", "cursorPolicy": { "mode": "agent", "approval": "allowlist" } }
  },
  "debugEnabled": true
}
```

Claude Code permission modes:

```text
default, acceptEdits, plan, auto, dontAsk, bypassPermissions
```

Codex `codexPolicy` axes: `sandbox` = `read-only | workspace-write | danger-full-access`;
`approval` = `untrusted | on-request | never`; `guardian` = route approvals through a reviewer.

Cursor `cursorPolicy` mirrors Cursor CLI's separate controls:
`mode` = `agent | ask | plan`; `approval` =
`allowlist | auto-review | unrestricted` (`unrestricted` is displayed as
**Run Everything** and maps to `--force`).

## Authentication

### `POST /api/auth/openrouter`

Stores an OpenRouter API key.

```json
{ "key": "sk-or-..." }
```

### `DELETE /api/auth/openrouter`

Clears the stored OpenRouter API key.

### `POST /api/auth/openrouter/test`

Calls OpenRouter's model endpoint to verify the configured key.

When `AGENTPARTY_E2E=1`, this endpoint returns a mocked verification result and does not call OpenRouter.

### `GET /api/auth/subscriptions`

Ensures the local subscription bridge is running, queries its authoritative
model surface (default `http://127.0.0.1:8317/v1/models`), and reports
Codex/ChatGPT and Claude OAuth availability separately. AgentParty starts the
bridge on launch and monitors it after launch. Provider refresh tokens remain in
CLIProxyAPI's persistent auth directory, so no service command or repeated login
is required after the browser approval. Failures are returned explicitly; this
endpoint never falls back to OpenRouter.

```json
{
  "ok": true,
  "baseUrl": "http://127.0.0.1:8317/v1",
  "service": { "status": "ready", "managed": true, "detail": "..." },
  "codex": { "available": true, "models": ["gpt-5.4-mini"], "loginCommand": "... -codex-login" },
  "claude": { "available": false, "models": [], "loginCommand": "... -claude-login" },
  "authentication": {}
}
```

### `POST /api/auth/subscriptions/:provider/login`

Starts the same one-time browser OAuth action exposed by the Authentication
screen. `:provider` is `codex` or `claude`. The response includes both the raw
subscription bridge state and the same `auth` provider list rendered by the UI.
While approval is pending, poll `GET /api/auth/subscriptions` or `GET /api/state`.

```json
{
  "ok": true,
  "provider": "claude",
  "status": "started",
  "detail": "Complete the Claude approval in the browser.",
  "subscriptions": { "authentication": { "claude": { "status": "pending" } } },
  "auth": [{ "id": "claude", "status": "pending" }, { "id": "codex", "status": "available" }, { "id": "openrouter", "status": "configured" }]
}
```

The approval is the only user action. On later launches AgentParty reuses the
stored OAuth refresh token and automatically starts/reconnects the local bridge.
If the bridge is absent on the first connection, AgentParty downloads the
official Windows release, requires its GitHub-published SHA-256 digest to match,
installs it under app data, and then opens OAuth. A failed download or digest
mismatch is returned visibly and no executable is launched.

### `DELETE /api/auth/subscriptions/:provider`

Disconnects the account for `:provider` (`codex`, `claude`, or `cursor`).

For `cursor`, AgentParty runs `cursor-agent logout` on the **desktop host** and
verifies the CLI reports an unauthenticated state afterwards. A WSL distro's own
Cursor login is that host's credential and is not touched. The response carries
`{ ok, provider: "cursor", status: "disconnected", detail, auth }`.

For `codex`/`claude` (the subscription bridge accounts):
The active credential files are moved out of CLIProxyAPI's watched auth
directory into AgentParty's recoverable app-data backup, then model discovery
verifies that the provider is no longer available. The response includes
`removedCredentials`, updated `subscriptions`, and the same `auth` provider list
rendered by the Authentication screen. A visible error is returned if no
matching credential exists or another credential source still exposes models.
For Codex, `runtimeAuthentication` reports the native-engine propagation result
for every active local/WSL engine (`changed`, `connected`,
`restartedSessions`, `deferredSessions`). AgentParty writes the selected bridge
OAuth account to each engine host's native Codex credential store. Idle live
sessions restart Codex app-server and resume the same thread immediately;
sessions with an active turn defer that restart until the turn completes. Each
affected session records one visible authentication-change diagnostic for that
credential generation. OAuth tokens are internal and are never returned by the
HTTP API.

Override the local deployment with `AGENTPARTY_SUBSCRIPTION_PROXY_URL` and
`AGENTPARTY_SUBSCRIPTION_PROXY_KEY`. `AGENTPARTY_SUBSCRIPTION_PROXY_BIN` and
`AGENTPARTY_SUBSCRIPTION_PROXY_CONFIG` override local binary/config discovery.
The default key is a loopback client key, not an OpenAI or Anthropic credential.

## Discord bridge

Lets one member report to (and be instructed from) a Discord channel, so the user
can follow a run from a phone or another PC without exposing the app to the
network. Design: `docs/기획 노트.md` §11.

Deliberate limits — these are the design, not gaps:

- **Text only.** No buttons, select menus, modals or uploads.
- **No throttling here.** A Discord 429 is returned to the caller with
  `retry_after_ms`; nothing is queued or retried for you.
- **2000 characters max.** Longer content is rejected, never truncated.
- **Inbound is whitelist-only.** A message from a Discord user id that is not in
  `allowedUserIds` is dropped and logged. An empty list allows nobody.

The bot token is stored in `settings.json` (outside the repo) and only ever read
back masked. For development it can also come from `DISCORD_BOT_TOKEN` (and
`DISCORD_USER_ID` / `DISCORD_GUILD_ID`) via the environment or a `.env` next to
the app; stored settings win over the environment.

### `GET /api/discord`

Bridge status. Never returns the token itself.

```json
{
  "configured": true,
  "connection": "connected",
  "botUser": { "id": "1530586029264867499", "username": "AgentParty" },
  "guildId": "1530584277505544343",
  "tokenMask": "********wxyz",
  "allowedUserIds": ["1530583970272514279"],
  "bindings": [
    { "workspacePath": "C:/work", "party": "party-1", "member": "reporter",
      "channelId": "1530587845813731339", "channelName": "reporter" }
  ]
}
```

`connection` is `off | connecting | connected | error`; on `error` an `error`
field carries the reason (a dead bridge must be visible, not silent).

### `POST /api/discord/settings`

Body (all optional): `botToken`, `guildId`, `allowedUserIds` (array of Discord
user ids). Returns the same shape as `GET /api/discord`. Changing the token or
guild drops the gateway so the next connect re-authenticates.

Leave `guildId` empty to auto-detect — allowed only when the bot is in exactly
one server; with several the call fails and lists them rather than guessing.

### `POST /api/party/members/:name/discord/connect`

Gives that member its own text channel (creating it, or reusing one with the same
name) and starts inbound delivery. Body: `{ "channelName": "optional-override" }`.
Returns `{ ok, channel, channelId, created }`. Same operation as the member's own
`discord-connect` tool.

### `POST /api/party/members/:name/discord/send`

Body: `{ "content": "text" }`. Posts as that member. Fails with the reason when
the content is over the limit or Discord rate limits the request.

### `POST /api/party/members/:name/discord/disconnect`

Stops bridging that member. The channel and its history remain in Discord.
Returns `{ ok, removed }`.

## Models

### `GET /api/models`

Returns the selectable model routes, harness permission contracts/defaults, and
the Codex catalog discovery state. Every route reports `executionHarness`, which
is the actual selected harness process and therefore matches `harnessId` even
for cross-routed models.

`modelProviders` is the shared provider contract used by Authentication and the
Workbench model groups. It contains Claude, Codex, Cursor, and OpenRouter;
`routeProviderId` maps the stable product identity to the internal
catalog route id used by each `modelRoutes` item.

```json
{
  "ok": true,
  "modelProviders": [{ "id": "claude", "label": "Claude", "routeProviderId": "anthropic", "authProviderId": "claude", "authKind": "subscription" }, { "id": "codex", "label": "Codex", "routeProviderId": "openai", "authProviderId": "codex", "authKind": "subscription" }, { "id": "cursor", "label": "Cursor", "routeProviderId": "cursor", "authProviderId": "cursor", "authKind": "subscription" }, { "id": "openrouter", "label": "OpenRouter", "routeProviderId": "openrouter", "authProviderId": "openrouter", "authKind": "apiKey" }],
  "modelRoutes": [{ "harnessId": "claude-code", "executionHarness": "claude-code", "model": "GPT-5.4 mini", "runtimeModel": "claude-gpt-5.4-mini", "label": "GPT-5.4 mini", "permission": { "kind": "permissionMode", "default": "default" } }],
  "harnesses": [
    { "id": "claude-code", "status": "available", "permission": { "kind": "permissionMode", "options": ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"], "default": "default" } },
    { "id": "cursor", "status": "available", "permission": { "kind": "cursorPolicy", "mode": ["agent", "ask", "plan"], "approval": ["allowlist", "auto-review", "unrestricted"], "default": { "mode": "agent", "approval": "allowlist" } } }
  ],
  "codexModels": { "status": "ready", "models": [{ "model": "gpt-5.5", "isDefault": true }], "at": "2026-07-03T00:00:00.000Z" }
}
```

Codex routes come from two sources (see `docs/codex-ux-research/07-model-routing.md`):

- **Account catalog** — a live `codex app-server` `model/list` discovery (the
  authenticated OpenAI account's models, e.g. `gpt-5.5`). Discovery runs once per
  app run in the background; until it settles the state is `pending` and a single
  static fallback route (`gpt-5.4`) represents the codex harness. A failure (e.g.
  codex CLI not installed) is reported as `{ "status": "error", "error": "..." }`
  — never silently hidden. When `AGENTPARTY_E2E=1` and no `AGENTPARTY_CODEX_BIN`
  override is set, discovery is skipped with an explicit error state so tests
  never reach user-owned APIs.
- **OpenRouter models** — every OpenRouter catalog model is also exposed as a
  codex route (`"harnessId": "codex"`, `"modelProvider": "openrouter"`, `"model"`
  = the OpenRouter slug such as `z-ai/glm-5.2`). Starting such a member routes
  `codex app-server` to OpenRouter via inline provider config (no `config.toml`
  edit) and bills the configured **OpenRouter API key** (not the Codex
  subscription). Selecting one without an OpenRouter key configured fails
  explicitly at session start.
- **Claude subscription models** are exposed as Codex routes with
  `"modelProvider": "claude-subscription"` and the exact CLIProxyAPI Claude
  model id. They use the local Claude OAuth credential rather than OpenRouter.

Cross-routing keeps the chosen harness process intact:

- **Claude Code + GPT** uses the Claude Code SDK with its `claude-gpt-*` alias;
  the embedded gateway keeps the request as Anthropic Messages and maps only the
  alias to the corresponding GPT model on local CLIProxyAPI's `/v1/messages`
  surface. It uses Claude permission modes and the signed-in Codex/ChatGPT subscription.
- **Codex + Claude** uses Codex app-server with
  `modelProvider: "claude-subscription"` and a CLIProxyAPI Claude model id. Its
  wire protocol remains Responses; it uses Codex sandbox/approval policy and the
  signed-in Claude subscription.
- **Cursor CLI** exposes `Auto` and `Grok 4.5` routes with
  `"harnessId":"cursor"`. Auto passes the literal `auto` slug and lets Cursor
  choose an opaque underlying model. Grok effort maps to Cursor's current
  named-model slugs (`cursor-grok-4.5-low|medium|high`). AgentParty never changes
  a selected Grok route to Auto after a plan error.
- **Claude Code + Cursor subscription** (`"Grok 4.5 Cursor"`, label
  "Grok 4.5 (Cursor)") keeps the Claude Code SDK process and routes the
  `claude-cursor-grok-4-5` alias through the embedded gateway's Cursor ACP
  bridge: a warm `cursor-agent acp` session serves the turns, and the harness's
  own tools are mirrored to the agent over a local MCP relay so tool_use /
  tool_result round-trips work end-to-end (multi-step chains included). Runs on
  the host that owns the workspace's harness (distro CLI for WSL). Requires a
  signed-in cursor-agent there; an unauthenticated host fails with an explicit
  error — no fallback. Image attachments are forwarded as ACP image blocks
  (verified live). See `docs/CURSOR_PROXY_TODO.md`.

### `GET /api/harnesses/cursor/status`

Runs read-only Cursor CLI diagnostics and returns the discovered installation,
version, Grok 4.5 slugs, and the CLI's login state (`status --format json`). The
inspection runs on the host that actually executes the harness for the request's
workspace — for a WSL workspace that is the **distro's** CLI, not the Windows
install. It does not return Cursor credentials or make a model call.

```json
{
  "installed": true,
  "version": "2026.07.20-8cc9c0b",
  "grok45Models": ["cursor-grok-4.5-low", "cursor-grok-4.5-medium", "cursor-grok-4.5-high"],
  "authenticated": true,
  "accountEmail": "user@example.com"
}
```

### `POST /api/models/codex/refresh`

Re-runs Codex model discovery and returns the same shape as `GET /api/models`
after the fresh discovery settles.

### `GET /api/usage`

Current account/provider-scoped rate-limit usage — the data behind the titlebar
usage indicator. These limits are **account-global** (shared by every agent using
that provider), not per-session or per-workspace, so this endpoint takes no
parameters. AgentParty first asks a newly-started harness for its current usage
when the harness exposes a read API (Claude SDK `/usage`, Codex
`account/rateLimits/read`, Cursor `DashboardService/GetCurrentPeriodUsage` with
the CLI's own stored credential), then keeps the snapshot fresh from each
harness's own event stream (Claude `rate_limit_event`, Codex
`account/rateLimits/updated`) or a 60s poll (Cursor).
Reports are merged per provider; a provider absent from the response simply
hasn't reported yet (show an unknown/loading state, never a fabricated 0%). A
read that answers but carries no usable windows is published as an explicit
empty report (`windows: []`), so the indicator moves from loading to
"데이터 없음" instead of loading forever.

**One active source per provider.** These reads are account-global, so several
live sessions (or a WSL engine and the desktop) polling the same account at
different moments would otherwise overwrite each other and make the number
change on every refresh. Every `usage_limit` event is stamped with its source
and only the provider's ACTIVE source is merged; precedence is live local
session → remote (WSL) engine → background poller. Claude's several weekly
buckets (`seven_day`, `seven_day_sonnet`, …) are folded to the **most
constrained** variant for the same reason.

**Fresh even with no open session.** Because those event streams only exist while
a session runs, the indicator used to go stale once every member was closed (e.g.
right after reopening the app). To fix this at the source, the SessionManager
keeps a lightweight **background usage connection** alive for every provider the
user actually has members for — a turn-less harness connection that self-polls
usage every 60s. It is reused, not duplicated: when a provider already has a live
member session, that session feeds usage and the background connection for it is
dropped; when the last session closes, the background poller revives within 60s.
A provider with no members spawns nothing. A background connection that fails to
connect (e.g. the provider's CLI is not logged in) backs off and the pill honestly
stays at "no data" — never a fabricated number.

```json
{
  "ok": true,
  "usage": {
    "claude": {
      "provider": "claude",
      "available": true,
      "updatedAt": 1751900000000,
      "windows": [
        { "kind": "five_hour", "utilization": 63, "resetsAt": 1751907200000 },
        { "kind": "weekly", "utilization": 41, "resetsAt": 1752300000000 }
      ]
    },
    "codex": { "provider": "codex", "available": true, "updatedAt": 1751900000000, "windows": [ ... ] },
    "cursor": {
      "provider": "cursor",
      "available": true,
      "updatedAt": 1751900000000,
      "windows": [ { "kind": "monthly", "utilization": 42, "resetsAt": 1753900000000 } ]
    }
  }
}
```

`utilization` is 0–100; `resetsAt` is epoch **ms** (omitted when the provider
didn't report a reset). Claude/Codex report `five_hour` + `weekly` windows;
Cursor reports one `monthly` window — the signed-in account's billing-cycle plan
meter (reset at `billingCycleEnd`). `available:false` means the provider
reported limits are not applicable (Claude API key / Bedrock / Vertex) — render
"해당 없음", not 0%. The titlebar indicator always shows Claude, Codex, and
Cursor; missing provider data is rendered as loading/unknown until a read or
push update arrives. Windows update live over the `usage:update` IPC push to
every window.

AgentParty refreshes live harness usage once per minute while a session is
running. Users or automation can request an immediate refresh:

### `POST /api/usage/refresh`

Asks every live harness that exposes usage reads to refresh now, then returns the
same shape as `GET /api/usage`. Failures are surfaced as session status events
instead of silently clearing existing usage.

### `GET /api/token-usage`

Aggregated **per-turn usage ledger** for the Token Usage dashboard — the real,
append-only accounting written on every completed turn (party id, member,
session, provider, model, effort, token split, cost, trigger, timestamp). This
is **distinct from `GET /api/usage`**: that endpoint is the account-global
rate-limit meter (실측 window %), while this one attributes token spend to the
local actors (party ▸ member ▸ trigger) over a time window.

Query params (all optional):

```text
range    5h (default) | weekly | today | 24h | 4h | 1h   — relative range from now
from,to  explicit epoch-ms bounds (override range; [from, to))
bucket   bucket width in minutes (default 5)
party    restrict to a single party id (#id identity)
trigger  user | party-message | gate-review | compact | subagent | init | unknown
```

The range param is `range`, **not** `window` — `?window=` is reserved API-wide
for selecting the target app window. Example:
`GET /api/token-usage?range=5h&bucket=5&party=7f3a`

Returns a `TokenUsageAggregate`: time-`buckets` (each with per-series token/cost
totals), plus `parties`, `members`, and `triggers` rollups, `totals`, and
`recordCount`. **`recordCount: 0` means the range has no samples — the dashboard
shows "아직 없음", never a fabricated 0%.** `costUsd` is the harness/provider
bill when available (실측); `estCostUsd` is a deterministic list-price `≈$`
conversion (환산) kept separate so 실측 and 환산 stay distinguishable. Token
fields are only present when the harness reported them (Codex exposes no cache
split), so a missing field means "not reported", not zero.

Each rollup row carries the design's derived metrics, computed from the raw
records so the dashboard and any agent read the same numbers:

```text
totalTokens    input+cacheRead+cacheWrite+output for the row
activeMs       real active run time (ms) — a UNION of the row's turn intervals,
               so a party's concurrent members are counted once (needs atStart;
               0 when no turn reported a start time)
cacheHitRate   cacheRead ÷ all input (0–1) — the cache-optimization lever
overheadRatio  overhead-trigger tokens ÷ totalTokens (0–1)
ratePerHour    totalTokens ÷ active hours — the burn speed (not summable)
trendPct       later-half vs earlier-half token change (%), for the trend arrows
```

Top level also carries `totalTokens`, `activeMsUnion` (union across the whole
range), `ratePerHour`, and `overheadRatio`. Every derived field is `undefined`
(not 0) when its inputs are absent, so "아직 없음" stays honest. **Active-time
metrics require the per-turn `atStart` timestamp**, recorded from the ledger's
phase-2 alignment onward — older records have no active time and contribute 0.

## Sessions

### `POST /api/sessions`

Creates a Claude Code harness session.

```json
{
  "workspacePath": "C:\\Project\\AgentPartyApp",
  "selectedHarnessId": "claude-code",
  "selectedProviderId": "openrouter",
  "model": "MiniMax M3",
  "effort": "medium",
  "permissionMode": "plan"
}
```

When these runtime fields are supplied, they are applied to the new session at creation time.
Use `"selectedHarnessId": "codex"` with a Codex route (any model from `GET /api/models` with `"harnessId": "codex"`, e.g. `"model": "gpt-5.5"`) to start a local Codex app-server-backed session. Codex auth is delegated to the local `codex` CLI; tests may override the binary with `AGENTPARTY_CODEX_BIN` and optional JSON-array args in `AGENTPARTY_CODEX_ARGS`.

Use `"selectedHarnessId":"cursor"` with `"model":"Auto"` for Cursor-managed
selection, or `"model":"Grok 4.5"` and effort `"low"`, `"medium"`, or `"high"`
for the named model. Cursor permissions use
`"cursorPolicy":{"mode":"agent","approval":"auto-review"}`. The CLI is auto-discovered;
override it with `cursorExecutablePath` in settings or
`AGENTPARTY_CURSOR_BIN` plus optional JSON-array `AGENTPARTY_CURSOR_ARGS`.
Cursor chat ids are persisted as `harnessSessionId`, so subsequent turns and
member reopen/respawn use `--resume`. Named-model plan/account failures are
reported as visible `cursor-cli` diagnostics and are never replaced with Auto.

### `GET /api/sessions/history`

Lists resumable Claude Code sessions for the current workspace.

### `POST /api/sessions/resume`

Opens a previous session.

```json
{ "sessionId": "session-id", "workspacePath": "C:\\Project\\AgentPartyApp" }
```

### `POST /api/sessions/:id/send`

Sends a user turn. `attachments` is an optional array of provider-neutral images; each adapter translates them to its own surface (Anthropic image block / OpenAI `image_url` / Codex `localImage`). Sending an image to a text-only model does **not** silently drop it — the turn is refused with a visible `vision` diagnostic (see the model's vision support at `capabilities.vision.image` in the model routes; `false` = text-only, `true` = supported, omitted = unknown).

```json
{
  "text": "이 스크린샷의 버그를 설명해줘.",
  "attachments": [
    { "kind": "image", "mediaType": "image/png", "dataBase64": "<base64 without the data: prefix>", "name": "bug.png" }
  ]
}
```

### `POST /api/sessions/:id/close`

Disposes the local session and removes it from the active session list.

### `POST /api/sessions/:id/interrupt`

Interrupts the active response.

### `POST /api/sessions/:id/force-stop`

Releases a turn the harness never closed, returning the session to idle and
dispatching anything queued behind it. This does **not** stop the harness — it
frees the app-side turn, which is what unblocks input.

Only needed when `interrupt` goes unanswered: `interrupting` counts as a busy
turn, so while it persists every later send is queued and never dispatched (the
member appears to accept chats and then silently never answers). The composer
surfaces this as the manual **강제 종료** control after a Stop has sat
unacknowledged for a few seconds. Nothing escalates on a timer, so a
slow-but-healthy interrupt is never torn out from under the harness. If the
harness process itself is gone, the member's `respawn` is the stronger remedy.

A session that is not in a turn is a no-op.

### `POST /api/sessions/:id/restart`

Restarts the session harness and begins an empty model conversation. For Cursor,
this explicitly discards the Cursor chat ID so the next turn does not pass
`--resume`; queued turns and stale error/context counters are also cleared.

### `POST /api/sessions/:id/compact`

Runs compaction.

### `POST /api/sessions/:id/model`

Changes the session model.

```json
{
  "selectedHarnessId": "claude-code",
  "model": "MiniMax M3",
  "providerId": "openrouter",
  "runtimeModel": "claude-minimax"
}
```

### `POST /api/sessions/:id/effort`

Changes reasoning effort. Options come from the model's catalog entry
(`src/shared/modelCatalog.json`). For router-backed (OpenRouter) models this is
translated to OpenRouter's unified `reasoning.effort`, so effort actually
controls reasoning.

```json
{ "effort": "medium" }
```

### `POST /api/sessions/:id/thinking`

Changes the thinking mode for models whose catalog entry exposes a thinking
control (e.g. MiniMax M3's adaptive/enabled/disabled, GLM-5.2's on/off). `mode`
is one of `adaptive` | `enabled` | `disabled`; `budget` (optional) sets a
thinking-token budget for models that expose a budget slider. Restarts the
session (resumed) to apply.

```json
{ "mode": "disabled" }
```

### `POST /api/sessions/:id/permission`

Changes permission mode. When the session belongs to a party member, the new mode
is also persisted back to that member, so reopening the member (or restarting the
app) restores the mode last chosen rather than the start-time value.

```json
{ "permissionMode": "default" }
```

### `POST /api/sessions/:id/codex-policy`

Updates a **Codex** session's two-axis safety model live (sandbox mode ×
approval policy + guardian). Takes effect on the next turn. Errors if the session
does not use the Codex harness. When the session belongs to a party member,
the policy is persisted and restored on member/app reopen.

```json
{ "policy": { "sandbox": "workspace-write", "approval": "on-request", "guardian": false } }
```

- `sandbox`: `read-only` | `workspace-write` | `danger-full-access`
- `approval`: `untrusted` | `on-request` | `never`
- `guardian`: route approvals through an auto-review reviewer.

### `POST /api/sessions/:id/cursor-policy`

Updates a **Cursor** session's agent mode and approval mode for the next turn.
When the session belongs to a party member, the policy is persisted.

```json
{ "policy": { "mode": "plan", "approval": "allowlist" } }
```

### `POST /api/sessions/:id/approve`

Responds to a pending approval request.

```json
{
  "requestId": "request-id",
  "behavior": "allow",
  "updatedInput": null,
  "message": ""
}
```

`behavior` is the coarse allow/deny. `updatedInput` carries request-specific
extras:

- **Codex approvals** — `{ "codexDecision": "once" | "session" | "always" | "decline" }`
  picks the richer choice the harness supports. `once` = accept this request,
  `session` = don't ask again this session, `always` = record a prefix rule
  (execpolicy amendment) so the same command auto-approves later (command
  approvals only; degrades to `session` when no rule was offered), `decline` =
  deny. When omitted, `behavior` maps to `once`/`decline`.
- **AskUserQuestion / Codex request-user-input** — `{ "answers": { "<question>": "<label>" } }`
  folds the chosen answers back into the tool input.

### `GET /api/sessions/:id/mcp`

Lists the MCP servers this session's member connects to (as a client), with live
status + tools. For AgentParty party members this can include the app-hosted
`agentparty-app` tool surface; Codex receives it as a per-session stdio MCP
server configured inline, and the server routes back through the local
automation API to the same AppController path as the UI. Requires a live session
(start the member first).

```json
{
  "supported": true,
  "harness": "claude-code",
  "servers": [
    {
      "name": "playwright",
      "state": "connected",
      "transport": "stdio",
      "scope": "user",
      "url": null,
      "version": "1.0.0",
      "error": null,
      "tools": [{ "name": "browser_navigate", "description": "…" }],
      "canReconnect": true,
      "canToggle": true,
      "canAuthenticate": false
    }
  ],
  "note": "…",
  "error": null
}
```

- `state`: `connected` | `connecting` | `failed` | `needs-auth` | `disabled` | `unknown`.
- `canReconnect` / `canToggle` / `canAuthenticate`: which actions this **harness**
  supports for this server. Capabilities are asymmetric — Claude Code supports
  reconnect + enable/disable but not programmatic OAuth (needs-auth is resolved in
  the interactive `/mcp`); Codex supports reconnect + OAuth but not live toggle
  (its enable/disable is config-file driven). The UI only offers supported actions.
- `note` / `error`: surfaced harness-level messages (never swallowed).
- Cursor injects the session-scoped `agentparty-app` stdio plugin. Its configured
  eleven-tool inventory is shown immediately with `state: "unknown"`; after a
  successful MCP discovery/call event is observed, state becomes `"connected"`.
  Cursor print mode does not emit a separate server lifecycle event, so the API
  does not claim a live state before that observation.

### `POST /api/sessions/:id/mcp/reconnect`

Reconnects one MCP server. `{ "server": "<name>" }`. On Codex this reloads the
MCP config (re-reads `~/.codex/config.toml` and refreshes loaded servers).

### `POST /api/sessions/:id/mcp/toggle`

Enables/disables one MCP server live. `{ "server": "<name>", "enabled": true }`.
Claude Code only; errors on Codex (config-file driven there).

### `POST /api/sessions/:id/mcp/authenticate`

Starts OAuth for a remote MCP server. `{ "server": "<name>" }` → `{ "authorizationUrl": "https://…" }`
to open in a browser. Codex only; on Claude Code, authenticate via the
interactive `/mcp` (the SDK doesn't expose an OAuth flow).

## AgentParty Parties

### `GET /api/party`

Lists parties, the selected party, its members, and recent party messages.

Party state is stored in the targeted window's workspace under
`.agent_party_app/state.json` (a legacy `.agentparty/state.json` is still read as
a fallback). Member role files are stored under
`.agent_party_app/parties/<party>/members`, but member sessions always start with
cwd set to the workspace root. The result is scoped to the targeted window's
workspace (`?window=<id>`; focused window when omitted).

### `POST /api/parties`

Creates a party, creates its `main` member, and attempts to init-start `main` so skills and slash commands can populate the palette before the first chat. Init failures are returned in the command message and logged instead of being hidden.

```json
{ "name": "Feature QA" }
```

### `POST /api/parties/:id/select`

Selects the active party for member creation and compatibility endpoints.

### `POST /api/parties/:id/delete`

Permanently deletes a party: closes every live session it owns, drops its members and messages, and removes its on-disk storage. If the deleted party was active, focus falls to another party (or none, if it was the last one). Returns the refreshed party listing.

## AgentParty Members

### `POST /api/party/messages`

Sends a message through the internal AgentParty router. `attachments` is optional (same provider-neutral image shape as `/api/sessions/:id/send`), so an agent can drive an image turn **by member name** without knowing the session id.

```json
{
  "from": "user",
  "to": "impl",
  "content": "이 스크린샷의 레이아웃 버그를 고쳐줘.",
  "attachments": [
    { "kind": "image", "mediaType": "image/png", "dataBase64": "<base64 without the data: prefix>", "name": "bug.png" }
  ]
}
```

If the target member is bound to an active session, AgentParty injects the message directly into that session as a channel payload. If no active session is bound, the message is recorded with `delivered: false` and no provider call is made. Sending an image to a text-only model is refused with a visible `vision` diagnostic (never silently dropped).

**Message Gate**: when `from` is a member (not `"user"`) and that member's gate is
active, the message is reviewed before delivery. A rejection returns
`partyMessage.delivered: false` with `partyMessage.error` set to the reviewer's
reason (rewrite and resend). Add `{ "force": true, "forceReason": "…" }` to bypass
the gate for one message (surfaced as a "forced" badge). A reviewer error is
fail-open: the message is delivered unreviewed with a visible notice. A human
`from: "user"` turn is never gated.

The reviewer's `effort` reaches the model differently per provider — `thinking`
for Anthropic (which rejects `effort` outright), `effort` for router-backed
models — and reasoning is never disabled, because a classifier that cannot
reason rejects compliant messages. This behaves identically for local and WSL
workspaces; for WSL the reviewer call runs on the desktop while the gate
decision stays in the distro's engine. See `docs/MESSAGE_GATE.md`.

### `POST /api/party/members`

Creates a member inside the selected party, or inside `partyId` when supplied.

```json
{
  "partyId": "party-id",
  "name": "impl",
  "runtime": "claude-code",
  "model": "sonnet",
  "permissionMode": "plan",
  "requirement": "implement scoped code changes",
  "initialTask": "Inspect the current repo."
}
```

Creation accepts the full runtime profile: `model`, `effort`, `reasoning`,
`reasoningBudget`, and an explicit initial permission. Use `permissionMode` for
a Claude Code harness, the complete `codexPolicy` object for Codex, or
`cursorPolicy` for Cursor:

```json
{
  "name": "gpt-worker",
  "runtime": "claude-code",
  "model": "GPT-5.4 mini",
  "requirement": "run inexpensive checks",
  "permissionMode": "plan"
}
```

The example runs the Claude Code harness itself and routes its GPT model calls
through the embedded router to the local Codex/ChatGPT subscription proxy.

### `POST /api/party/members/:name/message`

**The primary user-send path** — the exact same `AppController.sendMemberMessage` the UI's Send button (Enter / click) calls, so an agent drives an identical route to a user. Idempotently ensures the member has a live session (starting it with the member's own config if none is active — never a duplicate), then delivers the turn as a raw user message. Optional `attachments` (images) ride along, matching how the composer bundles a pasted/dropped image with the send. Sending an image to a text-only model is refused with a visible `vision` diagnostic (never silently dropped).

```json
{
  "text": "이 스크린샷의 버그를 설명해줘.",
  "attachments": [
    { "kind": "image", "mediaType": "image/png", "dataBase64": "<base64 without the data: prefix>", "name": "bug.png" }
  ]
}
```

### `POST /api/party/members/:name/send`

Lower-level compatibility endpoint that routes a message as an inter-member **channel** payload (wraps it with channel tags). Prefer `/message` for a plain user turn. Accepts the same optional `attachments`.

```json
{ "from": "user", "content": "이 이미지를 설명해줘.", "attachments": [{ "kind": "image", "mediaType": "image/png", "dataBase64": "<base64>", "name": "shot.png" }] }
```

### `POST /api/party/members/:name/open`

Marks a non-main member as opened in the UI without starting a harness session by itself. The Workbench may immediately call `start` for an active opened panel to prewarm the command/skill palette.

### `POST /api/party/members/:name/start`

Idempotently ensures a harness session exists for an opened member. If the
member is already live (for example, an HTTP start races the Workbench prewarm),
the existing session is returned instead of creating an orphaned duplicate.
Use `respawn` when a live session must be rebuilt. `main` is init-started when
its party is created; other members normally start when the user sends the first
chat message. The session cwd is the selected project root, not the member directory.

```json
{
  "model": "MiniMax M3",
  "effort": "medium",
  "permissionMode": "plan",
  "selectedProviderId": "openrouter"
}
```

### `POST /api/party/members/:name/resume`

Starts a new active session using the stored member profile.

### `POST /api/party/members/:name/respawn`

Reloads the member's session while CONTINUING the conversation: it tears the
current session down and starts a new one that resumes the same harness thread
(model context intact). The new session is rebuilt from the stored member
profile and re-reads the harness's MCP config, so this is how you apply changes
that need a session restart — e.g. a just-added MCP server — without losing the
conversation. This is what the tab toolbar's reset button calls. Contrast with a
hard restart (the member's right-click menu), which begins an EMPTY conversation.
Optional body fields override the profile for the new session (same shape as
`start`). Passing `selectedHarnessId` (`"claude-code"`, `"codex"`, or
`"cursor"`) changes
and persists the member's harness before recreating the session. A cross-harness
change intentionally starts a fresh harness thread because Claude conversation
IDs and Codex thread IDs are not compatible.

### `POST /api/party/members/:name/bind`

Binds an existing active session to a member.

```json
{ "sessionId": "session-123" }
```

### `POST /api/party/members/:name/close`

Closes the member's active session while keeping its registry/scaffold.

### `POST /api/party/members/:name/remove`

Fully removes a member. This is destructive.

### `POST /api/party/members/:name/status`

Turn state of one member. `name` `*` (or `all`) returns every member of the
party. `turnActive` mirrors the UI's "working" derivation (snapshot status is
`requesting`/`responding`/`interrupting`). Agents reach the same data via the
`member-status` party tool.

```json
{ "ok": true, "members": [ { "name": "impl", "running": true, "turnActive": true, "status": "responding", "turnCount": 3, "pendingApprovalCount": 0, "model": "Sonnet" } ] }
```

### `POST /api/party/members/:name/interrupt`

Stops the member's in-flight turn (the same adapter interrupt the toolbar stop
button uses). An idle member is reported with `interrupted: false`, not an
error; a member with no live session errors. `name` `*` (or `all`) stops every
busy member — `{ "exclude": "main" }` optionally skips one (the agents'
`interrupt` tool passes themselves). Agents reach this via the `interrupt`
party tool.

### `POST /api/party/members/:name/force-stop`

Member-addressed form of `/api/sessions/:id/force-stop` — releases a turn the
harness never closed so the member stops queueing input behind it. Returns
`released: false` for an idle member (not an error); a member with no live
session errors.

### `POST /api/party/members/:name/auto-compact`

Sets the member's per-member auto-compaction threshold, persisted to the member
(works with or without a live session). Body `{ "autoCompact": { "on": true,
"at": 65 } }` sets it (`at` = % of the model's context window; 10% and below /
95% and above can't be set, so it clamps to the 11–94 integer band);
`{ "autoCompact": null }` clears the override so the member
inherits the global `compactDefault` (see `POST /api/settings`). When on, the
session auto-compacts once occupancy crosses `at`%. Backs the toolbar compact
pill, the threshold modal, the runtime modal's auto-compact block, and the
sidebar `⇲ NN%` badge. The global default is set via `POST /api/settings`
`{ "compactDefault": { "on": true, "at": 80 } }`.

### `POST /api/party/members/:name/permission`

Changes and persists a member's permission by name, with or without a live
session. A live adapter is updated first, then the member record is written.
This is the same `PartyApplicationService.setMemberPermission` path used by the
agent-facing `member-permission` tool.

For a Claude Code harness (including Claude Code + GPT):

```json
{ "permissionMode": "auto" }
```

For a Codex harness (including Codex + Claude):

```json
{ "codexPolicy": { "sandbox": "workspace-write", "approval": "on-request", "guardian": true } }
```

For a Cursor harness:

```json
{ "cursorPolicy": { "mode": "agent", "approval": "auto-review" } }
```

### `POST /api/party/members/:name/gate`

Sets a member's **Message Gate** override — the delivery-time reviewer of that
member's OUTGOING messages to other members. This is a PATCH: any omitted axis is
left unchanged; a `null` axis clears it back to inherit. Cross-editable (any
member/agent may edit any member's gate). Backs the member gate modal and the
agent-facing `gate-set` tool. See `docs/MESSAGE_GATE.md`.

```json
{ "gate": { "mode": "on", "rule": "Be concise. Talk to the owner directly, don't route through main.", "reviewer": { "model": "haiku", "effort": "low" } } }
```

- `mode`: `"inherit"` (follow the party gate) | `"on"` | `"off"`.
- `rule`: the communication rule the headless reviewer enforces. `null` = inherit
  the party rule.
- `reviewer`: `{ model, effort }` for a custom headless reviewer (no harness —
  it runs as a raw completion). `null` = use the settings default
  (`gateDefaults`).

### `POST /api/parties/:id/gate`

Sets the **party-wide** Message Gate default (enablement + rule + optional
reviewer). Members with `mode: "inherit"` follow this. Backs the party gate modal
and the agent-facing `party-gate-set` tool. Body:

```json
{ "enabled": true, "rule": "Be concise. Prefer direct member-to-member messages over orchestrator round-trips.", "reviewer": { "model": "GPT-5.6 Terra", "effort": "low" } }
```

This replaces the whole party gate, so send every axis you want to keep.

`reviewer` is optional and resolves in three steps — member override → party →
`gateDefaults`. Omit it to fall back to the app-wide default, which is set via
`POST /api/settings` `{ "gateDefaults": { "model": "GPT-5.6 Terra", "effort": "low" } }`.
The party level exists so one party can review with a different model without
changing the app-wide setting.

The `POST /api/party/messages` send accepts `{ "force": true, "forceReason": "..." }`
to bypass the gate for one message (surfaced as a "forced" badge).

### `GET /api/party/status`

Convenience alias for `POST /api/party/members/*/status` — every member's turn state.

### `POST /api/party/interrupt`

Convenience alias for `POST /api/party/members/*/interrupt` — stops every busy
member. Body: `{ "exclude": "main" }` (optional).

### `POST /api/party/broadcast`

Sends one message to EVERY member of the party except the sender.

```json
{ "from": "user", "content": "전체 공지: 지금 작업을 마무리하고 상태를 보고하세요.", "interrupt": false }
```

Returns per-member delivery: `{ "delivered": ["impl", "test"], "failed": [{ "name": "survey1", "error": "target_member_has_no_active_session" }] }`.
With `"interrupt": true` each busy recipient's turn is stopped first so the
message is handled immediately. Agents reach this via the `broadcast` party tool.

> **Interrupt-and-inject**: `POST /api/party/messages`, `/members/:name/send`,
> and `/broadcast` all accept `"interrupt": true` — the recipient's in-flight
> turn is stopped first so the message is handled immediately instead of
> queueing behind it (agents: the `send`/`broadcast` tools' `interrupt` flag).

### `GET /api/party/members/:name/transcript`

The member's persisted transcript (assembled UI blocks), restored on app/member
reopen. The renderer saves it debounced; reopening a member resumes the harness
thread (Claude/Codex) via the stored thread id so the model context continues too.

```json
{ "ok": true, "blocks": [ { "kind": "user", "text": "..." }, { "kind": "assistant", "text": "..." } ] }
```

## Harness Party API

Harness skills and tools can call these local endpoints from inside a session. This is a local mechanical identity mechanism, not a public auth system.

### `GET /api/harness/party`

Returns the same member/message state as `GET /api/party`.

### `POST /api/harness/party/messages`

Sends a member-to-member message. The caller can be supplied in JSON as `from` or via `X-AgentParty-Member`.

```json
{
  "to": "reviewer",
  "content": "Please inspect the diff."
}
```

## Window

### `POST /api/window/minimize`

Minimizes the app window.

### `POST /api/window/maximize`

Toggles maximize/unmaximize.

### `POST /api/window/close`

Closes the app window.

## Navigation

### `POST /api/navigation`

Switches the visible app screen.

```json
{ "view": "workbench" }
```

Valid views:

```text
workbench, sessions, party, auth, runtime, automation
```

## Windows & workspaces

The app is one main process with **many windows**. Each window views one
**workspace** (a cwd directory); its party/members/sessions are scoped to that
workspace and persisted under `<workspace>/.agent_party_app/`. Several windows
may be open at once, including multiple on the same workspace (they share one
in-memory source of truth and live-sync).

**Addressing:** workspace-scoped and window-scoped endpoints accept a target
window via `?window=<id>` (or the `x-agentparty-window` header). When omitted,
the **focused** window is used. `GET /api/state?window=<id>` returns that
window's workspace, party, and the `windows` list.

Agent member tools additionally send `x-agentparty-party: <party-id>` on party
list, message, status, interrupt, broadcast, and member-action requests. This
pins a member session to the party that spawned it even if a user later selects
another party in the desktop window. Ordinary UI and automation clients can
omit the header and retain the active-window behavior above.

### `GET /api/windows`

Lists open windows: `{ windows: [{ id, workspacePath, focused }] }`.

### `POST /api/windows`

Opens a new window. Body `{ "workspacePath": "C:/path" }` (optional; defaults to
the last-used workspace). Returns `{ id, workspacePath, focused }`.

### `POST /api/windows/:id/workspace`

Points an existing window at a different workspace. Body
`{ "workspacePath": "C:/path" }`. Returns the window's fresh state.

## QA Endpoints (test-only)

These drive the renderer with **mock members and sessions** so the entire
frontend (transcripts, approval UI, send/receive, status, panels/tabs) can be
exercised end-to-end **without any model communication**. They are gated: every
`/api/qa/*` route returns `403 { "error": "qa_disabled" }` unless the app is
launched with `AGENTPARTY_QA=1` (or in E2E mode).

Launch with QA enabled:

```powershell
npm run start:qa
```

Seed the bundled scenario and capture a screenshot:

```powershell
npm run qa:seed                        # seed "Refactor Auth" party + capture
node scripts/qa-frontend.mjs --reset   # tear down mock members
```

### `POST /api/qa/seed`

Creates a party of mock members, each optionally pre-filled with transcript
blocks and a busy/idle/approval state. A mock member's session emits the same
normalized events as a real one, so the UI renders it identically.

```json
{
  "party": "Refactor Auth",
  "members": [
    {
      "name": "backend",
      "model": "claude-sonnet-4.5",
      "role": "API/auth",
      "status": "working",
      "autoReply": true,
      "blocks": [
        { "type": "assistant_text_delta", "text": "추적 결과 …" },
        { "type": "tool_call", "id": "t1", "name": "read_file", "status": "completed", "input": { "path": "src/auth/refresh.ts" }, "result": "…" }
      ]
    }
  ]
}
```

- `status`: `working` | `idle` | `approval` (drives the busy indicator).
- `autoReply` (default `true`): a real composer message gets a canned mock reply.
- `blocks`: an array of normalized events (`assistant_text_delta`,
  `reasoning_delta`, `tool_call`, `approval_request`, `status`, `turn_complete`).

### `POST /api/qa/members`

Adds (or restarts) one mock member with the same body shape as a `members[]`
entry above.

### `POST /api/qa/members/:name/emit`

Streams events into a seeded member, as if they just arrived.

```json
{ "status": "working", "events": [ { "type": "assistant_text_delta", "text": "한 줄 더…" } ] }
```

Simulate an approval prompt:

```json
{ "events": [ { "type": "approval_request", "requestId": "a1", "toolName": "apply_patch", "description": "좁은 패치 적용", "input": { "command": "git apply auth-narrow.patch" } } ] }
```

### `POST /api/qa/members/:name/subagents`

Injects a named **subagent scenario** into a seeded member as `subagent` events,
so the subagent dock + drill-in detail can be designed, demoed, and QA'd without
spawning a real subagent (mock-driven design). The events flow through the exact
same normalization + renderer fold a live harness would. Scenarios live in
`src/shared/subagentScenarios.ts`; an unknown name returns an error listing the
available scenarios (no silent no-op). Returns `{ scenario, count }`.

```json
{ "scenario": "claude-test-shards" }
```

Available scenarios: `claude-test-shards` (Claude `Agent`/`Task` fan-out — 6
shard-runners, 2 실행 · 2 완료 · 2 대기), `codex-call-tracer` (Codex collab thread
— a completed call-tracer), `codex-web-research` (Codex collab thread doing web
research — several `web_search` cards + a final markdown report; mirrors the exact
block stream `CodexSubagentTracker` emits for a web-searching child).

### `POST /api/qa/members/:name/subagents/open`

Opens a member's **subagent detail** (the drill-in overlay), as if the row were
clicked — so the detail view can be captured/QA'd without a renderer click. Body
`{ "subId": "shard-auth" }` (the subagent id from the injected scenario). QA mode
only.

### `POST /api/qa/members/:name/interaction`

Mocks a model-driven **interactive prompt** into a seeded member so the
interactive UI (e.g. the AskUserQuestion choice card) can be exercised without a
real model. Emits the same `approval_request` event the real harness produces,
then the member can be answered through `POST /api/sessions/:id/approve` (or by
clicking an option in the UI). Returns the generated `requestId`.

```json
{
  "type": "askUserQuestion",
  "questions": [
    {
      "question": "어떤 작업을 진행할까요?",
      "header": "작업 선택",
      "multiSelect": false,
      "options": [
        { "label": "코드 리뷰", "description": "현재 변경점을 리뷰합니다." },
        { "label": "버그 수정", "description": "보고된 버그를 수정합니다." }
      ]
    }
  ]
}
```

`questions` is optional — a sensible default question is used when omitted.
`requestId` is optional and auto-generated if not supplied. To answer, allow the
request with the chosen labels folded into the tool input:

```json
{ "requestId": "<from response>", "behavior": "allow",
  "updatedInput": { "answers": { "어떤 작업을 진행할까요?": "코드 리뷰" } } }
```

### `POST /api/qa/open`

Drives the targeted window's Workbench layout directly, opening mock members
into a specific panel/tab arrangement so split-view, tab DnD, and per-panel
density can be exercised without manual interaction. Window-scoped
(`?window=<id>`; focused window when omitted).

```json
{ "panels": [["backend", "frontend"], ["reviewer", "tester"], ["db-migrate"]] }
```

`panels` is an array of arrays of member names: each inner array becomes one
Workbench panel, the names are that panel's tabs left-to-right, and the **first
name is the active tab**. Names that don't match a current member are dropped,
and empty panels are skipped. The renderer switches to the Workbench view and
applies the layout.

### `POST /api/qa/usage`

Injects a provider usage-limit snapshot through the same aggregation + broadcast
path a real harness event takes, so the titlebar indicator can be driven without
consuming a real quota. Returns the merged snapshot (same shape as
`GET /api/usage`).

```json
{
  "provider": "claude",
  "available": true,
  "windows": [
    { "kind": "five_hour", "utilization": 63, "resetsAt": 1751907200000 },
    { "kind": "weekly", "utilization": 41 }
  ]
}
```

`provider` must be `"claude"`, `"codex"`, or `"cursor"`; each window needs a `kind`
(`"five_hour"` | `"weekly"` | `"monthly"`) and numeric `utilization` (0–100). `resetsAt` (epoch
ms) is optional. Windows merge by kind, so repeated calls update one window at a
time — mirroring how real providers report.

### `POST /api/qa/reset`

Removes every mock member (real members are left untouched).

## Low-Cost Live Model Test

### Cursor Grok reasoning and Fast mode

`Grok 4.5` exposes two independent model settings in `GET /api/models` and the
party `list-models` tool:

- `capabilities.effort`: `low | medium | high`
- `capabilities.serviceTier`: `standard | fast`

Create or respawn a Cursor member with the same fields used by the UI:

```json
{
  "runtime": "cursor",
  "model": "Grok 4.5",
  "effort": "high",
  "serviceTier": "fast"
}
```

The concrete Cursor CLI model is selected without fallback:
`cursor-grok-4.5-{effort}` for Standard and
`cursor-grok-4.5-{effort}-fast` for Fast.

Use MiniMax M3 for live calls:

```powershell
$base = "http://127.0.0.1:47831"
Invoke-RestMethod "$base/api/settings" -Method Post -ContentType application/json -Body '{"selectedHarnessId":"claude-code","selectedProviderId":"openrouter","claudeModel":"MiniMax M3","claudeEffort":"medium"}'
$session = Invoke-RestMethod "$base/api/sessions" -Method Post -ContentType application/json -Body '{"workspacePath":"C:\\Project\\AgentPartyApp"}'
Invoke-RestMethod "$base/api/sessions/$($session.id)/send" -Method Post -ContentType application/json -Body '{"text":"Reply with exactly PONG."}'
```
