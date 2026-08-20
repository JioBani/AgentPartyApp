# AgentParty Design System

AgentParty's UI is token-driven and **multi-theme**. Themes are the single
source of truth for every visual value — colors *and* shape (borders, radii,
focus ring). Components never hard-code a color or radius; they read a CSS
custom property that a theme supplies.

## Where things live

| Concern | File |
| --- | --- |
| Preset id/label/scheme/native `bg-0` metadata | `src/shared/appTheme.ts` |
| Remaining theme token values (per theme) | `src/renderer/theme/themes.ts` |
| Theme application + persistence + switcher | `src/renderer/theme/ThemeProvider.tsx`, `src/shared/appTheme.ts` |
| Member identity colors + tints | `src/renderer/theme/memberColors.ts` |
| Non-themed primitives (fonts, spacing, type ramp, resets) | `src/renderer/design-system.css` |
| Component styling (all `var(--token)`) | `src/renderer/styles.css` |

## Theming model

- `appTheme.ts` exports the ordered `THEME_METADATA`; `themes.ts` consumes that
  shared id/label/scheme/background source and adds each preset's remaining
  `color` map plus the shared `shape` map.
- First paint is owned by main. `createWindow` resolves the preset from
  settings.json, sets `BrowserWindow.backgroundColor` from the
  shared `bg-0` token (`THEME_BACKGROUNDS` in `appTheme.ts`, also used by
  `themes.ts`), and injects that boot payload via preload
  (`window.agentPartyAppearanceBoot`) **before** the page loads. The shared
  `theme/firstPaint.ts` module runs before React and is also used by
  `ThemeProvider`. `localStorage` is only an upgrade source when
  settings.json has no `theme`. `html[data-theme-paint=sync]` marks that path.
  Bare `:root` AgentParty Light tokens are a last-resort fallback, not the
  first-paint path.
- The user's preference is one of `agentparty-light`, `agentparty-dark`,
  `github-light`, `github-dark`, `dracula`, `nord`, or `solarized-dark`
  (`AppSettings.theme`, `src/shared/appTheme.ts`). AgentParty Light/Dark retain
  the exact original colour tokens from master `23dc88b`.
  The same id is painted on `<html data-theme>`. Settings → General → Appearance
  and the accessible titlebar menu share one AppController path. Legacy
  `light`/`dark` values migrate to the corresponding AgentParty preset, and
  settings always beat stale cache data.

### Add a new theme

1. Append its id/label/scheme/native background once to `THEME_METADATA` and
   `THEME_PREFERENCES` in `src/shared/appTheme.ts`.
2. Append its palette to `THEMES` in `themes.ts`, taking `bg-0`, label, and
   scheme from that metadata (TypeScript enforces all remaining tokens).
3. Add the preset to the contrast and real-Electron theme matrices.

Because borders and radii are tokens too, a theme can flatten corners, thicken
borders, or restyle focus rings without touching any component.

## Token groups

### Color tokens
`bg-0…bg-4`, `bg-input`, `border-subtle`, `border`, `border-strong`,
`text-0…text-3`, `accent`/`accent-dim`/`accent-bd`/`accent-fg`,
`selection`/`selection-fg`, `status`/`status-fg`,
`live`/`live-dim`, `success`/`success-dim`,
`danger`/`danger-dim`/`danger-fg`, `warning`/`warning-dim`/`warning-fg`, `scrim`.

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
- Do not place settings controls in the title bar; use the relevant Settings panel.

## QA

- `npm run test:layout` — pure panel/tab/DnD layout-engine assertions.
- `npm run test:render` — mounts the real renderer in jsdom with a mocked
  `window.agentParty` and asserts the Workbench paints (members, transcript,
  approval card, theme injection).
- `npm run test:ui` — both of the above.
- `npm run test:e2e` — full Electron automation smoke (requires a display).
