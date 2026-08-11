import { ModelView, ProviderId, routeProvider } from "./modelCatalog";
import type { RouteLike } from "./routes";

/** A model route paired with its resolved catalog view (perf/cost/context/…). */
export interface RouteEntry {
  route: RouteLike;
  meta: ModelView;
}

export function perfLabel(value: number | undefined): string {
  if (value == null) {
    return "—";
  }
  return `${value} / 5`;
}

/**
 * Bar heights per size. FIVE bars, one per point of the 0–5 tier — the design
 * draws four, which cannot tell perf 4 from perf 5: both fill every bar and both
 * are green (the colour switches at 4, so it does not separate them either). The
 * detail panel prints "N / 5" beside its meter, but a catalog ROW does not, so
 * four bars would make the top two tiers indistinguishable exactly where the
 * user is comparing models. Everything else is the design's: bar width, gap, the
 * ramp step of 3px, and the 4+ colour switch.
 */
const PERF_BARS = {
  sm: [3, 6, 9, 12, 15],
  lg: [4.5, 7.5, 10.5, 13.5, 16.5],
} as const;

export function PerfMeter({ value, size = "sm" }: { value: number | undefined; size?: keyof typeof PERF_BARS }) {
  const v = value ?? 0;
  return (
    <span className={`wb-meter wb-perf is-${size}` + (v >= 4 ? " is-high" : "")} title={value == null ? "Performance n/a" : `Performance ${v}/5`}>
      {PERF_BARS[size].map((height, index) => (
        <i key={height} className={index + 1 <= v ? "is-on" : ""} style={{ height: `${height}px` }} />
      ))}
    </span>
  );
}

export function CostMeter({ value }: { value: number | undefined }) {
  const v = value ?? 0;
  return (
    <span className="wb-meter wb-cost wb-mono" title={value == null ? "Cost n/a" : `Cost ${v}/5`}>
      {[1, 2, 3, 4, 5].map((bar) => (
        <span key={bar} className={bar <= v ? "is-on" : "is-off"}>$</span>
      ))}
    </span>
  );
}

export function groupByProvider(entries: RouteEntry[]): Array<{ provider: ProviderId; entries: RouteEntry[] }> {
  const order: ProviderId[] = ["anthropic", "openai", "cursor", "openrouter", "deepseek", "xai", "custom"];
  const buckets = new Map<ProviderId, RouteEntry[]>();
  for (const entry of entries) {
    const provider = routeProvider(entry.route);
    if (!buckets.has(provider)) {
      buckets.set(provider, []);
    }
    buckets.get(provider)!.push(entry);
  }
  return order
    .filter((provider) => buckets.has(provider))
    .map((provider) => ({ provider, entries: buckets.get(provider)! }));
}
