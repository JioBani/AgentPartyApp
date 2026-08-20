# AgentParty Design System

AgentParty's UI is token-driven and **multi-theme**. Themes are the single
source of truth for every visual value — colors *and* shape (borders, radii,
focus ring). Components never hard-code a color or radius; they read a CSS
custom property that a theme supplies.

## Where things live

| Concern | File |
| --- | --- |
| Theme token values (per theme) | `src/renderer/theme/themes.ts` |
| Theme application + persistence + switcher | `src/renderer/theme/ThemeProvider.tsx`, `src/shared/appTheme.ts` |
| Member identity colors + tints | `src/renderer/theme/memberColors.ts` |
| Non-themed primitives (fonts, spacing, type ramp, resets) | `src/renderer/design-system.css` |
| Component styling (all `var(--token)`) | `src/renderer/styles.css` |

## Theming model

- `themes.ts` exports a `THEMES` array. Each `Theme` has a `color` map and a
  `shape` map. The **first** entry is the default (currently `light`).
- First paint is owned by main. `createWindow` resolves preference+applied from
  settings.json and `nativeTheme`, sets `BrowserWindow.backgroundColor` from the
  shared `bg-0` token (`APPLIED_THEME_BACKGROUNDS` in `appTheme.ts`, also used by
  `themes.ts`), and injects that boot payload via preload
  (`window.agentPartyAppearanceBoot`) **before** the page loads. `index.html`
  and `ThemeProvider` prefer it. `localStorage` is only the true-legacy `dark`
  path when settings.json has no `theme`. `html[data-theme-paint=sync]` marks
  that path. Bare `:root` light tokens are a last-resort fallback, not the
  first-paint path.
- The user's preference is `system` | `light` | `dark` (`AppSettings.theme`,
  `src/shared/appTheme.ts`). The painted theme is still `data-theme="light|dark"`
  on `<html>`; `system` follows the OS via `prefers-color-scheme` (and Electron
  `nativeTheme`) and updates live. Settings → 모양 and the title-bar shortcut
  cycle the same three preferences. A leftover `localStorage` `agentparty.theme`
  of `dark` migrates only when settings.json has no explicit `theme` (`light` was
  the old first-paint default, not a choice).

### Add a new theme

1. Append a `Theme` object to `THEMES` in `themes.ts` (fill every `color` and
   `shape` token — TypeScript enforces completeness).
2. Done. The switcher, injection, and persistence pick it up automatically.

Because borders and radii are tokens too, a theme can flatten corners, thicken
borders, or restyle focus rings without touching any component.

## Token groups

### Color tokens
`bg-0…bg-4`, `bg-input`, `border-subtle`, `border`, `border-strong`,
`text-0…text-3`, `accent`/`accent-dim`/`accent-bd`/`accent-fg`,
`live`/`live-dim`, `success`/`success-dim`, `danger`/`danger-dim`, `scrim`.

### Shape tokens (themable)
`radius-window`, `radius-panel`, `radius-card`, `radius-button`, `radius-input`,
`radius-pill`, `radius-badge`, `border-width`, `focus-ring-width`.

### Member identity colors
Each member owns a fixed channel color used everywhere it appears (sidebar dot,
tab dot, panel focus border, assistant avatar, badges). Known roles keep their
assigned colors; other names map deterministically onto the palette. A member's
color is exposed to its subtree as `--member` plus tints (`--member-dim`,
`--member-soft`, `--member-bd`, `--member-focus`, `--member-ring`) via
`memberColorVars`.

### Non-themed primitives (`design-system.css`)
`--font-sans`, `--font-mono`, the `--space-*` scale, layout sizes
(`--titlebar-height`, `--navrail-width`, `--sidebar-width`), and shared shadows.

## Workbench UI

The Workbench is a VS Code-style split-panel + tab workspace
(`src/renderer/workbench/`):

- **A panel** is a watch slot you keep your eyes on; panels resize via the
  handle between them and can be split.
- **Tabs in one panel** are members that time-share that slot (one visible at a
  time); tabs can be dragged across panels, or dropped into empty space to
  create a new panel.
- Each panel computes its **own density** (`wide` / `mid` / `narrow`) from its
  rendered width via a `ResizeObserver`, collapsing controls independently of
  the window size.
- The **Runtime modal** (model pill) stages per-member model/effort/thinking/
  debug settings.

Layout (panels, tabs, weights, focus) persists per party in `localStorage`.

## Rules for new UI

- Use existing tokens before adding new ones; never hard-code a color or radius.
- Add a token to **every** theme in `themes.ts` (the type system enforces this).
- Add every new user-facing action to the automation API and `docs/API.md`
  (see `AGENTS.md`).
- Keep repeated items as rows/cards with the radius tokens.
- Do not place controls in the title bar except app/window-level actions
  (theme toggle, window controls).

## QA

- `npm run test:layout` — pure panel/tab/DnD layout-engine assertions.
- `npm run test:render` — mounts the real renderer in jsdom with a mocked
  `window.agentParty` and asserts the Workbench paints (members, transcript,
  approval card, theme injection).
- `npm run test:ui` — both of the above.
- `npm run test:e2e` — full Electron automation smoke (requires a display).
