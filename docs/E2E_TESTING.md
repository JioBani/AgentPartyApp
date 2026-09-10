# Testing & QA — mocks first, full process last

Several tiers of verification exist; use the lightest one that proves what you
changed, and reserve the heaviest (real model) for a final confirmation.

| Tier | What runs | Use for | Command |
|---|---|---|---|
| **디자인 목업** | the shipping components with fixture props, in a browser | reviewing a screen's LAYOUT against the design, including states that are expensive to produce for real | `npm run build` → open `dist-renderer/preview/index.html` |
| **jsdom UI** | renderer logic in jsdom (no Electron) | render/layout/logic regressions, fast | `npm run test:ui` |
| **Integration** | real services + a fake boundary (e.g. fake SessionManager) | service wiring without a model call | `npm run test:party-bridge` |
| **Full-process e2e** | the **real Electron app** + real engine + real model | end-to-end through the actual app, billed | manual (below) |

### 파티 그룹 · 멤버 cwd — 수동 e2e 레시피

기능 자체가 "앱을 어디서 띄웠는지와 무관"이라, 한 워크스페이스만 보는 검증은
아무것도 증명하지 못한다. 실제로 확인한 순서:

1. **마이그레이션 대상 만들기** — 격리 userData 와, `groupId` 도 `location` 도 없는
   `.agent_party_app` 를 손으로 심은 워크스페이스. 앱을 그 위에서 띄우면 부팅
   중에 마이그레이션이 돈다.
2. **정본성 확인** — `parties.json` 의 파티 id 와 멤버 이름이 그대로인지,
   `party.json` 의 멤버에 `location` 만 채워졌는지 본다. 옮겨진 파일은 없어야 한다.
3. **멱등성** — `POST /api/party-groups/migrate` 를 두 번 더 호출해
   `registered: 0, backfilled: 0` 인지 본다.
4. **그룹** — 그룹을 만들고 파티를 옮긴 뒤 **앱을 재시작**한다. 이동이 살아남아야
   한다(부팅 마이그레이션이 되돌리면 안 된다 — 실제로 되돌렸던 버그다).
5. **cwd 무관** — 파티가 하나도 없는 다른 워크스페이스로 창을 옮긴다. 사이드바에
   같은 그룹·파티가 그대로 보여야 하고, 파티를 클릭하면 원래 워크스페이스로
   따라가 멤버가 열려야 한다.
6. **실제 검증** — 진짜 배포판으로 `POST /api/cwd/check` 를 네 번: 있는 경로, 없는
   경로, 없는 배포판, 상대 경로. 넷이 서로 다른 `problem.kind` 로 나와야 한다.
7. **교차 환경** — 같은 파티에 Windows 멤버와 WSL 멤버를 만들고 사이드바가
   `Win 1 · WSL 1` 로 읽히는지 본다.
8. **대체 금지** — 없는 경로를 기본 cwd 로 설정해 본다. 거절되고 기존 기본값이
   그대로 남아야 한다.

9. **cwd 가 실행에 쓰이는지** — 멤버를 워크스페이스가 아닌 폴더에 만들고 한 턴을
   돌린 뒤, Claude CLI 가 스스로 남긴 기록을 본다:
   `~/.claude/projects/<cwd 슬러그>/<세션>.jsonl` 의 첫 줄 `cwd` 필드. 모델의
   협조가 필요 없는 유일한 증거다(모델에게 물으면 대답을 지어낼 수 있다).
   폴더를 지운 뒤 재개하면 `폴더 없음` 으로 거절되어야 한다.

`AGENTPARTY_QA=1` 로 띄우면 `/api/qa/input` 으로 마법사 입력까지 몰 수 있어
멤버 만들기 2단계를 실제로 통과시켜 볼 수 있다.

### 디자인 목업 — `dist-renderer/preview/index.html`

A page vite builds alongside the app and the guide stage, and that the app never
links to. It mounts the **real** components — `PartyGroupList`, `CwdPicker`,
`MemberWizard`, `NewPartyModal`, `NewGroupModal`, `MoveGroupModal`,
`WorkspaceCwdSettings` — with fixtures from `src/shared/partyGroupsGallery.ts`.

It exists because these screens are otherwise expensive to look at: the recent-cwd
list only shows its interesting states once a WSL distro will not start and a
remembered folder has been deleted, and the party groups only read correctly with
three groups and nine parties in them. Producing that by hand, repeatedly, is how
a design stops being reviewed.

Two rules make it worth trusting:

- **The shipping components, never a copy.** A mockup that redraws the UI proves
  nothing about the UI, and drifts at the first refactor. Everything on the page
  is prop-driven, which is what makes fixture rendering possible at all.
- **A frozen clock.** `GALLERY_NOW` is a fixed instant, so "2일 전" renders the
  same today and next month. A preview whose text moves on its own cannot be
  compared against yesterday's screenshot.

Fidelity is checked by MEASUREMENT, not by eye: open the design mockup and the
preview in headless Chrome, read `getBoundingClientRect` + `getComputedStyle` off
the same selectors in both, and compare. The party-group and cwd surfaces were
signed off that way — section, control, list, row, badge and hint boxes matched
the mockup to the tenth of a pixel.

### What `test:ui` covers (jsdom suite — keep this current when adding scripts)

| Script | Covers |
|---|---|
| `qa-temp-isolation` | the jsdom suite's own bundles stay **inside this worktree**, never in the shared install — see below |
| `qa-codex-authentication-store` | Codex credential ownership boundary: no AgentParty native auth store, OAuth-token DTO, bridge token export, or desktop↔WSL credential-copy RPC |
| `qa-resume-target` | ClaudeAdapter restart resume target ([#17]): before the first turn a setting change must not resume an uncommitted harness session; after a turn a soft restart continues the live conversation |
| `qa-router-diagnostics` | GPT-on-Claude-Code startup errors name the CLIProxyAPI chain (router down vs proxy unconfigured); a direct Anthropic model stays free of those diagnostics |
| `qa-workspace-location` | workspace = cwd / storage location rules |
| `qa-environment-precision` | 환경 보고서의 Windows/WSL host, 실제 cwd/command, timeout·spawn·exit·not-found 분류가 보존되는지 검증 |
| `qa-layout` | panel/tab layout engine, incl. `openMemberInNewPanel` (create → new region) |
| `qa-render` | renderer smoke render |
| `qa-askq` | AskUserQuestion choice-card rendering |
| `qa-interaction-api` | QA interaction API (inject AskUserQuestion) |
| `qa-model-catalog` | model catalog / routing, incl. DeepSeek direct-API routes and the codex Responses-API gate |
| `qa-model-catalog-list` | the catalog's model LIST (R-5/6/7): the `filter → favourites → provider groups` assembly order (grouping first would hide a starred match inside a collapsed group), favourites pinned on top in CATALOG order and removed from their provider group, provider groups collapsed by default with a name preview + `사용 중` badge, search over model name + provider (the catalog carries no tier field — that confirmed-design axis has no data behind it and was dropped rather than faked), search force-expanding groups while READING but never writing the user's collapse flags, and the traps: a star click must not change the selection, Escape with a query clears the query instead of closing the modal, a filtered-out model stays selected, and a stored favourite the catalog cannot resolve draws no ghost row while staying in storage |
| `qa-party-bridge` | in-process party bridge (send/create/remove/permission/list), explicit initial permissions, concrete execution-harness discovery, idempotent start + the session **primer** |
| `qa-party-mock` | inter-member messaging over the mock harness (engine-level) |
| `qa-member-wizard` | member-create step wizard + model detail + explicit initial permission step |
| `qa-member-tab-group` | member-create wizard lists open workbench tab groups and emits the exact selected panel id through the shared create input |
| `e2e-member-tab-group` | real Electron + local automation API: targeted existing-group placement, default new-group placement, and explicit rejection without half-creation |
| `qa-member-remove` | sidebar delete via right-click context menu: **member** delete (`삭제하기`, `main` protected) **and party** delete (two-step confirm `파티 삭제…` → `한 번 더 클릭` → `onRemoveParty`) |
| `qa-member-start-model` | member keeps its own model on first chat (no global fallback) |
| `qa-channel-render` | message **cards** (channel send/receive) + **party-action** cards (create/remove) |
| `qa-markdown` | markdown rendering of model output (headings/list/code/JSON/table/link) + links routed to the OS browser: a click is `preventDefault`ed and handed to `openExternal`, and the adjacent copy control writes the target URL |
| `qa-tool-output` | tool-call (bash) rendering: long command/result show a clipped **preview** inline with a summary "전체 보기" control that opens a popup holding the FULL command + result; short content has no expand control; content-array results render as plain text |
| `qa-message-preview` | sent/received **message** bodies (user + channel) preview by default and open the FULL text in a popup via "전체 보기"; short messages show in full with no expand control |
| `qa-harness-badge` | the execution harness shown wherever a member is identified ([P-8]): the shared `harnessLabel`/`harnessShort` helper (full + short names, an UNKNOWN harness id surfaced as-is instead of mapped to a guess, no default for a member with none), and the TabStrip DOM — each tab carries ITS OWN badge, the tooltip names the harness in full, and the badge yields to the member name when narrow. The sidebar row's badge is covered by `qa-render`. |
| `qa-command-palette` | composer `/` command/skill palette: harness-aware trigger, **live harness-reported inventory** (plugin/MCP/custom commands) merged with static built-ins, filter, action vs insert select |
| `qa-composer-completion` | Triggerless composer completion: one letter can find a member/provider/model, a member created while a query is open appears without another keystroke, Tab commits a member mention or advances provider → model, durable versioned tags restore the exact selected labels in the transcript while malformed lookalikes remain literal, deleting a mistaken provider closes its now-stale model list, while deleting only a model keeps the provider and reopens that provider's full model list, reserved `/` and `@` syntax stays untouched, and an open list never steals the configured Enter/Ctrl+Enter send gesture |
| `qa-default-profile` | member-creation default derived per-harness (`defaultMemberProfileOf`); RuntimeModal **harness lock** after first turn |
| `qa-harness-defaults` | **per-harness creation defaults** (harness-general): `harnessDefaultsOf`/`defaultMemberProfileOf` resolve each harness's own defaults; `buildPartyMember` creates a member from ITS harness's defaults (Codex → codex default model + 2-axis policy, Claude → claude default + permission mode); legacy flat settings.json migrates into `harnessDefaults["claude-code"]` |
| `qa-codex-policy` | Codex two-axis safety model: presets (Read Only/Auto/Full Access) + sandbox×approval + guardian; RuntimeModal shows it for Codex only |
| `qa-codex-approval` | Codex approval card variants: decision option sets per request kind + decision→protocol mapping (accept/acceptForSession/execpolicy-amendment/decline), request→meta/response translation (command/fileChange/permissions/userInput/elicitation), and the Transcript card showing the exact command/diff + once/session/prefix-rule/decline buttons |
| `qa-codex-items` | Structured transcript coverage: Codex pure model/event pipeline plus Transcript DOM for native fileChange diff rows and shared file-edit styling on untouched Claude Code `Edit`, Cursor `edit_file`, and Grok `edit` tool payloads. Also guards read-only tools against file-edit styling. |
| `qa-codex-discovery` | Codex `/` palette discovery: skills/list + plugin/installed → palette commands by source with disabled reasons (disabled skill / admin-disabled plugin; not-installed excluded), palette grouping (Skills/Plugins/Commands) + disabled badge, and CommandPalette DOM (source badges, dimmed disabled rows, preview reason) |
| `qa-codex-diagnostics` | Codex no-silent-fallback surfacing: classifier (reroute/rate-limit/guardian/config/deprecation/sandbox/mcp → severity+category, sandbox recovery hint; noisy rate-limit ticks + healthy MCP return null) + event pipeline (diagnostic→block, latestDiagnostic header pick) + Transcript DOM (severity banner, reroute detail, recovery hint) |
| `qa-codex-compact` | Codex compact control: `/compact`/toolbar compact during an active turn is queued with a visible status, sent as `thread/compact/start` after root turn completion, compact completion clears stale context occupancy, and compact failures surface as errors. |
| `qa-codex-models` | Codex live model catalog: `model/list` normalization (default-first, hidden dropped) + codex routes (per-model effort caps, leaderboard meta enrichment, static fallback without discovery) + MemberWizard DOM (all discovered models listed, pending hint, error banner + retry — no silent fallback) |
| `qa-vision` | Image (vision) support single-source gate: every model route carries `capabilities.vision`; `visionForModel` resolves by id/runtime/orModelId + Codex gpt-slug twin; Codex+OpenRouter routes inherit catalog vision; and the Claude Code gateway preserves Anthropic image blocks without rebuilding or silently dropping them. |
| `qa-composer-vision` | Composer image-attach gating (jsdom): on a vision model a dropped image adds a thumbnail and submit forwards `{kind:image,mediaType,dataBase64}` to `sendMessage`; on a text-only model the same drop is refused with a **visible reason** (no silent drop) and nothing is sent; the placeholder advertises image attach only when supported |
| `qa-composer-send-key` | Composer send key ([P-3]8) **and width-independence** ([#15], jsdom): the global `composer.sendKey` preference decides what Enter does — `ctrl-enter` (the default) makes Enter a newline and Ctrl/Cmd+Enter send; `enter` makes Enter send and Shift+Enter a newline — and the SAME thing happens at both panel densities. The narrow layout renders a single-line `<input>` inside the composer `<form>`, where the browser's default action for Enter is submit, so an Enter that must not send is asserted **consumed** (`defaultPrevented`) as well as "nothing was sent" |
| `qa-stall-status` | Stall watchdog renderer contract (harness-general): a `stall` diagnostic as the newest block makes a busy member read as **stalled** (not an endless "responding" spinner), later activity clears it back to working, turn end → idle, and a stalled member is not `busy` (panel offers restart). Backed by `SessionManager.scanForStalls` which flags an active turn silent past 120s. Also covers [#13] **dead vs never-started**: a member reported `missing_session` reads as `disconnected` (never `idle` = ready to chat), outranks a restored pending approval and a mid-flight busy status, and is never `busy` so no progress indicator can appear over it — while a member after an app RESTART still reads `not started`, because the restart clears the stale binding and its conversation resumes on the next message. |
| `qa-composer-interrupt` | Interrupt-on-send default (P-14) through the **real App tree** in jsdom: pressing Send forwards `{interrupt}` to the IPC bridge following the global `composer.interruptOnSend` setting (the UI used to drop the option entirely, so a Send could only ever queue). Locks the built-in default OFF — including for a settings.json written before the feature existed — because interrupting kills a turn that is already doing work |
| `qa-composer-drop-path` | Non-image file drop ([P-3]10, jsdom): dropping a non-image inserts its **path** into the draft (a member reads files itself, so a path is what it can act on) — it used to be swallowed entirely, since `onDrop` only reacted when some file was an image. Covers space-quoting, appending to an existing draft, mixed image+file drops doing both, a text-only model still accepting a path, and an unresolvable file being **reported** rather than skipped. `pathForFile` (the `webUtils` preload bridge) is mocked — see the script header for why no tier can drop a real file |
| `qa-composer-copy-image` | R-18 lock: the composer attachment strip does **not** carry a copy control (the mis-wired [P-3]9 surface). Remove still works. Transcript copy is covered by `qa-transcript-image`. |
| `qa-transcript-image` | R-18/R-19 (jsdom): a transcript image has copy + enlarge; copy hits the clipboard bridge per-image and surfaces failure; enlarge portals the shared overlay to `document.body`, uses the full application viewport with fit/actual zoom, and closes via backdrop/✕/Escape while restoring focus. |
| `qa-transcript-render-efficiency` | transcript scheduling/structural sharing: visible restore priority, one in-flight read, one cached-panel reveal per yield, progressive DOM convergence to the unchanged 150-block window, token-only session timestamp skips, stable latest-action delegates, historical block reuse, and streaming/action-sensitive refresh. |
| `qa-mcp` | MCP (external server) status + actions through the SAME `EngineConnection` methods the `/api/sessions/:id/mcp*` endpoints and the workbench MCP panel call (route parity): neutral snapshot shape + harness tag + per-server capability flags (`canReconnect`/`canToggle`/`canAuthenticate` — the honest Claude↔Codex asymmetry), and reconnect/toggle/authenticate mutating live state. Backed by the QA mock harness's seeded servers (connected+tools / needs-auth+authenticate / failed+error). |
| `qa-auto-compact` | per-member auto-compaction pure logic (`src/shared/autoCompact.ts`): threshold clamp/step-snap (50–95), OFF-by-default, stored/HTTP `normalizeAutoCompact`, inheritance (member setting → global `compactDefault` → built-in), token estimate (never against an unknown window), and `shouldAutoCompact` crossing test the renderer trigger fires on (off / unknown-window / unknown-usage never fire). |
| `qa-compact-dialog` | context donut + Auto-compact dialog render (jsdom), locking `design_handoff_auto_compact`: the donut is a **ring** (not a bar) with a threshold **tick** only when on, and clicking it opens the dialog; the dialog carries the current-usage card (used/total/%), the enable toggle, the 50–95 step-5 threshold slider, and a footer with **지금 압축 실행** (fires `compact` + closes; disabled with no live session) beside **완료**. |
| `qa-usage-limits` | account/provider-scoped rate-limit indicator (titlebar). Pure logic in `src/shared/usageLimits.ts` — window merge by kind (unreported windows preserved), level-color escalation (brand <75 → `--live` ≥75 → `--danger` ≥90; unknown → muted, never brand), reset-countdown formatting, epoch-seconds→ms normalization, and the full `buildUsageView` view model across known / unknown-loading / N/A (API key) / empty states (no fabricated 0%). Plus a jsdom render of `<UsageLimitPill>`: segments paint, click opens the popover with 5h + weekly meters + countdown, and ≥75% paints the warning border. |
| `qa-subagents` | subagent-observation view-models (dock + drill-in detail) + the `applySubagentEvents` fold that keeps subagent output in a SEPARATE slice from the parent transcript: status→style mapping, live one-line `currentAction` selection (`deriveSubagentAction`, the swap point in `src/shared/subagentActivity.ts`), responsive dock thresholds, empty assistant/status blocks dropped so a query-less/empty item never renders as a blank "선처럼" strip, and a new user-turn boundary resetting the dock so its count is per-turn rather than an ever-growing session total. Driven by the mock scenarios in `src/shared/subagentScenarios.ts`. Also locks that a LONG delegated prompt collapses to a preview + "전체 보기" popup instead of filling the drill-in view, while a short one still shows whole. |
| `qa-party-store` | party storage **split** (`PartyRepository`): the on-disk layout is a SHARED index `parties.json` + PER-PARTY `parties/<id>/party.json` (members/messages), so two processes editing different parties of one workspace never clobber. Locks in: legacy single-`state.json` → split migration (data intact, blob kept as backup, no re-migrate on the 2nd read), per-party **write isolation** (editing party A leaves party B's file byte-identical + mtime unchanged), and **authoritative partyId** (a member's party is its FILE — a missing/wrong stored `partyId` is corrected, never silently mis-routed). |
| `qa-subagent-tracker` | subagent **attribution** replayed against RECORDED real harness traffic (`scripts/fixtures/subagents/*.jsonl`, captured live from Haiku + gpt-mini): `ClaudeSubagentTracker` (task_started/progress/updated keyed by task_id+tool_use_id; `local_bash` steps never become their own rows) and `CodexSubagentTracker` (child-`threadId` routing, response-only/resumed root initialization, root replacement on restart, `collabAgentToolCall` prompt capture, powershell/bash launcher unwrap, `web_search` card with `action.queries` fallback so an empty top-level `query` still shows). Also verifies that an unmatched Claude `hook_started` becomes a named diagnostic while a matching `hook_response` cancels it. Locks correct attribution + parent/child separation against the ACTUAL protocol shapes. |
| `qa-approval-shapes` | approval **card content** replayed against RECORDED real harness traffic (`scripts/fixtures/approvals/*.jsonl`, captured live from codex-cli 0.145.0 + gpt-5.4-mini by `scripts/record-approval-traffic.mjs`). Locks what a card can actually show — 명령 원문/작업 디렉터리/요청 사유/항상 허용될 규칙 present, **파일 diff absent from every real request** — and that all four Codex decision scopes (once/session/always/decline) really are honoured by the server. Also a **regression lock for the stringified-id hang**: `RequestId` is `string | number` and Codex sends `0`, so replying `"0"` leaves the turn waiting forever; both outcomes are recorded side by side. Guards the trap that hid these — `fake-codex-appserver.mjs` invents a `diff` field and a string id that real Codex never sends. |
| `qa-settings-update-check` | Settings mount fires `checkForUpdate({ quiet: true })` so the titlebar pill is not stuck on the startup / 6-hour result; switching to the 버전 tab re-asks (quiet) so the release list is current. jsdom, no Electron. Quiet / debounce / skip-during-download live in `qa-update-channel`. |

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

`npm run test:e2e:environment-precision` launches the real Electron app without
a model call, drives **런타임 → 환경** through `/api/environment` and
`/api/navigation`, and verifies that Windows checks expose the actual workspace,
CLI command boundaries, and the isolated Codex SQLite path. WSL probing remains
explicit (`?wsl=1`) because it starts distributions and can legitimately wait on
a broken distro. Set `AGENTPARTY_E2E_INCLUDE_WSL=1` to include that host-specific
path and assert that timeouts remain errors with their command and POSIX cwd.

`node scripts/e2e-party-switch-perf.mjs` seeds 8 parties and 96 persisted
transcripts (~51 MiB of text), with 12 open tabs and six visible panels per
party. Half the blocks are collapsed tool results. Its first switch is a real
pointer click on the grouped-sidebar party row; later switches also cover the
public automation route. This distinction is intentional: a renderer click can
do expensive work before AppController, which an API-only regression cannot
observe. The test locks three milestones: correct layout, first usable transcript
within 500 ms, then all six sequentially filled within 5 seconds. It also covers
a cached warm return, a cold background-tab click, rapid-switch party scoping,
progressive convergence to the established 150-block tail, deferred tool
expansion, older-history paging, and a real workbench capture. Sleeping fixture
members keep it offline and unbilled.

For an existing workspace, run
`node scripts/benchmark-party-switch-real-store.mjs <workspace> [installed-exe]`.
The benchmark copies only `.agent_party_app` into a guarded temporary directory,
marks copied members sleeping, and launches the real app against that copy; the
source workspace and its live parties are never written. Omitting `installed-exe`
measures the current worktree build, while supplying it makes a baseline run.
Every timed switch is driven through the real grouped-sidebar pointer path, not
the lower-level party selection API, so the numbers match what a user feels.
Add `--open` to leave that isolated sleeping-member copy open in the real app
for hands-on QA; the command prints the copy and user-data paths for cleanup.

`npm run test:e2e:two-window` also clicks a grouped-sidebar party whose home is
another workspace. It verifies that the main process makes the authoritative
workspace decision, selects the exact party, and replaces the renderer's
workspace state while the public same-workspace API still returns full state.

`node scripts/qa-app-mcp-e2e.mjs` verifies the MCP status endpoint against the
**real** harness adapters (billed — starts a live Claude + Codex member): creates
one member per harness, warms its session, then `GET /api/sessions/:id/mcp` and
asserts `supported:true`, the correct `harness` tag, and a well-formed `servers`
array from the real SDK `mcpServerStatus()` (Claude) / app-server
`mcpServerStatus/list` (Codex) — proving the real MCP path, not just the mock.

`node scripts/e2e-wsl-workspace-open.mjs` (or `npm run test:e2e:wsl-workspace-open`)
boots the real app and opens a `wsl+<distro>:` workspace through the same
`POST /api/windows` call the `agent-party` CLI makes, then asserts `GET /api/state`
comes back with the distro, the distro path, AND a session list — the last one is
what proves the engine **inside** the distro answered, rather than the URI merely
being parsed on the Windows side. It also seeds pre-existing WSL parties (including
the legacy id `SEL-6809`), proves the owning engine registers and backfills them,
moves them repeatedly through `POST /api/parties/:id/group` without losing any
rows, verifies the native Windows renderer receives them, then relaunches on a
Windows workspace only and checks the WSL summaries remain visible without opening
the distro workspace. Guards both load-time engine failures and the regression
where the desktop treated a WSL URI as a Windows path, leaving a party visible in
the workbench but absent from the movable global registry. Requires the distro;
the isolated fixture workspace is created under `/tmp` inside it and removed.

`node scripts/e2e-live-codex-approval-roundtrip.mjs` drives the REAL
`CodexAdapter` against a real `codex app-server` (billed — one short turn) and
asserts an approval round-trips: the card fields arrive, the decision is sent,
and the turn actually FINISHES. This is the only tier that catches the approval
path breaking, because `scripts/fake-codex-appserver.mjs` answers with a string
request id while the real server numbers requests from ZERO — two separate bugs
(an `id: 0` dropped by a truthiness check, and a reply stringified so the server
never matched it) both hid behind that fake and made every Codex approval hang
forever. `--regress` re-breaks the reply in memory and asserts the turn then
hangs, so reverting the fix fails loudly instead of silently.
`--file-change` drives the OTHER approval kind, where the request carries no
diff at all and the card depends on the adapter having joined the `fileChange`
item it names — an ordering-dependent join a fixture replay cannot prove.

`node scripts/e2e-live-claude-always-allow.mjs` drives the REAL
`ClaudeAdapter` through two turns (billed) to check that "항상 허용 (규칙)"
stores something. It asserts on what lands on DISK, not on whether the model
asked again: measured, a repeat command in the SAME session is not re-prompted
even when nothing was stored, so an earlier version of this check passed for
that wrong reason. `--regress` answers "once" instead and asserts no rule is
written and a fresh session IS asked. Also pins the honest limit — a fresh
session can still be stopped by the DIRECTORY gate, whose only remedy is
`destination: "session"`, so no choice can promise silence.

`node scripts/capture-design-surfaces.mjs` boots the real app offline (QA mode,
mock harness), drives it through every screen/component state and lifts the
RENDERED DOM into `build/design-bundle/` for upload to the claude.ai/design
design-system project — the app documenting itself rather than being re-drawn.
`node scripts/verify-design-bundle.mjs [--shots]` then opens every produced page
in Electron and asserts it renders standalone (tokens resolved, the bundled font
actually loaded, real size, `@dsCard` marker present). See
[docs/DESIGN_MIRROR.md](DESIGN_MIRROR.md); it is also where the two traps found
while building it are written down (a party select that reports ok without moving
the window, and modals that survive Escape and poison the next capture).

`node scripts/qa-approval-metrics.mjs` (or `npm run qa:approval-metrics`)
MEASURES the approval card against the confirmed design instead of eyeballing a
capture: it boots the app with `--remote-debugging-port=0`, injects the recorded
scenarios, and compares `getComputedStyle` with the values declared in
"Approval Cards.dc.html" — 27 of them across head/body/footer, the diff rows and
the collapsed resolved line. Offline and unbilled. Two mismatches it caught that
the screenshots did not: the tool chip inheriting the shared chip's roomier
padding, and the decline button inheriting the base button's width. ⚠️ Selector
care matters here — `.wb-btn-soft` also matches the rule button, so measuring the
session button on a Claude card silently measured a different control.

`node scripts/e2e-idle-sleep.mjs` (or `npm run test:e2e:idle-sleep`) boots the
real app and drives idle sleep's two escape hatches through the AppController
methods the UI calls: the global policy the Settings → 유휴 슬립 card writes
(on/off, quiet period, and the 1–1440분 clamp an HTTP caller could otherwise step
outside), and the per-member 계속 켜두기 pin from the sidebar's right-click menu.
The pin is asserted to beat a *direct* sleep request, not only the timeout sweep
— were it advisory there, the menu item would be lying. Then sleeps and wakes an
un-pinned member and checks the session binding is released and re-bound. Offline
and unbilled: the member is created but never messaged, since sleeping is a
process-lifecycle concern and a model call would add cost without coverage.

`node scripts/e2e-cross-workspace-status-flap.mjs` (or
`npm run test:e2e:cross-workspace-flap`) boots the real app with TWO windows on
TWO workspaces — one WSL, one local — in ONE process, starts a local member to
generate session traffic, then asserts from the app's own debug log that this
process never wrote the WSL window's session list. `session:list` replaces the
renderer's array rather than merging, so a second producer silently overwrites
the owner's list; that is what made a member flicker idle ↔ not-started.

Asserts on the PUSH, not the paint, and that distinction is the whole test. An
earlier version polled the rendered status every 400ms and **passed against the
broken build**: the empty list is overwritten within milliseconds, so a DOM poll
almost never catches it even though React paints it and the user sees the
flicker. Measured against the reverted fix, the log showed 240 trespassing
pushes to 1 legitimate one — the assertion fails loudly. Requires the distro;
offline and unbilled.

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

`node scripts/e2e-cwd-independent-parties.mjs` also pre-seeds a legacy party in
a cwd that the test never opens, records that cwd only in the global group
registry, and boots the real app from a different workspace. It asserts the
party is copied into the Windows-global store, remains filed in its group, and
is immediately returned by `GET /api/party-groups`. This is the regression for
Windows Search launches previously showing an empty WSL-backed group.

`node scripts/e2e-usage-limits.mjs` (or `npm run test:e2e:usage-limits`) boots the
real app on an isolated userData + temp workspace (offline — mock member, no
model) and proves the usage-limit indicator end-to-end: provider usage injected
over `POST /api/qa/usage` is aggregated per provider (separate 5-hour + weekly
reports MERGE, and a re-report replaces only its own window), served by
`GET /api/usage`, and pushed to the titlebar pill (a `usage-limits.png` capture
shows the live Claude/Codex rings). Starts empty (no fabricated 0%).

`node scripts/e2e-model-catalog-list.mjs` (or `npm run test:e2e:catalog-list`)
boots the real app on an isolated userData + temp workspace (offline — a mock
member, no model turn) and locks the model catalog list (R-5/6/7) against the
confirmed design. Like the sidebar-overflow run it MEASURES the live renderer
over CDP rather than eyeballing a capture: the column's three tiers (fixed head
/ fixed search row / scrolling list, with the search row asserted OUTSIDE the
scroll container), and the search box's height, corner radius, gap and font size
compared against the confirmed mockup, which was rendered and probed the same
way. It then proves favourites take ONE path in both directions — starring in
the UI is read back over `GET /api/state`, and a list written over
`POST /api/settings` shows up in the UI after the reload that endpoint's
contract implies — including that a stored id the catalog cannot resolve draws
**no** row while remaining in storage (never silently pruned), and that the
header counts what is shown rather than what is stored. Also covers the traps: a
star click must not change the selection, Escape with a query clears the query
instead of closing the modal, and with every group expanded the list scrolls
with its last row still hit-testable at the app's minimum window width.
Captures (light + dark, since the colours are tokens) go to a temp dir.

`node scripts/e2e-sidebar-overflow.mjs` (or `npm run test:e2e:sidebar-overflow`)
boots the real app on an isolated userData + temp workspace (offline — mock
members, no model) and locks the OVERFLOW-SAFETY invariant behind [#11]: with 24
parties and 27 members the sidebar lists must SCROLL, not clip. Unlike a
screenshot check it MEASURES the running renderer over the Chrome DevTools
Protocol (`--remote-debugging-port=0`, port read from `<userData>/
DevToolsActivePort` — nothing hardcoded), asserting each list overflows, has a
computed `overflow-y` that actually scrolls, stays inside the window, keeps the
Members section usable beside it, and — the decisive one — that after scrolling
to the bottom `document.elementFromPoint()` over the LAST row hits that row, i.e.
it is clickable. It also asserts open dropdown and context menus remain inside
the viewport. The group context menu is rendered and captured in light and dark
themes with a deliberately long group name; every action row must have zero
computed border width so native button chrome cannot reappear inside the menu
shell.

`node scripts/e2e-usage-unpriced.mjs` (or `npm run test:e2e:usage-unpriced`)
seeds a usage ledger holding one member on a priced model, one on a model that
is deliberately absent from the catalog, and a Grok turn with a provider-reported
cost, then boots the real app on that
workspace (offline, no model call) and proves the dashboard never prices what it
cannot price: `GET /api/token-usage` reports `unpricedTurns`/`unpricedTokens`
instead of folding those turns into `estCostUsd`, and — measured in the running
renderer over CDP — the per-bucket table shows `?` for the bucket that member
actually spent in, its totals are marked `+?`, and the timeline caption states
how many turns are missing from its bars. Guards the AGENTS.md no-silent-
fallback rule at the exact spot it was violated (a `return 0` that summed into
`≈$0.000`).
It also verifies that the exact Grok amount wins over the missing catalog rate,
and repeats the table containment check at 1100x720 in the dark theme while
capturing both representative states.

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
is visible. Further legs cover **one-click copy** (code block + whole reply),
**a long subagent prompt collapsing** (a `subagent` event with a 40-line
`assignedTask` injected over `/api/qa/…/emit` — every canned scenario's task is
short — then drilled into through `/api/qa/…/subagents/open`), **the progress
indicator** across a real working→idle transition, **the harness badge** with
REAL codex/cursor members (creation starts no session, so it stays offline),
**a code block surviving a message sent mid-stream** ([#14]), **modals ignoring
an outside click** ([#16] — the popup is opened, the backdrop clicked, and the
popup then closed by its own button, which only proves anything because it was
still there), and **a dead member reading as `disconnected`** ([#13] — the
harness is really ended through `/api/qa/…/kill-harness`).

Every click asserts `applied.clicked`, so a selector that matches nothing fails
the run instead of passing on a screenshot of something else. Step 0 asserts
`runtime.appRoot` is under this script's own root (see §1b).

`node scripts/e2e-message-queue.mjs` (or `npm run test:e2e:message-queue`) boots
the real app on an isolated userData + temp workspace (offline — mock members,
no model) and proves the **message queue** ([P-3]4) end to end. The core claim
first: a message sent to a BUSY member reports `queued: true` and is absent from
the conversation, while a member-to-member message joins the same queue tagged
with its own sender (and stored as its raw body — the channel envelope is added
at delivery). Then the mutations — 위로 · 위와 합치기 · 편집 · 모두 취소 — and
their failures: cancelling an item that already left, and an unknown action, are
both REFUSED rather than silently accepted. Delivery is checked where it matters:
going idle hands the merged run over and the bubble appears in the conversation
*then*, marked 대기열에서 전송됨, with a member's message rendering exactly ONCE
(as the inbound channel card, not also as a duplicate user bubble). Also covers
the tab's dashed `≡N` badge, ArrowUp recalling the last queued message into the
composer, the narrow (<408px) chip form, and the queue surviving on disk.

Geometry is **measured over CDP**, not read off a picture — the 17×17 ordinal,
the 26×15 switch with its 11px knob, dashed row borders, and the merge rail
starting/ending at the run's midpoints and stopping at a sender change. Narrow
density is reached by splitting into three panels, not by shrinking the window
(the window has a minimum width, so the panel never gets narrow enough that way).
Step 0 asserts `runtime.appRoot` is under this script's own root (see §1b).

`node scripts/qa-queue-design.mjs` (or `npm run qa:queue-design`) is the **design
QA** counterpart: it reproduces every queue state the handoff specifies — empty,
one item, a same-sender run, mixed senders, 합치기 꺼짐, 접힘, the 20-item limit,
narrow/mid widths, dark, and the 대기열에서 전송됨 provenance left in the
conversation after delivery — and captures one PNG per state for comparison
against the handoff screenshots. Every member is a QA mock, so no model is called
and nothing is billed. **Reach these states this way, never by driving real
turns**: a live agent finishes when it finishes, so the state you wanted to
photograph is gone before the shutter opens, and a 20-item queue is unreachable
in practice. Pass `--keep` to leave the app running for hands-on inspection, and
`--out <dir>` to choose where the gallery lands. It asserts nothing — correctness
is `e2e-message-queue.mjs`'s job; this script only produces pictures.

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

`node scripts/e2e-composer-input.mjs` (or `npm run test:e2e:composer-input`) boots
the real app on an isolated userData + temp workspace (offline — mock members, no
model) and presses REAL keys at REAL panel widths, which is the only tier that can
prove the composer's input contract: the behaviour under test is a browser
DEFAULT ACTION (Enter submitting the form a single-line `<input>` sits in) at a
layout chosen from MEASURED element width. It covers [P-3]8 (the `composer.sendKey`
preference decides Enter, and round-trips through `POST /api/settings` to the live
window), [#15] (the same thing happens in a narrow panel — reached by SPLITTING
into three panels, since the window has a 1100px minimum and a single panel is
therefore never narrow), and P-14 (`composer.interruptOnSend` stops a busy
member's turn instead of queueing behind it; mock members are seeded
`autoReply:false` so "still busy" means "not interrupted" rather than "the mock
had not finished answering"). It first asserts `GET /api/spec` serves
`POST /api/qa/input` — an endpoint that exists only alongside this change — so a
run can never silently be measuring a different build. It also covers [P-3]9 by
writing to the **real OS clipboard** through `POST /api/clipboard/image` (the same
method behind the composer's copy button), asserting the response reports the
image actually written and that undecodable bytes are an error rather than a
silent empty write. Capture: `composer-input-e2e.png`.

`node scripts/e2e-composer-completion.mjs` (or
`npm run test:e2e:composer-completion`) boots the real app and drives the
contenteditable composer through `POST /api/qa/input`: `i` exposes the live
`impl` member and Tab inserts `@impl`; `cl` exposes Claude, Tab inserts its
provider, and the next live popover contains only that provider's models. It
also keeps an unmatched member query open, creates that member through the
public API, and proves the row appears without another input event. It
then Backspaces that mistaken Claude token, proves the model popover closes,
types `co`, and walks Codex → a Codex model instead. It then deletes only that
model and proves the full Codex model list reopens while the Codex provider
token remains. It selects a model again, sends the message, and verifies the
real transcript restores selectable provider/model chips rather than exposing
their durable storage wrapper. The same run sends plain
`cl` with Ctrl+Enter while the list is open, proving triggerless discovery
cannot hijack message send. It uses the live route catalog but makes no
provider/model call.

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

`node scripts/e2e-permission-popover-layouts.mjs` (or
`npm run test:e2e:permission-popover-layouts`) launches the real app and proves
the Codex permission popover is outside the clipping composer/panel hierarchy,
inside the viewport, and actually frontmost at both its top and bottom edges.
It covers one panel/one tab, four narrow columns, a vertical split with Codex at
the bottom, a five-tab overflow group, and the reported two-tab left group
beside a center panel and a nested right column. It also changes the open Codex
menu to Full Access so the extra warning row exercises live remeasurement, then
repeats the narrow four-column case for Cursor. The paint assertions use
`elementsFromPoint` via `POST /api/measure`; bounding boxes alone cannot detect
an element painted behind a clipping transcript.

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
only the concrete model id changes and fallback fields are removed. **Not in
`test:ui`:** the assertions pass, but on Windows the process then aborts
(`UV_HANDLE_CLOSING`) so a suite run would go red after a green summary — keep
it manual until that exit is fixed.

### Registered scripts kept outside `test:ui` on purpose

A script in `package.json` is not automatically in the unit suite. If it is
outside `test:ui`, one of these reasons should be true and written here — so the
next person does not re-investigate a silent orphan.

| Script | Why it stays outside |
|---|---|
| `test:temp-collision` | Property proof + negative control: spins a nested throwaway checkout and runs concurrent bundles. `qa-temp-isolation` (in `test:ui`) is the cheap guard; this one is the deliberate collision experiment, not a unit slot. |
| `test:harness-protocol` | Protocol contract is suite-worthy in principle, but Windows exit aborts after PASS (see above). |
| `test:subscription-install` | Network integration: downloads the official CLIProxyAPI release from GitHub and verifies SHA-256. Also short-circuits when a live bridge is already reachable on the machine, so it is not a deterministic offline unit. |
| `test:engine-rpc` | **Currently red for a product reason, not a stale assertion.** The headless `engineServerEntry` pulls `AppController`, which imports `electron` (`clipboard`/`nativeImage`). The QA correctly refuses an Electron reference in the WSL-bound server bundle. Do not wire into `test:ui` until the headless entry is Electron-free again; that is a product fix, not a test tweak. |
| `test:wsl-*` | Need a WSL distro (and often a built `dist/engine-server.mjs`). Wiring them would fail every Windows-only `test:ui` run. Judged separately from this batch. |
| `test:guide-auth` / `test:guide-chat` / `test:guide-offer` | Pure-logic guards for the guide (account gate, knowledge-path resolution, disabled startup offer). Written **after the unit bundle was frozen** (2026-08-02 verification policy), so they are run on demand rather than appended to `test:ui`. Cheap — run all three when touching `src/main/guideChat.ts`, `guideAuth.ts` or `guideOffer.ts`. |

The guide's **full-process** verifiers are not npm scripts — run them directly:

| Script | What it proves |
|---|---|
| `node scripts/verify-guide-stage.mjs` | Boots the real app, creates a canary party, opens the guide **screen**, jumps slides, and asserts the party store on disk is byte-identical afterwards. This is the isolation proof for the stage iframe's fake `window.agentParty`. |
| `node scripts/verify-guide-offer.mjs` | Proves both fresh-install and upgrade boots keep the guide prompt disabled. |
| `node scripts/verify-guide-chat-live.mjs` | A **real** model turn in the guide chat (minimal prompt/output, per `AGENTS.md`). Costs money. |
| `node scripts/qa-guide-slides.mjs <port>` | Walks every slide of a RUNNING app: the modal/menu the slide is about actually opened, its subject exists on the stage, and the caption does not cover it. Prints the measured `spot` literal for each slide — paste back into `GUIDE_SLIDES` after a workbench layout change. |

### Measuring the screen instead of squinting at it

Verification is a person driving the real app now, which leaves one gap: the
things that decide a faithful reproduction are the things eyes are worst at. A
1px gap looks right. A search box wrongly placed **inside** the scroll region
looks right until the user scrolls. A row covered by an invisible overlay looks
clickable. This project has passed a capture by eye before and been wrong.

`POST /api/measure` closes that gap — see `docs/API.md` for the full shape.
Typical use while comparing against a handoff:

```bash
# sizes, spacing and the styles a mockup pins down
curl -s -X POST $BASE/api/measure -H 'Content-Type: application/json' -d '{
  "selector": ".wb-queue-row", "styles": ["gap","borderRadius","overflowY","flex","minHeight"] }'

# is the header really outside the scrolling list? (identical in a screenshot)
curl -s -X POST $BASE/api/measure -H 'Content-Type: application/json' -d '{
  "selector": ".catalog-search", "within": ".catalog-scroll" }'

# after scrolling to the bottom, is the last row reachable or covered?
curl -s -X POST $BASE/api/measure -H 'Content-Type: application/json' -d '{
  "selector": ".catalog-row:last-child", "scroll": {"selector": ".catalog-scroll", "to": "bottom"},
  "at": {"x": 640, "y": 700} }'
```

Two habits make it worth having:

- **Report the numbers you read, not "it matched".** The value is that the next
  person can disagree with your judgement without re-running anything.
- **Check the instrument on something you already know.** Measuring an element
  whose size the handoff pins down (the queue's 17×17 ordinal chip) is how you
  find out the ruler is wrong before you trust it on something you don't know.

A selector that matches nothing **fails**. That is deliberate: "measured zero"
and "measured nothing" would otherwise be the same answer, and a typo would read
as a passing measurement.

### Typing into the composer, which is no longer a text box

The composer's editing surface is a **contenteditable area** (`.wb-composer-editor`),
not a textarea — a dropped file renders as a chip *inside* the sentence, and only
rich text can hold that. Other screens still use ordinary fields, so both exist.

`POST /api/qa/input` drives both, because it inserts text as a **real editing
command** rather than assigning a value. There is no value on an editable area to
assign, so the older approach could not reach the composer at all; and this one is
the more faithful of the two anyway, since the app sees the same input events a
person's keystrokes produce.

Two things to know when you read the result back:

- **Text replaces, it does not append.** Existing content is selected first.
  Passing `""` clears the field.
- **`value` is what the box reads; `draft` is what gets sent.** A chip displays a
  short name but stands for a full path, so the two differ on purpose. `draft` is
  read off the app's own draft (chips expanded), and `references` lists the paths
  on their own. Assert on `draft` or `references` when a path matters — asserting
  on `value` would pass while the path silently went missing.

### Where the jsdom bundles go, and why it matters

The jsdom tests can't import TypeScript, so each one bundles the module under
test on the fly and imports the result. That bundle now goes in **this
worktree** (`.qa/`, gitignored) via `scripts/lib/qaTemp.mjs`.

It used to go under `node_modules/`, and on this machine `node_modules/` is one
install **shared by every worktree**. Two lanes running their unit tests at once
therefore wrote the same path under the same fixed name: whoever finished last
decided what the other one imported, so a lane could assert against code it had
never written and see green. Read mid-write, it got half a file.

**Nothing inside the suffering test could see this** — the assertions passed and
the summary said green. `qa-temp-isolation` (in `test:ui`) is the guard: the
bundle directory must be inside this checkout and must not resolve into the
shared install.

`node scripts/qa-temp-collision.mjs` (`npm run test:temp-collision`) proves the
property by running it rather than by reading the code. It provisions its own
throwaway second checkout, plants a different value in each copy of one source,
bundles and imports on both sides simultaneously, and requires each side to see
only its own. It then repeats the run with both sides pointed at a single
directory as a **negative control** — the fault has to reappear, or the proof is
only demonstrating that the probe is blind. It stays **outside** `test:ui` on
purpose (see the table above): the suite already has the cheap location guard;
this script is the expensive collision experiment.

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
| `POST /api/parties/:partyId/members/:name/mcp-tools/send` `{arguments:{to,content}}` | **exercise an inter-member message through the real stdio MCP transport** — the named mock member sends to another member without spending a model turn. This is the default way to QA "a member messaged another" because it covers MCP schema, identity, framing, and host routing. Use direct `POST /api/party/messages` only for fixture setup or an explicit HTTP-contract regression, and record that reason. |
| `POST /api/qa/members/:name/subagents` `{scenario}` | inject a named **subagent** scenario (`claude-test-shards` / `codex-call-tracer` / `codex-web-research` in `src/shared/subagentScenarios.ts`) as `subagent` normalized events — drives the dock + detail through the real fold with no real subagent spawned |
| `POST /api/qa/members/:name/subagents/open` `{subId}` | open a subagent's drill-in detail (`subId` = the subagent id, or `"first"`) |
| `POST /api/qa/gate/open` `{kind:"member"\|"party", member}` | open a **Message Gate** modal over HTTP (member editor for `member`, or party manager for `member`=partyId) so an agent can drive the real UI route + `/api/capture` it |
| `POST /api/qa/input` `{selector, text, key, modifiers}` | focus a field, type into it, and press a key as a **real input event** — so the browser's own default action for that key runs (a script-dispatched DOM event never fires one). The input counterpart of `/api/capture`'s `click`; this is what makes keyboard-driven UI behaviour testable end-to-end. Text goes in as a real editing command, so it drives **both** an ordinary field and the composer's **editable area** — see below. Returns `{kind, value, references}`: what is actually in the target afterwards, not merely that the call ran |
| `POST /api/qa/window/bounds` `{x, y, width, height}` | resize/move the window, so **responsive** behaviour can be checked at a real width (the app switches layout on measured element width — no state injection stands in for it) |
| `POST /api/qa/update` `{state, latestVersion, releaseNotes, progress, releases:[…]}` | pin an **app-update** status and/or release history — the update pill, its dialog and the 설정 → 버전 tab, driven without publishing a release (a dev run cannot self-update at all). `{"reset":true}` restores the real updater. See `GET /api/update` in API.md for the shapes |
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

### 1b. Assert IN THE SCRIPT that the build now running is your worktree

An e2e launched from a worktree can measure a **different checkout** and report a
pass — this is not hypothetical: 21 scripts here hardcoded
`C:\Project\AgentPartyApp` as the app root, so any of them run from a worktree
built and drove the MAIN tree while the author read green output. Deriving the
root from `import.meta.url` (§ below) prevents it; asserting it proves it.

Make it the first assertion, before any behaviour is exercised:

```js
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appRoot = (await get("/api/state")).runtime?.appRoot || "";
// BOUNDARY comparison — see the warning below.
const within = (appRoot + path.sep).toLowerCase().startsWith(root.toLowerCase() + path.sep);
```

⚠️ **Compare on a path boundary, never a bare prefix.**
`C:\Project\AgentPartyApp` is a string prefix of `C:\Project\AgentPartyApp-w2`,
so a plain `startsWith` accepts a main-worktree build as your own — reproducing,
inside the check, the exact false pass the check exists to prevent. Append
`path.sep` to both sides.

Three instruments exist. **Only the first stays valid after a merge:**

| Form | How | Valid |
|---|---|---|
| `runtime.appRoot` (preferred) | `/api/state` (and `/api/health`) reports where the RUNNING module was loaded from — the app's own knowledge, not a value the driver supplied | always |
| A branch-only endpoint | assert `/api/spec` lists an endpoint only your branch serves | **before merge only** |
| A branch-only DOM class | `POST /api/capture` with `click` on a class only your branch renders (a selector miss fails the request, so the match IS the assertion) | **before merge only** |

⚠️ The last two **stop discriminating the moment your branch merges** — every
branch then has that endpoint or class, and the assertion passes forever while
proving nothing. That is the same trajectory as the dead knobs this project has
had to dig out (`AGENTPARTY_WORKSPACE` that nothing read, an
`AGENTPARTY_ALLOW_MULTI_INSTANCE` that stopped meaning anything when the
single-instance lock was removed). They all worked at first. If you use form 2
or 3 because `appRoot` is unavailable, say so in a comment *next to the
assertion* — the person who copies it into the next cycle will not read this
table.

Do NOT assert on `settings.workspacePath` or `logs.logFilePath` for this: both
are values the driver itself wrote into the isolated userData, so the check is
self-fulfilling.

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

### 4. Drive it exactly like an external QA agent — through the automation API
Every capability is on the automation API (`src/shared/apiSpec.ts`, `docs/API.md`).
When acting as a party member, use the member-scoped MCP transport endpoint so
the request crosses the shipped stdio relay instead of bypassing it. Direct HTTP
action routes are for HTTP-contract tests, fixture setup or inspection,
human-only actions, and capabilities with no MCP tool. Examples:
```
POST /api/party/members/main/start   { model, effort, permissionMode }
POST /api/parties/<partyId>/members/<sender>/mcp-tools/send
                                     { arguments: { to, content } }
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

`scripts/e2e-claude-auth-separation.mjs` launches the real Electron app with a
token-free fake Claude executable that reports `loggedIn:false`. It verifies the
separate native/bridge cards, the workspace-scoped native auth API, and that a
real Claude member becomes `auth-required` before the Agent SDK/provider process
is entered. The successful-login/provider-call half must use a real user-owned
Claude login and is intentionally never faked as product E2E.

The party communication feature passed both the jsdom suite and the in-process
integration test, yet agent-created members did **not** appear in the UI on a WSL
workspace — because the remote engine-server forwarded only `session:*` events,
not the new `party` event, so `party:update` never reached the renderer. Only a
screenshot of the real app revealed it. When a change crosses the main↔renderer
or local↔remote boundary, verify it here, with a capture.
