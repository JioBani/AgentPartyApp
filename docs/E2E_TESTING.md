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
| `qa-model-catalog` | model catalog / routing, incl. DeepSeek direct-API routes and the codex Responses-API gate |
| `qa-party-bridge` | in-process party bridge (send/create/remove/permission/list), explicit initial permissions, concrete execution-harness discovery, idempotent start + the session **primer** |
| `qa-party-mock` | inter-member messaging over the mock harness (engine-level) |
| `qa-member-wizard` | member-create step wizard + model detail + explicit initial permission step |
| `qa-member-remove` | sidebar delete via right-click context menu: **member** delete (`삭제하기`, `main` protected) **and party** delete (two-step confirm `파티 삭제…` → `한 번 더 클릭` → `onRemoveParty`) |
| `qa-member-start-model` | member keeps its own model on first chat (no global fallback) |
| `qa-channel-render` | message **cards** (channel send/receive) + **party-action** cards (create/remove) |
| `qa-markdown` | markdown rendering of model output (headings/list/code/JSON/table/link) + links routed to the OS browser: a click is `preventDefault`ed and handed to `openExternal`, and the adjacent copy control writes the target URL |
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
| `qa-codex-compact` | Codex compact control: `/compact`/toolbar compact during an active turn is queued with a visible status, sent as `thread/compact/start` after root turn completion, compact completion clears stale context occupancy, and compact failures surface as errors. |
| `qa-codex-models` | Codex live model catalog: `model/list` normalization (default-first, hidden dropped) + codex routes (per-model effort caps, leaderboard meta enrichment, static fallback without discovery) + MemberWizard DOM (all discovered models listed, pending hint, error banner + retry — no silent fallback) |
| `qa-vision` | Image (vision) support single-source gate: every model route carries `capabilities.vision`; `visionForModel` resolves by id/runtime/orModelId + Codex gpt-slug twin; Codex+OpenRouter routes inherit catalog vision; and the Claude Code gateway preserves Anthropic image blocks without rebuilding or silently dropping them. |
| `qa-composer-vision` | Composer image-attach gating (jsdom): on a vision model a dropped image adds a thumbnail and submit forwards `{kind:image,mediaType,dataBase64}` to `sendMessage`; on a text-only model the same drop is refused with a **visible reason** (no silent drop) and nothing is sent; the placeholder advertises image attach only when supported |
| `qa-stall-status` | Stall watchdog renderer contract (harness-general): a `stall` diagnostic as the newest block makes a busy member read as **stalled** (not an endless "responding" spinner), later activity clears it back to working, turn end → idle, and a stalled member is not `busy` (panel offers restart). Backed by `SessionManager.scanForStalls` which flags an active turn silent past 120s. |
| `qa-mcp` | MCP (external server) status + actions through the SAME `EngineConnection` methods the `/api/sessions/:id/mcp*` endpoints and the workbench MCP panel call (route parity): neutral snapshot shape + harness tag + per-server capability flags (`canReconnect`/`canToggle`/`canAuthenticate` — the honest Claude↔Codex asymmetry), and reconnect/toggle/authenticate mutating live state. Backed by the QA mock harness's seeded servers (connected+tools / needs-auth+authenticate / failed+error). |
| `qa-auto-compact` | per-member auto-compaction pure logic (`src/shared/autoCompact.ts`): threshold clamp/step-snap (50–95), OFF-by-default, stored/HTTP `normalizeAutoCompact`, inheritance (member setting → global `compactDefault` → built-in), token estimate (never against an unknown window), and `shouldAutoCompact` crossing test the renderer trigger fires on (off / unknown-window / unknown-usage never fire). |
| `qa-compact-dialog` | context donut + Auto-compact dialog render (jsdom), locking `design_handoff_auto_compact`: the donut is a **ring** (not a bar) with a threshold **tick** only when on, and clicking it opens the dialog; the dialog carries the current-usage card (used/total/%), the enable toggle, the 50–95 step-5 threshold slider, and a footer with **지금 압축 실행** (fires `compact` + closes; disabled with no live session) beside **완료**. |
| `qa-usage-limits` | account/provider-scoped rate-limit indicator (titlebar). Pure logic in `src/shared/usageLimits.ts` — window merge by kind (unreported windows preserved), level-color escalation (brand <75 → `--live` ≥75 → `--danger` ≥90; unknown → muted, never brand), reset-countdown formatting, epoch-seconds→ms normalization, and the full `buildUsageView` view model across known / unknown-loading / N/A (API key) / empty states (no fabricated 0%). Plus a jsdom render of `<UsageLimitPill>`: segments paint, click opens the popover with 5h + weekly meters + countdown, and ≥75% paints the warning border. |
| `qa-subagents` | subagent-observation view-models (dock + drill-in detail) + the `applySubagentEvents` fold that keeps subagent output in a SEPARATE slice from the parent transcript: status→style mapping, live one-line `currentAction` selection (`deriveSubagentAction`, the swap point in `src/shared/subagentActivity.ts`), responsive dock thresholds, empty assistant/status blocks dropped so a query-less/empty item never renders as a blank "선처럼" strip. Driven by the mock scenarios in `src/shared/subagentScenarios.ts`. |
| `qa-party-store` | party storage **split** (`PartyRepository`): the on-disk layout is a SHARED index `parties.json` + PER-PARTY `parties/<id>/party.json` (members/messages), so two processes editing different parties of one workspace never clobber. Locks in: legacy single-`state.json` → split migration (data intact, blob kept as backup, no re-migrate on the 2nd read), per-party **write isolation** (editing party A leaves party B's file byte-identical + mtime unchanged), and **authoritative partyId** (a member's party is its FILE — a missing/wrong stored `partyId` is corrected, never silently mis-routed). |
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

`node scripts/e2e-discovery.mjs` launches TWO real app processes that SHARE one
userData but open DIFFERENT cwds (the exact condition that used to clobber the
global `<userData>/automation.json`) and asserts they are independently
discoverable: each workspace's `instances/<pid>.json` points at its own process,
no global file is written, a party created in one is invisible to the other, and
discovery is cleaned up on quit. Offline.

`node scripts/e2e-party-store.mjs` boots the real app on an isolated userData +
temp workspace (offline — mock members, no model) and proves the party storage
split end-to-end: a pre-seeded legacy `state.json` migrates on first read; new
parties/members persist to the split layout (index + per-party files, isolated);
selecting a party persists `lastActivePartyId`; and after an app RESTART the
parties restore with `currentPartyId` back at the last-active party (proving
`currentPartyId` is per-process runtime seeded from the persisted hint).

`node scripts/e2e-usage-limits.mjs` (or `npm run test:e2e:usage-limits`) boots the
real app on an isolated userData + temp workspace (offline — mock member, no
model) and proves the usage-limit indicator end-to-end: provider usage injected
over `POST /api/qa/usage` is aggregated per provider (separate 5-hour + weekly
reports MERGE, and a re-report replaces only its own window), served by
`GET /api/usage`, and pushed to the titlebar pill (a `usage-limits.png` capture
shows the live Claude/Codex rings). Starts empty (no fabricated 0%).

`node scripts/e2e-sidebar-overflow.mjs` (or `npm run test:e2e:sidebar-overflow`)
boots the real app on an isolated userData + temp workspace (offline — mock
members, no model) and locks the OVERFLOW-SAFETY invariant behind [#11]: with 16
parties and 27 members the sidebar lists must SCROLL, not clip. Unlike a
screenshot check it MEASURES the running renderer over the Chrome DevTools
Protocol (`--remote-debugging-port=0`, port read from `<userData>/
DevToolsActivePort` — nothing hardcoded), asserting each list overflows, has a
computed `overflow-y` that actually scrolls, stays inside the window, keeps the
Members section usable beside it, and — the decisive one — that after scrolling
to the bottom `document.elementFromPoint()` over the LAST row hits that row, i.e.
it is clickable. It also asserts an open `.wb-dd-menu` is height-bounded and
scrolls. Horizontal menu containment is deliberately NOT asserted (see the note
in the script): `<Dropdown>`'s default `align="left"` can push a menu past the
right window edge, which needs a placement fix in `Dropdown.tsx`.

`node scripts/e2e-usage-unpriced.mjs` (or `npm run test:e2e:usage-unpriced`)
seeds a usage ledger holding one member on a priced model and one on a model
that is deliberately absent from the catalog, boots the real app on that
workspace (offline, no model call) and proves the dashboard never prices what it
cannot price: `GET /api/token-usage` reports `unpricedTurns`/`unpricedTokens`
instead of folding those turns into `estCostUsd`, and — measured in the running
renderer over CDP — the per-bucket table shows `?` for the bucket that member
actually spent in, its totals are marked `+?`, and the timeline caption states
how many turns are missing from its bars. Guards the AGENTS.md no-silent-
fallback rule at the exact spot it was violated (a `return 0` that summed into
`≈$0.000`).

`node scripts/e2e-transcript-render.mjs` (or `npm run test:e2e:transcript-render`)
boots the real app on an isolated userData + temp workspace (offline — a mock
member, no model) and drives the transcript-rendering surfaces the W2 lane owns.
It discovers the app through the **per-workspace instance file** (no fixed port)
and asserts the served workspace is its own. First leg — **links open in the OS
default browser**: a markdown link is clicked in the REAL renderer and the main
process's own IPC log is checked for `shell:openExternal` carrying that URL,
proving the renderer→preload→main path that no jsdom test can see; the app is
then confirmed not to have navigated away. The link's copy control is clicked and
captured so its honest outcome (check on success, ✗ when the clipboard refuses)
is visible.

`node scripts/e2e-discord-bridge.mjs` (or `npm run test:e2e:discord-bridge`) boots
the real app on an isolated userData + temp workspace and proves the Discord
bridge end-to-end **against Discord's own REST API**, not against our return
values: `/api/discord` reports the stored credentials without ever echoing the
token, `…/discord/connect` creates the member's channel, `…/discord/send` lands a
message in it, content over 2000 characters is REJECTED with the limit stated
(never truncated), and a **live model turn** has the member itself call the
`discord-connect`/`discord-send` MCP tools. It then navigates to Settings →
Runtime and captures the Discord card. The e2e channel is deleted on exit.

It also covers the **control panel** (docs/기획 노트.md §11.14): starting the app
registers nothing, `!파티` lists the party with the short id to register by,
`!등록` creates the channel under this desktop's category with the identity topic,
`!상태` reports the member as having no thread yet, `!연결` creates the thread
inside that channel, the binding records the owning app instance, a later HTTP
`connect` reuses both, and `!중단`/`!재시작` act on a live model turn. Commands are
driven through `POST /api/discord/command` — the same dispatcher a typed Discord
message reaches, since the bot cannot post as the user.

Image upload is covered too: a real PNG posted through
`…/discord/send-image` is verified as an actual Discord attachment, and an
over-size one is rejected with the limit stated. The other direction (an image
the USER attaches) and the 📨 → ⚙️ → ✅ delivery receipt only apply to messages a
person typed, so they are checked in the manual inbound leg — the script prints
what to look for.

`node scripts/qa-discord-control-panel.mjs` sets up an **attended** QA session for
exactly those legs and then gets out of the way: it launches the real app on an
isolated userData + temp workspace under the desktop name `QA-PC`, creates a
party and a member, registers the channel and connects the member *through the
control panel itself*, and leaves the app running with a printed checklist
(receipt reactions, typed commands, image in both directions, a second desktop
staying silent). `--status` shows what is bound and each binding's owning pid;
`--stop` kills that app's process tree and deletes the QA channel and category.
Needs `DISCORD_BOT_TOKEN` + `DISCORD_USER_ID`.

`--wsl` runs the same assertions against a workspace **inside a WSL distro**
(`AGENTPARTY_WSL_DISTRO`, default `Ubuntu-22.04`). That path matters: the party
tools then execute in the headless in-distro engine while the bridge stays on the
desktop, so the tools reach it through the reverse host-call channel. It caught a
real defect — the distro reports a bare posix workspace path while the desktop
knows `wsl+Distro:/path`, so the same member was keyed two ways and got two
channels; the desktop now always keys by its own URI.

Needs `DISCORD_BOT_TOKEN` + `DISCORD_USER_ID` (a `.env` next to the app is read).
By default it also runs the **inbound** leg, which is MANUAL: the bridge ignores
its own posts, so no bot can stand in for the user. The script prints the channel
to type in and waits (5 min) for the member to answer what you wrote. Pass
`--no-inbound` for an unattended run. Inbound also requires MESSAGE CONTENT INTENT
to be enabled for the bot — without it the gateway closes with 4014, and the app
says exactly that instead of showing a bare code.

`node scripts/e2e-auto-compact.mjs` (or `npm run test:e2e:auto-compact`) boots the
real app on an isolated userData + temp workspace (offline — mock members, no
model) and proves per-member auto-compaction end-to-end: `POST /api/party/members/
:name/auto-compact` persists a member's threshold both on `GET /api/state` AND in
the on-disk `party.json` (snapping 77 → 75), `{ autoCompact: null }` clears the
override, `POST /api/settings { compactDefault }` persists the global default, and
the workbench renders with the member open — the capture (`auto-compact-e2e.png`)
shows the toolbar compact pill + the sidebar `⇲ NN%` badges (members without their
own setting inheriting the global default). The crossing-trigger + inheritance
logic is locked deterministically by `qa-auto-compact` (in `test:ui`).

`node scripts/e2e-compact.mjs` is a BILLED manual-compaction probe (Sonnet low +
GPT mini low): it sends one real turn to each, then `POST /api/sessions/:id/compact` and
surfaces the harness outcome (Claude reports "compact failed / nothing to compact"
on a short session; Codex reports its actual compact lifecycle). Used to verify the compact
result/error is ATTRIBUTED, not folded into a generic "idle: failed" status.

`node scripts/e2e-permission-persist.mjs` (or `npm run test:e2e:permission-persist`)
boots the real app on an isolated userData + temp workspace (offline — mock members,
no model) and proves that Claude `permissionMode` and Codex `codexPolicy` changes
made DURING a session are written back to each owning member's `party.json` and
restored after an app RESTART. It also verifies the name-addressed member
permission endpoint works while the target is idle, and that a member-tool
party header still targets its spawning party after the desktop selects another
party.

`node scripts/e2e-member-permission-ui.mjs` (or `npm run test:e2e:permission-ui`)
is the same guarantee one layer up, driven through the REAL composer widgets:
it clicks `.wb-codex-perm-trigger` → a preset segment (and the Claude 권한
dropdown) via `POST /api/capture {click}` and asserts the choice reaches
`party.json` and survives a restart — **both with a live session and with the
member's session closed**. The closed-session case is the regression: the
composer's setters used to be session-scoped (`if (sessionId) …`), so a
permission changed while the session was down was dropped and the control
snapped back, which users reported as "the Codex permission resets itself".
It picks an OS-assigned free port, so lanes can run it concurrently.

`node scripts/e2e-live-codex-party-tools.mjs` (or
`npm run test:e2e:live-codex-party-tools`) is a billed one-turn GPT mini check of
the actual Codex stdio MCP surface. It requires the model to call
`mcp__agentparty-app__member-permission` and verifies the other member's
permission changed on the app/API side.

`node scripts/e2e-live-session-reopen.mjs` (or
`npm run test:e2e:live-session-reopen`) is the billed, minimal regression for
member conversations closing after menu navigation or an app restart. It runs a
real Electron process twice with the same workspace and userData, using native
Claude Sonnet at low effort. Two short turns prove that a visible panel
auto-creates a `resume-*` session without an explicit `/start`, retains the
persisted transcript, keeps the same harness thread, and preserves model context.
Cross-provider routing is tested separately so local OAuth/proxy state cannot
mask this lifecycle regression.

`node scripts/e2e-live-deepseek.mjs` (or `npm run test:e2e:live-deepseek`) is the
billed, real-process proof that DeepSeek's OWN API serves both harnesses from one
key: DeepSeek V4 Pro runs in Claude Code against `https://api.deepseek.com/anthropic`
(Anthropic Messages), and DeepSeek V4 Flash runs in Codex app-server against
`https://api.deepseek.com/responses` with `modelProvider: "deepseek"`. It also
asserts the honest-unavailability contract: V4 Pro stays VISIBLE on codex but
disabled, because DeepSeek does not serve pro on the Responses API yet
(verified live 2026-07-31) — a disabled route is never silently rerouted to
OpenRouter. Needs `DEEPSEEK_API_KEY`; no subscription is involved.

`node scripts/e2e-live-cross-harness.mjs` (or
`npm run test:e2e:live-cross-harness`) is the billed, real-process interruption
proof of true harness/model cross-routing. For each direction it waits for a real
streaming response, stops it through the same party interrupt action as the UI,
sends a replacement user message, and verifies the old turn never finishes. GPT
5.4 mini low runs in Claude Code through Anthropic Messages; Claude Sonnet low
runs in Codex app-server through Responses with
`modelProvider: "claude-subscription"`. GPT uses Codex/ChatGPT OAuth and Claude
uses Claude OAuth; OpenRouter credit is not involved.

`node scripts/e2e-subagents.mjs` (or `npm run test:e2e:subagents`) boots the real
app and injects the subagent scenarios through
`POST /api/qa/members/:name/subagents`, proving the dock + drill-in detail render
end-to-end through the real normalization + fold. Not billed — no real subagent is
spawned (mock-driven design); the trackers themselves are locked against RECORDED
real traffic by `qa-subagent-tracker` (in `test:ui`).

`npm run test:harness-protocol` is the non-billed protocol contract test. It
proves Claude Code owns Anthropic Messages and Codex owns Responses regardless
of model/provider. A fake GPT subscription receives the complete interrupt,
user, tool, thinking, and image-capable Anthropic request at `/v1/messages`;
only the concrete model id changes and fallback fields are removed.

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
| `POST /api/qa/gate/open` `{kind:"member"\|"party", member}` | open a **Message Gate** modal over HTTP (member editor for `member`, or party manager for `member`=partyId) so an agent can drive the real UI route + `/api/capture` it |
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
`AGENTPARTY_ALLOW_MULTI_INSTANCE=1`, an **isolated `AGENTPARTY_USER_DATA`**, and
discovers it via the **per-workspace instance file** (never a fixed port). Both
are load-bearing: a fixed-port poll once attached the driver to the USER'S
running app (which had that port persisted in settings) and drove real sessions
there, and a shared userData let e2e writes pollute the real settings/parties.
It also injects a fake `codex app-server` binary through
`AGENTPARTY_CODEX_BIN`/`AGENTPARTY_CODEX_ARGS`, so the Codex harness path is
verified without a real model call.

For a **live context-capacity meter** e2e (real Claude + Codex calls), run:
```
npm run test:e2e:context-usage
```
It launches the real app on the LEFT monitor, creates a party with two live
members (`claudey` on Claude Code / sonnet, `codexy` on Codex / gpt-5.4-mini),
sends one real turn to each, and asserts each member's session snapshot carries
`contextTokens > 0` — proving the adapters capture live context-window occupancy
from the harness's own usage report (Claude: assistant-message
`input + cache + output`; Codex: `tokenUsage.last`). Both panels are opened and
captured (`context-usage.png`) so the rendered meters (`used / total` + fill bar)
are visible. Override the Codex model with `AGENTPARTY_LIVE_CODEX_MODEL`.

For **member respawn** — the tab toolbar's reset button (reload the session while
CONTINUING the conversation) and `POST /api/party/members/:name/respawn` — run
(real Claude):
```
npm run test:e2e:member-respawn
```
Respawn is the button you press after adding an MCP server so it takes effect
without losing the chat. The test launches the real app, creates a Claude member,
starts it (session A, id `session-…`), sends one real turn to commit the harness
thread, then respawns and asserts the new session id is a RESUME session
(`resume-…`) — proving the fresh session was created WITH the old thread as its
resume target (conversation continues), not a fresh chat — that B ≠ A, the member
is running bound to B with the SAME harness thread id, the old app session A is
gone from `/api/state`, and the persisted model survived. Proves the whole
reload+resume chain through the real main process + HTTP + real session lifecycle
(qa-party-bridge proves the same service composition against a fake SessionManager;
qa-render proves the toolbar button and the right-click "하드 리스타트" menu wiring).
Override the model with `AGENTPARTY_LIVE_CLAUDE_MODEL`.

For the **background usage poller** — account usage staying fresh with NO open
session — run (real Claude):
```
npm run test:e2e:usage-poller
```
It creates a Claude member, closes every session (defeating the workbench prewarm,
including any orphan session) to reach a genuine zero-session state, then asserts
`GET /api/usage` still reports `claude` — sourced by the background poller, which
is deliberately absent from `state.sessions` (so "zero sessions + usage present"
isolates it). It then starts a live session (poller is reused, not duplicated) and
closes it (poller revives) to prove reconciliation never wedges. Capture:
`usage-poller.png`.

For a **live Fable 5 catalog/routing** e2e (one real Claude Fable turn), run:
```
npm run test:e2e:live-fable
```
It launches the real app (discovered via the per-workspace instance file — never
a fixed port; the persisted `automationApiPort` in a user's installed app once
made a fixed-port driver hijack that app and rewire its workspace), asserts
`GET /api/models` exposes `claude-fable-5[1m]` with the right shape (native
anthropic, adaptive-only thinking, effort to max, image vision, and NO `fable`
short alias — the CLI rejects it), then starts a live member on that model,
sends one real turn, and asserts the reply + live `contextTokens` prove the id
routes natively through the claude-code harness.

For a **live Opus 5 catalog/routing** e2e (one real Claude Opus 5 turn), run:
```
npm run test:e2e:live-opus5
```
Same shape as the Fable run, for `claude-opus-5[1m]`: it asserts the route is
native anthropic with a 1M window, effort to `max` defaulting to `high`, thinking
defaulting to `adaptive`, image vision, that `claude-opus-4-8[1m]` is still
selectable alongside it, and that NO `opus`/`opus[1m]` short-alias route exists —
the CLI's short aliases resolve to the *latest* model of a family (`opus` →
`claude-opus-5` as of CLI 2.1.220), so an alias-keyed route silently changes model
under a fixed label on a CLI update. The live turn additionally asserts the
snapshot model is an Opus 5 (never 4.8). Capture: `opus5-e2e.png`.

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

⚠️ **A script that spawns the app itself must derive the app root from
`import.meta.url`, never a hardcoded `C:\Project\AgentPartyApp`.** A hardcoded
root builds and runs the MAIN worktree, so a script run from any other worktree
tests code that does not contain the change under test — and reports a pass:
```js
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
```
Note `scripts/lib/electron-e2e.mjs` takes `root` as an argument, so the caller is
what has to be right.

⚠️ **A script that spawns the app itself must point it at a workspace through the
isolated `settings.json`, not an env var.** The app reads its launch workspace
from `<AGENTPARTY_USER_DATA>/settings.json` `workspacePath`; there is **no
`AGENTPARTY_WORKSPACE` env var** (`scripts/lib/electron-e2e.mjs` used to set one
— it was never read). Without it the app falls back to its **cwd**, which for a
script run from the repo is the source tree, and it drops its discovery dir
(`.agent_party_app/`) there — polluting the worktree it was supposed to leave
alone. So, before launching:
```js
fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ workspacePath: ws }));
```
and then assert the served workspace is yours (`GET /api/windows`) before driving
anything. `scripts/e2e-transcript-render.mjs` is the reference. Keep
`AGENTPARTY_ALLOW_MULTI_INSTANCE=1` and do **not** pin `automationApiPort` — the
port stays ephemeral and is found through the instance file (step 3).

### 3. Discover the automation API port
The port is ephemeral — **never hardcode it**. Discovery is **per-workspace** (no
machine-global file, so multiple processes on different cwds never shadow each
other). Each process serving a workspace drops a file under that workspace:
```
<workspace>/.agent_party_app/instances/<pid>.json
                                  { "baseUrl": "http://127.0.0.1:<port>", "pid, workspace, startedAt }
```
Scan that dir, pick a live entry (`scripts/lib/discovery.mjs` → `firstBaseUrl(workspace)`;
for a WSL workspace pass the `wsl+<distro>:/path` URI — the file resolves via the
`\\wsl$` UNC view). Poll `GET <baseUrl>/api/health` until `ok`.

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
POST /api/capture  {}                    →  { ok, path, width, height, bytes }
POST /api/capture  {click: "<selector>"} →  { ok, …, clicked: true,
                                              applied: { clicked: true } }
POST /api/capture  {scrollY: "bottom"}   →  { ok, …, applied: { scrollY: 1840 } }
```
`click` dispatches a real click before capturing, which is how an e2e drives the
actual UI over HTTP. **A selector that matches nothing FAILS the request.** It
used to answer `{ok:true}` regardless, so an e2e driving a mistyped or
since-renamed selector passed green without clicking anything.

The same applies to framing: `scrollY`/`scrollX` report the position actually
reached in `applied`, an explicitly named `scrollSelector` that does not exist
fails, and `scrollX` without `scrollSelector` fails. A screenshot of the wrong
scroll position looks exactly as plausible as the right one, so "I checked the
section below the fold" has to be checkable — assert on `applied`.
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
