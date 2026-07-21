# Handoff: AgentParty — Message Gate (메시지 검문)

## Overview
**Message Gate** is a delivery-time review step for **member-to-member messages** inside an AgentParty party. Before a message from one member (agent) is delivered to another, a lightweight **reviewer model** ("리뷰어") checks it against user-defined **communication rules** (e.g. "be concise", "don't route through the orchestrator — talk to the owner directly"). If the message violates a rule the reviewer **rejects** it and the sender must rewrite; otherwise it passes through.

Key concepts:
- The reviewer is conceptually **"one more member"** but **headless** — it has a **model + effort** only (there is **no harness selection**; the runtime runs it headless).
- Rules are a **party-wide global default**; any member may **override** them, or turn the gate **On/Off** independently (a 3-state: Inherit / On / Off).
- On new-party creation the gate is **off by default**.
- The gate is **fail-open**: if the reviewer errors/times out, the message is delivered **unreviewed** with a warning.

This is a distinct feature from the existing **Guardian (가디언)** in the permissions flow (Guardian pre-screens *approval requests*; Message Gate reviews *outgoing messages*). They share visual vocabulary but are separate systems with separate entry points.

## About the Design Files
The files in this bundle are **design references authored in HTML** — high-fidelity, interactive prototypes showing intended look and behavior. **They are not production code to copy.** They run on a small in-house template runtime (`support.js`, a `.dc.html` format); **do not port that runtime.**

Your task: **recreate this feature in the real AgentParty codebase** (Electron; recommended renderer React + TypeScript per the base Workbench handoff). Message Gate is an **addition to two existing screens** — the Workbench (`Workbench Multi.dc.html`) and Settings (`Settings.dc.html`) — so implement it inside those existing components/patterns, not as a standalone page. The broader Workbench/Settings structure and tokens are documented in the sibling `design_handoff_workbench` bundle; this doc covers **only the Message Gate additions**.

### How to view
Open `Workbench Multi.dc.html` in a browser (loads `support.js` from the same folder, fonts from Google Fonts). Then:
- **Member gate editor** — in any panel's tab toolbar, click the **⋯ (더보기)** button → **"Message Gate 설정"**.
- **Party gate manager** — **right-click** a party row in the left sidebar → **"메시지 검문 설정"**.
- **New-party flow** — click the accent **`+`** next to the "새 파티 이름…" input.
- **Transcript badges** — visible inline in the transcripts of `backend` (Forced), `frontend` (Rejected), `tester` (Review failed).
- **Gate defaults** — open `Settings.dc.html`, go to the **런타임(Runtime)** page → **"Message Gate"** section.

## Fidelity
**High-fidelity.** Colors, typography, spacing, copy, and interactions are final. Recreate faithfully, then adapt to real window resizing (the prototype is a fixed 1440×900 canvas). Default theme is **light** (a dark theme exists via the same tokens / theme toggle).

---

## Design Tokens (additions)
The feature uses the existing AgentParty token set. Two tokens were **added** to the Workbench `:root` (they already existed in Settings) — reproduce them in your theme system if missing:

```
Dark:   --live-bd:rgba(224,161,78,.34)   --success-bd:rgba(84,181,133,.34)   --danger-bd:rgba(224,99,93,.34)
Light:  --live-bd:rgba(185,121,29,.3)     --success-bd:rgba(47,143,94,.3)      --danger-bd:rgba(207,75,69,.3)
```

Semantic color usage in this feature:
- **`--accent`** (blue): the Message Gate feature identity — section headers, icon, mode-segment "on" states, primary buttons.
- **`--live`** (amber): caution — **Rejected** badge, empty-rules warning, "Overridden" badge.
- **`--danger`** (red): error — **Review failed** badge.
- **`--success`** (green): "심사함 (reviewing)" status chips.
- Neutrals (`--text-*`, `--bg-*`, `--border*`) exactly as elsewhere.

**Icon (feature mark):** a rounded **speech-bubble with a checkmark** (message-review), used everywhere Message Gate appears. Distinct from the Guardian **shield**. Inline SVG (stroke 1.7), path:
```
M21 11.5a8.4 8.4 0 0 1-1 4 8.5 8.5 0 0 1-7.6 4.5 8.4 8.4 0 0 1-4-1L3 20l1-3.4a8.4 8.4 0 0 1-1-4 8.5 8.5 0 0 1 4.5-7.6 8.4 8.4 0 0 1 4-1h.5a8.5 8.5 0 0 1 8 8v.5Z   +   m8.5 11.5 2 2 4-4
```

**Copy convention (unchanged from the app):** control **labels in English**, **hints/descriptions in Korean**, icons from lucide.

**Typography:** Geist (sans) / Geist Mono (mono — model names, effort, labels). Section headers: 11px/700, uppercase, letter-spacing .5–.6px, `--text-3`. Body 11.5–13.5px. Same as the rest of the app.

---

## Reviewer model (headless — IMPORTANT)
The reviewer is configured by **model + effort only**. **Do not add a harness selector** anywhere in Message Gate — it runs headless. The model catalog is the same 6-model catalog used by the Runtime modal (see base Workbench handoff): `claude-opus-4.1, claude-sonnet-4.5, claude-haiku-4, gpt-5, o4-mini, deepseek-v3.2`, grouped by provider (Anthropic / OpenAI / OpenRouter). Effort options come from each model's own `efforts` list.

Recommended default reviewer: **`claude-haiku-4` · low** (cheap + fast — the gate runs on every message).

---

## Screens / Views

### 1) Member Message Gate editor (modal)
**Entry point:** panel tab toolbar **⋯** overflow menu → **"Message Gate 설정"** (new menu item, placed between "세션 재시작" and "MCP 서버"; accent message-check icon). It is a **separate modal from Runtime** — the composer's permission pill and the toolbar model pill still open the **Runtime** modal unchanged; Message Gate no longer lives inside Runtime.

**Modal:** centered over a 50% scrim (`rgba(0,0,0,.5)`, 28px padding); width **560px**; `--bg-2`, border `--border-strong`, radius 14px, shadow `0 32px 72px -20px rgba(0,0,0,.8)`. Column: header / scrolling body / footer. Click-scrim or Cancel closes; changes are **staged** and written on **Apply**.

- **Header** (15/18/14 padding, bottom border `--border-subtle`): message-check icon (`--accent`) + "Message Gate" (13.5px/600) + mono target line `● {memberName} · 배달 직전 심사` (member channel-color dot) + flex spacer + **"Overridden" badge** (only when rules are overridden: `--live-dim` bg, `--live` text, 10px/700, pencil icon) + close ✕.

- **On/off 3-state segment** — one rounded container (`--bg-input`, border `--border`, radius 9px, 4px padding, 4px gap); three equal buttons (h 34px, radius 7px): **Inherit / On / Off**. Selected state: Inherit/On use `--accent-dim` bg + `--accent-bd` border + `--accent` text; Off uses `--bg-4` bg + `--border-strong` border + `--text-1` text; unselected are transparent/`--text-2`. When **Inherit** is selected, a caption below reads: `파티 기본값을 따릅니다 · 현재 <On|Off>` (the effective party value, "On"/"Off" in accent).

- **통신 규칙 (rules) block** (`--bg-1`, border `--border-subtle`, radius 10px, 13/14 padding, 9px gap):
  - Header row: "통신 규칙" (12.5px/600) + hint "리뷰어가 이 규칙으로 심사합니다" (`--text-3`) + spacer + **"전역 규칙으로 되돌리기"** button (only when overridden — h24, border `--border`, redo icon; resets text to the party global rule and clears the override).
  - **Textarea** (4 rows, `--bg-input`, border `--border`, radius 8px, 12px/1.6, resize none). **Prefilled with the party global rules** when not overridden; **typing anything that differs from the global rules flips the member into "overridden"** (shows the badge + reset button). Reset restores the global text and clears the override.
  - **Empty-rules warning** (`--live` box, shown when the gate is *effectively on* AND the text is blank): "규칙이 비어 있어 **심사가 실행되지 않습니다**. 게이트는 켜져 있지만 모든 메시지가 그대로 배달됩니다."
  - **Off note** (`--text-3`, shown when effectively off): "게이트가 꺼져 있어 이 멤버의 메시지는 심사 없이 배달됩니다."

- **리뷰어 모델 (reviewer) block** (`--bg-1`, border `--border-subtle`, radius 10px):
  - Toggle row: "리뷰어 모델 지정" (13px/600) + hint "끄면 설정 → Runtime의 게이트 기본 모델을 사용합니다." + switch (36×21 track; on = `--accent`).
  - **Off (unset):** a dashed-border info chip: "설정 기본값 사용 · `{defaultModel · effort}`" (mono).
  - **On (set):** a **model picker button** (full width, h40, `--bg-input`) showing the chosen **model name (mono)** + a chevron — **no harness chip**. Clicking opens a **popover** (absolute, below the button, max-height 236px, scroll) with the same **provider-grouped model list** as Runtime: each provider has a colored dot + uppercase label; each model row shows the **mono model name** + a sub-line of just the **tier** (Frontier/Fast/Balanced — **no harness**) + a check on the selected one. Below the button, an **Effort** segmented control (options from the selected model's `efforts`), same styling as Runtime's effort control (mono labels, h30).

- **Footer** (space-between, top border, `--bg-1`): staged-changes note on the left — clock icon + "변경됨 — Apply 시 적용됩니다" in `--live` when dirty, else "변경 사항 없음" in `--text-3`; **Cancel** (ghost) + **Apply** (accent) on the right.

### 2) Party global gate manager (modal)
**Entry point:** **right-click** a party row in the sidebar → a small **context menu** appears (anchored under the row, 198px, one item) → **"메시지 검문 설정"** (accent message-check icon). Selecting it sets that party active and opens the manager.

**Modal:** width **720px**, same chrome as above. Header: message-check icon + "Message Gate" + mono "파티 전역 · {partyName}" + spacer + a **status chip** ("`{n} / {total}명 심사 중`", green check icon, `--bg-3`) + close ✕.

- **Global default block** (`--bg-1`, radius 10px):
  - Toggle row with a 34×34 accent icon tile: "파티 메시지 검문 기본값" (13.5px/600) + hint "Inherit 상태인 멤버는 이 값을 따릅니다. 멤버가 On/Off로 직접 재정의할 수 있어요." + 38×22 switch (on = `--accent`).
  - When on: "통신 규칙 · 전역" textarea (edits the party global rules — live) + info line "리뷰어 기본 모델 `{model · effort}` · 설정 → Runtime에서 변경".

- **Member overview** — label row "멤버별 상태" + mono hint "Inherit / On / Off · 즉시 적용", then **one row per party member** (`--bg-1`, border `--border-subtle`, radius 9px, 10/12 padding):
  - channel-color dot + member name (88px fixed).
  - **Inline 3-state segment** (Inherit / On / Off, 54px × 26px buttons; selected Inherit/On = `--accent-dim`/`--accent`, Off = `--bg-4`/`--text-1`) — changes that member's mode **immediately** (not staged).
  - **Status chip**: "심사함" (`--success-dim`/`--success`) when the member's gate is effectively on, else "심사 안 함" (`--bg-3`/`--text-3`).
  - Right-aligned meta (mono): **rules source** — "오버라이드" (`--live`) or "전역 규칙" (`--text-2`); and **reviewer** — the member's specific model, or "기본값 · `{defaultModel}`" (`--text-3`). **No harness shown.**
  - **"편집"** button → opens the member editor modal (#1) for that member.
- **Footer:** "완료" (accent).

Effective-on logic (used for the chip and the header count): `mode === 'on' || (mode === 'inherit' && partyGate.on)`.

### 3) New-party creation flow
**Entry point:** accent **`+`** button beside the "새 파티 이름…" input opens a **480px modal**.
- Party name input.
- **"메시지 검문 사용"** block (`--bg-1`, radius 10px) — 34×34 accent icon tile + "메시지 검문 사용" + hint "멤버 간 메시지를 배달 직전 리뷰어가 심사합니다. 기본은 꺼짐." + switch. **Default off.**
- When toggled on, a **"통신 규칙 · 파티 전역" textarea** expands (prefilled with a starter rule set), plus an info line: "리뷰어는 설정 → Runtime의 게이트 기본 모델(claude-haiku-4)을 사용합니다. 멤버별로 재정의할 수 있어요." (**no harness**).
- Footer: Cancel + "파티 만들기" (accent; disabled/greyed until a name is entered).

### 4) Transcript result badges (inline, 3 types)
Inline chips in a member's transcript, minimally disruptive. Card = 1px border in the tone `-bd`, tone `-dim` background, radius 8px, 8/10 padding, column, 6px gap.
- **Header row:** tone-colored type icon (14px) + **label** (11px/700, tone color) + mono **route** "`{sender} → {target}`" (`--text-2`) + spacer + **pass-note** (10px/600, tone color) + a **caret expand button**.
- **Reason line:** 11.5px/1.55, `--text-1`; **clamped to 2 lines** collapsed (`-webkit-line-clamp:2`), full when expanded (handles long reasons).
- **Expanded extra:** a mono meta chip (`--bg-2`) with the violated rule ("위반 규칙 · …") or error code ("오류 · …").

The three types:
| Type | Label | Tone | Pass-note | Icon meaning |
|---|---|---|---|---|
| **Rejected** (반려) | 반려됨 | `--live` (amber, caution) | 전달 안 됨 · 재작성 필요 | u-turn / return arrow |
| **Forced** (강제 전송) | 강제 전송 | `--accent` (blue, noticeable) | 우회하여 전달됨 | double-fast-forward |
| **Review failed** (fail-open) | 리뷰 실패 | `--danger` (red, error) | 심사 없이 전달됨 | alert-triangle |

### 5) Settings → Runtime: Message Gate defaults
A new **"Message Gate"** `<section>` on the Runtime settings page (same card style as the neighboring "기본 하네스" / "Auto-compact" sections; placed right after "기본 하네스"). Contents:
- Uppercase section header "Message Gate" + mono "메시지 검문 · 리뷰어 기본값".
- Info panel (accent icon tile): explains the reviewer default is used by any gate-on member that hasn't set its own reviewer; recommends "**저렴하고 빠른 모델(Haiku)**".
- **Two dropdown controls** in a wrapping row (reusing the app's `__ctrl` dropdown component): **리뷰어 모델** (with a green "권장" badge when the value is the recommended `claude-haiku-4`) and **리뷰어 effort**. **There is NO harness control** — headless. Model options: `claude-haiku-4, claude-sonnet-4.5, o4-mini, gpt-5, deepseek-v3.2`; effort: `low, medium, high`.

---

## Interactions & Behavior
- **Inherit / On / Off** mode segment: member-level 3-state. "Inherit" pulls the party global on/off + rules; On/Off override just the enablement.
- **Override detection:** editing the member rules textarea to differ from the party global text flips the member to "overridden" (badge + reset). "전역 규칙으로 되돌리기" clears the override and re-inherits.
- **Reviewer set/unset:** unset → uses Settings default (model+effort); set → member picks its own model+effort (headless, no harness).
- **Empty rules while on** → "심사 미실행" warning (gate on but nothing to enforce → messages pass).
- **Member editor** stages changes; **Apply** writes; **Cancel**/scrim discards. **Party manager** inline mode toggles apply immediately; global rule textarea edits apply live.
- **Fail-open:** reviewer error/timeout ⇒ deliver unreviewed + "Review failed" badge.
- Motion: toggle knobs / carets ~.15s; modal scrim standard. No custom animation beyond existing app conventions.
- Menus/popovers close on outside click (full-screen invisible catcher behind them).

## State Management (shape used in the prototype)
Recreate with your store; suggested shapes:
```
partyGate: { on: boolean, rules: string }          // party-wide global default
gateReviewerDefault: { model: string, effort: string }   // from Settings → Runtime (NO harness)
gateOverride: {                                     // per member; absent = { mode:'inherit', rules:null, reviewer:null }
  [memberId]: {
    mode: 'inherit' | 'on' | 'off',
    rules: string | null,                           // null = inherit party rules
    reviewer: { model, effort } | null              // null = use gateReviewerDefault (NO harness)
  }
}
gateEdit: { open, target, mode, text, overridden, reviewerSet, reviewer, pickerOpen, staged }  // member modal (staged)
partyGateEdit: { open }                             // party manager modal
partyCtx: partyId | null                            // which party's right-click menu is open
newParty: { open, name, gateOn, rules }             // new-party modal
```
Transcript gate badge block shape:
```
{ kind:'gate', gate:'rejected'|'forced'|'failed', to:'<memberName>', time, reason:'<string>',
  rule?:'<violated rule>',        // rejected/forced
  errcode?:'<code>' }             // failed
```
Effective-on: `mode==='on' || (mode==='inherit' && partyGate.on)`.

Triggers: ⋯ menu "Message Gate 설정" → open member editor seeded from `gateOverride[id]` + `partyGate`; Apply → write `gateOverride[id]`. Party row right-click → context menu → open party manager. Inline member segment in manager → write `gateOverride[id].mode` immediately. New-party create → seed the new party's `partyGate` from the modal.

## Assets
No raster assets. All icons are inline stroke SVG (1.7–1.9 width) — reuse your lucide/equivalent set: message-square-check (feature mark), pencil (overridden), redo/undo (reset & rejected), fast-forward (forced), alert-triangle (failed & warnings), shield-check reused only by the unrelated Guardian, chevrons, check, close, info. Fonts: Geist + Geist Mono (bundle locally for Electron).

## Files in this bundle
- `Workbench Multi.dc.html` — Workbench with the member editor modal, party manager modal, party right-click menu, new-party modal, and the 3 transcript badges. (Primary reference.)
- `Settings.dc.html` — Settings → Runtime with the Message Gate defaults section.
- `support.js` — prototype runtime, needed only to open the `.dc.html` files; **do not port.**

For overall Workbench/Settings layout, tokens, member colors, and the Runtime modal (which Message Gate deliberately sits beside, not inside), see the sibling `design_handoff_workbench` bundle.
