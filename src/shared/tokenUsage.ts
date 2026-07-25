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
  /**
   * Turn start time (ISO 8601), when known. Needed for **active time** — the
   * design's rate/utilization metrics measure real elapsed run time, not turn
   * count. Missing means "not reported" (older records), so a turn without it
   * contributes 0 active time, never a fabricated span.
   */
  atStart?: string;
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
  /** Present on `gate-review` turns: the reviewer's verdict, so the dashboard can
   *  compute the gate's reject rate and net effect from measured data. */
  gate?: { verdict: "allow" | "reject" };
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
  /** Tokens from overhead triggers (party-message/gate-review/compact/init). */
  overheadTokens: number;
  /** Total tokens (input+cacheRead+cacheWrite+output) in the earlier half of the
   *  range — paired with {@link secondHalfTokens} to derive a trend direction. */
  firstHalfTokens: number;
  /** Total tokens in the later half of the range. */
  secondHalfTokens: number;
}

/** Overhead triggers: spend not directly executing a user instruction. */
export const OVERHEAD_TRIGGERS: ReadonlySet<TokenTrigger> = new Set<TokenTrigger>([
  "party-message",
  "gate-review",
  "compact",
  "init",
]);

export interface RollupRow extends SeriesTotals {
  key: string;   // partyId, `${partyId}:${member}`, or trigger
  label: string;
  /** Total tokens across all kinds (the row's headline usage number). */
  totalTokens: number;
  /** Real elapsed run time in ms — a UNION of this row's turn intervals, so a
   *  party's members running concurrently are counted once (design §4). 0 when
   *  no turn carried a start time (see {@link TurnUsageRecord.atStart}). */
  activeMs: number;
  /** cacheRead ÷ all input (fresh+read+write); undefined when no input reported. */
  cacheHitRate?: number;
  /** overheadTokens ÷ totalTokens; undefined when nothing reported. */
  overheadRatio?: number;
  /** Tokens per active hour (totalTokens ÷ activeHours); undefined without active time. */
  ratePerHour?: number;
  /** Later-vs-earlier-half token change, %; undefined when the earlier half is empty. */
  trendPct?: number;
  /** Most-recent model/effort seen for this row — the dominant runtime for its
   *  chips (a session's model/effort can change mid-run; this is the latest). */
  lastModel?: string;
  lastEffort?: string;
}

export interface UsageBucket {
  tMs: number;                         // bucket start (epoch ms)
  totals: SeriesTotals;
  bySeries: Record<string, SeriesTotals>; // keyed by series key (party id or member)
  /** Total tokens per trigger in this bucket — drives the G2 composition-over-time
   *  chart. Keyed by {@link TokenTrigger}; absent triggers are simply missing. */
  byTrigger: Record<string, number>;
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
  /** Total tokens across everything in range (totals.* summed). */
  totalTokens: number;
  /** UNION of every in-range turn interval, ms — the real wall-clock the range
   *  was actively running (concurrent turns counted once). Drives the "활성
   *  시간당 토큰" rate headline. 0 when no turn carried a start time. */
  activeMsUnion: number;
  /** totalTokens ÷ (activeMsUnion in hours); undefined without active time. */
  ratePerHour?: number;
  /** overheadTokens ÷ totalTokens across the range; undefined when nothing reported. */
  overheadRatio?: number;
  /** Message Gate stats over the range (from `gate-review` turns), or undefined
   *  when the gate never ran. `netTokens` is the gate's net effect measured on the
   *  cost side (−reviewTokens) — downstream savings aren't measurable, so a
   *  persistently negative net is the honest "게이트가 순비용" signal. */
  gate?: { reviews: number; rejects: number; rejectRate: number; reviewTokens: number; netTokens: number };
  /** How many raw records fed this aggregate — 0 ⇒ the UI shows "아직 없음". */
  recordCount: number;
}

function emptyTotals(): SeriesTotals {
  return {
    costUsd: 0, estCostUsd: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, turns: 0,
    overheadTokens: 0, firstHalfTokens: 0, secondHalfTokens: 0,
  };
}

/** Total tokens across all kinds for one turn's split. */
function turnTokensTotal(t: TurnTokenBreakdown): number {
  return (t.input || 0) + (t.cacheRead || 0) + (t.cacheWrite || 0) + (t.output || 0);
}

/** Merges [start,end] ms intervals and returns the total covered span (union). */
function unionMs(intervals: Array<[number, number]>): number {
  if (!intervals.length) return 0;
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [curStart, curEnd] = sorted[0];
  for (let i = 1; i < sorted.length; i += 1) {
    const [s, e] = sorted[i];
    if (s > curEnd) {
      total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    } else if (e > curEnd) {
      curEnd = e;
    }
  }
  total += curEnd - curStart;
  return total;
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

function addTurn(into: SeriesTotals, record: TurnUsageRecord, midMs?: number): void {
  into.costUsd += typeof record.costUsd === "number" ? record.costUsd : 0;
  into.estCostUsd += estimatedTurnCostUsd(record);
  into.input += record.tokens.input || 0;
  into.cacheRead += record.tokens.cacheRead || 0;
  into.cacheWrite += record.tokens.cacheWrite || 0;
  into.output += record.tokens.output || 0;
  into.turns += 1;
  const total = turnTokensTotal(record.tokens);
  if (OVERHEAD_TRIGGERS.has(record.trigger)) {
    into.overheadTokens += total;
  }
  if (midMs !== undefined) {
    if (Date.parse(record.at) < midMs) into.firstHalfTokens += total;
    else into.secondHalfTokens += total;
  }
}

/** Query for the raw per-turn records behind the member drill-in. */
export interface TokenUsageTurnsQuery {
  fromMs: number;
  toMs: number;
  partyId?: string;
  member?: string;
  /** Cap the number of returned records (newest-kept); omit for all. */
  limit?: number;
}

/**
 * Selects the raw turn records for one member/party/range, chronological. The
 * drill-in derives both the context-growth curve (chronological) and the
 * expensive-turns list (sorted by total tokens) from this — no new instrumentation
 * is needed because every turn is already a ledger record.
 */
export function selectTurns(records: TurnUsageRecord[], query: TokenUsageTurnsQuery): TurnUsageRecord[] {
  const { fromMs, toMs, partyId, member, limit } = query;
  const rows = records.filter((r) => {
    const t = Date.parse(r.at);
    if (!Number.isFinite(t) || t < fromMs || t >= toMs) return false;
    if (partyId && r.partyId !== partyId) return false;
    if (member && r.member !== member) return false;
    return true;
  }).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return typeof limit === "number" && limit > 0 && rows.length > limit ? rows.slice(rows.length - limit) : rows;
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

  const midMs = fromMs + (toMs - fromMs) / 2;
  const scopedToParty = !!partyId;
  const seriesKeyOf = (r: TurnUsageRecord): string =>
    scopedToParty ? (r.member || "(unknown)") : (r.partyId || "(none)");

  const bucketMap = new Map<number, UsageBucket>();
  const parties = new Map<string, RollupRow>();
  const members = new Map<string, RollupRow>();
  const triggers = new Map<string, RollupRow>();
  const totals = emptyTotals();
  let gateReviews = 0, gateRejects = 0, gateReviewTokens = 0;
  // Per-row + global turn intervals [start,end]ms, unioned into activeMs later.
  const partyIvals = new Map<string, Array<[number, number]>>();
  const memberIvals = new Map<string, Array<[number, number]>>();
  const triggerIvals = new Map<string, Array<[number, number]>>();
  const allIvals: Array<[number, number]> = [];
  const memberLastAt = new Map<string, number>();

  const ensureRow = (map: Map<string, RollupRow>, key: string, label: string): RollupRow => {
    let row = map.get(key);
    if (!row) {
      row = { key, label, totalTokens: 0, activeMs: 0, ...emptyTotals() };
      map.set(key, row);
    }
    return row;
  };
  const pushIval = (map: Map<string, Array<[number, number]>>, key: string, r: TurnUsageRecord): void => {
    if (!r.atStart) return;
    const s = Date.parse(r.atStart);
    const e = Date.parse(r.at);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) return;
    (map.get(key) || map.set(key, []).get(key)!).push([s, e]);
    if (map === partyIvals) allIvals.push([s, e]);
  };

  for (const r of inRange) {
    const tMs = bucketStartMs(Date.parse(r.at), bucketMinutes);
    let bucket = bucketMap.get(tMs);
    if (!bucket) {
      bucket = { tMs, totals: emptyTotals(), bySeries: {}, byTrigger: {} };
      bucketMap.set(tMs, bucket);
    }
    const skey = seriesKeyOf(r);
    if (!bucket.bySeries[skey]) bucket.bySeries[skey] = emptyTotals();
    addTurn(bucket.bySeries[skey], r);
    addTurn(bucket.totals, r);
    bucket.byTrigger[r.trigger] = (bucket.byTrigger[r.trigger] || 0) + turnTokensTotal(r.tokens);

    const partyKey = r.partyId || "(none)";
    addTurn(ensureRow(parties, partyKey, partyKey), r, midMs);
    pushIval(partyIvals, partyKey, r);
    if (r.member) {
      const memberKey = `${partyKey}:${r.member}`;
      const mrow = ensureRow(members, memberKey, r.member);
      addTurn(mrow, r, midMs);
      pushIval(memberIvals, memberKey, r);
      // Latest model/effort wins (records are not guaranteed ordered). Skip
      // gate-review turns: the reviewer is a separate agent on its own model, so
      // its runtime must not masquerade as the member's dominant model/effort.
      const t = Date.parse(r.at);
      if (r.model && r.trigger !== "gate-review" && t >= (memberLastAt.get(memberKey) ?? -Infinity)) {
        memberLastAt.set(memberKey, t);
        mrow.lastModel = r.model;
        mrow.lastEffort = r.effort;
      }
    }
    addTurn(ensureRow(triggers, r.trigger, r.trigger), r, midMs);
    pushIval(triggerIvals, r.trigger, r);
    addTurn(totals, r, midMs);
    if (r.trigger === "gate-review" && r.gate) {
      gateReviews += 1;
      if (r.gate.verdict === "reject") gateRejects += 1;
      gateReviewTokens += turnTokensTotal(r.tokens);
    }
  }

  /** Fills totalTokens + derived (activeMs/cache/overhead/rate/trend) on a row. */
  const finalize = (row: RollupRow, ivals?: Array<[number, number]>): RollupRow => {
    row.totalTokens = row.input + row.cacheRead + row.cacheWrite + row.output;
    row.activeMs = ivals ? unionMs(ivals) : 0;
    const allInput = row.input + row.cacheRead + row.cacheWrite;
    row.cacheHitRate = allInput > 0 ? row.cacheRead / allInput : undefined;
    row.overheadRatio = row.totalTokens > 0 ? row.overheadTokens / row.totalTokens : undefined;
    row.ratePerHour = row.activeMs > 0 ? row.totalTokens / (row.activeMs / 3_600_000) : undefined;
    row.trendPct = row.firstHalfTokens > 0
      ? (row.secondHalfTokens - row.firstHalfTokens) / row.firstHalfTokens * 100
      : (row.secondHalfTokens > 0 ? 100 : undefined);
    return row;
  };

  const byEst = (a: RollupRow, b: RollupRow) => b.estCostUsd - a.estCostUsd || b.output - a.output;
  const partyRows = [...parties.values()].map((row) => finalize(row, partyIvals.get(row.key))).sort(byEst);
  const memberRows = [...members.values()].map((row) => finalize(row, memberIvals.get(row.key))).sort(byEst);
  const triggerRows = [...triggers.values()].map((row) => finalize(row, triggerIvals.get(row.key))).sort(byEst);
  const totalTokens = totals.input + totals.cacheRead + totals.cacheWrite + totals.output;
  const activeMsUnion = unionMs(allIvals);
  return {
    fromMs,
    toMs,
    bucketMinutes,
    partyId,
    buckets: [...bucketMap.values()].sort((a, b) => a.tMs - b.tMs),
    parties: partyRows,
    members: memberRows,
    triggers: triggerRows,
    totals,
    totalTokens,
    activeMsUnion,
    ratePerHour: activeMsUnion > 0 ? totalTokens / (activeMsUnion / 3_600_000) : undefined,
    overheadRatio: totalTokens > 0 ? totals.overheadTokens / totalTokens : undefined,
    gate: gateReviews > 0
      ? { reviews: gateReviews, rejects: gateRejects, rejectRate: gateRejects / gateReviews, reviewTokens: gateReviewTokens, netTokens: -gateReviewTokens }
      : undefined,
    recordCount: inRange.length,
  };
}
