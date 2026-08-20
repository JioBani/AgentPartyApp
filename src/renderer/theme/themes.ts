import { APPLIED_THEME_BACKGROUNDS } from "../../shared/appTheme";

/**
 * Theme registry — single source of truth for every themable design token.
 *
 * Adding a new theme is intentionally one step: append a `Theme` object to
 * `THEMES`. Everything else (CSS variable injection, the theme switcher list,
 * persistence) is derived from this array, so themes stay extensible without
 * touching component code.
 *
 * Tokens are grouped into `color` and `shape`. Shape tokens (border widths,
 * radii, focus ring) are themable on purpose: a theme can round corners,
 * thicken borders, or flatten the UI without any component change.
 */

export type ThemeColorToken =
  | "bg-0" | "bg-1" | "bg-2" | "bg-3" | "bg-4" | "bg-input"
  | "border-subtle" | "border" | "border-strong"
  | "text-0" | "text-1" | "text-2" | "text-3"
  | "accent" | "accent-dim" | "accent-bd" | "accent-fg"
  | "live" | "live-dim" | "live-bd"
  | "compact-zone"
  | "success" | "success-dim" | "success-bd"
  | "danger" | "danger-dim" | "danger-bd"
  | "warning" | "warning-dim" | "warning-bd"
  | "grid"
  | "scrim"
  /**
   * Drop-shadow colour for raised surfaces (menus, popovers, modals, toasts).
   *
   * Themable because a shadow is NOT theme-neutral. Every popover used to
   * hard-code `rgba(0,0,0,…)`: invisible over a dark background, but a hard
   * grey-black edge over a light one — which is what a light-theme context menu
   * reads as, since its surface is the same colour as the page behind it.
   * `shadow` is everyday elevation; `shadow-strong` is for surfaces that float
   * above everything (command palette, modals).
   */
  | "shadow" | "shadow-strong";

export type ThemeShapeToken =
  | "radius-window" | "radius-panel" | "radius-card" | "radius-button"
  | "radius-input" | "radius-pill" | "radius-badge"
  | "border-width" | "focus-ring-width";

export interface Theme {
  id: string;
  label: string;
  /** Drives the native `color-scheme` so form controls/scrollbars match. */
  scheme: "light" | "dark";
  color: Record<ThemeColorToken, string>;
  shape: Record<ThemeShapeToken, string>;
}

/** Shape tokens shared by the built-in themes (override per theme as needed). */
const baseShape: Record<ThemeShapeToken, string> = {
  "radius-window": "9px",
  "radius-panel": "11px",
  "radius-card": "10px",
  "radius-button": "7px",
  "radius-input": "8px",
  "radius-pill": "6px",
  "radius-badge": "5px",
  "border-width": "1px",
  "focus-ring-width": "1px",
};

const light: Theme = {
  id: "light",
  label: "Light",
  scheme: "light",
  color: {
    "bg-0": APPLIED_THEME_BACKGROUNDS.light,
    "bg-1": "#f3f4f6",
    "bg-2": "#ffffff",
    "bg-3": "#eef0f3",
    "bg-4": "#e6e9ed",
    "bg-input": "#ffffff",
    "border-subtle": "#e2e5ea",
    "border": "#d3d7df",
    "border-strong": "#c0c5ce",
    "text-0": "#171a1f",
    "text-1": "#454b56",
    "text-2": "#6c7480",
    "text-3": "#9aa1ac",
    "accent": "#3f6fe6",
    "accent-dim": "rgba(63,111,230,.1)",
    "accent-bd": "rgba(63,111,230,.28)",
    "accent-fg": "#ffffff",
    "live": "#b9791d",
    "live-dim": "rgba(185,121,29,.13)",
    "live-bd": "rgba(185,121,29,.3)",
    // The donut's "compaction zone" arc (threshold → full). Warmer/denser than
    // live-dim so the runway-before-compact reads at 18px. See ContextDonut.
    "compact-zone": "rgba(185,121,29,.26)",
    "success": "#2f8f5e",
    "success-dim": "rgba(47,143,94,.13)",
    "success-bd": "rgba(47,143,94,.28)",
    "danger": "#cf4b45",
    "danger-dim": "rgba(207,75,69,.13)",
    "danger-bd": "rgba(207,75,69,.3)",
    // Caution that is not failure (a stalled member, a warning diagnostic). The
    // codebase already drew this distinction in markup (`is-warning` vs
    // `is-error`) while painting it from a literal, so it could never be themed.
    "warning": "#b07816",
    "warning-dim": "rgba(176,120,22,.13)",
    "warning-bd": "rgba(176,120,22,.3)",
    // Chart gridlines — faint, tuned per theme so the Token Usage charts read on
    // both backgrounds without competing with data marks.
    "grid": "rgba(20,25,35,.07)",
    "scrim": "rgba(20,23,29,.42)",
    // Cool-tinted and far lighter than the dark theme's: on a near-white page a
    // neutral-black shadow reads as a dirty outline rather than depth.
    "shadow": "rgba(20,23,29,.13)",
    "shadow-strong": "rgba(20,23,29,.2)",
  },
  shape: baseShape,
};

const dark: Theme = {
  id: "dark",
  label: "Dark",
  scheme: "dark",
  color: {
    "bg-0": APPLIED_THEME_BACKGROUNDS.dark,
    "bg-1": "#0e1014",
    "bg-2": "#14171d",
    "bg-3": "#1b1f27",
    "bg-4": "#222731",
    "bg-input": "#0c0e12",
    "border-subtle": "#1c2028",
    "border": "#262b35",
    "border-strong": "#333a46",
    "text-0": "#e7e9ee",
    "text-1": "#aeb4c0",
    "text-2": "#79808d",
    "text-3": "#535965",
    "accent": "#5b8cff",
    "accent-dim": "rgba(91,140,255,.13)",
    "accent-bd": "rgba(91,140,255,.32)",
    "accent-fg": "#ffffff",
    "live": "#e0a14e",
    "live-dim": "rgba(224,161,78,.13)",
    "live-bd": "rgba(224,161,78,.34)",
    "compact-zone": "rgba(224,161,78,.32)",
    "success": "#54b585",
    "success-dim": "rgba(84,181,133,.13)",
    "success-bd": "rgba(84,181,133,.32)",
    "danger": "#e0635d",
    "danger-dim": "rgba(224,99,93,.13)",
    "danger-bd": "rgba(224,99,93,.34)",
    "warning": "#d9a441",
    "warning-dim": "rgba(217,164,65,.16)",
    "warning-bd": "rgba(217,164,65,.34)",
    "grid": "rgba(255,255,255,.06)",
    "scrim": "rgba(0,0,0,.5)",
    // Unchanged from the literals these replace — on a near-black background a
    // neutral-black shadow is correct, so the dark theme keeps its exact look.
    "shadow": "rgba(0,0,0,.4)",
    "shadow-strong": "rgba(0,0,0,.6)",
  },
  shape: baseShape,
};

/** Ordered registry. The first entry is the default theme. */
export const THEMES: Theme[] = [light, dark];

export const DEFAULT_THEME_ID = THEMES[0].id;

export function getTheme(id: string): Theme {
  return THEMES.find((theme) => theme.id === id) || THEMES[0];
}

/**
 * Type, motion and control size — theme-independent, so it is emitted once on
 * bare `:root` rather than per theme.
 *
 * ⚠️ The design project's `foundations/tokens.css` is generated FROM this file
 * and already publishes this scale; the app was the side missing it, which made
 * every `var(--font-*)` in guide.css resolve to nothing. Keep the two equal.
 */
const SCALE: Record<string, string> = {
  "font-micro": "9.5px",
  "font-meta": "10px",
  "font-caption": "10.5px",
  "font-body-sm": "11px",
  "font-body": "11.5px",
  "font-ui": "12px",
  "font-ui-lg": "12.5px",
  "font-title": "13px",
  "font-heading": "14px",
  "font-display": "15px",
  "weight-regular": "400",
  "weight-medium": "500",
  "weight-semibold": "600",
  "weight-bold": "700",
  "motion-fast": "0.12s",
  "motion-base": "0.15s",
  "motion-slow": "0.3s",
  "motion-pulse": "1.6s",
  "motion-sweep": "1.2s",
  "control-height": "30px",
  "control-height-sm": "26px",
  "row-height": "38px",
  "tab-height": "37px",
  "bar-height": "40px",
  "dot-size": "7px",
  "touch-target-min": "44px",
};

/** Builds the `--token: value` declaration block for one theme. */
function declarations(theme: Theme): string {
  const lines: string[] = [`color-scheme: ${theme.scheme};`];
  for (const [token, value] of Object.entries(theme.color)) {
    lines.push(`--${token}: ${value};`);
  }
  for (const [token, value] of Object.entries(theme.shape)) {
    lines.push(`--${token}: ${value};`);
  }
  return lines.join("\n  ");
}

/**
 * Generates the full stylesheet for every registered theme, keyed by
 * `:root[data-theme="<id>"]`. The default theme is also emitted on bare
 * `:root` so first paint is themed before any attribute is set (no FOUC).
 */
export function buildThemeStylesheet(): string {
  const blocks = THEMES.map((theme) => `:root[data-theme="${theme.id}"] {\n  ${declarations(theme)}\n}`);
  blocks.unshift(`:root {\n  ${declarations(getTheme(DEFAULT_THEME_ID))}\n}`);
  const scale = Object.entries(SCALE)
    .map(([token, value]) => `--${token}: ${value};`)
    .join("\n  ");
  blocks.unshift(`:root {\n  ${scale}\n}`);
  return blocks.join("\n\n");
}
