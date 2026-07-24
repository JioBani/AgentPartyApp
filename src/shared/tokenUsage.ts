import { resolveCatalogModel } from "./modelCatalog";

/**
 * Per-turn usage ledger — the real, append-only accounting the Token Usage
 * dashboard is built on. One {@link TurnUsageRecord} is written per completed
 * turn (on the harness `turn_complete`), keyed by party/member/session identity,
 * then range-queried and aggregated for the dashboard.
 *
 * Honesty rules (mirroring docs/디자인 핸드오프/token_usage_brief.md §4/§8):
 *   - Token fields are only populated when the harness reports them. A missing
 *     field means "not reported", NEVER zero — Codex, for one, exposes no cache
 *     split. Aggregation must treat `undefined` as absent, not 0.
 *   - `trigger` records the real cause when known and `"unknown"` otherwise; it
 *     is never fabricated into `"user"`.
 *   - `costUsd` is the harness/provider-reported bill when available (실측/
 *     provider-reported); the list-price `≈$` conversion is DERIVED at
 *     aggregation time and kept in a separate field so 실측 and 환산 stay
 *     visually distinguishable, as the brief requires.
 */

export type TokenTrigger =
  | "user"          // a person's direct send — the baseline
  | "party-message" // a member-to-member message drove the turn
  | "gate-review"   // Message Gate reviewer call
  | "compact"       // context compaction turn
  | "subagent"      // a subagent turn
  | "init"          // session init / background poll
  | "unknown";      // origin genuinely undetermined — never guessed

export const TOKEN_TRIGGERS: TokenTrigger[] = [
  "user",
  "party-message",
  "gate-review",
  "compact",
  "subagent",
  "init",
  "unknown",
];

/**
 * The token split for one turn, as far as the harness reports it. Every field is
 * optional on purpose — see the honesty rules above.
 */
export interface TurnTokenBreakdown {
  /** Fresh (non-cached) input tokens. */
  input?: number;
  /** Cache-read input tokens (cheap reads). */
  cacheRead?: number;
  /** Cache-creation input tokens (cache writes). */
  cacheWrite?: number;
  /** Generated / output tokens. */
  output?: number;
  /** Context-window occupancy at turn end (non-cumulative; drops after compact). */
  context?: number;
  /** Context-window size when the harness reports it numerically. */
  contextWindow?: number;
}

export interface TurnUsageRecord {
  /** Turn end time (ISO 8601). Bucketed by end time — usage is reported then. */
  at: string;
  /** Party id — the `#id` identity (parties with the same name stay separate). */
  partyId?: string;
  /** Member name within the party. */
  member?: string;
  /** Resumable harness/thread session id. */
  sessionId?: string;
  /** Transient app-session id (the ManagedSession id) — always present. */
  appSessionId: string;
  /** Provider the turn drew from: `claude` | `codex` | `cursor` | `openrouter` | … */
  provider?: string;
  model?: string;
  effort?: string;
  trigger: TokenTrigger;
  tokens: TurnTokenBreakdown;
  /** Harness/provider-reported bill in USD when available (실측/provider-reported). */
  costUsd?: number;
  /** Cost provenance: `harness-reported` | `provider-reported` | `estimated` | `subscription` | … */
  costBasis?: string;
  /** Cost source: `claude-code` | `openrouter` | `codex` | `estimate` | … */
  costSource?: string;
}

// ── Aggregation ────────────────────────────────────────────────────────────

export interface TokenUsageQuery {
  /** Inclusive range start (epoch ms). */
  fromMs: number;
  /** Exclusive range end (epoch ms). */
  toMs: number;
  /** Bucket width in minutes (1/3/5/15/30/60/240/1440). */
  bucketMinutes: number;
  /** Restrict to a single party id; omit for all parties. */
  partyId?: string;
  /** Restrict to a single trigger; omit for all. */
  trigger?: TokenTrigger;
}

export interface SeriesTotals {
  costUsd: number;      // real bill sum (0 when all subscription/unavailable)
  estCostUsd: number;   // list-price ≈$ conversion (always computable from tokens)
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  turns: number;
}

export interface RollupRow extends SeriesTotals {
  key: string;   // partyId, `${partyId}:${member}`, or trigger
  label: string;
}

export interface UsageBucket {
  tMs: number;                         // bucket start (epoch ms)
  totals: SeriesTotals;
  bySeries: Record<string, SeriesTotals>; // keyed by series key (party id or member)
}

export interface TokenUsageAggregate {
  fromMs: number;
  toMs: number;
  bucketMinutes: number;
  partyId?: string;
  buckets: UsageBucket[];
  parties: RollupRow[];
  members: RollupRow[];
  triggers: RollupRow[];
  totals: SeriesTotals;
  /** How many raw records fed this aggregate — 0 ⇒ the UI shows "아직 없음". */
  recordCount: number;
}

function emptyTotals(): SeriesTotals {
  return { costUsd: 0, estCostUsd: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, turns: 0 };
}

/** Standard cache multipliers vs base input rate (Anthropic-style list pricing). */
const CACHE_WRITE_MULT = 1.25;
const CACHE_READ_MULT = 0.1;

/**
 * List-price `≈$` for one turn: real token counts × the model's catalog per-1M
 * rate. This is a DETERMINISTIC comparison value (not a bill) — it lets
 * subscription turns (Claude/Codex), which carry no per-turn bill, still be
 * ranked by cost. Returns 0 when the model/rate is unknown (never fabricated).
 */
export function estimatedTurnCostUsd(record: TurnUsageRecord): number {
  const catalog = record.model ? resolveCatalogModel(record.model) : undefined;
  const inPerM = catalog?.inPerM;
  const outPerM = catalog?.outPerM ?? catalog?.ioPerM;
  if (typeof inPerM !== "number" && typeof outPerM !== "number") {
    return 0;
  }
  const t = record.tokens;
  const inputUnits = (t.input || 0) + (t.cacheWrite || 0) * CACHE_WRITE_MULT + (t.cacheRead || 0) * CACHE_READ_MULT;
  const inCost = typeof inPerM === "number" ? (inputUnits / 1_000_000) * inPerM : 0;
  const outCost = typeof outPerM === "number" ? ((t.output || 0) / 1_000_000) * outPerM : 0;
  return inCost + outCost;
}

function addTurn(into: SeriesTotals, record: TurnUsageRecord): void {
  into.costUsd += typeof record.costUsd === "number" ? record.costUsd : 0;
  into.estCostUsd += estimatedTurnCostUsd(record);
  into.input += record.tokens.input || 0;
  into.cacheRead += record.tokens.cacheRead || 0;
  into.cacheWrite += record.tokens.cacheWrite || 0;
  into.output += record.tokens.output || 0;
  into.turns += 1;
}

export function bucketStartMs(atMs: number, bucketMinutes: number): number {
  const width = Math.max(1, bucketMinutes) * 60_000;
  return Math.floor(atMs / width) * width;
}

/**
 * Pure aggregation over raw records. Buckets by turn-end time; rolls up by party,
 * by member (`party:member`), and by trigger. Series keys are member names when a
 * single party is scoped, else party ids — matching the dashboard's scope model.
 */
export function aggregateUsage(records: TurnUsageRecord[], query: TokenUsageQuery): TokenUsageAggregate {
  const { fromMs, toMs, bucketMinutes, partyId, trigger } = query;
  const inRange = records.filter((r) => {
    const t = Date.parse(r.at);
    if (!Number.isFinite(t) || t < fromMs || t >= toMs) return false;
    if (partyId && r.partyId !== partyId) return false;
    if (trigger && r.trigger !== trigger) return false;
    return true;
  });

  const scopedToParty = !!partyId;
  const seriesKeyOf = (r: TurnUsageRecord): string =>
    scopedToParty ? (r.member || "(unknown)") : (r.partyId || "(none)");

  const bucketMap = new Map<number, UsageBucket>();
  const parties = new Map<string, RollupRow>();
  const members = new Map<string, RollupRow>();
  const triggers = new Map<string, RollupRow>();
  const totals = emptyTotals();

  const ensureRow = (map: Map<string, RollupRow>, key: string, label: string): RollupRow => {
    let row = map.get(key);
    if (!row) {
      row = { key, label, ...emptyTotals() };
      map.set(key, row);
    }
    return row;
  };

  for (const r of inRange) {
    const tMs = bucketStartMs(Date.parse(r.at), bucketMinutes);
    let bucket = bucketMap.get(tMs);
    if (!bucket) {
      bucket = { tMs, totals: emptyTotals(), bySeries: {} };
      bucketMap.set(tMs, bucket);
    }
    const skey = seriesKeyOf(r);
    if (!bucket.bySeries[skey]) bucket.bySeries[skey] = emptyTotals();
    addTurn(bucket.bySeries[skey], r);
    addTurn(bucket.totals, r);

    addTurn(ensureRow(parties, r.partyId || "(none)", r.partyId || "(none)"), r);
    if (r.member) addTurn(ensureRow(members, `${r.partyId || "(none)"}:${r.member}`, r.member), r);
    addTurn(ensureRow(triggers, r.trigger, r.trigger), r);
    addTurn(totals, r);
  }

  const byEst = (a: RollupRow, b: RollupRow) => b.estCostUsd - a.estCostUsd || b.output - a.output;
  return {
    fromMs,
    toMs,
    bucketMinutes,
    partyId,
    buckets: [...bucketMap.values()].sort((a, b) => a.tMs - b.tMs),
    parties: [...parties.values()].sort(byEst),
    members: [...members.values()].sort(byEst),
    triggers: [...triggers.values()].sort(byEst),
    totals,
    recordCount: inRange.length,
  };
}
