# Testing & QA — mocks first, full process last

Several tiers of verification exist; use the lightest one that proves what you
changed, and reserve the heaviest (real model) for a final confirmation.

| Tier | What runs | Use for | Command |
|---|---|---|---|
| **jsdom UI** | renderer logic in jsdom (no Electron) | render/layout/logic regressions, fast | `npm run test:ui` |
| **Integration** | real services + a fake boundary (e.g. fake SessionManager) | service wiring without a model call | `npm run test:party-bridge` |
| **Full-process e2e** | the **real Electron app** + real engine + real model | end-to-end through the actual app, billed | manual (below) |

The first two are deterministic and belong in CI. The full-process e2e is manual
(it launches a GUI and makes billed model calls) but is the **only** tier that
catches main↔renderer / remote-engine wiring gaps — e.g. it caught the WSL party
broadcast bug that the integration test (in-process fake) could not see.

**Develop and QA the frontend on mocks; reach for the real model only at the
end.** You should never need to start a real session and type chat to verify a
frontend behavior. Mock the backend's inputs and outputs over the API instead,
and watch the result in the UI — then do one full-process e2e to confirm.

---

## Mock-driven frontend QA (the primary loop)

`MockHarnessSession` implements the exact same `HarnessSession` contract as
`ClaudeAdapter` and emits the same normalized events through the same
SessionManager path, so **the renderer cannot tell a mock member from a live
one**. Drive it entirely over the automation API.

Enable QA mode: `npm run start:qa` (sets `AGENTPARTY_QA=1`). The `/api/qa/*`
endpoints return 403 otherwise. (`npm run qa:seed` runs a canned scenario via
`scripts/qa-frontend.mjs`.)

| Command | Mocks |
|---|---|
| `POST /api/qa/seed` `{party, members:[{name, role, model, effort, status, blocks, autoReply}]}` | a mock party + members (each with a mock session) |
| `POST /api/qa/members` `{name, role, model, effort, autoReply}` | add **one** mock member — also exercises the live member-list `party:update` |
| `POST /api/qa/members/:name/emit` `{events:[…], status}` | inject conversation I/O into a member's transcript (see event shapes below) |
| `POST /api/qa/members/:name/interaction` `{questions}` | inject an `AskUserQuestion` choice card |
| `POST /api/party/messages` `{to, from, content}` | **simulate an inter-member message** — `from` (any name) → `to` (a mock member). Recorded in party state and rendered in the receiver's transcript; an `autoReply` member also bounces a response back. This is how you QA "a member messaged another" with no real session. |
| `POST /api/qa/reset` | remove mock members |

**Inter-member messaging** is the key party-feature primitive. Because
`MockHarnessSession.sendUserTurn` emits the same `status: "sent"` event a real
session does, an alice→bob message shows up in bob's transcript verbatim
(channel-wrapped, `from="alice"`). Seed members with `autoReply:false` to inspect
an inbox cleanly, or `true` to see a canned reply come back. Regression:
`scripts/qa-party-mock.mjs` (in `test:ui`).

**Useful normalized event shapes** for `emit.events` (full union in
`src/core/events.ts`):
```
{ type:"status", status:"sent", detail:"<text>" }          // an incoming/user message line
{ type:"assistant_text_delta", text:"…" }                   // streamed assistant text
{ type:"reasoning_delta", text:"…" }                        // streamed reasoning
{ type:"tool_call", id, name:"mcp__agentparty-app__send", input, status:"started|completed" }
{ type:"approval_request", requestId, toolName, input, title }
{ type:"turn_complete", result:"ok", stopReason:"end_turn" }
{ type:"status", status:"responding|idle|interrupted" }
```

Reference harnesses: `scripts/qa-party-mock.mjs` (inter-member messaging),
`scripts/qa-interaction-api.mjs` (AskUserQuestion), `scripts/qa-frontend.mjs`
(seed + arrange + screenshot). All build `engineHost` in-process and call the
engine's `qa*` methods directly — the same methods the `/api/qa/*` routes call.

---

## Full-process e2e: launch the real app and drive it over HTTP

The app **can** be launched here. The catch that makes it look otherwise: VS Code
/ Claude Code terminals export `ELECTRON_RUN_AS_NODE=1`, which makes the Electron
binary boot as plain Node (so `app` is undefined). `scripts/launch-electron.mjs`
strips that var — always launch through it, not the raw binary.

### 1. Build current source first
The launcher runs `dist/main` + the bundled engine-server. Rebuild so your
changes are actually in the running process (the packaged `release/` exe is a
separate, possibly-stale artifact):
```
npm run build
```

### 2. Launch the real app (optionally targeting a workspace)
```
node scripts/launch-electron.mjs --workspace wsl+Ubuntu-22.04:/home/dev/agentparty-wsl-e2e
```
Run it in the background. `--workspace` accepts a local path or a
`wsl+<distro>:<posix-path>` URI. A **WSL workspace gives members real Claude auth**
(the distro is logged in) — local Windows may not be. Members there run on the
remote engine (billed on the distro's subscription).

### 3. Discover the automation API port
The port is `47831` *unless* taken, then a fallback — never hardcode it. Read:
```
<userData>/automation.json   →  e.g. C:\Users\<you>\AppData\Roaming\AgentParty\automation.json
                                  { "baseUrl": "http://127.0.0.1:47831", "pid": 12345 }
```
Poll `GET <baseUrl>/api/health` until `ok`.

### 4. Drive it exactly like an external QA agent — over HTTP only
Every capability is on the automation API (`src/shared/apiSpec.ts`, `docs/API.md`),
routed through the same `AppController` methods as the UI. Examples:
```
POST /api/party/members/main/start   { model, effort, permissionMode }
POST /api/party/messages             { to, from, content }    # deliver a user turn
GET  /api/party                      # members + messages (poll for results)
POST /api/party/members/<name>/remove
```
See `scripts/qa-app-party-e2e.mjs` for a full loop (a member uses its in-process
party tools to create another member and they message each other), verified via
`GET /api/party`.

### 5. Visual check — `POST /api/capture`
```
POST /api/capture  {}        →  { ok, path, width, height, bytes }
```
Then read the PNG. **Caveat (Windows):** `webContents.capturePage()` returns an
**empty buffer when the window is occluded or minimized**, so `/api/capture`
yields a 0-byte file unless the window is foreground. It captures reliably **right
after launch** (the window is foreground) and while nothing has stolen the OS
foreground. If you get empty captures, the feature is fine — bring the window
forward (a fresh `POST /api/windows` opens a foreground window) and retry.

### 6. Stop the app
Kill by the discovery-file `pid`. On Windows from Git Bash, `taskkill /PID` gets
mangled by MSYS path conversion — invoke it through Node to pass args literally:
```
node -e "require('child_process').execSync('taskkill /PID <pid> /T /F')"
```

---

## Why this tier matters

The party communication feature passed both the jsdom suite and the in-process
integration test, yet agent-created members did **not** appear in the UI on a WSL
workspace — because the remote engine-server forwarded only `session:*` events,
not the new `party` event, so `party:update` never reached the renderer. Only a
screenshot of the real app revealed it. When a change crosses the main↔renderer
or local↔remote boundary, verify it here, with a capture.
