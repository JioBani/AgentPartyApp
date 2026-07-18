# Handoff: AgentParty — Panel Header, Context Indicator & Auto-compact

## Overview
This handoff covers a **redesign of the per-member panel header** in the AgentParty Workbench (an **Electron** desktop app for supervising multiple AI coding agents). The redesign reorganizes the header around what the user looks at most, and replaces the old bar-style context meter with a compact **donut context indicator** that also shows the auto-compact threshold. It also moves the **permission control into the composer** and consolidates all **compaction actions into one settings dialog**.

> This document supersedes the panel-**header / toolbar**, **auto-compact**, and **composer permission** portions of `design_handoff_workbench`. Everything else in that older handoff (panels, tabs, resize/split, transcript blocks, Runtime modal, tokens) still applies unchanged. Read this document as the source of truth for the header + context + compaction + composer-permission areas.

## About the Design Files
The files in this bundle are **design references authored in HTML** — a high-fidelity, interactive prototype of the intended look and behavior. **They are not production code to copy.** They run on a small in-house template runtime (`support.js`, a `.dc.html` format); **do not port that runtime.**

Your task: **recreate this design faithfully in the real codebase.** Target is an **Electron app**; if a renderer framework already exists (React/Vue/Svelte), use it and its patterns. If none exists, **React + TypeScript** in the renderer is recommended.

### How to view the prototype
Open **`Workbench Multi.dc.html`** in a browser. Use the scenario switcher (top-right: `단일 / 2분할 / 3구역 / 좁은 패널 / 드래그 중`). The **좁은 패널** scenario shows the same member at wide / mid / narrow widths side-by-side — use it to verify the density rules below. Click a panel's **context donut** to open the Auto-compact dialog; click the **model** button for the model catalog; click **effort** for its inline dropdown.

## Fidelity
**High-fidelity.** Colors, sizes, spacing, and interactions are final. Recreate pixel-faithfully. **Default theme is light** (see Tokens); dark is an option only.

---

## ⚠️ Read this first — the exact things implementations usually get wrong
These are the points where a loose reading drifts from the design. Match them precisely:

1. **The context indicator is a DONUT (ring), not a bar.** 18×18px. It is a `conic-gradient` progress ring with a hollow center, **plus a compaction-zone arc and a threshold tick** (spec + exact gradient stops below). Do not substitute a horizontal progress bar.
2. **The donut has THREE color regions, in this order around the ring:** filled usage → neutral remainder → **warm "compaction zone"** from the threshold to 100%. The threshold also gets a **tick mark**. The zone arc is the whole point ("how much runway before auto-compact") — do not drop it.
3. **One entry point for compaction.** Clicking the donut opens the **Auto-compact dialog**, which contains BOTH "지금 압축 실행" (run compact now) and the threshold slider. There is **no** compact button/pill in the header and **no** compact/threshold items in the ⋯ menu. (An earlier design had a segmented compact pill and menu items — those are removed.)
4. **Model and effort are SEPARATE controls.** Model button → opens the model catalog (Runtime modal). Effort button → opens a small **inline dropdown** (low/medium/high) right there in the header. Do not merge them back into one "sonnet-4.5 · high" button.
5. **The ⋯ (more) button is ALWAYS visible** at every panel width. When space is tight, **hide the effort control first** — never the ⋯ button. (Model stays; effort is reachable via the model/Runtime modal.)
6. **The permission control lives in the composer, to the RIGHT of the Send button** — not in the header, not in the ⋯ menu.
7. **The ⋯ menu has exactly two items:** 세션 재시작, MCP 서버. Nothing else.
8. **Default theme = light.** The prototype root is `data-theme="light"`.
9. **The sidebar member rows do NOT show an auto-compact badge.** (Removed — it was noise.)

---

## Design Tokens
CSS custom properties, two themes on the root via `data-theme`. **Default is light.**

### Light (default)
```
--bg-0:#e7e8eb   --bg-1:#f3f4f6   --bg-2:#ffffff   --bg-3:#eef0f3   --bg-4:#e6e9ed
--bg-input:#ffffff
--border-subtle:#e2e5ea   --border:#d3d7df   --border-strong:#c0c5ce
--text-0:#171a1f   --text-1:#454b56   --text-2:#6c7480   --text-3:#9aa1ac
--accent:#3f6fe6   --accent-dim:rgba(63,111,230,.1)   --accent-bd:rgba(63,111,230,.28)   --accent-fg:#fff
--live:#b9791d    --live-dim:rgba(185,121,29,.1)      (working / auto-compact accent)
--success:#2f8f5e --success-dim:rgba(47,143,94,.1)
--danger:#cf4b45  --danger-dim:rgba(207,75,69,.1)
```
### Dark (optional)
```
--bg-0:#0a0b0e   --bg-1:#0e1014   --bg-2:#14171d   --bg-3:#1b1f27   --bg-4:#222731
--bg-input:#0c0e12
--border-subtle:#1c2028   --border:#262b35   --border-strong:#333a46
--text-0:#e7e9ee   --text-1:#aeb4c0   --text-2:#79808d   --text-3:#535965
--accent:#5b8cff   --accent-dim:rgba(91,140,255,.13)  --accent-bd:rgba(91,140,255,.32)  --accent-fg:#fff
--live:#e0a14e    --success:#54b585   --danger:#e0635d
```

### Typography
- Sans **Geist**; Mono **Geist Mono** (model names, %, token counts, K/K, paths). Bundle both locally for Electron.
- Header member name 12.5px/600; control buttons 11.5px; % readout 11.5px/600 mono; status pill 10px/600; K/K range 10.5px mono.

### Member channel colors (fixed per member — used as the donut fill "safe" color)
```
backend #5b8cff · frontend #a07bff · reviewer #54b585 · tester #e0a14e · db-migrate #3ac6d6 · docs #e06b9c
```
(These fixed member hues are intentionally the dark-palette blues/greens etc. and are used verbatim in both themes as each member's identity color.)

---

## Panel header (height 40px)
Replaces the old toolbar. **Shown at all panel widths** (it no longer disappears when narrow). Container: `position:relative; display:flex; align-items:center; gap:7px; height:40px; padding:0 6px 0 11px; background:var(--bg-1); border-bottom:1px solid var(--border-subtle); z-index:6`.

Left → right:

1. **Status dot** — 7×7px circle in the member color. If the member is *working*, a pulsing ring: an absolutely-positioned sibling `inset:-3px; border-radius:50%; border:1.5px solid <memberColor>; opacity:.5; animation: ap-pulse 1.5s infinite` (`@keyframes ap-pulse{0%,100%{opacity:1}50%{opacity:.3}}`).
2. **Member name** — 12.5px/600 `--text-0`, `white-space:nowrap; overflow:hidden; text-overflow:ellipsis`.
3. **Status pill** *(wide only)* — `height:17px; padding:0 6px; border-radius:5px`, bg = member-tint (`memberColor@.15` when working/approval, else `--bg-3`), text 10px/600 (member color when working/approval, else `--text-2`). Text: `working` / `idle` / `approval`.
4. **Spacer** — `flex:1; min-width:6px`.
5. **Model button** — `height:26px; max-width:{narrow?116px:240px}; padding:0 8px; gap:5px; background:var(--bg-2); border:1px solid var(--border); border-radius:6px; font-family:mono; font-size:11.5px; color:var(--text-1)`. Label = model name **with a leading `claude-` stripped** (e.g. `sonnet-4.5`), truncating; then a 10px chevron-down `--text-3`. Hover bg `--bg-3`. **Click → open model catalog (Runtime modal) for this member.**
6. **Effort control** *(hidden when narrow)* — a `position:relative` wrapper containing:
   - Button: `height:26px; padding:0 8px; gap:4px; background:var(--bg-2); border:1px solid var(--border); border-radius:6px; font-family:mono; font-size:11.5px; color:var(--text-1)`; label = current effort (`low`/`medium`/`high`) + 10px chevron. Hover bg `--bg-3`.
   - **Inline dropdown** (on click): a full-screen outside-click catcher (`position:fixed; inset:0; z-index:44`) + a menu `position:absolute; top:31px; right:0; width:132px; background:var(--bg-2); border:1px solid var(--border); border-radius:9px; box-shadow:0 18px 44px -16px rgba(0,0,0,.7); padding:4px`. Rows: `height:30px; padding:0 10px; border-radius:6px; font-family:mono; font-size:12px`, hover bg `--bg-3`; the selected row is `--text-0` and shows a trailing 13px accent check (`--accent`), others `--text-1`. Selecting writes that member's effort and closes.
7. **Context donut button** (Tier 2) — `height:26px; padding:0 8px 0 7px; gap:7px; background:var(--bg-2); border:1px solid var(--border); border-radius:6px`. Hover bg `--bg-3`. Contents:
   - **Ring**, `position:relative; width:18px; height:18px`:
     - Outer circle: `position:absolute; inset:0; border-radius:50%; background:<CONIC>` (gradient below).
     - Inner hole: `position:absolute; inset:3.5px; border-radius:50%; background:var(--bg-2)` (match the button bg).
     - **Threshold tick** *(only when auto-compact is on)*: a rotation wrapper `position:absolute; inset:0; transform:rotate(<at×3.6>deg)` containing `position:absolute; top:-1px; left:50%; transform:translateX(-50%); width:2px; height:6px; background:var(--live); border-radius:1px`.
   - **K/K range** *(wide only)* — mono 10.5px `--text-3`, e.g. `128K / 200K` (used tokens / model context window).
   - **% readout** — mono 11.5px/600, color = `ctxCol`, e.g. `64%`.
   - **Click → open the Auto-compact dialog** for this member.
8. **⋯ (more) button** — **ALWAYS visible.** `width:28px; height:26px; background:transparent; border:none; border-radius:6px; color:var(--text-2)`; three horizontal dots (15px). Hover bg `--bg-3`, color `--text-0`. Click toggles the overflow menu:
   - Outside-click catcher `position:fixed; inset:0; z-index:44`; menu `position:absolute; top:43px; right:6px; width:200px; background:var(--bg-2); border:1px solid var(--border); border-radius:10px; box-shadow:0 18px 44px -16px rgba(0,0,0,.7); padding:5px`.
   - **Exactly two items** (each `height:33px; padding:0 9px; gap:9px; border-radius:7px; font-size:12px; color:var(--text-1)`, hover bg `--bg-3`/`--text-0`): **세션 재시작** (refresh/undo icon) and **MCP 서버** (nested-square icon).

### Donut gradient + colors (exact)
Let `pct` = round(usedTokens / contextWindow × 100), clamped 0–100. `at` = the member's auto-compact threshold %. `on` = auto-compact enabled.

```
fill      = pct>=90 ? var(--danger) : pct>=75 ? var(--live) : <memberColor>
ctxCol    = pct>=90 ? var(--danger) : pct>=75 ? var(--live) : var(--text-1)
zoneTint  = light ? rgba(185,121,29,.26) : rgba(224,161,78,.32)
```
`CONIC` (a `conic-gradient(...)`, 12 o'clock start, clockwise):
```
if !on:            conic-gradient(fill 0 {pct}%, var(--bg-4) {pct}% 100%)
else if pct <= at: conic-gradient(fill 0 {pct}%, var(--bg-4) {pct}% {at}%, zoneTint {at}% 100%)
else (pct > at):   conic-gradient(fill 0 {pct}%, zoneTint {pct}% 100%)
```
So: filled usage in `fill`, the gap up to the threshold in the neutral track `--bg-4`, and the region from the threshold to full in the warm `zoneTint`. When usage passes the threshold the neutral gap disappears. The tick sits exactly on the threshold. **When auto-compact is off there is no zone and no tick** — just fill + track.

---

## Auto-compact dialog (~430px) — opened by clicking the donut
The single place to run a compaction and to configure the threshold. Centered over a 50% scrim (`rgba(0,0,0,.5)`, z-index 70); click-scrim or "완료" closes.

- **Header** (`padding:15px 18px 14px; border-bottom:1px solid var(--border-subtle)`): compact icon (`--live`) + title **Auto-compact** + target member dot + name; a close ✕ on the right.
- **Body** (`padding:18px; display:flex; flex-direction:column; gap:14px`):
  1. **Current-usage card** — `background:var(--bg-1); border:1px solid var(--border-subtle); border-radius:10px; padding:13px 14px; gap:9px`.
     - Row: `현재 컨텍스트 사용량` (11.5px `--text-2`) · right: mono 13px/600 in `ceUsedCol` = `{usedK}K / {totalK}K · {pct}%` (the `· {pct}%` in `--text-3`/400).
     - Track: `height:7px; border-radius:4px; background:var(--bg-4)` with a fill `width:{pct}%; background:ceUsedFill; border-radius:4px`, and (when on) a **threshold line** `position:absolute; top:-2px; bottom:-2px; left:{at}%; width:2px; background:var(--live)`.
     - Caption (when on): `막대 위 세로선 = 자동 압축이 실행되는 임계치` (10.5px `--text-3` mono).
     - `ceUsedCol`/`ceUsedFill` follow the same ≥90 danger / ≥75 live / else member-color thresholds as the donut.
  2. **Enable toggle** row — a 36×21 switch (knob 16px, `left` transitions ~.15s; track = `--accent` on / `--bg-4` off) + label `임계치 초과 시 자동 압축` (13px/600) and sub `끄면 입력창의 압축 버튼으로 수동 실행만 됩니다.` (11.5px `--text-2`).
  3. **Threshold slider card** *(only when enabled)* — `background:var(--bg-1); border:1px solid var(--border-subtle); border-radius:10px; padding:14px 15px; gap:11px`: label `압축 임계치 · 컨텍스트 사용률` + readout mono 14px/600 `--live` = `{at}% · ≈ {round(window×at/100)}K 토큰`; `<input type=range min=50 max=95 step=5>` `accent-color:var(--live)`; end labels `50%` / `95%`.
- **Footer** (`display:flex; justify-content:space-between; align-items:center; padding:11px 16px; border-top:1px solid var(--border-subtle); background:var(--bg-1)`):
  - **Left — "지금 압축 실행"**: `height:30px; padding:0 12px; gap:7px; background:transparent; border:1px solid var(--border); border-radius:7px; color:var(--text-1); font-size:12.5px` + compact icon (`--live`). Runs a manual compact for the target member, then closes.
  - **Right — "완료"**: `height:30px; padding:0 18px; background:var(--accent); border:none; border-radius:7px; color:var(--accent-fg); font-size:12.5px/600`.

Per-member thresholds are **independent**. Prototype seeds: backend 80 (on) · frontend 85 (on) · reviewer off · tester 75 (on) · db-migrate off · docs off. New members inherit a global default `compactDefault {on, at}` (edited on Settings → Runtime; also editable inside the Runtime modal's Auto-compact block).

---

## Composer permission (moved here)
In the **wide/mid composer** action row (`display:flex; align-items:center; justify-content:space-between`):
- **Left group** (`gap:3px`): attach button, @-mention button. *(The permission control and the old divider are removed from here.)*
- **Right group** (`display:flex; align-items:center; gap:7px`), in this order:
  1. **Send / Stop** button — `height:28px; padding:0 12px; gap:6px; border-radius:7px; font-size:12px/600`. Idle: bg = member color, white text, label `Send ›`. Working: `--danger-dim` bg, `--danger` text, danger border, label `Stop ■`.
  2. **Permission button** — `height:28px; padding:0 8px; gap:5px; background:transparent; border:1px solid var(--border); border-radius:7px; font-family:mono; font-size:11.5px; color:var(--text-1)`: shield icon + current mode text (`ask` / `auto` / `read`) + 10px chevron. Hover bg `--bg-3`/`--text-0`. **Click → opens the Runtime modal** (where permission mode is set).

In the **narrow composer** (single-line): unchanged from the base workbench — input + expand + icon-only Send/Stop. (Permission is reachable via the Runtime modal.)

---

## Responsive / density (measure each panel's OWN width)
Each panel derives a density tier from its rendered width (prototype uses a `ResizeObserver`; in the app observe each panel, not the window). The header is present in all tiers.
- **wide ≥ 600px**: status pill • model • effort • donut **with K/K range** + % • ⋯
- **mid 408–599px**: model • effort • donut (**% only**, no K/K) • ⋯   *(no status pill)*
- **narrow < 408px**: model • donut (**% only**) • ⋯   *(no status pill, **effort hidden**)*

Flags in the prototype: `showEffort = !isNarrow`; status pill & K/K range are `isWide` only; the ⋯ button has **no** density gate (always rendered).

---

## State (delta from base workbench)
- `compact: { memberId → { on:boolean, at:number } }` — per-member auto-compact; `compactDefault:{on,at}`.
- `compacting: { memberId → boolean }` — transient "manual compact running" flag (drives a brief spinner on the run action).
- `compactEdit: { open, target }` — the Auto-compact dialog target.
- `effortOverride: { memberId → 'low'|'medium'|'high' }`; `effortMenu: memberId|null` — which panel's inline effort dropdown is open.
- `headerMenu: memberId|null` — which panel's ⋯ menu is open.
- `modelOverride: { memberId → modelName }` (unchanged from base).
- Context %: derived from `usedTokens(member) / contextWindow(model)`. In the real app `usedTokens` streams from the agent process; `contextWindow` comes from the model catalog (`sonnet-4.5`/`opus`/`haiku` = 200K, `gpt-5` = 400K, `o4-mini` = 200K, `deepseek-v3.2` = 164K).

Triggers: donut → open Auto-compact dialog; dialog "지금 압축 실행" → manual compact + close; toggle/slider → write `compact[member]` live; model button → Runtime modal; effort button → toggle inline dropdown, row → write `effortOverride` + close; ⋯ → toggle header menu; composer permission → Runtime modal.

---

## Electron notes
- Fluid layout (`100vw/100vh`), custom `frame:false` window chrome, **fonts bundled locally** (no Google Fonts link), per-panel `ResizeObserver` for density — same as the base workbench handoff. Persist per-member `compact`, `effortOverride`, and `modelOverride` alongside layout.
- Icons are inline stroke SVGs (1.6–1.8 width) — map to your icon set: shield (permission), refresh/undo (restart), nested-square (MCP), three-dots (more), compact (the `M4 9h7V2 …` corners-in glyph), chevron, check.

## Files in this bundle
- `Workbench Multi.dc.html` — full Workbench prototype with the redesigned header/donut/dialog/composer (primary reference). Open in a browser; use the top-right scenario switcher; **좁은 패널** shows the three density tiers.
- `support.js` — prototype runtime (needed only to open the `.dc.html`; **do not port**).
