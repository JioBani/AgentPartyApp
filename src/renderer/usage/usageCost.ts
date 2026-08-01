/**
 * Model encoding + cost FORMATTING helpers for the Token Usage dashboard (new
 * handoff: cost-first, model×effort encoded by color-tint + fill-height). Pure,
 * so the encoding rules live in one testable place.
 *
 * Cost itself is computed in ONE place — `estimatedTurnCostUsd` in
 * src/shared/tokenUsage.ts. This module used to carry a second copy of that
 * arithmetic; two copies means the next fix lands in one of them, which is the
 * exact trap that let unpriceable turns be summed as $0 here.
 */

/** Model family → identity color for the transposed table's cell tint (design §토큰). */
const MODEL_COLOR: Record<string, string> = {
  opus: "#6d5ae6",
  sonnet: "#2f9e8f",
  haiku: "#8b8f99",
  "gpt-5": "#c98a3a",
  "gpt-5-mini": "#d8b06a",
  fable: "#c25b8f",
};

/** Unidentified model: a neutral that is NOT any family's identity colour (and
 *  deliberately lighter than haiku's grey, so the two do not read alike). */
const UNKNOWN_COLOR = "#b0b5be";

/**
 * Coarse model family from any catalog id/alias (e.g. `gpt-5.4-mini` →
 * `gpt-5-mini`), or `undefined` when the id matches none of them.
 *
 * It must NOT guess. This used to fall through to "sonnet", which made an
 * uncatalogued model render as `sonnet medium` in the dashboard with sonnet's
 * colour and tier — the user would be reading the identity of a model they
 * never ran. A fabricated identity is worse than a fabricated number.
 */
export function modelFamily(model: string | undefined): string | undefined {
  const m = (model || "").toLowerCase();
  if (!m) return undefined;
  if (m.includes("opus")) return "opus";
  if (m.includes("haiku")) return "haiku";
  if (m.includes("fable")) return "fable";
  if (m.includes("mini")) return "gpt-5-mini";
  if (m.includes("gpt")) return "gpt-5";
  if (m.includes("sonnet")) return "sonnet";
  return undefined;
}

/** Identity colour, or the neutral when the family is unknown. */
export function modelColor(model: string | undefined): string {
  const fam = modelFamily(model);
  return (fam && MODEL_COLOR[fam]) || UNKNOWN_COLOR;
}

/**
 * Short display label (family, since effort is shown separately). For an
 * unrecognized id the RAW id is shown — it is the one true thing known about
 * the model — and a missing id says so instead of naming a family.
 */
export function modelLabel(model: string | undefined): string {
  return modelFamily(model) || model?.trim() || "모델 미상";
}

/** Capability tier 1–3 (haiku/mini=1, sonnet=2, opus/gpt-5=3), or undefined. */
export function modelTier(model: string | undefined): number | undefined {
  const fam = modelFamily(model);
  if (!fam) return undefined;
  if (fam === "opus" || fam === "gpt-5") return 3;
  if (fam === "sonnet") return 2;
  return 1;
}

/** ▰▱ capability bars, or "—" when the model's tier is not known. */
export function tierBars(model: string | undefined): string {
  const t = modelTier(model);
  if (t === undefined) return "—";
  return "▰".repeat(t) + "▱".repeat(3 - t);
}

/** effort → mini-bar fill height (% of cell) — the design's EFF_H. */
const EFF_H: Record<string, number> = { min: 22, low: 40, med: 60, medium: 60, high: 80, max: 100 };
export function effortHeight(effort: string | undefined): number {
  return EFF_H[(effort || "med").toLowerCase()] ?? 60;
}

/** effort → density (% of member color) for the model·effort timeline rane. */
const EFF_MIX: Record<string, number> = { min: 38, low: 52, med: 66, medium: 66, high: 82, max: 100 };
export function effortMix(color: string, effort: string | undefined): string {
  const pct = EFF_MIX[(effort || "med").toLowerCase()] ?? 66;
  return `color-mix(in srgb, ${color} ${pct}%, var(--bg-2))`;
}

/** Cell background = model color at 30% over the card bg (theme-adaptive). */
export function cellTint(model: string | undefined): string {
  return `color-mix(in srgb, ${modelColor(model)} 30%, var(--bg-2))`;
}

/** `≈$` cost, precision scaled to magnitude (design fmtCost). */
export function fmtCost(v: number | undefined, prefix = "≈$"): string {
  if (v === undefined || !Number.isFinite(v)) return "—";
  const n = v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v >= 1 ? v.toFixed(2) : v.toFixed(3);
  return prefix + n;
}

/** Money axis tick (`$12` / `$1.5` / `$0.20`). */
export function fmtMoneyAxis(v: number): string {
  if (v >= 10) return "$" + v.toFixed(0);
  if (v >= 1) return "$" + v.toFixed(1);
  return "$" + v.toFixed(2);
}
