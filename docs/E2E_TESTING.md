# Testing & QA — mocks first, full process last

Several tiers of verification exist; use the lightest one that proves what you
changed, and reserve the heaviest (real model) for a final confirmation.

| Tier | What runs | Use for | Command |
|---|---|---|---|
| **jsdom UI** | renderer logic in jsdom (no Electron) | render/layout/logic regressions, fast | `npm run test:ui` |
| **Integration** | real services + a fake boundary (e.g. fake SessionManager) | service wiring without a model call | `npm run test:party-bridge` |
| **Full-process e2e** | the **real Electron app** + real engine + real model | end-to-end through the actual app, billed | manual (below) |

### What `test:ui` covers (jsdom suite — keep this current when adding scripts)

| Script | Covers |
|---|---|
| `qa-workspace-location` | workspace = cwd / storage location rules |
| `qa-layout` | panel/tab layout engine, incl. `openMemberInNewPanel` (create → new region) |
| `qa-render` | renderer smoke render |
| `qa-askq` | AskUserQuestion choice-card rendering |
| `qa-interaction-api` | QA interaction API (inject AskUserQuestion) |
| `qa-model-catalog` | model catalog / routing |
| `qa-party-bridge` | in-process party bridge (send/create/remove/list) + the session **primer** |
| `qa-party-mock` | inter-member messaging over the mock harness (engine-level) |
| `qa-member-wizard` | member-create step wizard + model detail |
| `qa-member-remove` | sidebar delete via right-click context menu: **member** delete (`삭제하기`, `main` protected) **and party** delete (two-step confirm `파티 삭제…` → `한 번 더 클릭` → `onRemoveParty`) |
| `qa-member-start-model` | member keeps its own model on first chat (no global fallback) |
| `qa-channel-render` | message **cards** (channel send/receive) + **party-action** cards (create/remove) |
| `qa-markdown` | markdown rendering of model output (headings/list/code/JSON/table/link) |
| `qa-tool-output` | tool-call (bash) rendering: long command/result show a clipped **preview** inline with a summary "전체 보기" control that opens a popup holding the FULL command + result; short content has no expand control; content-array results render as plain text |
| `qa-message-preview` | sent/received **message** bodies (user + channel) preview by default and open the FULL text in a popup via "전체 보기"; short messages show in full with no expand control |
| `qa-command-palette` | composer `/` command/skill palette: harness-aware trigger, **live harness-reported inventory** (plugin/MCP/custom commands) merged with static built-ins, filter, action vs insert select |
| `qa-default-profile` | member-creation default derived per-harness (`defaultMemberProfileOf`); RuntimeModal **harness lock** after first turn |
| `qa-harness-defaults` | **per-harness creation defaults** (harness-general): `harnessDefaultsOf`/`defaultMemberProfileOf` resolve each harness's own defaults; `buildPartyMember` creates a member from ITS harness's defaults (Codex → codex default model + 2-axis policy, Claude → claude default + permission mode); legacy flat settings.json migrates into `harnessDefaults["claude-code"]` |
| `qa-codex-policy` | Codex two-axis safety model: presets (Read Only/Auto/Full Access) + sandbox×approval + guardian; RuntimeModal shows it for Codex only |
| `qa-codex-approval` | Codex approval card variants: decision option sets per request kind + decision→protocol mapping (accept/acceptForSession/execpolicy-amendment/decline), request→meta/response translation (command/fileChange/permissions/userInput/elicitation), and the Transcript card showing the exact command/diff + once/session/prefix-rule/decline buttons |
| `qa-codex-items` | Codex ThreadItem coverage: pure model (diff stats, fileChange normalization, plan steps, tool source mcp:<server>/plugin/namespace) + event pipeline (plan upserts one evolving card, command output deltas append, cwd/exit/duration merge, fileChange→diff block) + Transcript DOM (plan checklist, fileChange +/- stats, tool source badge + exit/duration, live output) |
| `qa-codex-discovery` | Codex `/` palette discovery: skills/list + plugin/installed → palette commands by source with disabled reasons (disabled skill / admin-disabled plugin; not-installed excluded), palette grouping (Skills/Plugins/Commands) + disabled badge, and CommandPalette DOM (source badges, dimmed disabled rows, preview reason) |
| `qa-codex-diagnostics` | Codex no-silent-fallback surfacing: classifier (reroute/rate-limit/guardian/config/deprecation/sandbox/mcp → severity+category, sandbox recovery hint; noisy rate-limit ticks + healthy MCP return null) + event pipeline (diagnostic→block, latestDiagnostic header pick) + Transcript DOM (severity banner, reroute detail, recovery hint) |
| `qa-codex-models` | Codex live model catalog: `model/list` normalization (default-first, hidden dropped) + codex routes (per-model effort caps, leaderboard meta enrichment, static fallback without discovery) + MemberWizard DOM (all discovered models listed, pending hint, error banner + retry — no silent fallback) |
| `qa-vision` | Image (vision) support single-source gate: every model route carries `capabilities.vision`; the three text-only models (GLM-5.2 / Qwen3.7 Max / DeepSeek V4 Pro) are `image:false`, the rest `true`; `visionForModel` resolves by id/runtime/orModelId + Codex gpt-slug twin; Codex+OpenRouter routes inherit catalog vision; and the router shim translates an Anthropic image block into an OpenAI `image_url` part **without silently dropping it** (text-only messages stay plain strings) |
| `qa-composer-vision` | Composer image-attach gating (jsdom): on a vision model a dropped image adds a thumbnail and submit forwards `{kind:image,mediaType,dataBase64}` to `sendMessage`; on a text-only model the same drop is refused with a **visible reason** (no silent drop) and nothing is sent; the placeholder advertises image attach only when supported |
| `qa-stall-status` | Stall watchdog renderer contract (harness-general): a `stall` diagnostic as the newest block makes a busy member read as **stalled** (not an endless "responding" spinner), later activity clears it back to working, turn end → idle, and a stalled member is not `busy` (panel offers restart). Backed by `SessionManager.scanForStalls` which flags an active turn silent past 120s. |
| `qa-mcp` | MCP (external server) status + actions through the SAME `EngineConnection` methods the `/api/sessions/:id/mcp*` endpoints and the workbench MCP panel call (route parity): neutral snapshot shape + harness tag + per-server capability flags (`canReconnect`/`canToggle`/`canAuthenticate` — the honest Claude↔Codex asymmetry), and reconnect/toggle/authenticate mutating live state. Backed by the QA mock harness's seeded servers (connected+tools / needs-auth+authenticate / failed+error). |
| `qa-subagents` | subagent-observation view-models (dock + drill-in detail) + the `applySubagentEvents` fold that keeps subagent output in a SEPARATE slice from the parent transcript: status→style mapping, live one-line `currentAction` selection (`deriveSubagentAction`, the swap point in `src/shared/subagentActivity.ts`), responsive dock thresholds, empty assistant/status blocks dropped so a query-less/empty item never renders as a blank "선처럼" strip. Driven by the mock scenarios in `src/shared/subagentScenarios.ts`. |
| `qa-subagent-tracker` | subagent **attribution** replayed against RECORDED real harness traffic (`scripts/fixtures/subagents/*.jsonl`, captured live from Haiku + gpt-mini): `ClaudeSubagentTracker` (task_started/progress/updated keyed by task_id+tool_use_id; `local_bash` steps never become their own rows) and `CodexSubagentTracker` (child-`threadId` routing, `collabAgentToolCall` prompt capture, powershell/bash launcher unwrap, `web_search` card with `action.queries` fallback so an empty top-level `query` still shows). Locks correct attribution + parent/child separation against the ACTUAL protocol shapes. |

When you add a QA script or `/api/*` endpoint, update this table (and `docs/API.md`
for endpoints) so other sessions can discover it.

The first two are deterministic and belong in CI. The full-process e2e is manual
(it launches a GUI and makes billed model calls) but is the **only** tier that
catches main↔renderer / remote-engine wiring gaps — e.g. it caught the WSL party
broadcast bug that the integration test (in-process fake) could not see.

**Develop and QA the frontend on mocks; reach for the real model only at the
end.** You should never need to start a real session and type chat to verify a
frontend behavior. Mock the backend's inputs and outputs over the API instead,
and watch the result in the UI — then do one full-process e2e to confirm.

**Self-launching, offline full-process checks** exist for state-only paths that
need no model turn — they boot a real Electron app on an isolated
`AGENTPARTY_USER_DATA` + temp workspace, drive it over HTTP, and clean up:
`node scripts/qa-app-party-delete-e2e.mjs` verifies party deletion end-to-end
(create A+B → delete active B → A becomes current + B's on-disk dir removed →
delete last party → parties/current cleared → missing party errors, no silent
no-op). Not billed; safe to run anytime after `npm run build`.

`node scripts/qa-app-mcp-e2e.mjs` verifies the MCP status endpoint against the
**real** harness adapters (billed — starts a live Claude + Codex member): creates
one member per harness, warms its session, then `GET /api/sessions/:id/mcp` and
asserts `supported:true`, the correct `harness` tag, and a well-formed `servers`
array from the real SDK `mcpServerStatus()` (Claude) / app-server
`mcpServerStatus/list` (Codex) — proving the real MCP path, not just the mock.

`node scripts/e2e-subagents.mjs` (or `npm run test:e2e:subagents`) boots the real
app and injects the subagent scenarios through
`POST /api/qa/members/:name/subagents`, proving the dock + drill-in detail render
end-to-end through the real normalization + fold. Not billed — no real subagent is
spawned (mock-driven design); the trackers themselves are locked against RECORDED
real traffic by `qa-subagent-tracker` (in `test:ui`).

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
| `POST /api/qa/members/:name/subagents` `{scenario}` | inject a named **subagent** scenario (`claude-test-shards` / `codex-call-tracer` / `codex-web-research` in `src/shared/subagentScenarios.ts`) as `subagent` normalized events — drives the dock + detail through the real fold with no real subagent spawned |
| `POST /api/qa/members/:name/subagents/open` `{subId}` | open a subagent's drill-in detail (`subId` = the subagent id, or `"first"`) |
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

For the deterministic smoke path, run:
```
npm run test:e2e
```

For a deterministic **Codex approval-decision** e2e (no model), run:
```
npm run test:e2e:codex-approval
```
It launches the real app on the LEFT monitor with a fake `codex app-server`
(`scripts/fake-codex-appserver.mjs`) that pauses a turn on a command / file-change
approval, resolves it via `POST /api/sessions/:id/approve` with
`{ codexDecision: "session" | "always" }`, and asserts the whole path emits the
correct protocol decision (`acceptForSession` /
`acceptWithExecpolicyAmendment` / degrade-to-session). The fake server records the
decision it received to a sidecar file so the assertion sees the real end-to-end
result.
The smoke driver launches its own Electron process with
`AGENTPARTY_ALLOW_MULTI_INSTANCE=1` and a dedicated automation port
(`AGENTPARTY_E2E_PORT`, default `48931`) so it does not attach to an already
open development app. It also injects a fake `codex app-server` binary through
`AGENTPARTY_CODEX_BIN`/`AGENTPARTY_CODEX_ARGS`, so the Codex harness path is
verified without a real model call.

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
Then read the PNG. **Background capture works** — even when the window is behind
others. `src/main/main.ts` disables Chromium's native window occlusion
(`disable-features=CalculateNativeWinOcclusion` + occluded/renderer backgrounding
switches) and sets `webPreferences.backgroundThrottling: false`, so an occluded
window keeps painting and `capturePage()` returns real pixels off-foreground.
(Without those, Windows returns a 0-byte image for occluded windows —
electron/electron#31992.) A still-**minimized** window may still capture empty;
if so, restore it. The switches only apply to a freshly launched app, so rebuild
+ relaunch after changing them.

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
