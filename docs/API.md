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

Returns current app state, router URL, automation URL, log file path, and
`runtime.appRoot` (which build is running — see `GET /api/state` below).

### `GET /api/spec`

Returns a machine-readable list of supported endpoints.

### `GET /api/state`

Returns settings, auth provider states, sessions, model routes, harnesses, router status, logs, and AgentParty member state.

#### `runtime.appRoot` — which build is actually running

```json
{ "runtime": { "appRoot": "C:\\Project\\AgentPartyApp-w1\\dist\\main\\application" } }
```

The directory the running code was loaded from, read off the running module.
**Every other path in this payload was supplied by the caller** —
`settings.workspacePath` and `logs.logFilePath` are configured, so a test that
asserts on them is asserting on its own input. `appRoot` is the app stating a
fact about itself, so an e2e can prove it is driving the build it just made.

Parallel worktrees each build to their own `dist`, and an e2e that launched the
wrong one still reported green. Assert this first:

```js
const { runtime } = await get("/api/state");
// Compare on a path BOUNDARY: ".../AgentPartyApp" is a string prefix of
// ".../AgentPartyApp-w1", so a bare startsWith accepts a sibling's build.
const ok = (runtime.appRoot + path.sep).toLowerCase()
  .startsWith(myRoot.toLowerCase() + path.sep);
```

where `myRoot` comes from the script's own `import.meta.url`. See
`scripts/e2e-member-liveness.mjs` for the live example.

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

### `GET /api/diagnostics`

Everything a bug report needs about this install, in one call — the same report
the settings **런타임 → 진단** tab shows and its `진단 정보 복사` button copies.
No secrets: `auth` carries `id`/`label`/`status` only, never a key or token.

```json
{
  "version": "0.1.0",
  "packaged": false,
  "appRoot": "C:\\Project\\AgentPartyApp\\dist\\main",
  "os": { "platform": "win32", "release": "10.0.26200", "arch": "x64" },
  "versions": { "node": "20.18.1", "electron": "33.2.1", "chrome": "130.0.6723.152" },
  "workspace": { "uri": "C:\\Project\\AgentPartyApp", "kind": "local", "path": "C:\\Project\\AgentPartyApp" },
  "logs": { "filePath": "…\\logs\\agentparty-….ndjson", "folderPath": "…\\logs" },
  "auth": [{ "id": "claude", "label": "Claude 구독", "status": "configured" }]
}
```

`version` is `""` only where the running process cannot know it (the headless
WSL engine); then `versionError` states why rather than the field going blank.
`workspace.kind` is `"wsl"` for a WSL workspace — that is the "WSL 여부" answer.

### `POST /api/diagnostics/open-logs`

Opens the log folder in the OS file manager. No body. Returns
`{ "ok": true, "path": "…\\logs" }`, or **500 with the OS reason** when the
folder could not be opened — it never reports success for a window that did not
appear.

### `GET /api/environment`

Whether this machine can actually run a member, and what to do when it cannot —
the same report the settings **런타임 → 환경** tab renders. Sibling of
`/api/diagnostics` and deliberately separate: that one describes a build for a
bug report, this one is a to-do list. No secrets: paths and versions only.

Query: `?refresh=1` bypasses the 30s cache, `?wsl=1` also probes WSL distros
(off by default because probing **starts** a distro).

```json
{
  "checkedAt": "2026-08-13T04:12:00.000Z",
  "expectedClaudeCli": "2.1.191",
  "checks": [
    {
      "id": "harness.cursor",
      "group": "harness",
      "label": "Cursor",
      "status": "missing",
      "detail": "설치되어 있지만 로그인되어 있지 않습니다.",
      "path": "C:\\Users\\me\\AppData\\Local\\cursor-agent\\versions\\2026.07.23-e383d2b",
      "remedies": [
        { "kind": "command", "label": "로그인 명령 복사", "command": "cursor-agent login" },
        { "kind": "repair", "label": "로그인", "repairId": "harness.cursor.login", "confirm": "…" }
      ]
    }
  ]
}
```

`status` is `ok` | `warn` | `missing` | `error` | `unknown`; `missing` and
`error` are what block work. `raw` carries the untranslated probe failure (CLI
output, paths tried) when there is one — surfaced, never swallowed.

`expectedClaudeCli` is the Claude Code version this build's Agent SDK is paired
with; a host CLI that differs is reported as `warn` rather than hidden.
On Windows, Claude and Codex discovery recognize both native `.exe` installs
and npm's `.cmd` launchers, including the standard `%APPDATA%\npm` location
when the running desktop app inherited an older `PATH`. Claude's npm launcher
is resolved to its package `cli.js`, because the Agent SDK requires a directly
spawnable executable or JavaScript entrypoint.

### `POST /api/environment/repair`

Applies one of the fixes the report offered.

```json
{ "repairId": "wsl.sdk.reinstall:Ubuntu-20.04" }
```

The body carries an **id, never a command**: the command is looked up in a
freshly built report, so this endpoint can only run a string the app itself
authored. An unknown id is a **500** with the reason.

Returns `{ "ok": true, "detail": "Claude Code 준비를 확인했습니다.", "output": "…", "report": { … } }`,
where `report` is the post-repair environment so the caller re-renders from one
source. `ok` is true only when both the repair command and the matching
post-repair check succeed (`ok` or non-blocking `warn`). A command that exits 0
but still leaves the harness missing or broken returns `ok: false` with the
verification reason and command output; it is never presented as a completed
installation. A failed command likewise returns `ok: false` **with** its output
rather than a bare error.

A remedy whose `confirm` field is set changes the user's own system (installing
a CLI); the UI confirms before calling. One without it touches only app-owned
state (the SDK copy inside a distro's `~/.agent_party_app`).

### `GET /api/update`

Where the app self-update stands. Account/machine-global (one installed build
serves every window), so it takes no window or workspace scope. The same status
the titlebar update pill and its dialog render; live changes are pushed to the
renderer on the `update:status` channel.

```json
{
  "ok": true,
  "update": {
    "state": "available",
    "currentVersion": "0.1.0",
    "latestVersion": "0.2.0",
    "releaseNotes": "- 업데이트 알림 추가\n",
    "releaseDate": "2026-08-15T02:00:00.000Z",
    "releaseUrl": "https://github.com/JioBani/AgentParty-releases/releases/tag/v0.2.0",
    "checkedAt": "2026-08-15T02:04:00.000Z"
  }
}
```

`state` is one of `idle`, `checking`, `available`, `downloading`, `downloaded`,
`up-to-date`, `error`, `disabled`. `downloading` additionally carries
`progress: { percent, transferred, total, bytesPerSecond }`.

`downgrade: true` on an `available` state means the offered version is **older**
than the running one — the publisher recalled a release (see the rollback runbook
in docs/RELEASE.md). The UI says "되돌리기", not "새 버전": a rollback presented as
an upgrade is a claim the user acts on. Downloading and installing are otherwise
the same path.

Installing never happens on its own: `autoInstallOnAppQuit` is off, so a
downloaded update waits until the user asks for it.

`disabled` is **not** an error — it means this build genuinely cannot replace
itself (a dev run, or the portable `.exe`), and `disabledReason` says which. A
failed check is `error` with the reason in `error`; it is never reported as
`up-to-date`.

Releases are read from the **public** repo `JioBani/AgentParty-releases`
(`src/shared/appUpdate.ts` is the single source for that address, and matches
`build.publish` in package.json), so no token ships in the app.

### `GET /api/update/versions`

Every published release, newest first — what 설정 → **버전** tab lists. Read from
the public GitHub releases API with no token, and cached for 10 minutes because
unauthenticated GitHub allows 60 requests/hour per IP. `?refresh=1` bypasses the
cache.

```json
{
  "ok": true,
  "releases": [
    {
      "version": "0.2.0",
      "name": "v0.2.0",
      "notes": "## 앱 내 자동 업데이트\n\n- …",
      "publishedAt": "2026-08-14T17:43:13Z",
      "url": "https://github.com/JioBani/AgentParty-releases/releases/tag/v0.2.0",
      "prerelease": false,
      "current": true
    }
  ]
}
```

`notes` is the **raw markdown** the author published (GitHub's REST `body`) —
unlike `GET /api/update`, whose notes come from the updater as rendered HTML and
are converted back to markdown before they reach the UI. `current` marks the
version this build is running. Drafts are never listed.

Separate from `GET /api/update` on purpose: that one answers "what should I do
now", this one answers "what has ever shipped", and the tab shows the history
even on a build where self-update is unavailable. **500** with the reason when
the list cannot be fetched (rate limit, network) — it never returns an empty
list to mean failure.

### `POST /api/update/check`

Re-asks the release feed. No body. Returns the same `{ ok, update }` envelope
with the settled status — a network or feed failure comes back as
`state: "error"` rather than a rejection, so a caller always learns the outcome.

### `POST /api/update/download`

Downloads the pending installer. No body. Auto-download is off by design: the
user is told first and decides. **500** when there is nothing to download (the
state is not `available`). Progress arrives via `GET /api/update` polling or the
`update:status` push; the response resolves when the download settles.

### `POST /api/update/install`

Quits the app and runs the downloaded installer, relaunching afterwards. No
body. Every running member is stopped by the quit, so the UI confirms first.
**500** when no update has been downloaded — it never silently no-ops.

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

**Every pre-capture step is verified, and the response reports what it achieved
in `applied` (`{theme, clicked, scrollY, scrollX}`).** A `click` selector, or a
`scrollSelector` you name explicitly, that matches no element **fails the
request**; `scrollX` without `scrollSelector` fails too. `applied.scrollY` /
`applied.scrollX` carry the position actually reached, so a caller can confirm
the view moved. These options are how e2e tests drive and frame the real UI: a
step that silently did nothing turns every downstream assertion — and every
"I checked the section below the fold" screenshot — into a false pass.

```json
{ "path": "C:\\tmp\\lower.png", "scrollY": 900, "theme": "dark", "click": "[data-tu=compare-toggle]" }
```

### `POST /api/measure`

Reads measurements off the **live screen**. `/api/capture` answers "what does it
look like"; this answers "what is it".

The questions that decide a faithful reproduction are not visible in a picture: a
1px gap, whether a search box sits INSIDE the scroll region (identical before the
first scroll, wrong only after the user scrolls), whether the last row is
actually clickable or merely drawn under something else. This returns those as
numbers so a person judges on evidence rather than on "looks about right".

**It asserts nothing** — it is an instrument, not a test. And it is **not a way
to run code in the renderer**: the script is fixed, and the request supplies
selectors, style names and attribute names. What can be asked is enumerable on
purpose, so the next reader can tell what was verified from the request alone.

```json
{
  "selector": ".wb-queue-row",
  "styles": ["gap", "borderRadius", "overflowY", "flex", "minHeight", "transform", "fill"],
  "attributes": ["placeholder", "aria-expanded", "data-queue-index"],
  "within": ".wb-queue-list",
  "containedBy": ".wb-panel",
  "at": { "x": 886, "y": 693 },
  "scroll": { "selector": ".wb-transcript", "to": "bottom" },
  "limit": 100
}
```

Everything but `selector` is optional.

| Field | Answers |
|---|---|
| `styles` | computed values, by CSS property name |
| `attributes` | attribute values; **`null` = absent**, `""` = present and empty |
| `within` | is each match a **descendant** of that element — the "is the search box inside the scroll region" question |
| `containedBy` | is each match's box inside that element's box, plus how far it spills on each edge (clipping) |
| `at` | what is **actually at a point**: the top-most element, the stack under it, and whether the top-most belongs to `selector`. Tells "drawn there" from "reachable there" |
| `scroll` | scrolls that element (pixels or `"bottom"`) **before** measuring, and reports the position reached |

Each element carries `box` (viewport coordinates), `content`/`scroll` sizes,
`scrollable` (content taller/wider than the visible area — the "only the list
scrolls" question), `text`, and whatever `styles`/`attributes` were asked for.
The response also has `count`, `texts` in document order (list ordering), `gaps`
between consecutive matches, the active `theme`, and the `viewport`.

**Not measuring and measuring zero are different facts.** A selector that matches
nothing is a **500 naming the selector** — never an empty list, never a zero.
The same for a `within`/`containedBy`/`scroll` target that does not exist, an
unknown style property, and an `at` point outside the window. A typo must not be
able to come back as "gap: 0, looks fine".

### `POST /api/clipboard/image`

Puts an image on the OS clipboard, so it can be pasted into any other app. The
same `AppController` method the composer's thumbnail copy button calls.

```json
{ "mediaType": "image/png", "dataBase64": "<base64 without the data: prefix>" }
```

`mediaType` defaults to `image/png`. Bytes that do not decode to an image are an
**error**, not an empty write: writing an empty image would clear the clipboard
while reporting success, and the user would paste nothing with no way to tell
why. On success the response carries the image actually written —
`{ ok, width, height, bytes }` — so a caller can assert on it instead of trusting
`ok`.

## Settings

### `POST /api/settings`

Updates app settings.

`transcriptFontScale` is the session/transcript text zoom (1 = 100%, clamped
0.6–2.0). In the UI it is driven by Ctrl+wheel over a session view; over HTTP it
is a plain setting, e.g. `{"transcriptFontScale": 1.3}`. It applies on the next
window load (or immediately in the window that changed it).

`fonts` picks the app's UI and code font families by **family name as the OS
reports it** — `{"fonts": {"sans": "Malgun Gothic", "mono": "D2Coding"}}`. Both
keys are optional; `""` selects the platform default stack. In the UI this is
설정 → 글꼴 (`view: "automation"`). Font **size** is a separate setting — see
`transcriptFontScale` above. Call `GET /api/appearance/fonts` for the names this
machine has.

The selection applies live in every open window: the renderer writes the chosen
stacks into the `--font-sans` / `--font-mono` CSS variables that every surface
already draws through.

A family this machine does **not** have is stored, not rejected. The app cannot
tell "gone for good" from "absent on this PC" — erasing it would silently delete
the choice of someone syncing settings between two machines — so the missing font
is reported by `GET /api/appearance/fonts` and flagged in the picker instead.
Characters that could break out of the CSS declaration (quotes, backslash,
semicolon, braces, parens, angle brackets, control chars) are stripped, and the
value is capped at 100 characters.

The ids the first version of this setting used (`maplestory`, `geist-mono`,
`system-sans`, …) are still accepted and migrate to the equivalent family name on
read, so an upgrading user keeps the font they chose.

### `POST /api/shell/open-path`

Opens a local file the way the desktop would. The same controller method as a
clicked file link in the transcript.

```json
{ "path": "./docs/API.md" }
```

A relative path resolves against the **calling window's workspace** — not the
app bundle — so the same string a member wrote in a message resolves the way the
user reads it. `file://` URLs and absolute paths are taken as given. On Windows,
markdown/URL-shaped drive paths such as `/C:/work/report.html` are restored to
`C:\work\report.html` before resolution; POSIX/WSL absolute paths and UNC paths
are left unchanged.

The response says what actually happened, because "opened" and "the file manager
came up instead" are different outcomes:

```json
{ "ok": true, "action": "opened", "path": "C:\\work\\docs\\API.md" }
```

`action` is `opened` (handed to the default application) or `revealed` (shown in
the file manager), with `reason` explaining any fall back to `revealed`. Two
cases produce `revealed`:

- The OS has no application registered for that type.
- The file is an executable or script (`.exe`, `.bat`, `.ps1`, `.vbs`, `.lnk`, …
  — see `shared/localFiles.ts`). Those are **never launched**: the link that
  named the file was written by a model into a chat message, and running it is
  not a decision the app may take. Revealing puts the choice back with the user.

A path that does not exist is an **error** naming the resolved path, not a
silent no-op — a dead click is indistinguishable from a broken feature.

### `GET /api/appearance/fonts`

Every font family installed on this machine, the current selection, and the short
recommended list the picker floats to the top.

Query parameters:

| name | meaning |
|---|---|
| `q` | Case-insensitive substring filter on the family name — the same match the picker's search box applies. |

```json
{
  "ok": true,
  "selected": { "sans": "Maplestory", "mono": "Geist Mono" },
  "recommended": [
    { "family": "Maplestory", "label": "Maplestory", "role": "sans",
      "note": "앱에 포함됨 · 넥슨 메이플스토리체", "bundled": true, "installed": true }
  ],
  "families": [
    { "family": "Cascadia Mono", "monospace": true },
    { "family": "Malgun Gothic", "monospace": false }
  ],
  "totalFamilies": 224
}
```

`families` is the OS enumeration (`queryLocalFonts`), deduplicated to one entry
per family and sorted. `totalFamilies` is the count **before** `q` was applied,
so a filtered call still reports the real scale.

`monospace` is measured, not read off the name: the app compares the advance of
`i` against `W` within the family. That matters because several fixed-width
Korean fonts (`DotumChe`, `GulimChe`, `BatangChe`) are not named "Mono", and some
fonts that are named "Mono" are not fixed-width. The 코드 글꼴 picker offers only
families that pass this test.

There is deliberately **no Hangul-coverage flag**. A family missing the glyph
falls back to the system's Hangul font, which makes it indistinguishable from a
family that *is* that system font — measurement confirmed 맑은 고딕 reporting as
"no Hangul". The picker renders a Hangul sample in each family instead.

`recommended[].installed` is `true` for the bundled face and for anything the
enumeration returned; otherwise it comes from a width measurement, and it is
`null` — never a made-up `false` — when nothing could be measured.

CSS substitutes a missing family without a word, so a `POST /api/settings` that
names an uninstalled font succeeds and changes nothing on screen. Confirm what
the screen actually uses with `POST /api/measure`
(`{"selector":"body","styles":["font-family"]}`).

Enumeration needs a live window and the renderer's Local Font Access permission.
When it could not run, `families` is empty and `error` states why — the list is
never quietly truncated to the recommended entries without saying so.

`idleSleep` controls when a quiet member's harness process is released to reclaim
its memory — `{"idleSleep": {"enabled": true, "timeoutMinutes": 5}}`, the default.
`timeoutMinutes` is clamped 1–1440: below a minute a member would be torn down and
rebuilt between two halves of one thought, and past a day `enabled: false` says it
better. The timeout is only a floor; the sweep still refuses a member that is
mid-turn, waiting on an approval, compacting, holding detached background work or
queued messages, running on Cursor, or marked `keepAwake` (see
`/api/party/members/:name/sleep`). A sleeping member keeps its conversation and
wakes on the next message.

`memberMessaging.interruptOnSend` is the Runtime default for member-to-member
messages that omit `interrupt`, for example
`{"memberMessaging":{"interruptOnSend":true}}`. It does not affect human
composer sends. A sender's `outboundInterrupt` override takes precedence; an
explicit boolean on the individual send takes precedence over both.

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

### Grok

Grok reaches the app two ways, both paid for by the user's Grok subscription and
both reading the credential the official CLI wrote (`grok login`). AgentParty
only ever READS it: the refresh token rotates under the CLI's own lock, so a
second writer would invalidate the login. `GET /api/auth` reports a `grok`
provider that separates "not installed" from "installed but not signed in".

- **Grok models on the Claude Code harness** — `selectedProviderId: "xai"` with a
  catalog model such as `Grok 4.5 xAI`. The embedded gateway forwards to
  `api.x.ai/v1/messages`, xAI's Anthropic-compatible surface.
- **The Grok Build harness** — `selectedHarnessId: "grok"` (member `runtime:
  "grok"`), which runs the official `grok` CLI over ACP. Party tools reach it
  through `session/new`'s `mcpServers`, so nothing is written to disk. As
  measured from the authenticated CLI on 2026-08-13, it exposes `grok-4.6`
  (the default) and retains `grok-4.5`; both report a 500K context window.

Grok Build reasoning settings were re-measured against the official CLI on
2026-08-13. `grok-4.6` accepts `low`, `medium`, `high`, and `xhigh` effort;
`grok-4.5` accepts `low`, `medium`, and `high`. Both default to `high`. The CLI
consumes `--reasoning-effort` when the ACP agent starts, so a saved live change
takes effect after the member is reopened/restarted. Neither model exposes a
separate reasoning on/off toggle (`none` and `minimal` are rejected). Grok Build
ACP permission requests are bridged into AgentParty's normal approval flow.
`GET /api/usage` reports Grok's authenticated subscription-credit period from
the official CLI's `_x.ai/billing` extension (the same source as `/usage`).
Per-turn tokens ARE recorded separately — the gateway
measures them from the upstream response, because Claude Code reports zeros for
router-backed models.

`favoriteModels` is the list of catalog model **ids** the user has starred. The
model catalog pins them above the provider groups, in catalog order. It drives
the same path as the star button in the catalog UI, e.g.
`{ "favoriteModels": ["claude-opus-5[1m]", "gpt-5.6"] }`.

Two properties are deliberate and worth knowing when driving this over HTTP:

- **Ids are never auto-pruned.** An id that matches no catalog model is stored
  and served back unchanged. "Retired for good" and "absent right now" (a
  credential was removed, a remote provider list failed to load) are
  indistinguishable here, and pruning would permanently delete a user's choice in
  the second case — silently, since they never saw it happen.
- **The catalog resolves the list when it renders**, so an unresolvable id draws
  no row (never a ghost) and reappears by itself once the model is selectable
  again. To audit the gap, compare `settings.favoriteModels` from
  `GET /api/state` against the ids in `GET /api/models` — stored-but-unshown is
  therefore observable rather than invisible.

Tidying the list is an explicit write to this endpoint, never a side effect of
opening a screen.

`gateDefaults` is the **Message Gate** reviewer default — `{ "model", "effort" }`
only (NO harness; the reviewer runs headless). Any gate-on member that has not
set its own reviewer uses this. Recommended: a cheap/fast model, e.g.
`{ "gateDefaults": { "model": "GPT-5.6 Terra", "effort": "low" } }` — the
built-in default, picked on measured accuracy rather than price. See the Message
Gate endpoints below.

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

### `GET /api/auth`

Lists every credential provider (subscriptions and API keys) with its status,
masked value, and where the credential came from.

Native Codex (`id: "codex"`) and the local subscription bridge
(`id: "codex-bridge"`) are deliberately separate. The native card is read from
`codex login status` on the desktop execution host. The bridge card is only for
GPT models routed through the Claude Code harness. AgentParty never reads or
copies the bridge's rotating OAuth refresh token into native Codex
`auth.json`; each native Windows/WSL host must own its own `codex login`.

### `POST /api/auth/deepseek`

Stores a DeepSeek API key (DeepSeek's own API, used by the DeepSeek V4 models).

```json
{ "key": "sk-..." }
```

### `DELETE /api/auth/deepseek`

Clears the stored DeepSeek API key.

### `POST /api/auth/deepseek/test`

Calls DeepSeek's model endpoint to verify the configured key.

When `AGENTPARTY_E2E=1`, this endpoint returns a mocked verification result and does not call DeepSeek.

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
  "auth": [{ "id": "claude", "status": "pending" }, { "id": "codex-bridge", "status": "available" }, { "id": "codex", "status": "available" }, { "id": "openrouter", "status": "configured" }]
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
Disconnecting the Codex bridge does not log native Codex out and never modifies
native `auth.json`. This ownership boundary prevents one bridge/desktop/WSL
process from replaying a rotated, revoked refresh token over a credential that
the native Codex CLI has already refreshed. OAuth tokens are internal and are
never returned by the HTTP API.

Override the local deployment with `AGENTPARTY_SUBSCRIPTION_PROXY_URL` and
`AGENTPARTY_SUBSCRIPTION_PROXY_KEY`. `AGENTPARTY_SUBSCRIPTION_PROXY_BIN` and
`AGENTPARTY_SUBSCRIPTION_PROXY_CONFIG` override local binary/config discovery.
The default key is a loopback client key, not an OpenAI or Anthropic credential.

## Discord bridge

Lets a member report to (and be instructed from) Discord, so the user can follow a
run from a phone or another PC without exposing the app to the network. Design:
`docs/기획 노트.md` §11.

Layout — one level per thing that can collide:

```
category  "<desktop name>"        this PC
  channel #<party>-<id slice>     one party  (pinned header: desktop, party, cwd)
    thread <member>               one member (all traffic happens here)
```

Names alone identify nothing: two PCs — or two workspaces on one PC — routinely
hold a party called `dev` with a member called `main`. A channel is therefore
matched by the identity stamped in its **topic** (desktop + workspace + party id),
never by its name, so two machines can never be joined to one channel. Only
**thread** messages are delivered; a message typed in the party channel body names
no member, so it is logged and dropped (the bot does not reply there).

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
  "desktopName": "WORK-PC",
  "configured": true,
  "connection": "connected",
  "botUser": { "id": "1530586029264867499", "username": "AgentParty" },
  "guildId": "1530584277505544343",
  "tokenMask": "********wxyz",
  "allowedUserIds": ["1530583970272514279"],
  "bindings": [
    { "workspacePath": "C:/work", "party": "party-1", "member": "reporter",
      "channelId": "1530587845813731339", "channelName": "dev-7bd616",
      "threadId": "1530608537422532678", "threadName": "reporter",
      "owner": { "pid": 12345, "startedAt": "2026-07-26T02:00:00.000Z" } }
  ],
  "partyChannels": [
    { "workspacePath": "C:/work", "party": "party-1", "partyName": "dev",
      "channelId": "1530587845813731339", "channelName": "dev-7bd616",
      "owner": { "pid": 12345, "startedAt": "2026-07-26T02:00:00.000Z" } }
  ],
  "instance": { "pid": 12345, "startedAt": "2026-07-26T02:00:00.000Z" }
}
```

`connection` is `off | connecting | connected | error`; on `error` an `error`
field carries the reason (a dead bridge must be visible, not silent).

`owner` names the app instance that delivers for that channel. Several AgentParty
processes share one `userData`, so all of them see the same bindings and all of
them receive the message — only the owner acts, which is what stops one typed
instruction from being delivered twice or starting a second session for the same
member. A dead owner's binding is adopted by the elected (lowest live pid)
instance serving that workspace.

### `POST /api/discord/settings`

Body (all optional): `desktopName` (the category this PC's channels live under —
defaults to the OS hostname), `botToken`, `guildId`, `allowedUserIds` (array of
Discord user ids). Returns the same shape as `GET /api/discord`. Changing the token or
guild drops the gateway so the next connect re-authenticates.

Leave `guildId` empty to auto-detect — allowed only when the bot is in exactly
one server; with several the call fails and lists them rather than guessing.

### `POST /api/discord/command`

Runs a control-panel command — the same dispatcher a message typed in Discord
goes through. Body: `{ "content": "!상태", "channelId": "…", "post": true }`.
`channelId` supplies the party/member scope (a party channel or a member thread);
`post: false` returns the reply without posting it. Returns
`{ ok, handled, reply }`.

This exists because the bot ignores its own posts, so it cannot type as the user
— without a second entrance the panel could only be exercised by hand. Command
reference: `!도움말` (or `!help`) lists them; see docs/기획 노트.md §11.14.

### `POST /api/discord/register`

Registers a party's Discord channel **without** touching its members — the same
operation the `!등록` control command performs. Body: `{ "partyId": "party-…" }`
(defaults to the window's active party). Returns `{ ok, channel, channelId,
created }`.

Opening the app registers nothing on its own; a channel exists only because
someone asked for it, from Discord or through this endpoint.

### `POST /api/party/members/:name/discord/connect`

Places the member in Discord — desktop category → party channel → member thread,
creating whatever is missing — and starts inbound delivery. Body:
`{ "channelName": "optional-thread-name" }`. Returns
`{ ok, channel, channelId, thread, threadId, created, threadCreated }` —
`created` refers to the party CHANNEL, `threadCreated` to the member's thread.
They differ routinely: registering a party makes the channel, so the first
`connect` for a member creates only the thread. Same operation as the member's
own `discord-connect` tool.

### `POST /api/party/members/:name/discord/send`

Body: `{ "content": "text" }`. Posts as that member. Fails with the reason when
the content is over the limit or Discord rate limits the request.

### `POST /api/party/members/:name/discord/send-image`

Body: `{ "dataBase64": "…", "filename": "shot.png", "mediaType": "image/png",
"caption": "optional" }`. Uploads the image into that member's thread. Over the
server's attachment limit (10 MB assumed) it is REJECTED with the limit stated,
never silently dropped. The member's own `discord-send-image` tool takes a FILE
PATH instead and reads it in the process the member runs in — for a WSL member
that path exists only inside the distro, so only the bytes cross to the desktop.

Images the user attaches in Discord travel the other way automatically: they are
downloaded and delivered as ordinary user-turn attachments, and anything that
cannot be delivered (not an image, too large, download failed) is reported in the
thread.

### `POST /api/party/members/:name/discord/disconnect`

Stops bridging that member. The thread and its history remain in Discord.
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

- **Grok Build** exposes `grok-4.6` and `grok-4.5` with
  `"harnessId":"grok"`. New installs default to 4.6; an existing saved 4.5
  preference remains selectable and is not silently rewritten. The 4.6 route
  advertises `low/medium/high/xhigh` effort and the 4.5 route advertises
  `low/medium/high`; effort is applied at ACP process start and is therefore
  marked `mutableDuringSession:false`.

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
  (verified live).

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
keeps a lightweight **background usage connection** alive for every provider
shown in the titlebar — a turn-less harness connection that self-polls
usage every 60s. It is reused, not duplicated: when a provider already has a live
member session, that session feeds usage and the background connection for it is
dropped; when the last session closes, the background poller revives within 60s.
A provider with no live member uses one lightweight background connection. A
background connection that fails to connect (e.g. the provider's CLI is not
logged in) backs off and the pill honestly
stays at "no data" — never a fabricated number.

Usage is account-global, not party-scoped: switching parties or opening/closing
member tabs does not change the selected account's snapshot. The last validated
snapshot is persisted under the app's user-data directory so an app restart does
not blank Claude while its proactive SDK read is waiting for the first live
rate-limit event. Expired reset windows and malformed cache entries are discarded.

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
    },
    "grok": { "provider": "grok", "available": true, "updatedAt": 1786550000000, "windows": [ { "kind": "weekly", "utilization": 14, "resetsAt": 1786896635397 } ] }
  }
}
```

`utilization` is 0–100; `resetsAt` is epoch **ms** (omitted when the provider
didn't report a reset). Claude/Codex report `five_hour` + `weekly` windows;
Cursor reports one `monthly` window — the signed-in account's billing-cycle plan
meter (reset at `billingCycleEnd`). Grok Build reports a `weekly` subscription
credit window and reset from `_x.ai/billing`; its completed-turn tokens/cost
remain separately available in `/api/token-usage`.
`available:false` means the provider-reported limit is not applicable or not
exposed — render "해당 없음", not 0%. Missing provider data is rendered as
loading/unknown until a read or push update arrives. Windows update live over
the `usage:update` IPC push to every window.

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
split), so a missing field means "not reported", not zero. In the per-turn token
split, `input`/`cacheRead`/`cacheWrite`/`output` are the turn's **billed totals**
(cumulative across every internal tool round-trip — correct for cost), whereas
`context` is the **context-window occupancy** at the turn (non-cumulative, the
same meter as the snapshot's `contextTokens`, dropping after `/compact`). It is
NOT the sum of the split — deriving it that way ballooned with tool-call count
and misread as context held. Absent when no live occupancy was reported.

Grok's vendor ACP completion reports prompt input with cache tokens included;
the ledger normalizes it into disjoint `input`, `cacheRead`, and `cacheWrite`
buckets and records the exact vendor cost when supplied. Account quota remains
separate and comes from Grok Build's authenticated `_x.ai/billing` extension.

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

If the member is **busy**, the message is not delivered — it is parked on that
member's message queue and the response carries `"queued": true` plus the
resulting `queue`. It is handed over when the member next goes idle. Callers must
honour the flag: a queued message has NOT been seen by the agent yet.

Optional `interrupt: true` stops the member's in-flight turn and parks the
message at the **front** of the app queue so the idle drain handles it next
(still visible and cancellable until then). It does **not** hand the turn to a
busy harness — that would land in the adapter buffer where it cannot be listed
or cancelled. A **compaction is never interrupted** — tearing it down half-way
would waste the work and leave context partial, so the message still parks at
the front and waits. The Discord bridge always sends with `interrupt`, because a
person typed it and is waiting.

### `GET /api/party/members/{name}/queue`

Reads what the member has been sent but has not been handed yet.

```json
{
  "ok": true,
  "queue": {
    "items": [
      { "id": "q-…", "text": "401 전환 패치 끝나면…", "from": null, "at": "2026-08-02T12:00:00.000Z" }
    ],
    "merge": true,
    "collapsed": false
  }
}
```

`from` is `null` for the user, otherwise the sending member's name; it is also
the merge boundary (below). The queue is **persisted**, so it survives an app
restart — and nothing is auto-delivered into a session that did not exist when
the message was queued.

### `POST /api/party/members/{name}/queue`

Every queue mutation, as one discriminated `action`. The UI's row buttons drive
this same controller method.

| `action` | Extra fields | Effect |
|---|---|---|
| `send` | — | Sends the leading run now — see **Sending now** |
| `sendItem` | `itemId` | Same, for exactly that row |
| `cancel` | `itemId` | Removes that row |
| `edit` | `itemId` | Removes that row and returns its `text` for the composer |
| `move` | `itemId`, `toIndex` (0-based) | Puts that row at an absolute position |
| `mergeUp` | `itemId` | Folds that row into the one above it |
| `mergeInto` | `itemId`, `targetId` | Folds `itemId` into `targetId` wherever the two sit — the drop half of dragging one queued message onto another. The dragged text lands AFTER the target's, and the target keeps its place, because merging changes what a message says rather than when it is sent. Deliberately one operation: as a move followed by a merge, a failure in between would leave the queue reordered but unmerged |
| `clear` | — | Empties the queue |
| `preference` | `merge` and/or `collapsed` | Persists a per-member preference |

```json
{ "action": "cancel", "itemId": "q-abc123" }
```

Responses carry the resulting `queue`; `edit` additionally returns `text`.

**There is exactly one queue, and it is this one.** The app never hands a turn to
a busy member — not even for `send`, and not for `interrupt: true` on a send
either. A turn handed to a busy harness lands in the adapter's own buffer and
waits for the very same moment (turn end), except there it can no longer be
listed, edited or cancelled. Nothing about that second holding pen is visible
from where the user sits: they typed one message into one box.

**Sending now.** On an idle member, `send`/`sendItem` deliver. On a BUSY one they
**stop the turn** and leave the delivery to the idle drain — `sendItem` first
pulls its row to the front, so the row that was asked for is the row that goes.
Stopping is the only thing that actually makes a queued message sooner, so it is
what these actions do, and the button says 중단하고 보내기 while a turn is running.
`interrupt: true` on a send is the same shape: front of the app queue + stop,
then the idle drain — never a bypass into the harness buffer.

`move` takes an absolute `toIndex` rather than a direction because the gesture
behind it is a drag: expressing "put this there" as a run of ±1 swaps would march
the queue through orders nobody asked for, persisting and broadcasting each one.

**Failures are errors, never silent no-ops.** Cancelling, editing, moving or
merging a row that is no longer queued returns an error — the item was almost
certainly delivered a moment ago, and reporting success would leave the caller
believing it stopped a message the agent is already answering. Merging across
senders is refused for the same reason (it would forge attribution), as is
enqueueing past the 20-item limit.

**Merging.** With `merge` on (the default), a send folds the **leading run** —
the consecutive items at the front that share one sender — into a single turn,
joined by a blank line, verbatim and in order. A different sender ends the run
and stays queued. With `merge` off, exactly one item goes per turn.

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

Runs compaction on a LIVE session. A session id that is not running is an error,
not an `ok` for work that never happened. To compact a member without caring
whether its process is up — including one released by idle sleep, which has no
session id at all — use `POST /api/party/members/:name/compact`, which is what
the UI drives.

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
- **Grok ACP permissions** — `behavior: "allow" | "deny"` selects the exact
  allow/reject option Grok offered. `{ "__approvalScope": "always" }` requests
  Grok's `allow_always`/`reject_always` option when available. AgentParty party
  tools are auto-approved, matching the Claude member contract; other Grok
  tools follow the member's persisted permission mode.

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

For a **member-originated** message, omitting `interrupt` uses the sender's
per-member `outboundInterrupt` override, then the Runtime
`memberMessaging.interruptOnSend` default. An explicit `true` or `false` always
wins. This applies equally to the lower-level member `send` endpoint and the
agent-facing `send`/`broadcast` tools. Interrupt is conditional on the recipient
having an active turn when the message arrives: an idle, sleeping, or unstarted
recipient is sent to, woken, or started normally and is never immediately stopped.

The reviewer's `effort` reaches the model differently per provider — `thinking`
for Anthropic (which rejects `effort` outright), `effort` for router-backed
models — and reasoning is never disabled, because a classifier that cannot
reason rejects compliant messages. This behaves identically for local and WSL
workspaces; for WSL the reviewer call runs on the desktop while the gate
decision stays in the distro's engine.

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

**Only `name` is required.** Every omitted field is filled from
`harnessDefaults` for the resolved harness (and `runtime` itself falls back to
`selectedHarnessId`), so `{"name": "impl"}` creates a member on the saved
defaults. That is the same request the wizard's **기본 설정으로 만들기** button
sends: the shortcut adds no defaults of its own, it just leaves the fields out.

```json
{ "name": "impl" }
```

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

Optional `interrupt: true` stops the member's in-flight turn and parks the
message at the front of the app queue so the idle drain handles it next (still
visible and cancellable until then). It does not hand a busy harness a turn
directly. A **compaction is never interrupted** — tearing it down half-way would
waste the work and leave context partial, so the message still parks at the
front and waits. The Discord bridge always sends with `interrupt`, because a
person typed it and is waiting.

This endpoint is a **human/user turn**, so omitting `interrupt` means `false`.
The app's own Send button remains independent and fills its value from
`composer.interruptOnSend`; a caller may explicitly pass either boolean.

### `POST /api/party/members/:name/send`

Lower-level compatibility endpoint that routes a message as an inter-member **channel** payload (wraps it with channel tags). Prefer `/message` for a plain user turn. Accepts the same optional `attachments`.

```json
{ "from": "user", "content": "이 이미지를 설명해줘.", "attachments": [{ "kind": "image", "mediaType": "image/png", "dataBase64": "<base64>", "name": "shot.png" }] }
```

### `POST /api/party/members/:name/open`

Gives the member a **tab** in the workbench — the same thing a click on its
sidebar row does, through the same code — and marks it opened. It does not start
a harness session by itself; the Workbench prewarms an active opened panel,
which is what puts a session behind it.

Because the tab layout is party state (see `POST /api/party/layout`), the tab
appears in **every window showing that party**, not only the one addressed by
`?window=`.

This used to set the status flag and nothing else, while still answering
`Member 'X' opened.` — so an agent asking for a member got a success message and
no tab anywhere. If you are looking for the older behaviour, there is none worth
keeping: a status nobody can see is not "opened".

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

### `POST /api/party/members/:name/sleep`

Releases the member's harness process while KEEPING its conversation: status
becomes `sleeping` and `harnessSessionId` carries the thread, so the next message
resumes rather than restarts it. This is what the idle sweep does on its own once
a member has been quiet past `idleSleep.timeoutMinutes`; the endpoint exists so a
person or a QA run can exercise the same path without waiting it out.

A member with no live session returns `ok` and says so — it is already released.
The sweep additionally refuses (and logs) a member that is mid-turn, waiting on
an approval, compacting, holding detached background work, holding queued turns,
running on Cursor (which keeps no process between turns), or marked
`keepAwake`. Calling this endpoint bypasses only the *timeout*, not those.

```json
{ "ok": true, "message": "Member 'impl' is sleeping; a message wakes it.", "member": { "name": "impl", "status": "sleeping", "sleptAt": "2026-08-06T02:10:00.000Z" } }
```

### `POST /api/party/members/:name/wake`

Starts a sleeping member again, resuming its harness thread, and delivers
anything waiting on its queue. Equivalent to `resume`; it exists as its own verb
so the intent reads correctly against `sleep`. Sending a message to a sleeping
member does this automatically — the message is queued, the sender gets an
immediate `ok`, and the wake runs behind it.

### `POST /api/party/members/:name/compact`

Compacts the member's conversation now, **waking it first if it is asleep** — the
conversation outlives the process that was holding it, so a sleeping member is
woken for the compaction rather than told it has nothing to compact. This is the
route the toolbar control and the composer's `/compact` command take.

While a compaction is in flight the member will not be slept by the idle sweep
and an interrupt-on-send will not stop it; the protection is released when the
harness reports the outcome (or, if it never does, after 15 minutes with a
warning in the log — never silently).

```json
{ "ok": true, "message": "Compacting 'impl' (woken for it).", "member": { "name": "impl", "status": "idle" } }
```

### `POST /api/party/members/:name/keep-awake`

`{ "keepAwake": true }` pins the member awake regardless of how long it is quiet;
`false` lets it follow the global setting again. Use it for a member doing work
the app cannot observe, where a wake-up would not restore what was lost. Turning
it on wakes the member if it is currently asleep.

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

### `POST /api/party/members/:name/outbound-interrupt`

Sets the named member's default for messages it sends to other members. This is
a sender setting and works without a live session.

```json
{ "outboundInterrupt": true }
```

- `true`: interrupt a busy recipient and put the message at the front.
- `false`: keep a busy recipient's current turn and queue behind it.
- `null`: inherit `memberMessaging.interruptOnSend` from Runtime settings.

Calls that explicitly include `interrupt: true` or `interrupt: false` override
both this value and the Runtime default. Even an explicit `true` only interrupts
a turn that was already active when the message arrived; it does not stop idle,
sleeping, or newly started recipients.

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
agent-facing `gate-set` tool.

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

A screenshot a tool returned is NOT inlined in these blocks. Its bytes go to
`<workspace>/.agent_party_app/images/<sha256>.<ext>` and the block keeps a
reference, because base64-wrapped PNG is both the largest thing a transcript
holds (measured at 564 KB for one block) and the one payload compression cannot
shrink. Fetch the bytes with the next endpoint.

```json
{ "type": "image", "source": { "type": "agentparty-file", "file": "3f9a….png", "media_type": "image/png", "bytes": 576936 } }
```

### `GET /api/party/transcript-image/:file`

The bytes of one screenshot a transcript references, as a data URL. `:file` is
the `file` field of an `agentparty-file` source — a name inside the image store,
never a path (anything resolving outside it is rejected). Naming files by content
hash means re-reading the same screenshot does not store it twice.

```json
{ "ok": true, "dataUrl": "data:image/png;base64,iVBORw0KGgo…", "bytes": 576936 }
```

### `GET /api/party/members/:name/harness-original`

Where the HARNESS keeps its own copy of this member's conversation. The app's
transcript has a retention window; the harness file does not, so once a member's
window is full this names where the rest of the history still is.

```json
{ "ok": true, "original": { "harness": "claude-code", "path": "C:\Users\me\.claude\projects\C--Project-App\<session>.jsonl", "exists": true, "bytes": 38578 } }
```

`original` is `null` when the member has no harness session yet, or the harness
keeps none we can name. `exists: false` matters: Claude Code derives its
directory from the ABSOLUTE cwd (every character outside `[a-zA-Z0-9]` becomes
`-`), so **moving the project folder orphans the history** — the new path maps
to a different, empty directory. Report that rather than a path leading nowhere.

### `GET /api/party/layout`

The workbench tab layout for the calling window's party: which members are open,
in which panels, in what order, and which tab is frontmost in each.

```json
{
  "ok": true,
  "layout": {
    "panels": [
      { "id": "pa", "tabs": ["impl", "review"], "active": "impl", "weight": 1 },
      { "id": "pb", "tabs": ["test"], "active": "test", "weight": 1 }
    ],
    "focusedPanelId": "pa"
  }
}
```

`layout` is absent when the party has none stored yet — the workbench then seeds
one from the member list. A stored layout with **no panels is a different fact**:
it means every tab was closed, and is honoured rather than reseeded.

### `POST /api/party/layout`

Sets that layout. Send `{ "layout": { ... } }` in the shape above.

This is **party state, not window state**. Every window of this process showing
that party moves with it, and the layout is stored with the workspace — so it
survives a reinstall and follows the workspace to another machine. It used to
live in each renderer's `localStorage`, where two windows on one party each kept
a private copy of a shared key: a tab closed in one stayed open in the other, and
that window's next change wrote the closed tab back.

```json
{ "ok": true, "changed": true, "partyId": "party-...", "layout": { "panels": [ ... ], "focusedPanelId": "pa" } }
```

`changed: false` means the layout already matched what was stored, so no window
was told anything — re-sending is harmless. Panels with no `id` or no `tabs` are
dropped, and a `focusedPanelId` naming no surviving panel falls back to the
first, so a malformed body cannot leave the workbench unable to open anything.

## Harness Party API

Harness skills and tools can call these local endpoints from inside a session. This is a local mechanical identity mechanism, not a public auth system.

### `GET /api/harness/party`

Returns the same member/message state as `GET /api/party`.

### `POST /api/harness/party/messages`

Sends a member-to-member message. The caller can be supplied in JSON as `from`
or via the UTF-8/base64url `X-AgentParty-Member-Base64url` header described
below. The legacy raw `X-AgentParty-Member` header remains accepted.

```json
{
  "to": "reviewer",
  "content": "Please inspect the diff."
}
```

Returns the UI's command result (party list, members, messages) — it is the same
endpoint the app itself uses. **Agents should not call it**; use the tool
endpoint below, which answers with the compact tool result instead.

### `POST /api/harness/party/tools/:tool`

Runs ONE party tool as the calling member, for a harness whose tools live
outside the app process — today Codex, via
`scripts/agentparty-codex-mcp-server.mjs`. `:tool` is a party tool name
(`send`, `member-create`, `list`, `interrupt`, `broadcast`, `discord-send`, …);
the body is that tool's arguments.

The caller is taken from `X-AgentParty-Member-Base64url` (the member name's
UTF-8 bytes encoded as base64url) and never from the body, so an agent cannot
act as another member. `X-AgentParty-Party-Base64url` scopes it to that member's
own party. The ASCII-only encoding is required because Fetch header values use
the ByteString contract while member names may be Unicode. Legacy raw
`X-AgentParty-Member` / `X-AgentParty-Party` headers remain accepted.

This runs the same `invokePartyTool` the in-process harnesses use, so every
harness gets identical behaviour and identical answers:

```json
{ "ok": true }
{ "ok": true, "data": { "queued": true } }
{ "ok": false, "error": "Rewrite it as one line; the party rule forbids status essays." }
```

`ok: false` means it did NOT happen — a Message Gate rejection included. Do not
read a `message` field for that verdict; the older path returned `ok: true` with
the refusal buried inside, which is exactly what this endpoint exists to end.

#### `attach-image`

Puts an image into the CALLING member's own conversation for the user to look
at. Takes `path` (a file on the machine that member runs on) **or** `url`
(`http`/`https`), never both, plus an optional `caption`.

```json
{ "path": "C:\\shots\\bug.png", "caption": "the row that overflows" }
{ "url": "https://example.com/chart.png" }
```

The reply carries only a reference, never the picture:

```json
{ "ok": true, "data": { "file": "<sha256>.png", "mediaType": "image/png", "bytes": 20480 } }
{ "ok": true, "data": { "url": "https://example.com/chart.png" } }
```

That is the whole point of the tool. A file is copied into the workspace image
store (content-addressed — the same store tool screenshots use) and rendered
from `GET /api/party/transcript-image/:file`; a URL is kept as given and loaded
from its own source. **The bytes never enter the model's context**: a tool
result IS part of the conversation, so returning them there would cost exactly
what this avoids. The member consequently cannot see what it attached, and
should say in its reply whatever the conversation needs to remember about it.

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

The **런타임** screen is tabbed, and an optional `tab` lands on one of its tabs
directly instead of leaving the caller to click the strip:

```json
{ "view": "runtime", "tab": "harness" }
```

```text
general (기본 하네스 · Auto-compact · 유휴 슬립 · 입력창)
harness (하네스별 생성 기본값 — 하네스 하나씩, 아래 `harness` 로 선택)
environment (하네스 준비 상태와 해결 방법 — GET /api/environment 와 같은 값)
gate    (Message Gate 리뷰어 기본값)
discord (Discord 브리지 자격증명 + 연결된 멤버)
versions (설치된 버전 · 최신 릴리스와 변경 내역 · 이전 버전 이력 — GET /api/update, GET /api/update/versions)
diagnostics (빌드 정보 · 로그 폴더 열기 · 진단 정보 복사 — GET /api/diagnostics 와 같은 값)
```

The **하네스 기본값** tab shows one harness at a time, picked by its own sub-tab
strip. An optional `harness` lands on one of them:

```json
{ "view": "runtime", "tab": "harness", "harness": "codex" }
```

```text
claude-code, codex, cursor, grok
```

A `tab` on a screen that has none, an unknown tab id, a `harness` outside the
`harness` tab, or an unknown harness id is an **error** — never a navigation that
reports success and leaves the screen where it was. The response echoes what was
applied (`{ok, view, tab, harness}`).

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
The guide stage is not in this list — use `GET /api/guide`.

### `POST /api/windows`

Opens a new window. Body `{ "workspacePath": "C:/path" }` (optional; defaults to
the last-used workspace). Returns `{ id, workspacePath, focused }`.

`{ "partyId": "party-…" }` opens the window ON that party instead of whatever the
workspace last selected. The party is pinned before the window can ask, so it
cannot land on the party another window happens to be showing. This backs the
sidebar's party right-click → **새 창에서 열기**, and it is how several parties are
run side by side: every window belongs to ONE app process, so they share the
workspace's engine and its sessions — a member already running is reused, not
started again.

When `partyId` is supplied, it must exist in the target `workspacePath`. A
mismatched pair returns an error and does not open a window; the server never
silently substitutes that workspace's currently selected party.

### `POST /api/windows/:id/workspace`

Points an existing window at a different workspace. Body
`{ "workspacePath": "C:/path" }`. Returns the window's fresh state.

## Guide

The in-app guide is a **separate BrowserWindow** with its own preload. It mounts
the real `App` tree against a fake `window.agentParty` and never talks to the
party store. Opening it, jumping slides, or clicking around the stage must not
change the user's parties or workspace.

### `GET /api/guide/offer`

`{ pending, shown }`. First-install popup state (§8). `pending` is true only
on a brand-new userData that has not yet been shown the
*"가이드를 먼저 보시겠습니까?"* dialog. An existing `settings.json` with no
offer record is treated as an **upgrade** — `shown: true`, never offered.
There is no "finished the guide" flag.

### `POST /api/guide/offer`

Body `{ "shown": true }` only. Records that the popup was presented. Same
AppController method as the dialog appearing. Anything else is an error.

### `GET /api/guide`

`{ open, presenting, id?, slide, slideCount, slideId?, title?, sceneId?, sceneTitle? }`.
`open: false` when the window is not showing. `presenting` is false on the
landing ("가이드 보기") until a slide is shown. The guide window is **not**
in `GET /api/windows`.

### `POST /api/guide/open`

Opens the guide (or focuses it if already open). Returns the same payload as
`GET /api/guide`. Starts at slide 0.

### `POST /api/guide/close`

Closes the guide window. Returns `{ open: false, … }`.

### `POST /api/guide/slide`

Body `{ "index": 0 }`. Jumps to that absolute snapshot and remounts the stage.
Out-of-range or a missing window is an error — nothing is substituted.

### `POST /api/guide/capture`

Captures the guide window. Body `{ "path": "C:/tmp/guide.png" }` (optional).
The guide is not a `GET /api/windows` entry, so `POST /api/capture` cannot see
it — this is the dedicated route. A full-size white frame still counts as a
successful capture — use `GET /api/guide/inspect` to ask what is actually in
the DOM.

### `GET /api/guide/inspect`

Reads the live guide DOM through a fixed `webContents.executeJavaScript`
script (no caller text). Returns whether `.guide-root`, landing, chatbot,
cost copy, and the 「질문하기」 FAB are present, their boxes/styles, FAB
contrast under both `light` and `dark`, and any `[[slide:N]]` missing/link
nodes. A missing selector is `{ present: false }`, never a guessed zero box.

### `POST /api/guide/ask`

Body `{ "open": true }`. Opens or closes the presentation 「질문하기」 panel —
the same action as the FAB. Errors if the presentation is not showing.

### `GET /api/guide/knowledge`

`{ path }` — the knowledge md folder the guide session uses as cwd
(dev: `<app>/guide/knowledge`, packaged: extraResources).

### `GET /api/guide/chat?kind=chatbot|slide`

One conversation. Chatbot is persisted; slide chat is not.

### `POST /api/guide/chat`

Body `{ kind, text, viewing? }`. Same AppController method as the guide input.
`viewing` is `{ index, title, scene }` for slide chat (appended to that turn only).

### `POST /api/guide/chat/reset` · `POST /api/guide/chat/compact`

Reset starts a new conversation. Compact uses the harness default.

### `GET/POST /api/guide/chat/settings`

Shared harness / model / effort / language for both chats. Claude Code and
Codex have defaults; other harnesses have none — send fails until the user picks
a model.

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
      "runtime": "claude-code",
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

- `runtime`: `claude-code` | `codex` | `cursor` (default `claude-code`). Send it
  whenever `model` belongs to another harness — the mock member is created with
  this pair, so a mismatch both mislabels the harness badge and is rejected by
  the beta cross-harness lock.
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

#### `type: "approval"` — replay a recorded approval card

Injects a **real, recorded** approval request so the approval card can be
designed, demoed and QA'd without paying for a model turn each time:

```json
{ "type": "approval", "scenario": "codex-command-once" }
```

Every scenario is generated from traffic captured off a live harness
(`scripts/fixtures/approvals/*.jsonl` → `src/shared/approvalScenarios.ts`) and is
expanded through the **same mapping a live harness goes through**
(`src/shared/approvalRequest.ts`), so an injected card and a real one cannot
drift apart. Nothing in it is hand-authored.

Scenario names follow `<harness>-<situation>`, e.g. `codex-command-once`,
`codex-command-always` (prefix-rule variant), `codex-untrusted-no-reason` (a card
with no 요청 사유), `claude-bash` (carries `blockedPath` + a `"echo one *"` prefix
rule), `claude-file-edit` (carries `old_string`/`new_string`, so a diff is
renderable). An unknown name returns **400 with the available list** rather than
injecting nothing.

⚠️ **Refused on a real member.** Injecting into a session backed by a live
harness returns an error: the harness never issued the request, so the card's
buttons would have nothing to answer. Getting a genuine approval means running a
real turn — `scripts/record-approval-traffic.mjs` documents which prompts
actually raise one (`git status`, for instance, never does on either harness).

#### Answering

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

### `POST /api/qa/update`

Pins an app-update status so the update pill and dialog can be reviewed without
publishing a release — a dev run cannot self-update at all, so this is the only
way to see those surfaces before shipping. The body is a partial `UpdateStatus`
(see `GET /api/update`); it is merged over the current one and broadcast on the
`update:status` channel exactly like a real change. Once pinned, real checks and
the background timer stop, so nothing overwrites what the test is looking at.

```json
{ "state": "available", "latestVersion": "0.2.0", "releaseNotes": "- 첫 자동 업데이트\n" }
```

A `releases` array in the same body stands a fixed **release history** in for
the GitHub fetch, so the 버전 tab's list and its folded "이전 버전" section can be
reviewed without publishing throwaway releases to a public repo. Entries take
the `GET /api/update/versions` shape.

```json
{ "state": "up-to-date", "releases": [{ "version": "0.3.1", "name": "핫픽스", "notes": "- …", "publishedAt": "2026-08-10T02:30:00.000Z", "url": "https://…", "prerelease": false }] }
```

`{"reset": true}` drops both mocks and restores the real updater. Returns
`{ "ok": true, "update": { … }, "releases": [ … ] }`.

### `POST /api/qa/input`

Types into a field and/or presses a key in the targeted window — the input
counterpart of `/api/capture`'s `click`, so a keyboard-driven workflow can be
driven through the real UI instead of calling the mutation behind it.
Window-scoped (`?window=<id>`; focused window when omitted).

```json
{ "selector": ".wb-composer-editor", "text": "상태 알려줘", "key": "Enter", "modifiers": ["control"] }
```

Every field is optional and applied in order:

- `selector` — focuses the matching element first. If nothing matches, the call
  **fails** rather than typing into whatever held focus.
- `text` — inserted as a **real editing command**, the same one a keystroke
  produces, so the app receives the beforeinput/input it would from a person.
  This works on both editing surfaces the app has: an ordinary field with a
  value, and the composer's **editable area** (which has no value to assign,
  because a file chip has to be able to sit inside the sentence). Existing
  content is selected first, so the text **replaces** it; `""` clears the field.
  If the focused element is neither, the call **fails**, naming that element's
  tag: being unable to type is a failure, not a quiet no-op.
- `key` — sent as a **real input event** (`keyDown`/`char`/`keyUp`), so the
  browser's own default action for that key still runs. This is the reason the
  endpoint exists: a synthetic DOM event dispatched from a script never fires a
  default action, so behaviour that depends on one — Enter submitting the form
  a single-line input sits in — cannot be verified any other way.
- `modifiers` — Electron modifier names (`control`, `shift`, `alt`, `meta`).

Returns `{ ok, selector, key, kind, value, references }` describing what is
actually in the target afterwards — not merely that the call ran:

- `kind` — `"value"` for a field, `"editable"` for an editable area, `"none"`
  when the target holds no text at all.
- `value` — the field's value, or the editable area's text as the sentence
  actually **reads on screen** (a chip contributes the short name it displays).
- `draft` — the message text the composer would **send**: the same sentence with
  every chip expanded to the full path it stands for. This is read off the app's
  own draft, not reassembled here — a second implementation of that rule could
  disagree with the real one and nobody would notice. (The composer trims it at
  send time; `draft` is the untrimmed state of the box.)
- `references` — the full paths of any file chips, in document order, for
  asserting on one path without parsing the sentence.

`value` and `draft` differ **on purpose**: the screen shows `trace.har`, the
member receives the whole path. Assert on `draft` or `references` when a path
matters — asserting on `value` would pass while the path silently went missing.

### `POST /api/qa/window/bounds`

Resizes/moves the targeted window, so responsive behaviour can be verified at a
real width. The app switches layout on measured element width, which no state
injection stands in for. Window-scoped (`?window=<id>`).

```json
{ "width": 700, "height": 900 }
```

Only the given fields change (`x`, `y`, `width`, `height`); a maximized window is
restored first, since bounds are ignored while maximized. Returns the resulting
`{ bounds }`.

### `POST /api/qa/design-gallery`

Builds the **card design gallery**: a party named `카드 디자인 갤러리` with one
mock member per transcript-card case, each already showing its card — approval
requests, their allowed/denied states, question cards (single / multi / free /
secret / multi-step), answered questions, and the compaction block (running /
done / no-figures / failed).

Every member is a mock session, so nothing launches a harness, calls a model, or
runs a command. Approval payloads are the recordings in
`src/shared/approvalScenarios.ts`; the case list is `src/shared/designGallery.ts`,
read by both this route and the scripts, so there is no second copy to drift.

Returns `{ ok, party, members }`. `npm run design:gallery` launches the app on an
isolated userData + workspace and opens it.

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
