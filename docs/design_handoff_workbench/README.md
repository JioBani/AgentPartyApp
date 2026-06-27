# Handoff: AgentParty — Multi-Member Workbench

## Overview
AgentParty is a desktop app (Electron target) for running and supervising **multiple AI coding agents ("members") at once**. The Workbench is the main screen. Its defining idea is a **VS Code–style split-panel + tab workspace**:

- A **panel** = a "watch slot" you keep your eyes on.
- The **tabs inside one panel** = members that work sequentially and time-share that one slot (only one visible at a time).
- So the user puts **members they must watch simultaneously into separate panels**, and **members that take turns into tabs of the same panel**. **The layout itself expresses concurrency vs. sequencing between members.**

This handoff covers that Workbench: the party sidebar, the multi-panel work area, per-member transcripts, the responsive panel behavior, and the Runtime (model settings) modal.

## About the Design Files
The files in this bundle are **design references authored in HTML** — high-fidelity, interactive prototypes showing the intended look and behavior. **They are not production code to copy.** They run on a small in-house template runtime (`support.js`, a `.dc.html` format); **do not port that runtime.**

Your task: **recreate these designs in the real codebase.** Target is an **Electron app**. If a renderer framework already exists (React/Vue/Svelte/etc.), use it and its established patterns/component library. If none exists yet, **React + TypeScript in the Electron renderer** is the recommended choice for this UI (lots of stateful split/tab/resizable logic).

### How to view the prototype
Open **`Workbench Multi.dc.html`** in a browser (it loads `support.js` from the same folder and fonts from Google Fonts). Use the scenario switcher in the top-right (`단일 / 2분할 / 3구역 / 좁은 패널 / 드래그 중`) to see each state. Click a member's **model pill** in a panel toolbar to open the Runtime modal. Drag the handle between panels to resize. See `screenshots/` for stills. `Workbench (single-view reference).dc.html` is an earlier single-transcript version kept only for reference of the composer/runtime detail.

## Fidelity
**High-fidelity.** Colors, typography, spacing, and interactions are final. Recreate pixel-faithfully, then adapt to real window resizing (see Electron Notes — the prototype is a fixed 1440×900 canvas; the real app must be fluid).

---

## Design Tokens

CSS custom properties. Two themes (the prototype toggles via `data-theme` on the root; default dark). Reproduce as your theme system.

### Dark (default)
```
--bg-0:#0a0b0e   --bg-1:#0e1014   --bg-2:#14171d   --bg-3:#1b1f27   --bg-4:#222731
--bg-input:#0c0e12
--border-subtle:#1c2028   --border:#262b35   --border-strong:#333a46
--text-0:#e7e9ee   --text-1:#aeb4c0   --text-2:#79808d   --text-3:#535965
--accent:#5b8cff   --accent-dim:rgba(91,140,255,.13)   --accent-bd:rgba(91,140,255,.32)   --accent-fg:#fff
--live:#e0a14e     --live-dim:rgba(224,161,78,.13)      (working/in-progress)
--success:#54b585  --success-dim:rgba(84,181,133,.13)
--danger:#e0635d   --danger-dim:rgba(224,99,93,.13)
```
### Light
```
--bg-0:#e7e8eb   --bg-1:#f3f4f6   --bg-2:#ffffff   --bg-3:#eef0f3   --bg-4:#e6e9ed
--bg-input:#ffffff
--border-subtle:#e2e5ea   --border:#d3d7df   --border-strong:#c0c5ce
--text-0:#171a1f   --text-1:#454b56   --text-2:#6c7480   --text-3:#9aa1ac
--accent:#3f6fe6   --accent-dim:rgba(63,111,230,.1)   --accent-bd:rgba(63,111,230,.28)
--live:#b9791d   --success:#2f8f5e   --danger:#cf4b45
```

### Typography
- Sans: **Geist** (`'Geist', sans-serif`). Mono: **Geist Mono** (used for model names, tokens, paths, timestamps, counts).
- Base font-size 13px, line-height 1.5, `-webkit-font-smoothing:antialiased`.
- Common sizes: titles 15px/600; panel/tab member name 12–13px/600; body 12.5px/1.5–1.65; labels (UPPERCASE) 10–11px/700 letter-spacing .6px color `--text-3`; meta/mono 10.5–11px color `--text-3`.

### Radii / shadow
- Radii: window 9px; panels/cards 10–11px; buttons/inputs 6–8px; tabs square top with a 2px top accent bar; pills 5–6px; status badges 4–5px.
- Focused panel shadow: `0 0 0 1px <memberColor@.3>, 0 18px 40px -22px rgba(0,0,0,.7)`. Modal: `0 32px 72px -20px rgba(0,0,0,.8)`.

### Member channel colors (FIXED per member — core identity system)
Each member has one fixed color used everywhere it appears (sidebar dot, tab dot + active top-bar, panel focus border/top bar, assistant avatar dot, approval/badge accents).
```
backend     #5b8cff  (blue)
frontend    #a07bff  (violet)
reviewer    #54b585  (green)
tester      #e0a14e  (amber)
db-migrate  #3ac6d6  (cyan)
docs        #e06b9c  (pink)
```
Tints are produced as `rgba(r,g,b,a)` from the hex (helper `hexA(hex,a)` in the prototype): e.g. open-member sidebar bg `@.06–.14`, focused panel border `@.5`, approval accent ring `@.12`.

---

## Layout / Regions (left → right, top → bottom)

Root is a fixed 1440×900 rounded window in the prototype → **make it fill the OS window** in the app.

1. **Title bar** (38px): brand mark + "AgentParty" + theme toggle. In Electron this is your custom frame (see Notes).
2. **Body row** (fills height; `overflow:hidden`): `[nav rail] [party sidebar] [content column]`.

### Nav rail (52px, `--bg-0`)
Vertical icon rail: workbench (active, accent), members, runtime, …, user avatar pinned bottom. Static in the prototype; wire to real navigation.

### Party sidebar (236px, collapsible, `--bg-0`)
Collapses fully to the left so the work area can grow. Mechanism in prototype: animate `flex-basis` 236px↔0 with `overflow:hidden` + `min-width:0` (parent row must be `overflow:hidden`). Use any equivalent (e.g. width transition) in the app.
- **Header (44px)**: party member icon + **active party name** (`activePartyName`, truncates) + **collapse button** (« chevrons-left, title "파티 패널 접기"). When collapsed, a re-open button (panel icon, accent) appears at the **left of the screen header**.
- **Parties section**: UPPERCASE "Parties" label + count; new-party input (`새 파티 이름…`) + accent `+` button; list of parties. Each party row: live dot (pulses if any member working), name, mono subtitle (`3 members · 1 working`), and an accent check on the active party. Active row: `--accent-dim` bg + `--accent-bd` border.
- **Members section** (fills, scrolls): UPPERCASE "Members" label + hint "클릭해 패널로 열기". One row per member of the active party (height 38): channel-color dot (pulses if working), name, then `승인` badge (member-color bg) if an approval is pending, an unread count chip, and small mono status (`working/idle/...`) when no approval badge. **Clicking a member opens it as a tab in the currently focused panel** (or focuses it if already open). Row bg tints in the member color when that member is open in a panel.

### Content column
- **Screen header (60px)**: `[collapsed→reopen btn] "Workbench" + repo/branch (mono) + one-line concept caption` on the left; **scenario switcher** segmented control on the right (prototype-only demo control — see "Scenarios"). The app does not need the switcher; it's how the prototype shows the five states.
- **Scenario caption bar (small)**: explanatory text for the current demo state — prototype-only.
- **Work area** (fills): a horizontal flex row of **panels** with draggable resize handles between them. `position:relative` (hosts the drag ghost + Runtime modal overlay).

---

## Panel anatomy (the core component — repeats N times)
A panel is a column card: `background --bg-1`, border `--border-subtle` (focused: member-color `@.5` + glow shadow), radius 11px, `overflow:hidden`. Top → bottom:

1. **Member color bar** (3px) in the active member's channel color.
2. **Tab strip** (38px, `--bg-0`): horizontally scrollable list of tabs + trailing actions. Each **tab** (max-width 170px): 2px top bar (member color when active, else transparent), channel-color dot (pulses if working), member name (truncate; active = `--text-0`/600, inactive = `--text-1`/500), then live indicators — `승인` badge / unread chip — and a close ✕ (appears on hover). Active tab bg = `--bg-1` (connects to body). **Inactive tabs still show name + color + live status** so you can tell, without switching, that a backgrounded member finished or raised an approval. Trailing buttons: `+` add member tab, `⋯` (narrow only), split (new panel).
3. **Toolbar** (40px — hidden when panel is *narrow*): member dot + name + status pill (`working` pulses). Right side, **density-dependent** (see Responsive): model pill (opens Runtime), effort pill, permission pill, compact/restart icons, and a stop/restart action (stop = danger when working).
4. **Transcript** (fills, scrolls; padding 16px wide / 12px narrow): a vertical list of typed blocks:
   - **user**: right-aligned bubble, `--bg-3`, radius `9 9 3 9`.
   - **assistant**: member-color avatar dot + name + time, optional collapsed **reasoning chip** (`🧠 Reasoned … · 8s`), then body text 12.5px/1.65.
   - **tool call**: bordered card, caret + green ✓ chip + mono tool name + arg (truncate) + duration; expandable `<pre>` result (auto-expanded in *wide*, collapsed otherwise; result wraps in *narrow*).
   - **status**: search-icon + mono line.
   - **approval**: member-color accent card (border `@.42`, ring `@.12`): shield + "Approval required" + tool chip; description; `$ command` in a `<pre>`; **Deny / Allow once** buttons (Allow = member color). Buttons go **full-width stacked (column-reverse)** in *narrow* so they're always reachable.
   - **typing**: three bouncing member-color dots + "작업 중…".
5. **Composer** (bottom):
   - *wide/mid*: bordered box, 2-row textarea (`{member}에게 메시지 보내기…`), toolbar row (attach, @-mention) + Send/Stop button (Stop = danger when that member is working).
   - *narrow*: single-line input + expand button + icon-only Send/Stop.

---

## Responsive behavior (must be excellent — measure each panel's own width)
Each panel computes a **density tier from its own rendered pixel width** (prototype uses a `ResizeObserver` on the work area + flex weights; in the app, observe each panel). Thresholds:
- **wide ≥ 600px**: full toolbar (model + effort + permission pills, compact + restart icons, stop), 2-row composer, tool results auto-expanded.
- **mid 408–599px**: toolbar shows model pill + `⋯` overflow + stop; 2-row composer; tool results collapsed.
- **narrow < 408px**: **no toolbar row** (controls collapse into a `⋯` button in the tab strip); **single-line composer**; transcript prefers wrap over horizontal scroll; approval buttons stack full-width; tabs shrink/scroll.

Same member, three widths, is shown side-by-side in the "좁은 패널" scenario (`screenshots/03-responsive-breakpoints.png`).

## Resizing & splitting
- **Resize**: drag the 8px handle on a panel's left edge; adjusts the flex weights of the two adjacent panels (min clamp). Live density recompute as widths change.
- **Split**: panel `split` button creates a new panel to the right seeded with the current active member (becomes a new watch slot).
- **Add tab / close tab / close empty panel**: `+` adds the first member not already open; closing the last tab removes the panel; focus falls back to a remaining panel.
- **Tab drag between panels** (VS Code parity): in the prototype this is shown as a **static state only** (`드래그 중` scenario): the dragged tab dims, a rotated **ghost chip** follows the cursor, and the target panel shows a dashed member-color **drop zone** ("여기에 놓아 새 패널 만들기"). **You must implement real drag-and-drop** of tabs across panels (and drop-to-create-new-panel) in the app — see `screenshots/04-tab-drag.png` for the intended affordances.

## Runtime (model settings) modal
Opened per member by clicking that panel's **model pill**. Centered modal (~830px) over a 50% scrim; click-scrim or Cancel closes.
- Header: Runtime + target member dot/name + "Claude Code".
- Left pane: **Model list grouped by provider** (Anthropic / OpenAI / OpenRouter), each provider with a colored dot + count; each model row shows mono name, tier label, a 4-bar **performance meter** (green when high), a 5-`$` **cost meter**, and a check on the selected one.
- Right pane: selected model detail — name + provider chip; 3 stat cards (Performance bars + tier, Cost per-1M in/out + `$` meter, Context window); **Effort** segmented control (options vary per model); **Extended thinking** toggle (only for thinking-capable models); **Debug logging** toggle.
- Footer: staged-changes note ("변경됨 — Apply 시 세션이 재시작됩니다" in `--live` when dirty) + Cancel / Apply (accent). Apply writes the chosen model back to that member.

Model catalog used in the prototype (id, name, provider, tier, perf 1–4, cost 1–5, in/out per 1M, context, thinking, efforts):
```
claude-opus-4.1   Anthropic  Frontier  4 5  $15/$75    200K  think  low/med/high
claude-sonnet-4.5 Anthropic  Frontier  4 4  $3/$15     200K  think  low/med/high
claude-haiku-4    Anthropic  Fast      2 2  $0.80/$4   200K  -      low/med
gpt-5             OpenAI     Frontier  4 3  $1.25/$10  400K  think  minimal/low/med/high
o4-mini           OpenAI     Balanced  3 2  $1.10/$4.40 200K think  low/med/high
deepseek-v3.2     OpenRouter Balanced  3 1  $0.27/$1.10 164K -      low/med/high
```

## Members & sample data (prototype party "Refactor Auth")
```
backend    blue   sonnet-4.5  working  (reasoning + read_file tool + run_command approval)
frontend   violet sonnet-4.5  idle     (blocked on backend's 401 contract)
reviewer   green  o4-mini     approval (grep + apply_patch approval pending)
tester     amber  gpt-5       working  unread:2 (regression suite running, typing)
db-migrate cyan   deepseek    idle     (migration staged, awaiting approval)
docs       pink   haiku-4     idle
```
Second party: "Payments Migration" (2 members, idle). These are placeholders — wire to real agent sessions.

---

## State management (suggested shape)
- `panels: [{ id, tabs: memberId[], active: memberId, weight }]` — ordered left→right; `weight` drives flex sizing.
- `focusedPanelId` — which panel receives member-opens / shows focus ring.
- `members: { id → { name, color, model, effort, perm, status, unread } }`; `status ∈ working | idle | approval | not-started`.
- `parties: [{ id, name, members[] }]`, `activePartyId`.
- `sidebarOpen: boolean`.
- `runtime: { open, targetMemberId, selModel, effort, thinking, debug, staged }`; `modelOverride: { memberId → modelName }`.
- Per-panel density is **derived** from measured width, not stored.
- Transcript = per-member ordered list of typed blocks (see Panel anatomy). In the real app these stream from the agent process.

Triggers: select tab → set panel.active + focus; member click → open/focus; resize handle → adjust adjacent weights; split → insert panel; model pill → open runtime seeded from member's current model; Apply → write modelOverride + close.

## Interactions & motion
- Pulse dot: `opacity 1→.3→1`, ~1.5s, for working state. Typing dots: staggered bounce ~1.2s.
- Sidebar collapse & panel resize: ~.24s ease. Toggle knobs / carets: ~.15s.
- Hover states everywhere use `--bg-2/--bg-3` fills or border-strong; primary buttons use `filter:brightness(1.08–1.1)`.

## Assets
- No raster assets. All icons are inline SVG (stroke-based, 1.6–1.8 width) — reuse your icon library with equivalents (panel, split, shield/permission, brain/thinking, search, check, plus, close, chevrons, etc.).
- Fonts: **Geist** + **Geist Mono** (Google Fonts in the prototype). **Bundle them locally** for Electron (offline).

## Electron implementation notes (important — the prototype is a fixed canvas)
1. **Fluid layout**: replace the fixed 1440×900 root with `100vw/100vh` flex fill; every region already uses flex — keep panels `flex`-weighted and the work area `min-height:0; overflow:hidden`.
2. **Window chrome**: the title-bar mock isn't functional. Use a `frame:false` BrowserWindow (or `titleBarStyle:'hidden'`), set `-webkit-app-region: drag` on the title bar and `no-drag` on its buttons, and wire min/max/close via IPC.
3. **Fonts offline**: ship Geist/Geist Mono as local `@font-face`; drop the Google Fonts `<link>`.
4. **Per-panel ResizeObserver** for density — do not key responsiveness off the window size; key it off each panel's width.
5. **Real tab DnD** across panels + drop-to-split (prototype only shows the target state).
6. **Persistence**: persist layout (panels/tabs/weights), active party, sidebar state, and per-member model overrides.
7. Agent transcripts/approvals/tokens come from the real Claude Code (or other agent) processes — the blocks here are the rendering contract to fill.

## Files in this bundle
- `Workbench Multi.dc.html` — the multi-panel Workbench (primary reference). Open in a browser; use the top-right scenario switcher.
- `Workbench (single-view reference).dc.html` — earlier single-transcript version (composer + runtime detail reference).
- `support.js` — the prototype runtime (needed only to open the `.dc.html` files; **do not port**).
- `screenshots/` — 01 split (2 panels) · 02 three-zone · 03 responsive breakpoints (wide/mid/narrow) · 04 tab-drag state · 05 runtime modal.
