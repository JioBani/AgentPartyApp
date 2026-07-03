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

### `GET /api/logs`

Returns the active log file path.

### `POST /api/capture`

Captures the current Electron window and stores it as a PNG. If `path` is omitted, the file is written next to the current log file.

```json
{ "path": "C:\\tmp\\agentparty-capture.png" }
```

## Settings

### `POST /api/settings`

Updates app settings.

Member-creation defaults are **per harness** (`harnessDefaults`), not global: each
harness owns its own default model/effort/reasoning and its harness-appropriate
permission config (`permissionMode` for Claude Code, `codexPolicy` two-axis for
Codex). `selectedHarnessId` is the harness a brand-new member defaults to. A new
member is created from ITS harness's defaults (a Codex member gets the Codex
default model + sandbox policy, a Claude member the Claude default + permission
mode). A legacy settings.json with flat `claudeModel`/`claudeEffort`/
`claudePermissionMode` is migrated into `harnessDefaults["claude-code"]` on load.

Example:

```json
{
  "selectedHarnessId": "claude-code",
  "harnessDefaults": {
    "claude-code": { "model": "MiniMax M3", "effort": "medium", "permissionMode": "plan" },
    "codex": { "model": "gpt-5.5", "effort": "medium", "codexPolicy": { "sandbox": "read-only", "approval": "on-request", "guardian": false } }
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

## Models

### `GET /api/models`

Returns the selectable model routes and the Codex catalog discovery state.

```json
{
  "ok": true,
  "modelRoutes": [{ "harnessId": "codex", "model": "gpt-5.5", "label": "GPT-5.5" }],
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

### `POST /api/models/codex/refresh`

Re-runs Codex model discovery and returns the same shape as `GET /api/models`
after the fresh discovery settles.

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

### `GET /api/sessions/history`

Lists resumable Claude Code sessions for the current workspace.

### `POST /api/sessions/resume`

Opens a previous session.

```json
{ "sessionId": "session-id", "workspacePath": "C:\\Project\\AgentPartyApp" }
```

### `POST /api/sessions/:id/send`

Sends a user turn.

```json
{ "text": "Reply with PONG." }
```

### `POST /api/sessions/:id/close`

Disposes the local session and removes it from the active session list.

### `POST /api/sessions/:id/interrupt`

Interrupts the active response.

### `POST /api/sessions/:id/restart`

Restarts the session harness.

### `POST /api/sessions/:id/compact`

Runs compaction.

### `POST /api/sessions/:id/model`

Changes the session model.

```json
{
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

Changes permission mode.

```json
{ "permissionMode": "default" }
```

### `POST /api/sessions/:id/codex-policy`

Updates a **Codex** session's two-axis safety model live (sandbox mode ×
approval policy + guardian). Takes effect on the next turn. Errors if the session
is not a Codex harness.

```json
{ "policy": { "sandbox": "workspace-write", "approval": "on-request", "guardian": false } }
```

- `sandbox`: `read-only` | `workspace-write` | `danger-full-access`
- `approval`: `untrusted` | `on-request` | `never`
- `guardian`: route approvals through an auto-review reviewer.

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

## AgentParty Members

### `POST /api/party/messages`

Sends a message through the internal AgentParty router.

```json
{
  "from": "user",
  "to": "impl",
  "content": "Review the current implementation."
}
```

If the target member is bound to an active session, AgentParty injects the message directly into that session as a channel payload. If no active session is bound, the message is recorded with `delivered: false` and no provider call is made.

### `POST /api/party/members`

Creates a member inside the selected party, or inside `partyId` when supplied.

```json
{
  "partyId": "party-id",
  "name": "impl",
  "runtime": "claude-code",
  "requirement": "implement scoped code changes",
  "initialTask": "Inspect the current repo."
}
```

### `POST /api/party/members/:name/send`

Compatibility endpoint for sending a message to a member.

```json
{ "from": "reviewer", "content": "Review the current implementation." }
```

### `POST /api/party/members/:name/open`

Marks a non-main member as opened in the UI without starting a harness session by itself. The Workbench may immediately call `start` for an active opened panel to prewarm the command/skill palette.

### `POST /api/party/members/:name/start`

Starts a fresh harness session for an opened member. `main` is init-started when its party is created; other members normally start when the user sends the first chat message. The session cwd is the selected project root, not the member directory.

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

### `POST /api/party/members/:name/bind`

Binds an existing active session to a member.

```json
{ "sessionId": "session-123" }
```

### `POST /api/party/members/:name/close`

Closes the member's active session while keeping its registry/scaffold.

### `POST /api/party/members/:name/remove`

Fully removes a member. This is destructive.

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

### `POST /api/qa/reset`

Removes every mock member (real members are left untouched).

## Low-Cost Live Model Test

Use MiniMax M3 for live calls:

```powershell
$base = "http://127.0.0.1:47831"
Invoke-RestMethod "$base/api/settings" -Method Post -ContentType application/json -Body '{"selectedHarnessId":"claude-code","selectedProviderId":"openrouter","claudeModel":"MiniMax M3","claudeEffort":"medium"}'
$session = Invoke-RestMethod "$base/api/sessions" -Method Post -ContentType application/json -Body '{"workspacePath":"C:\\Project\\AgentPartyApp"}'
Invoke-RestMethod "$base/api/sessions/$($session.id)/send" -Method Post -ContentType application/json -Body '{"text":"Reply with exactly PONG."}'
```
