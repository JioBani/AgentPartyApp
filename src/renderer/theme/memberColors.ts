/**
 * Member channel colors — each member owns one fixed color used everywhere it
 * appears (sidebar dot, tab dot, panel focus border, assistant avatar, badges).
 *
 * Known roles from the design handoff keep their assigned colors; any other
 * member name is mapped deterministically onto the same palette so a member's
 * color is stable across reloads without per-member persistence.
 */

const NAMED_COLORS: Record<string, string> = {
  backend: "#5b8cff", // blue
  frontend: "#a07bff", // violet
  reviewer: "#54b585", // green
  tester: "#e0a14e", // amber
  "db-migrate": "#3ac6d6", // cyan
  docs: "#e06b9c", // pink
  main: "#5b8cff",
};

/** Palette used for members without a named color (cycled deterministically). */
const PALETTE = ["#5b8cff", "#a07bff", "#54b585", "#e0a14e", "#3ac6d6", "#e06b9c"];

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export function memberColor(name: string): string {
  const key = name.trim().toLowerCase();
  if (NAMED_COLORS[key]) {
    return NAMED_COLORS[key];
  }
  return PALETTE[hashString(key) % PALETTE.length];
}

/** Returns an `rgba()` tint of a hex color (the prototype's `hexA` helper). */
export function hexA(hex: string, alpha: number): string {
  const normalized = hex.replace("#", "");
  const value = normalized.length === 3
    ? normalized.split("").map((char) => char + char).join("")
    : normalized;
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * CSS custom properties scoping a member's color to a subtree. Components read
 * `var(--member)` and its tints instead of hard-coding the hex, so the same
 * markup themes itself to whichever member owns it.
 */
export function memberColorVars(name: string): React.CSSProperties {
  const color = memberColor(name);
  return {
    ["--member" as string]: color,
    ["--member-dim" as string]: hexA(color, 0.13),
    ["--member-soft" as string]: hexA(color, 0.08),
    ["--member-bd" as string]: hexA(color, 0.42),
    ["--member-focus" as string]: hexA(color, 0.5),
    ["--member-ring" as string]: hexA(color, 0.12),
  } as React.CSSProperties;
}
