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

export function PerfMeter({ value }: { value: number | undefined }) {
  const v = value ?? 0;
  return (
    <span className={"wb-meter wb-perf" + (v >= 4 ? " is-high" : "")} title={value == null ? "Performance n/a" : `Performance ${v}/5`}>
      {[1, 2, 3, 4, 5].map((bar) => (
        <i key={bar} className={bar <= v ? "is-on" : ""} style={{ height: `${3 + bar * 2}px` }} />
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
  const order: ProviderId[] = ["anthropic", "openai", "openrouter", "custom"];
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
