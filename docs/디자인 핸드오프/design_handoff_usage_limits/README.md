# Handoff: Usage Limit Indicator (Claude Code / Codex)

## Overview
A persistent **usage-limit indicator** for the AgentParty workbench titlebar. It shows, at a glance, how much of each AI provider's rate limit has been consumed — the **5-hour rolling window** and the **weekly window** for **Claude Code (Anthropic)** and **Codex (OpenAI)**. Because these limits are **account/provider-scoped** (shared by every agent using that provider), the indicator lives in a single global spot rather than per-agent.

Two parts:
1. **Titlebar pill** — always visible. One mini progress ring per provider showing the 5-hour usage %.
2. **Popover** — opens on click. Full breakdown: 5-hour + weekly bars per provider, with reset countdowns and a link to Settings.

## About the Design Files
The files in this bundle (`Workbench Multi.dc.html`, `support.js`) are **design references created in HTML** — a prototype showing intended look and behavior, **not production code to copy directly**. The task is to **recreate this UI in the Electron app's existing environment** (its renderer framework — React/Vue/vanilla — and its established component + styling patterns). The HTML uses a small in-house template runtime (`support.js`); ignore that runtime and reimplement the markup/logic natively.

The relevant code in the reference file:
- Titlebar markup: the `<!-- USAGE LIMIT PILL -->` block near the top of the template.
- Logic/data: the `USAGE` object, the `lc()` level-color helper, and `buildUsage()` in the `<script>` class; plus the `usageOpen` state and the `toggleUsage` / `usagePills` / `usageRows` / `usageTriggerBd` values in `renderVals()`.

## Fidelity
**High-fidelity.** Final colors, typography, spacing, and interaction are specified below and should be matched closely. The one thing that is mocked is the **data** — the numbers in the prototype are static samples. In the real app they must come from live provider quota data (see *Data & Integration*).

## Screens / Views

### 1. Titlebar pill (always visible)
- **Position**: top titlebar, right cluster, immediately left of the theme toggle. The whole cluster is `display:flex; align-items:center; gap:8px; position:relative` (the popover anchors to this relative container).
- **The pill is a `<button>`**:
  - `height:26px; padding:0 8px 0 10px; gap:11px`
  - `background: var(--bg-2)`
  - `border:1px solid` → color driven by state (see *usageTriggerBd* under States)
  - `border-radius:8px; cursor:pointer`
  - hover: `border-color: var(--border-strong)`
- **Inside the pill**, one segment per provider (`display:flex; align-items:center; gap:5px`), plus a trailing chevron-down icon (`11×11`, `stroke:var(--text-3)`, `stroke-width:2.2`).
- **Each provider segment** contains:
  - **Ring** — `14×14`, `border-radius:50%`, `background: conic-gradient(<levelColor> 0 <pct>%, var(--bg-4) <pct>% 100%)`. Inside it a centered `8×8` circle filled `var(--bg-2)` (the "hole" — matches the pill background) to make it a donut. The `pct` here is the **5-hour** usage %.
  - **Label** — provider name. `font-size:11px; font-weight:600; letter-spacing:-.1px; color:var(--text-1)`.
  - **Percent** — 5-hour %. `font-size:10.5px; font-family:var(--mono); color:<levelColor>`.

### 2. Popover (on click)
- **Trigger**: clicking the pill toggles `usageOpen`. A transparent full-window backdrop (`position:fixed; inset:0; z-index:199`) sits behind the popover; clicking it closes the popover.
- **Popover container**:
  - `position:absolute; top:34px; right:0` (anchored under the pill, right-aligned)
  - `width:288px`
  - `background:var(--bg-2); border:1px solid var(--border); border-radius:12px`
  - `box-shadow:0 20px 50px -16px rgba(0,0,0,.62)`
  - `padding:14px; z-index:200; display:flex; flex-direction:column; gap:13px`
- **Header row** (`space-between`):
  - Left: `사용 한도` — `font-size:12px; font-weight:700; letter-spacing:.4px; text-transform:uppercase; color:var(--text-2)`
  - Right: `계정 · provider별` — `font-size:10.5px; color:var(--text-3); font-family:var(--mono)`
- **Per-provider block** (`display:flex; flex-direction:column; gap:10px`). The first block has no top border; each subsequent block has `padding-top:12px; border-top:1px solid var(--border-subtle)`.
  - **Provider header row** (`gap:7px`): an `8×8` square swatch (`border-radius:2px; background:<provider color>`), the provider name (`font-size:12.5px; font-weight:600; color:var(--text-0)`), and a sub label like `3명 사용` (`font-size:10.5px; color:var(--text-3); font-family:var(--mono)`) = number of party members currently using that provider.
  - **Two meters** per provider — one `5시간 한도` (5-hour), one `주간 한도` (weekly). Each meter (`display:flex; flex-direction:column; gap:5px`):
    - **Label row** (`space-between`, `align-items:baseline`): meter name `font-size:11px; color:var(--text-1); font-weight:500`; right side `font-size:10px; color:var(--text-2); font-family:var(--mono)` reading e.g. `63% · 2시간 12분 후 리셋`.
    - **Bar**: track `height:6px; border-radius:3px; background:var(--bg-4); overflow:hidden`; fill `height:100%; width:<pct>%; background:<levelColor>; border-radius:3px`.
- **Footer button** (`Settings에서 상세 보기`): `height:30px; full width; gap:6px; background:transparent; border:1px solid var(--border); border-radius:7px; color:var(--text-1); font-size:11.5px; font-weight:500`; a gear icon (`12×12`) on the left; hover `background:var(--bg-3); color:var(--text-0)`. Should navigate to the Settings → Usage section.

## Interactions & Behavior
- **Toggle**: click pill → open/close popover. Click backdrop → close. (Consider also: `Esc` to close, and reposition/flip if the titlebar is near a screen edge.)
- **Level escalation** — the single most important behavior. Ring, percent text, and bar fills are colored by usage level via `lc(pct, base)`:
  - `pct < 75` → provider brand color (Claude `#c5835f`, Codex `#2bb67e`)
  - `75 ≤ pct < 90` → `var(--live)` (amber warning)
  - `pct ≥ 90` → `var(--danger)` (red)
  - The **pill border** also escalates: if **any** provider's 5-hour OR weekly usage is `≥ 75`, the pill border becomes `var(--live)` to draw the eye. Otherwise it's `var(--accent-bd)` while the popover is open, else `var(--border)`.
- **Reset countdowns**: the `후 리셋` text should tick down against the real reset timestamp (5-hour window resets on a rolling basis; weekly resets on the plan's weekly boundary).
- **No transitions are required**; a short fade/scale on popover open is optional and on-brand.

## State Management
- `usageOpen: boolean` — popover visibility. Toggled by `toggleUsage`.
- Usage data per provider (from the live source — see below), each provider needing:
  - `label` (e.g. "Claude" / "Codex"), brand color `pc`
  - `members` — count of active agents using this provider (derive from the roster / model assignments)
  - `h5` (5-hour used %), `h5reset` (human string, e.g. "2시간 12분")
  - `wk` (weekly used %), `wkreset` (e.g. "4일 6시간")
- Derived: `anyHigh = providers.some(p => p.h5 >= 75 || p.wk >= 75)` → drives pill border warning.
- `buildUsage()` maps each provider into `{ pill: {...}, meters: [5h, weekly] }` view objects; reimplement as a selector/computed in your framework.

## Data & Integration (Electron-specific)
The prototype's numbers are hardcoded. In the app they must come from live quota data:
- **Claude Code (Anthropic)** and **Codex (OpenAI)** each expose rate-limit / usage state. Read it in the **main process** (where credentials and CLI/API access live), not the renderer, then push to the renderer over IPC (`ipcMain.handle` / `ipcRenderer.invoke`, or a push channel on refresh).
- Poll on an interval (e.g. every 30–60s) and also refresh when a value is likely to have changed (after an agent run completes). Keep the reset countdowns updating locally between polls from the last-known reset timestamp so they tick smoothly without hammering the source.
- `members` per provider = count of agents in the current party whose assigned model belongs to that provider (Anthropic models → Claude; OpenAI models → Codex). Providers with no active members can be hidden or shown at 0.
- Handle the **unknown/loading** state (before first fetch) and **error** state (couldn't read quota) — e.g. a muted ring and a "—" percent; don't show a misleading 0%.

## Design Tokens
All values are CSS custom properties defined at the top of the reference file, in both dark (`:root`) and light (`[data-theme="light"]`) themes. Key ones used by this feature:

| Token | Dark | Light | Use |
|---|---|---|---|
| `--bg-2` | `#14171d` | `#ffffff` | pill bg, popover bg, ring hole |
| `--bg-3` | `#1b1f27` | `#eef0f3` | hover bg |
| `--bg-4` | `#222731` | `#e6e9ed` | ring track, bar track |
| `--border-subtle` | `#1c2028` | `#e2e5ea` | provider-block divider |
| `--border` | `#262b35` | `#d3d7df` | pill/popover border (default) |
| `--border-strong` | `#333a46` | `#c0c5ce` | pill border hover |
| `--text-0` | `#e7e9ee` | `#171a1f` | provider name |
| `--text-1` | `#aeb4c0` | `#454b56` | labels |
| `--text-2` | `#79808d` | `#6c7480` | header title, meter right text |
| `--text-3` | `#535965` | `#9aa1ac` | sub labels, chevron |
| `--accent-bd` | `rgba(91,140,255,.32)` | `rgba(63,111,230,.28)` | pill border when open |
| `--live` | `#e0a14e` | `#b9791d` | warning level (≥75%) |
| `--danger` | `#e0635d` | `#cf4b45` | critical level (≥90%) |

Provider brand colors (not tokens — literals): **Claude/Anthropic `#c5835f`**, **Codex/OpenAI `#2bb67e`**.

**Typography**: Sans = `Geist` (`--sans`), Mono = `Geist Mono` (`--mono`). Sizes used: 10 / 10.5 / 11 / 11.5 / 12 / 12.5 px. All percentages and reset strings are in the mono face.

**Radii**: pill `8px`, popover `12px`, ring/dot `50%`, bar `3px`, footer button `7px`, swatch `2px`.

**Shadow**: popover `0 20px 50px -16px rgba(0,0,0,.62)`.

## Assets
No image assets. Icons are inline SVG (chevron-down, gear). The two progress rings are pure CSS `conic-gradient` donuts (no SVG/canvas needed). Recreate icons with your app's existing icon set (Lucide-style stroke icons, `stroke-width` ~1.8–2.2).

## Files
- `Workbench Multi.dc.html` — full workbench reference; the usage indicator is the `<!-- USAGE LIMIT PILL -->` block plus the `USAGE` / `lc` / `buildUsage` logic and the `usage*` values in `renderVals()`.
- `support.js` — the prototype's template runtime (reference only; do not port).
- `screenshots/usage-popover.png` — the pill + open popover, for visual reference.
