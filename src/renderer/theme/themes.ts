import { THEME_METADATA, type ThemePreference } from "../../shared/appTheme";

export type ThemeColorToken =
  | "bg-0" | "bg-1" | "bg-2" | "bg-3" | "bg-4" | "bg-input"
  | "border-subtle" | "border" | "border-strong"
  | "text-0" | "text-1" | "text-2" | "text-3"
  | "accent" | "accent-dim" | "accent-bd" | "accent-fg"
  | "selection" | "selection-fg" | "status" | "status-fg"
  | "live" | "live-dim" | "live-bd" | "compact-zone"
  | "success" | "success-dim" | "success-bd"
  | "danger" | "danger-dim" | "danger-bd" | "danger-fg"
  | "warning" | "warning-dim" | "warning-bd" | "warning-fg"
  | "grid" | "scrim" | "shadow" | "shadow-strong";

export type ThemeShapeToken =
  | "radius-window" | "radius-panel" | "radius-card" | "radius-button"
  | "radius-input" | "radius-pill" | "radius-badge"
  | "border-width" | "focus-ring-width";

export interface Theme {
  id: ThemePreference;
  label: string;
  scheme: "light" | "dark";
  color: Record<ThemeColorToken, string>;
  shape: Record<ThemeShapeToken, string>;
}

const shape: Record<ThemeShapeToken, string> = {
  "radius-window": "9px", "radius-panel": "11px", "radius-card": "10px",
  "radius-button": "7px", "radius-input": "8px", "radius-pill": "6px",
  "radius-badge": "5px", "border-width": "1px", "focus-ring-width": "2px",
};

const metadata = Object.fromEntries(THEME_METADATA.map((entry) => [entry.id, entry])) as Record<ThemePreference, (typeof THEME_METADATA)[number]>;

/** Exact colour values from the pre-feature registry at master 23dc88b. */
const agentPartyLight: Theme = {
  ...metadata["agentparty-light"], shape,
  color: {
    "bg-0": metadata["agentparty-light"].background, "bg-1": "#f3f4f6", "bg-2": "#ffffff", "bg-3": "#eef0f3", "bg-4": "#e6e9ed", "bg-input": "#ffffff",
    "border-subtle": "#e2e5ea", "border": "#d3d7df", "border-strong": "#c0c5ce",
    "text-0": "#171a1f", "text-1": "#454b56", "text-2": "#6c7480", "text-3": "#9aa1ac",
    "accent": "#3f6fe6", "accent-dim": "rgba(63,111,230,.1)", "accent-bd": "rgba(63,111,230,.28)", "accent-fg": "#ffffff",
    "selection": "#cbd8f8", "selection-fg": "#171a1f", "status": "#3f6fe6", "status-fg": "#ffffff",
    "live": "#b9791d", "live-dim": "rgba(185,121,29,.13)", "live-bd": "rgba(185,121,29,.3)", "compact-zone": "rgba(185,121,29,.26)",
    "success": "#2f8f5e", "success-dim": "rgba(47,143,94,.13)", "success-bd": "rgba(47,143,94,.28)",
    "danger": "#cf4b45", "danger-dim": "rgba(207,75,69,.13)", "danger-bd": "rgba(207,75,69,.3)", "danger-fg": "#000000",
    "warning": "#b07816", "warning-dim": "rgba(176,120,22,.13)", "warning-bd": "rgba(176,120,22,.3)", "warning-fg": "#000000",
    "grid": "rgba(20,25,35,.07)", "scrim": "rgba(20,23,29,.42)", "shadow": "rgba(20,23,29,.13)", "shadow-strong": "rgba(20,23,29,.2)",
  },
};

/** Exact colour values from the pre-feature registry at master 23dc88b. */
const agentPartyDark: Theme = {
  ...metadata["agentparty-dark"], shape,
  color: {
    "bg-0": metadata["agentparty-dark"].background, "bg-1": "#0e1014", "bg-2": "#14171d", "bg-3": "#1b1f27", "bg-4": "#222731", "bg-input": "#0c0e12",
    "border-subtle": "#1c2028", "border": "#262b35", "border-strong": "#333a46",
    "text-0": "#e7e9ee", "text-1": "#aeb4c0", "text-2": "#79808d", "text-3": "#535965",
    "accent": "#5b8cff", "accent-dim": "rgba(91,140,255,.13)", "accent-bd": "rgba(91,140,255,.32)", "accent-fg": "#ffffff",
    "selection": "#263b70", "selection-fg": "#e7e9ee", "status": "#5b8cff", "status-fg": "#0a0b0e",
    "live": "#e0a14e", "live-dim": "rgba(224,161,78,.13)", "live-bd": "rgba(224,161,78,.34)", "compact-zone": "rgba(224,161,78,.32)",
    "success": "#54b585", "success-dim": "rgba(84,181,133,.13)", "success-bd": "rgba(84,181,133,.32)",
    "danger": "#e0635d", "danger-dim": "rgba(224,99,93,.13)", "danger-bd": "rgba(224,99,93,.34)", "danger-fg": "#000000",
    "warning": "#d9a441", "warning-dim": "rgba(217,164,65,.16)", "warning-bd": "rgba(217,164,65,.34)", "warning-fg": "#000000",
    "grid": "rgba(255,255,255,.06)", "scrim": "rgba(0,0,0,.5)", "shadow": "rgba(0,0,0,.4)", "shadow-strong": "rgba(0,0,0,.6)",
  },
};

const githubLight: Theme = {
  ...metadata["github-light"], shape,
  color: {
    "bg-0": metadata["github-light"].background, "bg-1": "#ffffff", "bg-2": "#ffffff", "bg-3": "#f6f8fa", "bg-4": "#eaeef2", "bg-input": "#ffffff",
    "border-subtle": "#d8dee4", "border": "#d0d7de", "border-strong": "#afb8c1",
    "text-0": "#1f2328", "text-1": "#424a53", "text-2": "#59636e", "text-3": "#6e7781",
    "accent": "#0969da", "accent-dim": "rgba(9,105,218,.12)", "accent-bd": "rgba(9,105,218,.38)", "accent-fg": "#ffffff",
    "selection": "#b6d7ff", "selection-fg": "#1f2328", "status": "#0969da", "status-fg": "#ffffff",
    "live": "#9a6700", "live-dim": "rgba(154,103,0,.12)", "live-bd": "rgba(154,103,0,.32)", "compact-zone": "rgba(154,103,0,.25)",
    "success": "#1a7f37", "success-dim": "rgba(26,127,55,.12)", "success-bd": "rgba(26,127,55,.3)",
    "danger": "#cf222e", "danger-dim": "rgba(207,34,46,.11)", "danger-bd": "rgba(207,34,46,.3)", "danger-fg": "#ffffff",
    "warning": "#9a6700", "warning-dim": "rgba(154,103,0,.12)", "warning-bd": "rgba(154,103,0,.32)", "warning-fg": "#ffffff",
    "grid": "rgba(31,35,40,.08)", "scrim": "rgba(31,35,40,.45)", "shadow": "rgba(31,35,40,.14)", "shadow-strong": "rgba(31,35,40,.24)",
  },
};

const githubDark: Theme = {
  ...metadata["github-dark"], shape,
  color: {
    "bg-0": metadata["github-dark"].background, "bg-1": "#010409", "bg-2": "#161b22", "bg-3": "#21262d", "bg-4": "#30363d", "bg-input": "#0d1117",
    "border-subtle": "#21262d", "border": "#30363d", "border-strong": "#484f58",
    "text-0": "#f0f6fc", "text-1": "#c9d1d9", "text-2": "#8b949e", "text-3": "#7d8590",
    "accent": "#58a6ff", "accent-dim": "rgba(88,166,255,.14)", "accent-bd": "rgba(88,166,255,.42)", "accent-fg": "#0d1117",
    "selection": "#264f78", "selection-fg": "#ffffff", "status": "#1f6feb", "status-fg": "#ffffff",
    "live": "#d29922", "live-dim": "rgba(210,153,34,.14)", "live-bd": "rgba(210,153,34,.38)", "compact-zone": "rgba(210,153,34,.3)",
    "success": "#3fb950", "success-dim": "rgba(63,185,80,.14)", "success-bd": "rgba(63,185,80,.36)",
    "danger": "#f85149", "danger-dim": "rgba(248,81,73,.14)", "danger-bd": "rgba(248,81,73,.38)", "danger-fg": "#000000",
    "warning": "#d29922", "warning-dim": "rgba(210,153,34,.14)", "warning-bd": "rgba(210,153,34,.38)", "warning-fg": "#000000",
    "grid": "rgba(240,246,252,.07)", "scrim": "rgba(1,4,9,.68)", "shadow": "rgba(1,4,9,.5)", "shadow-strong": "rgba(1,4,9,.75)",
  },
};

const dracula: Theme = {
  ...metadata.dracula, shape,
  color: {
    "bg-0": metadata.dracula.background, "bg-1": "#21222c", "bg-2": "#30323f", "bg-3": "#383a47", "bg-4": "#44475a", "bg-input": "#21222c",
    "border-subtle": "#3b3d4d", "border": "#4b4e61", "border-strong": "#6272a4",
    "text-0": "#f8f8f2", "text-1": "#e2e2dc", "text-2": "#b9b9b2", "text-3": "#9b9ba5",
    "accent": "#bd93f9", "accent-dim": "rgba(189,147,249,.16)", "accent-bd": "rgba(189,147,249,.44)", "accent-fg": "#211a2b",
    "selection": "#44475a", "selection-fg": "#f8f8f2", "status": "#6272a4", "status-fg": "#ffffff",
    "live": "#f1fa8c", "live-dim": "rgba(241,250,140,.13)", "live-bd": "rgba(241,250,140,.35)", "compact-zone": "rgba(241,250,140,.28)",
    "success": "#50fa7b", "success-dim": "rgba(80,250,123,.13)", "success-bd": "rgba(80,250,123,.35)",
    "danger": "#ff5555", "danger-dim": "rgba(255,85,85,.14)", "danger-bd": "rgba(255,85,85,.38)", "danger-fg": "#000000",
    "warning": "#ffb86c", "warning-dim": "rgba(255,184,108,.14)", "warning-bd": "rgba(255,184,108,.38)", "warning-fg": "#000000",
    "grid": "rgba(248,248,242,.07)", "scrim": "rgba(20,21,27,.62)", "shadow": "rgba(12,12,16,.45)", "shadow-strong": "rgba(12,12,16,.7)",
  },
};

const nord: Theme = {
  ...metadata.nord, shape,
  color: {
    "bg-0": metadata.nord.background, "bg-1": "#272c36", "bg-2": "#3b4252", "bg-3": "#434c5e", "bg-4": "#4c566a", "bg-input": "#242933",
    "border-subtle": "#3b4252", "border": "#4c566a", "border-strong": "#616e88",
    "text-0": "#eceff4", "text-1": "#e5e9f0", "text-2": "#c2c8d2", "text-3": "#aeb8c8",
    "accent": "#88c0d0", "accent-dim": "rgba(136,192,208,.15)", "accent-bd": "rgba(136,192,208,.42)", "accent-fg": "#20252e",
    "selection": "#4c566a", "selection-fg": "#eceff4", "status": "#5e81ac", "status-fg": "#ffffff",
    "live": "#ebcb8b", "live-dim": "rgba(235,203,139,.14)", "live-bd": "rgba(235,203,139,.38)", "compact-zone": "rgba(235,203,139,.29)",
    "success": "#a3be8c", "success-dim": "rgba(163,190,140,.14)", "success-bd": "rgba(163,190,140,.36)",
    "danger": "#bf616a", "danger-dim": "rgba(191,97,106,.16)", "danger-bd": "rgba(191,97,106,.4)", "danger-fg": "#000000",
    "warning": "#d08770", "warning-dim": "rgba(208,135,112,.15)", "warning-bd": "rgba(208,135,112,.38)", "warning-fg": "#000000",
    "grid": "rgba(236,239,244,.07)", "scrim": "rgba(23,27,34,.64)", "shadow": "rgba(15,18,23,.45)", "shadow-strong": "rgba(15,18,23,.7)",
  },
};

const solarizedDark: Theme = {
  ...metadata["solarized-dark"], shape,
  color: {
    "bg-0": metadata["solarized-dark"].background, "bg-1": "#00212b", "bg-2": "#073642", "bg-3": "#0b4351", "bg-4": "#17515f", "bg-input": "#00212b",
    "border-subtle": "#0b4351", "border": "#1b5663", "border-strong": "#657b83",
    "text-0": "#fdf6e3", "text-1": "#eee8d5", "text-2": "#a8b5b5", "text-3": "#93a1a1",
    "accent": "#2aa198", "accent-dim": "rgba(42,161,152,.16)", "accent-bd": "rgba(42,161,152,.45)", "accent-fg": "#001f27",
    "selection": "#075b6b", "selection-fg": "#fdf6e3", "status": "#268bd2", "status-fg": "#ffffff",
    "live": "#b58900", "live-dim": "rgba(181,137,0,.15)", "live-bd": "rgba(181,137,0,.4)", "compact-zone": "rgba(181,137,0,.3)",
    "success": "#859900", "success-dim": "rgba(133,153,0,.15)", "success-bd": "rgba(133,153,0,.38)",
    "danger": "#dc322f", "danger-dim": "rgba(220,50,47,.15)", "danger-bd": "rgba(220,50,47,.4)", "danger-fg": "#ffffff",
    "warning": "#cb4b16", "warning-dim": "rgba(203,75,22,.15)", "warning-bd": "rgba(203,75,22,.4)", "warning-fg": "#ffffff",
    "grid": "rgba(238,232,213,.07)", "scrim": "rgba(0,25,31,.68)", "shadow": "rgba(0,18,23,.48)", "shadow-strong": "rgba(0,18,23,.72)",
  },
};

export const THEMES: Theme[] = [agentPartyLight, agentPartyDark, githubLight, githubDark, dracula, nord, solarizedDark];
export const DEFAULT_THEME_ID: ThemePreference = "agentparty-light";
export function getTheme(id: string): Theme { return THEMES.find((theme) => theme.id === id) || agentPartyLight; }

const SCALE: Record<string, string> = {
  "font-micro": "9.5px", "font-meta": "10px", "font-caption": "10.5px", "font-body-sm": "11px",
  "font-body": "11.5px", "font-ui": "12px", "font-ui-lg": "12.5px", "font-title": "13px",
  "font-heading": "14px", "font-display": "15px", "weight-regular": "400", "weight-medium": "500",
  "weight-semibold": "600", "weight-bold": "700", "motion-fast": "0.12s", "motion-base": "0.15s",
  "motion-slow": "0.3s", "motion-pulse": "1.6s", "motion-sweep": "1.2s", "control-height": "30px",
  "control-height-sm": "26px", "row-height": "38px", "tab-height": "37px", "bar-height": "40px",
  "dot-size": "7px", "touch-target-min": "44px",
};

function declarations(theme: Theme): string {
  return [`color-scheme: ${theme.scheme};`, ...Object.entries(theme.color).map(([key, value]) => `--${key}: ${value};`), ...Object.entries(theme.shape).map(([key, value]) => `--${key}: ${value};`)].join("\n  ");
}

export function buildThemeStylesheet(): string {
  const blocks = THEMES.map((theme) => `:root[data-theme="${theme.id}"] {\n  ${declarations(theme)}\n}`);
  blocks.unshift(`:root {\n  ${declarations(agentPartyLight)}\n}`);
  blocks.unshift(`:root {\n  ${Object.entries(SCALE).map(([key, value]) => `--${key}: ${value};`).join("\n  ")}\n}`);
  return blocks.join("\n\n");
}
