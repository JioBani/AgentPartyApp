import { useEffect, useMemo, useRef, useState } from "react";
import type { RollupRow, TokenUsageAggregate, TokenUsageQuery, TurnUsageRecord } from "../../shared/tokenUsage";
import type { UsageLimitsSnapshot, UsageWindowKind } from "../../shared/usageLimits";
import { memberColor } from "../theme/memberColors";
import { fmtActive, fmtBucketLabel, fmtRate, fmtTokens, fmtTokensAxis, INTERVAL_PRESETS, isMemberModelTurn, RANGE_PRESETS } from "./usageFormat";
import {
  cellTint, effortHeight, effortMix, fmtCost, fmtMoneyAxis, modelColor, modelLabel, modelTier, tierBars, turnCost,
} from "./usageCost";

/**
 * Token Usage dashboard — cost-first (design_handoff_token_usage-new). Renders the
 * real per-turn usage ledger: cost bars × context-held dashed lines on one time
 * axis, a model·effort rane, a party catalog, a per-bucket cost table, and the
 * who-table. Cost is a deterministic list-price conversion of measured tokens
 * (not an estimate). Absent data reads "아직 없음"/"—", never a fabricated 0.
 */

interface TokenUsageViewProps {
  usage: UsageLimitsSnapshot;
  parties: Array<{ id: string; name: string }>;
  onOpenMemberChat?: (partyId: string, member: string) => void;
}

type SortKey = "name" | "active" | "turns" | "cost" | "share" | "rate" | "cache" | "overhead" | "est";

const REST_KEY = "__rest";
// Wheel-zoom bounds on the on-screen candle count. Max is kept where candles stay
// individually legible (≥ ~2.5px slot) rather than fusing into a smear.
const MIN_BARS = 10;
const MAX_BARS = 400;

/** ↑input (fresh+cache) and ↓output totals for a rollup row. */
function ioOf(r: { input: number; cacheRead: number; cacheWrite: number; output: number }) {
  return { inTok: r.input + r.cacheRead + r.cacheWrite, outTok: r.output };
}
function colorForKey(name: string): string { return memberColor(name); }

// ── one derived series over the timeline ────────────────────────────────────
interface Series {
  key: string; name: string; color: string;
  cost: number[];       // per-bucket cost (USD)
  ctx: number[];        // per-bucket context occupancy (tokens), carried
  resets: number[];     // bucket indices where a compact dropped context
  segs: Array<{ model?: string; effort?: string; n: number }>; // model×effort run-length segments
}

export function TokenUsageView({ usage, parties, onOpenMemberChat }: TokenUsageViewProps) {
  const [rangeKey, setRangeKey] = useState("5h");
  const [scope, setScope] = useState<string>("all");
  const [intervalKey, setIntervalKey] = useState("5m");
  const [ctxOn, setCtxOn] = useState(true);
  const [hover, setHover] = useState<string | null>(null);
  const [hoverBucket, setHoverBucket] = useState<number | null>(null);
  const [chartEnd, setChartEnd] = useState<number | null>(null); // null = live (right edge pinned to now); a timestamp = panned into the past
  const [zoom, setZoom] = useState(1); // wheel zoom: multiplies the interval's base bar count (how many candles fit on screen), interval fixed
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "share", dir: "desc" });
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [dataMode, setDataMode] = useState<"cost" | "pct">("cost");
  const [tableQuery, setTableQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [hiddenParties, setHiddenParties] = useState<Record<string, boolean>>({});
  const [hiddenMembers, setHiddenMembers] = useState<Record<string, boolean>>({}); // key `${partyId}:${member}`
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false);
  const [compare, setCompare] = useState(false);
  const [aggPrev, setAggPrev] = useState<TokenUsageAggregate | null>(null);
  const [archPinned, setArchPinned] = useState<Record<string, boolean>>({});
  const [catPickerOpen, setCatPickerOpen] = useState(false);
  const [drill, setDrill] = useState<{ partyId: string; member: string; color: string } | null>(null);

  const [agg, setAgg] = useState<TokenUsageAggregate | null>(null);
  const [turns, setTurns] = useState<TurnUsageRecord[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNowTick(Date.now()), 1000); return () => clearInterval(id); }, []);
  const [refreshTick, setRefreshTick] = useState(0); // bumps to pull fresh ledger data while live (new turns/members)

  const range = RANGE_PRESETS.find((r) => r.key === rangeKey) || RANGE_PRESETS[0];
  const interval = INTERVAL_PRESETS.find((i) => i.key === intervalKey) || INTERVAL_PRESETS[2];
  const partyName = (id: string) => parties.find((p) => p.id === id)?.name || id;
  const activeIds = useMemo(() => new Set(parties.map((p) => p.id)), [parties]);

  // Aggregate window = the range preset (tables/catalog/headline are range-scoped).
  const windowBounds = useMemo(() => {
    const now = Date.now();
    return { fromMs: now - range.rangeMs, toMs: now };
  }, [rangeKey]);
  // Chart/bucket-table window = a stock-chart viewport. Its WIDTH is interval × n
  // (a finer interval = shorter, denser span = zoom); its RIGHT EDGE is `chartEnd`,
  // which the user drags left/right to travel through time. `chartEnd === null` is
  // live: pinned to now, snapped to the bucket grid so it steps once per bar.
  // Wheel zoom scales how many candles are on screen WITHOUT changing the interval:
  // the visible bar count = the preset's baseN × zoom (clamped), and the window
  // width follows it. So 1분봉 stays 1분봉; the wheel just fits more/fewer of them.
  const visibleBars = Math.round(Math.min(MAX_BARS, Math.max(MIN_BARS, interval.n * zoom)));
  const chartSpanMs = interval.minutes * visibleBars * 60_000;
  const liveEnd = useMemo(() => {
    const width = interval.minutes * 60_000;
    return Math.ceil(nowTick / width) * width;
  }, [intervalKey, nowTick]);
  const chartBounds = useMemo(() => {
    const end = chartEnd ?? liveEnd;
    return { fromMs: end - chartSpanMs, toMs: end };
  }, [intervalKey, chartEnd, liveEnd, chartSpanMs]);
  const isLive = chartEnd === null;
  const chartRangeLabel = `${fmtBucketLabel(chartBounds.fromMs, interval.minutes)} – ${fmtBucketLabel(chartBounds.toMs, interval.minutes)}`;
  // Wheel handler target: set the new bar count + the cursor-anchored right edge in
  // one update (zoom = bars ÷ baseN so `visibleBars` round-trips to the same count).
  const applyZoom = (nextBars: number, nextEnd: number | null) => { setZoom(nextBars / interval.n); setChartEnd(nextEnd); };

  // Fetch A — the range-scoped aggregate (gauges / catalog / who-table). Independent
  // of the chart viewport, so panning the chart never refetches or reflows these.
  const reqNonce = useRef(0);
  useEffect(() => {
    const mine = ++reqNonce.current;
    const now = Date.now();
    const fromMs = now - range.rangeMs, toMs = now;
    const q: TokenUsageQuery = { fromMs, toMs, bucketMinutes: interval.minutes };
    const api = window.agentParty;
    if (!api.getTokenUsage) { setLoading(false); return; }
    if (!agg) setLoading(true); // only gate on the FIRST load; live-refresh polls keep the current content visible
    const prevQ: TokenUsageQuery = { fromMs: fromMs - range.rangeMs, toMs: fromMs, bucketMinutes: interval.minutes };
    Promise.all([
      api.getTokenUsage(q) as Promise<TokenUsageAggregate>,
      (compare ? api.getTokenUsage(prevQ) : Promise.resolve(null)) as Promise<TokenUsageAggregate | null>,
    ]).then(([a, prev]) => {
      if (mine !== reqNonce.current) return;
      setAgg(a); setAggPrev(prev); setLoading(false);
    }).catch(() => { if (mine === reqNonce.current) setLoading(false); });
  }, [rangeKey, intervalKey, compare, refreshTick]);

  // Fetch B — raw turns for the chart viewport (timeline / rane / context / bucket
  // table). Buffered ±1 span so panning within the loaded window is instant with no
  // refetch and no loading flicker; only crossing the buffer edge triggers a silent
  // fetch. Independent of `loading` (Fetch A owns the empty/error state).
  const turnsBuf = useRef<{ fromMs: number; toMs: number } | null>(null);
  const lastRefresh = useRef(refreshTick);
  useEffect(() => {
    // A live-refresh tick forces a refetch of the current window (new turns land
    // inside the loaded buffer, so the coverage check would otherwise skip them).
    const forced = lastRefresh.current !== refreshTick; lastRefresh.current = refreshTick;
    const view = chartBounds;
    const buf = turnsBuf.current;
    if (!forced && buf && view.fromMs >= buf.fromMs && view.toMs <= buf.toMs) return;
    const need = { fromMs: view.fromMs - chartSpanMs, toMs: view.toMs + chartSpanMs };
    turnsBuf.current = need;
    const api = window.agentParty.getTokenUsageTurns;
    if (!api) { setTurns([]); return; }
    let alive = true;
    (api({ fromMs: need.fromMs, toMs: need.toMs }) as Promise<TurnUsageRecord[]>)
      .then((t) => { if (alive) setTurns(Array.isArray(t) ? t : []); })
      .catch(() => { /* an empty chart surfaces the gap; Fetch A owns the error banner */ });
    return () => { alive = false; };
  }, [chartBounds.fromMs, chartBounds.toMs, chartSpanMs, refreshTick]);

  // Live refresh: while pinned to the live edge, re-pull the ledger every few
  // seconds so newly-recorded turns and freshly-added members (and the resulting
  // idle-fold) appear without a manual control change. A panned-to-past view is
  // static, so it isn't polled; leaving the Token Usage view unmounts this.
  useEffect(() => {
    if (!isLive) return;
    const id = setInterval(() => setRefreshTick((t) => t + 1), 5000);
    return () => clearInterval(id);
  }, [isLive]);

  const recordCount = agg?.recordCount ?? 0;
  const isEmpty = !loading && recordCount === 0;

  // Default to the most-active party so members show right away (the handoff
  // defaults to a party scope, not the all-parties roll-up). One-time; the user
  // can still switch to "전체" or another party from the scope dropdown.
  const didInitScope = useRef(false);
  useEffect(() => {
    if (didInitScope.current || !agg?.parties.length) return;
    didInitScope.current = true;
    const top = agg.parties.find((p) => activeIds.has(p.key)) || agg.parties[0];
    if (top) { setScope(top.key); setExpanded((cur) => (Object.keys(cur).length ? cur : { [top.key]: true })); }
  }, [agg]);

  // ── Catalog: active parties (in current list) + archived (ledger-only) ─────
  const catalog = useMemo(() => {
    const rows = (agg?.parties || []).map((p) => {
      const io = ioOf(p);
      return { id: p.key, name: partyName(p.key), status: activeIds.has(p.key) ? "active" as const : "archived" as const,
        cost: p.estCostUsd, inTok: io.inTok, outTok: io.outTok, tokens: p.totalTokens, row: p };
    });
    return rows.sort((a, b) => (a.status === b.status ? b.cost - a.cost : a.status === "active" ? -1 : 1));
  }, [agg, parties]);

  // ── Timeline series from raw turns, bucketed by the interval ───────────────
  const { series, buckets } = useMemo(() => buildSeries(turns || [], scope, chartBounds, interval.minutes, partyName, hiddenMembers), [turns, scope, chartBounds, intervalKey, parties, hiddenMembers]);
  const isHidden = (key: string) => scope === "all" ? !!hiddenParties[key] : !!hiddenMembers[`${scope}:${key}`];
  const toggleSeries = (key: string) => scope === "all"
    ? setHiddenParties((h) => ({ ...h, [key]: !h[key] }))
    : setHiddenMembers((h) => ({ ...h, [`${scope}:${key}`]: !h[`${scope}:${key}`] }));
  const visSeries = series.filter((s) => !isHidden(s.key));

  // ── Headline window utilization (실측) ─────────────────────────────────────
  const win = (kind: UsageWindowKind) => usage.claude?.windows.find((w) => w.kind === kind);
  const claudeAvail = usage.claude?.available !== false;
  const fiveH = claudeAvail ? win("five_hour") : undefined;
  const weekly = claudeAvail ? win("weekly") : undefined;
  const resetIn = (at?: number) => {
    if (!at) return undefined;
    const ms = at - nowTick; if (ms <= 0) return "곧";
    const min = Math.round(ms / 60_000), h = Math.floor(min / 60), m = min % 60;
    return h > 0 ? `${h}시간 ${String(m).padStart(2, "0")}분` : `${m}분`;
  };

  if (drill) {
    return <MemberDrillIn drill={drill} agg={agg} windowBounds={windowBounds} onBack={() => setDrill(null)} onOpenChat={() => onOpenMemberChat?.(drill.partyId, drill.member)} />;
  }

  const scopeLabel = scope === "all" ? "전체 (활성 파티)" : partyName(scope);

  return (
    <div style={dashboardRoot}>
      {/* Toolbar: theme handled by app; here only compare/brush notice */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={pillGroup}>
          {RANGE_PRESETS.filter((r) => r.key !== "1h").map((r) => (
            <button key={r.key} data-tu="range" data-range={r.key} onClick={() => setRangeKey(r.key)} style={segBtn(rangeKey === r.key)}>{r.label}</button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        {compare &&<div style={{ display: "inline-flex", alignItems: "center", gap: 8, height: 32, padding: "0 12px", background: "var(--accent-dim)", border: "1px solid var(--accent-bd)", borderRadius: 9, fontSize: 11.5, color: "var(--accent)", fontWeight: 600 }}><span className="wb-mono" style={{ color: "var(--text-1)" }}>A</span> 현재 <span style={{ color: "var(--text-3)" }}>vs</span> <span className="wb-mono" style={{ color: "var(--text-1)" }}>B</span> 직전 구간</div>}
        <button onClick={() => setCompare((v) => !v)} title="구간 비교" style={{ display: "inline-flex", alignItems: "center", gap: 7, height: 32, padding: "0 13px", borderRadius: 9, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "var(--font-sans)", background: compare ? "var(--accent-dim)" : "var(--bg-2)", border: `1px solid ${compare ? "var(--accent-bd)" : "var(--border)"}`, color: compare ? "var(--accent)" : "var(--text-1)" }}>비교 모드</button>
      </div>

      {compare && !isEmpty && <CompareCard a={agg} b={aggPrev} rangeLabel={range.label} />}

      {isEmpty ? <EmptyState /> : (
        <>
          {/* a. 한도 게이지 — 5시간 + 주간 */}
          <section style={{ position: "relative", background: "var(--bg-2)", border: "1px solid var(--live-bd)", borderRadius: 14, padding: "15px 19px", display: "flex", flexDirection: "column", gap: 11, overflow: "hidden" }}>
            <div style={{ position: "absolute", inset: 0, background: "linear-gradient(120deg,var(--live-dim),transparent 55%)", pointerEvents: "none" }} />
            <div style={{ display: "flex", alignItems: "center", gap: 8, position: "relative" }}>
              <span style={cardLabel}>한도 소진율</span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10.5, color: "var(--live)", fontWeight: 600 }}><span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--live)" }} />실측 · Claude</span>
            </div>
            <GaugeRow label="5시간" pct={fiveH?.utilization} reset={resetIn(fiveH?.resetsAt)} accent />
            <GaugeRow label="주간" pct={weekly?.utilization} reset={resetIn(weekly?.resetsAt)} />
          </section>

          {/* c. 타임라인 — 비용(막대) × 컨텍스트 보유(점선) */}
          <TimelineSection
            series={series} isHidden={isHidden} onToggleSeries={toggleSeries}
            buckets={buckets} ctxOn={ctxOn} setCtxOn={setCtxOn}
            interval={interval} scope={scope} parties={parties} scopeLabel={scopeLabel}
            scopeMenuOpen={scopeMenuOpen} setScopeMenuOpen={setScopeMenuOpen} onScope={(id) => { setScope(id); setHover(null); setScopeMenuOpen(false); }}
            hover={hover} setHover={setHover} hoverBucket={hoverBucket} setHoverBucket={setHoverBucket}
            onInterval={(k) => { setIntervalKey(k); setZoom(1); }}
            chartEnd={chartEnd} liveEnd={liveEnd} isLive={isLive} onPan={setChartEnd} chartRangeLabel={chartRangeLabel}
            visibleBars={visibleBars} onZoom={applyZoom}
          />

          {/* e. 카탈로그 */}
          <Catalog
            rows={catalog} members={agg?.members || []} archPinned={archPinned}
            hiddenParties={hiddenParties} hiddenMembers={hiddenMembers}
            onToggleParty={(id) => setHiddenParties((h) => ({ ...h, [id]: !h[id] }))}
            onToggleMember={(pid, m) => setHiddenMembers((h) => ({ ...h, [`${pid}:${m}`]: !h[`${pid}:${m}`] }))}
            pickerOpen={catPickerOpen} setPickerOpen={setCatPickerOpen} onPinArchived={(id) => setArchPinned((a) => ({ ...a, [id]: !a[id] }))}
          />

          {/* f. 봉별 실제 수치 (비용) */}
          <BucketCostTable series={visSeries} buckets={buckets} interval={interval} scopeLabel={scope === "all" ? "전체" : `${partyName(scope)} 멤버`} dataMode={dataMode} setDataMode={setDataMode} rangeLabel={`${isLive ? "실시간" : "과거"} · ${chartRangeLabel}`} turns={turns || []} scope={scope} />

          {/* g. 누가 — 파티 ▸ 멤버 */}
          <WhoTable agg={agg} parties={parties} activeIds={activeIds} sort={sort} setSort={setSort} expanded={expanded} setExpanded={setExpanded} hover={hover} setHover={setHover} onDrill={setDrill} tableQuery={tableQuery} setTableQuery={setTableQuery} showArchived={showArchived} setShowArchived={setShowArchived} utilPct={fiveH?.utilization} />
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Timeline series derivation (from raw turns)
// ─────────────────────────────────────────────────────────────────────────────

function buildSeries(
  turns: TurnUsageRecord[], scope: string, wnd: { fromMs: number; toMs: number }, intervalMin: number,
  partyName: (id: string) => string, hiddenMembers: Record<string, boolean>,
): { series: Series[]; buckets: number[] } {
  const width = intervalMin * 60_000;
  const from = Math.floor(wnd.fromMs / width) * width;
  const nB = Math.max(1, Math.ceil((wnd.toMs - from) / width));
  const buckets: number[] = [];
  for (let i = 0; i < nB; i += 1) buckets.push(from + i * width);
  // Bucket index for a timestamp, or -1 when it falls OUTSIDE the visible window.
  // `turns` is fetched with a ±1-span buffer (for smooth panning), so out-of-window
  // turns must be DROPPED here — clamping them into bucket 0 / nB-1 was piling all
  // off-screen spend onto the first/last candle ("양 끝의 정체불명 봉").
  const bucketOf = (ms: number) => { const b = Math.floor((ms - from) / width); return b >= 0 && b < nB ? b : -1; };

  // Group turns by series key.
  const keyOf = (r: TurnUsageRecord) => scope === "all" ? (r.partyId || "(none)") : (r.member || "(unknown)");
  const inScope = (r: TurnUsageRecord) => scope === "all" ? true : r.partyId === scope;
  const groups = new Map<string, TurnUsageRecord[]>();
  for (const r of turns) {
    if (!inScope(r)) continue;
    // In all-scope, a party's stack excludes its hidden members (design behavior).
    if (scope === "all" && hiddenMembers[`${r.partyId || "(none)"}:${r.member || ""}`]) continue;
    const k = keyOf(r);
    (groups.get(k) || groups.set(k, []).get(k)!).push(r);
  }

  const build = (key: string, rows: TurnUsageRecord[]): Series => {
    rows.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const cost = new Array(nB).fill(0);
    const ctx = new Array(nB).fill(NaN);
    const resets: number[] = [];
    let lastCtx = 0;
    const segs: Series["segs"] = [];
    for (const r of rows) {
      const bi = bucketOf(Date.parse(r.at));
      if (bi < 0) continue; // outside the visible window (buffered turn) — don't fold into an edge bar
      cost[bi] += turnCost(r.model, r.tokens);
      const c = r.tokens.context;
      if (typeof c === "number") {
        if (r.trigger === "compact" && c < lastCtx) resets.push(bi);
        ctx[bi] = c; lastCtx = c;
      }
      // Model·effort segments show the MEMBER's own runtime — exclude the gate
      // reviewer's turns (a different agent) so its Sonnet/no-effort calls don't
      // appear as phantom model switches in the member's lane.
      if (isMemberModelTurn(r.trigger)) {
        const last = segs[segs.length - 1];
        if (last && last.model === r.model && last.effort === r.effort) last.n += 1;
        else segs.push({ model: r.model, effort: r.effort, n: 1 });
      }
    }
    // carry context forward over idle buckets
    let carry = NaN;
    for (let i = 0; i < nB; i += 1) { if (!Number.isNaN(ctx[i])) carry = ctx[i]; else if (!Number.isNaN(carry)) ctx[i] = carry; }
    const name = scope === "all" ? partyName(key) : key;
    return { key, name, color: colorForKey(name), cost, ctx, resets, segs };
  };

  let series = [...groups.entries()].map(([k, rows]) => build(k, rows));
  // rank by total cost; for all-scope collapse the tail into "기타 N개"
  series.sort((a, b) => b.cost.reduce((x, y) => x + y, 0) - a.cost.reduce((x, y) => x + y, 0));
  if (scope === "all" && series.length > 6) {
    const head = series.slice(0, 6);
    const rest = series.slice(6);
    const cost = new Array(nB).fill(0), ctx = new Array(nB).fill(0);
    rest.forEach((s) => s.cost.forEach((v, i) => { cost[i] += v; }));
    head.push({ key: REST_KEY, name: `기타 ${rest.length}개`, color: "var(--text-3)", cost, ctx, resets: [], segs: [] });
    series = head;
  }
  return { series, buckets };
}

// ─────────────────────────────────────────────────────────────────────────────
// c. Timeline — cost bars × context lines
// ─────────────────────────────────────────────────────────────────────────────

function TimelineSection(props: {
  series: Series[]; isHidden: (key: string) => boolean; onToggleSeries: (key: string) => void;
  buckets: number[]; ctxOn: boolean; setCtxOn: (v: boolean) => void;
  interval: { label: string; minutes: number }; scope: string; parties: Array<{ id: string; name: string }>; scopeLabel: string;
  scopeMenuOpen: boolean; setScopeMenuOpen: (v: boolean) => void; onScope: (id: string) => void;
  hover: string | null; setHover: (h: string | null) => void; hoverBucket: number | null; setHoverBucket: (i: number | null) => void;
  onInterval: (k: string) => void;
  chartEnd: number | null; liveEnd: number; isLive: boolean; onPan: (end: number | null) => void; chartRangeLabel: string;
  visibleBars: number; onZoom: (nextBars: number, nextEnd: number | null) => void;
}) {
  const { series: allSeries, isHidden, buckets, ctxOn, interval, hover, hoverBucket } = props;
  const series = allSeries.filter((s) => !isHidden(s.key));
  const [scopeQuery, setScopeQuery] = useState("");
  const readout = hoverBucket != null && buckets[hoverBucket] != null
    ? `${fmtBucketLabel(buckets[hoverBucket], interval.minutes)} · ${fmtCost(series.reduce((a, s) => a + (s.cost[hoverBucket] || 0), 0))} · ${fmtTokens(series.reduce((a, s) => a + (Number.isFinite(s.ctx[hoverBucket]) ? s.ctx[hoverBucket] : 0), 0))} tok`
    : "막대=비용, 점선=컨텍스트 보유량 · 좌우로 드래그해 시간 이동 · 더블클릭=지금";

  return (
    <section style={cardSection}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <span style={sectionTitle}>타임라인 — 비용(막대) × 컨텍스트 보유(점선)</span>
            <span className="wb-mono" style={{ fontSize: 10.5, color: "var(--text-3)" }}>{props.chartRangeLabel}</span>
            {props.isLive
              ? <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, color: "var(--live)", fontWeight: 600 }}><span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--live)" }} />실시간</span>
              : <span style={{ fontSize: 10, color: "var(--text-3)", fontWeight: 600, background: "var(--bg-1)", border: "1px solid var(--border)", borderRadius: 6, padding: "1px 6px" }}>과거 구간</span>}
          </div>
          <span style={{ fontSize: 11.5, color: "var(--text-2)" }}>{readout}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          {/* scope dropdown */}
          <div style={{ position: "relative" }}>
            <button data-tu="scope-toggle" onClick={() => props.setScopeMenuOpen(!props.scopeMenuOpen)} style={{ display: "inline-flex", alignItems: "center", gap: 7, height: 30, padding: "0 11px", background: "var(--bg-1)", border: "1px solid var(--border)", borderRadius: 9, fontSize: 11.5, fontWeight: 600, color: "var(--text-1)", cursor: "pointer" }}>
              {props.scope !== "all" && <span style={{ width: 9, height: 9, borderRadius: 3, background: colorForKey(props.scopeLabel), flex: "none" }} />}{props.scopeLabel}
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
            {props.scopeMenuOpen && (
              <div style={{ position: "absolute", top: 34, right: 0, zIndex: 20, width: 230, background: "var(--bg-2)", border: "1px solid var(--border)", borderRadius: 10, boxShadow: "0 20px 50px -14px rgba(0,0,0,.55)", padding: 6 }}>
                <input autoFocus value={scopeQuery} onChange={(e) => setScopeQuery(e.target.value)} placeholder="파티 이름·#id 검색" style={{ width: "100%", height: 30, padding: "0 9px", marginBottom: 5, background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 11.5, color: "var(--text-0)", outline: "none", fontFamily: "var(--font-sans)", boxSizing: "border-box" }} />
                <div style={{ maxHeight: 240, overflow: "auto", display: "flex", flexDirection: "column", gap: 2 }}>
                  {!scopeQuery.trim() && <button onClick={() => props.onScope("all")} style={menuItem(props.scope === "all")}>전체 (활성 파티)</button>}
                  {props.parties.filter((p) => !scopeQuery.trim() || p.name.toLowerCase().includes(scopeQuery.toLowerCase()) || p.id.includes(scopeQuery)).map((p) => (
                    <button key={p.id} data-tu="scope-party" data-pid={p.id} onClick={() => props.onScope(p.id)} style={menuItem(props.scope === p.id)}>
                      <span style={{ width: 9, height: 9, borderRadius: 3, background: colorForKey(p.name), flex: "none" }} />{p.name}<span className="wb-mono" style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-3)" }}>#{p.id.slice(-4)}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          {allSeries.map((s) => {
            const off = isHidden(s.key);
            return (
              <button key={s.key} data-tu="legend" data-key={s.key} title={off ? "클릭해서 다시 표시" : "클릭해서 숨김"} onClick={() => props.onToggleSeries(s.key)} onMouseEnter={() => props.setHover(s.key)} onMouseLeave={() => props.setHover(null)}
                style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "transparent", border: "none", padding: 0, cursor: "pointer", fontFamily: "var(--font-sans)", opacity: off ? 0.4 : (hover && hover !== s.key ? 0.45 : 1) }}>
                <span style={{ width: 10, height: 10, borderRadius: 3, background: off ? "var(--border-strong)" : s.color, flex: "none" }} />
                <span style={{ fontSize: 11.5, fontWeight: 500, color: "var(--text-1)", textDecoration: off ? "line-through" : "none" }}>{s.name}</span>
              </button>
            );
          })}
          <button onClick={() => props.setCtxOn(!ctxOn)} style={{ display: "inline-flex", alignItems: "center", gap: 6, height: 28, padding: "0 10px", borderRadius: 8, fontSize: 11, fontWeight: 600, cursor: "pointer", background: ctxOn ? "var(--accent-dim)" : "var(--bg-1)", border: `1px solid ${ctxOn ? "var(--accent-bd)" : "var(--border)"}`, color: ctxOn ? "var(--accent)" : "var(--text-2)" }}>
            <span style={{ width: 16, height: 0, borderTop: `2px dashed ${ctxOn ? "var(--accent)" : "var(--text-3)"}`, flex: "none" }} />컨텍스트 보유 (k)
          </button>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
        <span style={miniLabel}>간격</span>
        <div style={{ ...pillGroup, background: "var(--bg-1)" }}>
          {INTERVAL_PRESETS.map((iv) => <button key={iv.key} data-tu="interval" data-iv={iv.key} onClick={() => props.onInterval(iv.key)} style={{ ...segBtnSmall(interval.minutes === iv.minutes), fontFamily: "var(--font-mono)" }}>{iv.label}</button>)}
        </div>
        <span style={{ fontSize: 10.5, color: "var(--text-3)" }}>봉 <b style={{ color: "var(--text-2)", fontWeight: 600 }}>{props.visibleBars}개</b> · 좌우 드래그=시간 이동 · 휠=봉 개수(범위) 조절 (주식 차트처럼)</span>
        <div style={{ flex: 1 }} />
        <button onClick={() => props.onPan(null)} disabled={props.isLive} title="가장 최근 구간으로" style={{ display: "inline-flex", alignItems: "center", gap: 5, height: 26, padding: "0 11px", borderRadius: 7, fontSize: 11, fontWeight: 600, cursor: props.isLive ? "default" : "pointer", fontFamily: "var(--font-sans)", background: props.isLive ? "var(--bg-1)" : "var(--accent-dim)", border: `1px solid ${props.isLive ? "var(--border)" : "var(--accent-bd)"}`, color: props.isLive ? "var(--text-3)" : "var(--accent)", opacity: props.isLive ? 0.6 : 1 }}>지금으로<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2}><path d="M13 6l6 6-6 6M5 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" /></svg></button>
      </div>

      <TimelineChart series={series} buckets={buckets} ctxOn={ctxOn} interval={interval} hover={hover} hoverBucket={hoverBucket} setHoverBucket={props.setHoverBucket} chartEnd={props.chartEnd} liveEnd={props.liveEnd} onPan={props.onPan} visibleBars={props.visibleBars} onZoom={props.onZoom} />

      {/* d. 모델·effort 레인 (파티 선택 시) */}
      {props.scope === "all" ? (
        <div style={{ fontSize: 10.5, color: "var(--text-3)" }}>모델·effort 타임라인은 파티를 선택하면 멤버별로 표시됩니다.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: "var(--text-3)" }}>모델·effort 타임라인 <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0, color: "var(--text-3)" }}>색=멤버 · 농도=effort · 세로선=변경 지점</span></div>
          {series.filter((s) => s.key !== REST_KEY).map((s) => <ModelEffortRane key={s.key} s={s} />)}
        </div>
      )}
    </section>
  );
}

function ModelEffortRane({ s }: { s: Series }) {
  const total = s.segs.reduce((a, x) => a + x.n, 0) || 1;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "88px 1fr", alignItems: "center", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        <span style={{ width: 9, height: 9, borderRadius: 3, background: s.color, flex: "none" }} /><span style={{ fontSize: 11, color: "var(--text-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</span>
      </div>
      <div style={{ display: "flex", height: 22, borderRadius: 6, overflow: "hidden", border: "1px solid var(--border-subtle)" }}>
        {s.segs.length === 0 ? <div style={{ flex: 1, background: "var(--bg-1)" }} /> : s.segs.map((sg, i) => (
          <div key={i} title={`${modelLabel(sg.model)} ${sg.effort || ""}`} style={{ width: `${sg.n / total * 100}%`, background: effortMix(s.color, sg.effort), borderLeft: i > 0 ? "1.5px solid var(--bg-2)" : "none", display: "flex", alignItems: "center", paddingLeft: 6, minWidth: 0, overflow: "hidden" }}>
            {sg.n / total > 0.12 && <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--text-0)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{modelLabel(sg.model)} {sg.effort}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

/** SVG: stacked cost bars (left $ axis) + dashed context lines (right k axis).
 *  Drag the plot left/right to pan the time axis; wheel to zoom the number of
 *  visible candles (interval fixed), anchored on the cursor; double-click = 지금. */
function TimelineChart(props: {
  series: Series[]; buckets: number[]; ctxOn: boolean; interval: { minutes: number };
  hover: string | null; hoverBucket: number | null; setHoverBucket: (i: number | null) => void;
  chartEnd: number | null; liveEnd: number; onPan: (end: number | null) => void;
  visibleBars: number; onZoom: (nextBars: number, nextEnd: number | null) => void;
}) {
  const { series, buckets, ctxOn, interval, hover, hoverBucket, setHoverBucket } = props;
  const W = 1080, H = 300, x0 = 8, x1 = 1032, y0 = 14, y1 = 250;
  const N = Math.max(buckets.length, 1);
  const slot = (x1 - x0 - 34) / N;
  // Never wider than ~85% of the slot — the old hard 2px floor exceeded the slot
  // at high bar counts, so candles overlapped into one solid block ("봉이 하나로
  // 합쳐져" when zoomed far out). Cap keeps a visible gap at any count.
  const barW = Math.min(Math.max(slot * 0.62, 1), 46, slot * 0.85);
  const width = interval.minutes * 60_000;

  // ── pan: dragging the plot right travels into the past (older bars slide in) ──
  const containerRef = useRef<HTMLDivElement>(null);
  const pan = useRef<{ startX: number; startEnd: number } | null>(null);
  const MAXPAST = 400 * 24 * 3_600_000;
  const onDown = (e: React.PointerEvent) => {
    pan.current = { startX: e.clientX, startEnd: props.chartEnd ?? props.liveEnd };
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* older webview */ }
  };
  const onMove = (e: React.PointerEvent) => {
    const p = pan.current, el = containerRef.current;
    if (!p || !el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    const dxVb = ((e.clientX - p.startX) / rect.width) * W;   // px moved, in viewBox units
    const dt = dxVb * (width / slot);                          // → ms (drag right ⇒ +dx ⇒ older)
    let end = p.startEnd - dt;
    if (end >= props.liveEnd) { props.onPan(null); return; }   // caught up to now → live
    const minEnd = props.liveEnd - MAXPAST;
    if (end < minEnd) end = minEnd;
    props.onPan(end);
  };
  const onUp = (e: React.PointerEvent) => { try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* noop */ } pan.current = null; };

  // ── wheel zoom: change the visible bar count, anchored on the cursor's time ──
  // A native non-passive listener is required — React's onWheel is passive, so it
  // can't preventDefault the page scroll. Latest values are read from a ref so the
  // listener is attached once (no re-bind churn as bars/pan change).
  const zoomRef = useRef({ visibleBars: props.visibleBars, end: props.chartEnd, liveEnd: props.liveEnd, width, onZoom: props.onZoom });
  zoomRef.current = { visibleBars: props.visibleBars, end: props.chartEnd, liveEnd: props.liveEnd, width, onZoom: props.onZoom };
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.deltaY) return;
      e.preventDefault();
      const st = zoomRef.current;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0) return;
      const cursorVbX = ((e.clientX - rect.left) / rect.width) * W;         // cursor x in viewBox units
      const frac = Math.min(1, Math.max(0, (cursorVbX - (x0 + 34)) / (x1 - (x0 + 34))));
      const end = st.end ?? st.liveEnd;
      const curSpan = st.visibleBars * st.width;
      const tCursor = (end - curSpan) + frac * curSpan;                     // time under the cursor (kept fixed)
      const factor = e.deltaY > 0 ? 1.2 : 1 / 1.2;                          // wheel down ⇒ more bars (zoom out)
      const nextBars = Math.min(MAX_BARS, Math.max(MIN_BARS, Math.round(st.visibleBars * factor)));
      const nextEnd = tCursor + (1 - frac) * (nextBars * st.width);         // re-anchor cursor at the same x
      st.onZoom(nextBars, nextEnd >= st.liveEnd ? null : nextEnd);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const totals = buckets.map((_, i) => series.reduce((a, s) => a + (s.cost[i] || 0), 0));
  const maxT = Math.max(...totals, 0.001) * 1.08;
  // Context axis auto-scales to the visible data (like the cost axis) — a fixed
  // ceiling pinned every real value to the top and drew a flat line.
  const ctxVals: number[] = [];
  if (ctxOn) for (const s of series) { if (s.key === REST_KEY) continue; for (const v of s.ctx) if (Number.isFinite(v)) ctxVals.push(v); }
  const maxCtx = ctxVals.length ? Math.max(...ctxVals) * 1.1 : 200_000;
  const px = (i: number) => x0 + 34 + slot * i + (slot - barW) / 2;
  const ux = (i: number) => x0 + 34 + slot * i + slot / 2;
  const uyC = (v: number) => y1 - (Math.min(v, maxCtx) / maxCtx) * (y1 - y0);

  const kids: JSX.Element[] = [];
  for (let g = 0; g <= 4; g += 1) {
    const y = y1 - (y1 - y0) * g / 4;
    kids.push(<line key={`g${g}`} x1={x0 + 30} y1={y} x2={x1 - 24} y2={y} stroke="var(--grid)" strokeWidth={1} />);
    kids.push(<text key={`lt${g}`} x={x0 + 26} y={y + 3} textAnchor="end" fontSize={10} fill="var(--text-3)" fontFamily="var(--font-mono)">{fmtMoneyAxis(maxT * g / 4)}</text>);
    if (ctxOn) kids.push(<text key={`rt${g}`} x={x1 - 20} y={y + 3} textAnchor="start" fontSize={10} fill="var(--text-3)" fontFamily="var(--font-mono)">{fmtTokensAxis(maxCtx * g / 4)}</text>);
  }
  for (let i = 0; i < buckets.length; i += 1) {
    let acc = 0;
    for (const s of series) {
      const v = s.cost[i] || 0; const h = (v / maxT) * (y1 - y0);
      if (h < 0.4) continue;
      kids.push(<rect key={`b${i}${s.key}`} x={px(i)} y={y1 - acc - h} width={barW} height={h} fill={s.color} opacity={hover && hover !== s.key ? 0.22 : 1} rx={1.5} />);
      acc += h;
    }
  }
  if (ctxOn) {
    for (const s of series) {
      if (s.key === REST_KEY) continue;
      const dim = hover && hover !== s.key ? 0.16 : 1;
      let d = ""; let started = false;
      s.ctx.forEach((v, i) => { if (!Number.isFinite(v)) return; d += (started ? "L" : "M") + ux(i).toFixed(1) + " " + uyC(v).toFixed(1); started = true; });
      if (d) kids.push(<path key={`cx${s.key}`} d={d} fill="none" stroke={s.color} strokeWidth={2} strokeDasharray="5 3" strokeLinejoin="round" strokeLinecap="round" opacity={dim} />);
      s.resets.forEach((ri, k) => { const j = ri > 0 ? ri - 1 : 0; if (Number.isFinite(s.ctx[j])) kids.push(<circle key={`cc${s.key}${k}`} cx={ux(j)} cy={uyC(s.ctx[j])} r={3} fill="var(--bg-2)" stroke={s.color} strokeWidth={1.6} opacity={dim} />); });
    }
  }
  const lblStep = Math.max(Math.ceil(N / 8), 1);
  for (let i = 0; i < buckets.length; i += 1) {
    if (hoverBucket === i) kids.push(<rect key={`hl${i}`} x={x0 + 34 + slot * i} y={y0} width={slot} height={y1 - y0} fill="var(--text-0)" fillOpacity={0.04} pointerEvents="none" />);
    kids.push(<rect key={`ht${i}`} x={x0 + 34 + slot * i} y={y0} width={slot} height={y1 - y0} fill="transparent"
      onMouseEnter={() => setHoverBucket(i)} onMouseLeave={() => setHoverBucket(null)} />);
    if (i % lblStep === 0) kids.push(<text key={`xl${i}`} x={ux(i)} y={y1 + 18} textAnchor="middle" fontSize={10} fill="var(--text-3)" fontFamily="var(--font-mono)" pointerEvents="none">{fmtBucketLabel(buckets[i], interval.minutes)}</text>);
  }
  return (
    <div ref={containerRef} style={{ width: "100%", cursor: "grab", touchAction: "none" }}
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onDoubleClick={() => props.onPan(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block", userSelect: "none" }}>{kids}</svg>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Compare mode (A current vs B previous window)
// ─────────────────────────────────────────────────────────────────────────────

function CompareCard({ a, b, rangeLabel }: { a: TokenUsageAggregate | null; b: TokenUsageAggregate | null; rangeLabel: string }) {
  if (!a) return null;
  const costA = a.parties.reduce((x, p) => x + p.estCostUsd, 0);
  const costB = b ? b.parties.reduce((x, p) => x + p.estCostUsd, 0) : undefined;
  const lowSample = (a.recordCount || 0) < 8 || (b?.recordCount || 0) < 8;
  const rows: Array<{ label: string; av?: number; bv?: number; fmt: (n?: number) => string; higherWorse: boolean }> = [
    { label: "비용", av: costA, bv: costB, fmt: (n) => fmtCost(n), higherWorse: true },
    { label: "시간당", av: a.ratePerHour, bv: b?.ratePerHour, fmt: (n) => fmtRate(n), higherWorse: true },
    { label: "오버헤드", av: a.overheadRatio, bv: b?.overheadRatio, fmt: (n) => (n == null ? "—" : `${Math.round(n * 100)}%`), higherWorse: true },
    { label: "턴", av: a.totals.turns, bv: b?.totals.turns, fmt: (n) => (n == null ? "—" : String(Math.round(n))), higherWorse: false },
  ];
  return (
    <div style={{ background: "var(--bg-2)", border: "1px solid var(--accent-bd)", borderRadius: 14, padding: "14px 18px", display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}><span style={sectionTitle}>구간 비교 — A 현재 vs B 직전</span><span className="wb-mono" style={{ fontSize: 10.5, color: "var(--text-3)" }}>{rangeLabel}</span></div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
        {rows.map((r) => {
          const delta = r.av != null && r.bv != null && r.bv !== 0 ? (r.av - r.bv) / r.bv * 100 : undefined;
          const worse = delta != null && ((r.higherWorse && delta > 0) || (!r.higherWorse && delta < 0));
          const col = delta == null ? "var(--text-3)" : worse ? "var(--danger)" : "var(--success)";
          return (
            <div key={r.label} style={{ display: "flex", flexDirection: "column", gap: 4, padding: "8px 10px", background: "var(--bg-1)", border: "1px solid var(--border-subtle)", borderRadius: 9 }}>
              <span style={{ fontSize: 10.5, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: 0.3 }}>{r.label}</span>
              <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}><span className="wb-mono" style={{ fontSize: 16, fontWeight: 600, color: "var(--text-0)" }}>{r.fmt(r.av)}</span><span className="wb-mono" style={{ fontSize: 11, color: "var(--text-3)" }}>vs {r.fmt(r.bv)}</span></div>
              <span className="wb-mono" style={{ fontSize: 11, fontWeight: 700, color: col }}>{delta == null ? "표본 없음" : `${delta >= 0 ? "▲ +" : "▼ "}${Math.round(Math.abs(delta))}%`}</span>
            </div>
          );
        })}
      </div>
      {lowSample && <div style={{ fontSize: 10.5, color: "var(--live)" }}>⚠ 표본이 적어(A {a.recordCount}턴 · B {b?.recordCount ?? 0}턴) 델타는 노이즈일 수 있습니다 — 신뢰 판단은 표본이 쌓인 뒤에.</div>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// e. Catalog
// ─────────────────────────────────────────────────────────────────────────────

interface CatRow { id: string; name: string; status: "active" | "archived"; cost: number; inTok: number; outTok: number; tokens: number; row: RollupRow }

function Catalog(props: {
  rows: CatRow[]; members: RollupRow[]; archPinned: Record<string, boolean>;
  hiddenParties: Record<string, boolean>; hiddenMembers: Record<string, boolean>;
  onToggleParty: (id: string) => void; onToggleMember: (pid: string, m: string) => void;
  pickerOpen: boolean; setPickerOpen: (v: boolean) => void; onPinArchived: (id: string) => void;
}) {
  const { rows, members, archPinned, hiddenParties, hiddenMembers } = props;
  const [pq, setPq] = useState("");
  const shown = rows.filter((p) => p.status === "active" || archPinned[p.id]);
  const archived = rows.filter((p) => p.status === "archived");
  const archMatches = archived.filter((p) => !pq.trim() || p.name.toLowerCase().includes(pq.toLowerCase()) || p.id.includes(pq));
  const pinnedCount = archived.filter((p) => archPinned[p.id]).length;

  return (
    <section style={{ ...cardSection, gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <span style={sectionTitle}>카탈로그</span>
        <span style={{ fontSize: 10.5, color: "var(--text-3)" }}>파티·멤버를 클릭해 그래프에서 켜고 끕니다 · 비용 우선 · ↑입력 ↓출력 · 이름이 같아도 #id·기간으로 분리</span>
        <div style={{ flex: 1 }} />
        <div style={{ position: "relative" }}>
          <button onClick={() => { props.setPickerOpen(!props.pickerOpen); setPq(""); }} style={{ display: "inline-flex", alignItems: "center", gap: 6, height: 28, padding: "0 10px", background: "var(--bg-1)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 11, fontWeight: 600, color: "var(--text-1)", cursor: "pointer" }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" strokeLinecap="round" /></svg>이전 파티 검색{pinnedCount > 0 && <span className="wb-mono" style={{ fontSize: 9.5, background: "var(--accent)", color: "var(--accent-fg)", borderRadius: 8, padding: "0 5px" }}>{pinnedCount}</span>}
          </button>
          {props.pickerOpen && (
            <div style={{ position: "absolute", top: 32, right: 0, zIndex: 30, width: 280, background: "var(--bg-2)", border: "1px solid var(--border)", borderRadius: 10, boxShadow: "0 20px 50px -14px rgba(0,0,0,.55)", padding: 8 }}>
              <input autoFocus value={pq} onChange={(e) => setPq(e.target.value)} placeholder="지운 파티 이름·#id 검색" style={{ width: "100%", height: 30, padding: "0 9px", background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 11.5, color: "var(--text-0)", outline: "none", fontFamily: "var(--font-sans)", boxSizing: "border-box" }} />
              <div style={{ maxHeight: 220, overflow: "auto", marginTop: 6, display: "flex", flexDirection: "column", gap: 2 }}>
                {archMatches.length === 0 && <span style={{ fontSize: 11, color: "var(--text-3)", padding: "10px 4px" }}>보관된 파티가 없습니다.</span>}
                {archMatches.map((p) => (
                  <button key={p.id} onClick={() => props.onPinArchived(p.id)} style={{ display: "flex", alignItems: "center", gap: 7, height: 32, padding: "0 8px", borderRadius: 7, border: "none", cursor: "pointer", background: archPinned[p.id] ? "var(--accent-dim)" : "transparent", fontFamily: "var(--font-sans)", textAlign: "left" }}>
                    <span style={{ width: 9, height: 9, borderRadius: 3, background: colorForKey(p.name), flex: "none" }} />
                    <span style={{ fontSize: 11.5, color: "var(--text-1)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
                    <span className="wb-mono" style={{ fontSize: 9.5, color: "var(--text-3)" }}>#{p.id.slice(-4)}</span>
                    <span className="wb-mono" style={{ fontSize: 10.5, color: "var(--text-2)" }}>{fmtCost(p.cost)}</span>
                    {archPinned[p.id] && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth={2.4}><path d="M5 12l5 5L20 7" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
      <div style={{ display: "flex", gap: 12, overflowX: "auto", paddingBottom: 4 }}>
        {shown.length === 0 && <span style={{ fontSize: 11.5, color: "var(--text-3)" }}>아직 없음</span>}
        {shown.map((p) => {
          const off = hiddenParties[p.id];
          return (
            <div key={p.id} style={{ flex: "none", width: 218, background: "var(--bg-1)", border: "1px solid var(--border-subtle)", borderRadius: 12, padding: "11px 12px", opacity: off ? 0.5 : 1 }}>
              <div onClick={() => props.onToggleParty(p.id)} style={{ display: "flex", alignItems: "flex-start", gap: 7, cursor: "pointer" }}>
                <span style={{ width: 10, height: 10, borderRadius: 3, background: colorForKey(p.name), flex: "none", marginTop: 3 }} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 5 }}>
                    <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text-0)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textDecoration: off ? "line-through" : "none" }}>{p.name}</span>
                    <span className="wb-mono" style={{ fontSize: 9.5, color: "var(--text-3)" }}>#{p.id.slice(-4)}</span>
                    {p.status === "archived" && <span style={{ fontSize: 8.5, fontWeight: 700, color: "var(--text-2)", background: "var(--bg-3)", padding: "1px 4px", borderRadius: 3 }}>보관</span>}
                  </div>
                </div>
                <div style={{ textAlign: "right", flex: "none" }}>
                  <div className="wb-mono" style={{ fontSize: 13.5, fontWeight: 700, color: "var(--text-0)" }}>{fmtCost(p.cost)}</div>
                  <div className="wb-mono" style={{ fontSize: 9.5, color: "var(--text-3)" }}>↑{fmtTokens(p.inTok)} ↓{fmtTokens(p.outTok)}</div>
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 9 }}>
                {members.filter((m) => m.key.startsWith(p.id + ":")).sort((a, b) => b.estCostUsd - a.estCostUsd).slice(0, 6).map((m) => {
                  const io = ioOf(m); const moff = hiddenMembers[`${p.id}:${m.label}`];
                  return (
                    <div key={m.key} onClick={(e) => { e.stopPropagation(); props.onToggleMember(p.id, m.label); }} style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", opacity: moff ? 0.45 : 1 }}>
                      <span style={{ width: 7, height: 7, borderRadius: 2, background: moff ? "var(--border-strong)" : colorForKey(m.label), flex: "none" }} />
                      <span style={{ fontSize: 10.5, color: "var(--text-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, textDecoration: moff ? "line-through" : "none" }}>{m.label}</span>
                      <div style={{ textAlign: "right" }}><span className="wb-mono" style={{ fontSize: 10.5, fontWeight: 600, color: "var(--text-1)" }}>{fmtCost(m.estCostUsd)}</span><div className="wb-mono" style={{ fontSize: 8.5, color: "var(--text-3)" }}>↑{fmtTokens(io.inTok)} ↓{fmtTokens(io.outTok)}</div></div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <span style={{ fontSize: 10.5, color: "var(--text-3)", display: "flex", alignItems: "center", gap: 6 }}><span style={{ width: 14, height: 2, background: "var(--text-0)", flex: "none" }} />Claude 5시간 소진률(실측) · 지운 파티는 <b style={{ color: "var(--text-2)", fontWeight: 600 }}>이전 파티 검색</b>으로 다시 추가</span>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// f. Bucket cost table (transposed) — cost cells with model-tint mini bars
// ─────────────────────────────────────────────────────────────────────────────

function BucketCostTable(props: {
  series: Series[]; buckets: number[]; interval: { minutes: number }; scopeLabel: string;
  dataMode: "cost" | "pct"; setDataMode: (m: "cost" | "pct") => void; rangeLabel: string;
  turns: TurnUsageRecord[]; scope: string;
}) {
  const { series, buckets, interval, dataMode } = props;
  const times = buckets.map((b) => fmtBucketLabel(b, interval.minutes));
  // Align the horizontal scroll to the newest bucket (the chart's right/live edge)
  // whenever the window shifts, so the populated recent buckets are what you see —
  // a wide interval otherwise opens on the empty oldest columns. Manual scroll-left
  // to inspect older buckets still works; only a window change re-aligns.
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastBucket = buckets[buckets.length - 1];
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [lastBucket, buckets.length, series.length]);
  // Fixed column widths (not 1fr) so every row computes an identical intrinsic
  // width; rows are `max-content` so the container truly scrolls horizontally and
  // the sticky left column pins instead of scrolling with the cells. (gridTpl is
  // built below from displayCols, which may fold idle runs.)
  const rowW: React.CSSProperties = { width: "max-content", minWidth: "100%" };
  const [pin, setPin] = useState<{ x: number; y: number; series: string; time: string; prev: string; next: string } | null>(null);
  const [foldIdle, setFoldIdle] = useState(true); // collapse buckets where every visible member is idle
  // per (series,bucket) dominant model/effort for cell tint/height, from turns
  const meta = useMemo(() => {
    const m = new Map<string, { model?: string; effort?: string }>();
    const width = interval.minutes * 60_000; const from = buckets[0] ?? 0;
    for (const r of props.turns) {
      // Cell tint/height + the change badge track the member's own model·effort;
      // the gate reviewer's turns are a different agent and must not trigger a
      // phantom "opus→sonnet" change or repaint the cell in the reviewer's color.
      if (!isMemberModelTurn(r.trigger)) continue;
      const key = props.scope === "all" ? (r.partyId || "(none)") : (r.member || "(unknown)");
      const bi = Math.floor((Date.parse(r.at) - from) / width);
      m.set(`${key}:${bi}`, { model: r.model, effort: r.effort });
    }
    return m;
  }, [props.turns, buckets, interval.minutes, props.scope]);

  // model·effort change points per series (a bucket whose model/effort differs
  // from the previous active bucket) → renders a ⇄ pin badge.
  const changes = useMemo(() => {
    const set = new Map<string, { prev: string; next: string }>();
    for (const s of series) {
      let last: { model?: string; effort?: string } | null = null;
      for (let i = 0; i < buckets.length; i += 1) {
        const md = meta.get(`${s.key}:${i}`);
        if (!md || (s.cost[i] || 0) <= 0) continue;
        if (last && (last.model !== md.model || last.effort !== md.effort)) {
          set.set(`${s.key}:${i}`, { prev: `${modelLabel(last.model)} ${last.effort || ""}`, next: `${modelLabel(md.model)} ${md.effort || ""}` });
        }
        last = md;
      }
    }
    return set;
  }, [series, meta, buckets]);

  const bucketTotals = buckets.map((_, i) => series.reduce((a, s) => a + (s.cost[i] || 0), 0));

  // Collapse consecutive buckets where EVERY visible member is idle (total 0) into
  // one narrow "⋯N" column — the table then shows the active buckets instead of a
  // sea of $0.000. Toggleable; each active bucket keeps its real index for tint/badge.
  const displayCols: Array<{ kind: "b"; i: number } | { kind: "gap"; from: number; to: number; count: number }> = [];
  {
    let run: number[] = [];
    const flush = () => { if (run.length) { displayCols.push({ kind: "gap", from: run[0], to: run[run.length - 1], count: run.length }); run = []; } };
    for (let i = 0; i < buckets.length; i += 1) {
      if (foldIdle && (bucketTotals[i] || 0) <= 0) run.push(i);
      else { flush(); displayCols.push({ kind: "b", i }); }
    }
    flush();
  }
  const gridTpl = "140px " + (displayCols.map((c) => (c.kind === "gap" ? "46px" : "62px")).join(" ") || "62px");
  const idleFolded = displayCols.reduce((a, c) => a + (c.kind === "gap" ? c.count : 0), 0);

  return (
    <section style={{ ...cardSection, gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <span style={sectionTitle}>봉별 실제 수치</span>
        <span className="wb-mono" style={{ fontSize: 10.5, color: "var(--text-3)" }}>{props.rangeLabel} · {props.scopeLabel}</span>
        <div style={{ flex: 1 }} />
        <button onClick={() => setFoldIdle((v) => !v)} title="전 멤버가 유휴인 구간을 접어서 표시" style={{ display: "inline-flex", alignItems: "center", gap: 5, height: 26, padding: "0 10px", borderRadius: 7, fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "var(--font-sans)", background: foldIdle ? "var(--accent-dim)" : "var(--bg-1)", border: `1px solid ${foldIdle ? "var(--accent-bd)" : "var(--border)"}`, color: foldIdle ? "var(--accent)" : "var(--text-2)" }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M8 7l-4 5 4 5M16 7l4 5-4 5" strokeLinecap="round" strokeLinejoin="round" /></svg>
          유휴 접기{foldIdle && idleFolded > 0 ? ` · ${idleFolded}` : ""}
        </button>
        <div style={{ ...pillGroup, background: "var(--bg-1)", borderRadius: 8 }}>
          {[{ k: "cost", l: "비용" }, { k: "pct", l: "한도 %" }].map((d) => <button key={d.k} onClick={() => props.setDataMode(d.k as "cost" | "pct")} style={segBtnSmall(dataMode === d.k)}>{d.l}</button>)}
        </div>
      </div>
      <div ref={scrollRef} data-tu="bucket-scroll" style={{ maxHeight: 288, overflow: "auto", border: "1px solid var(--border-subtle)", borderRadius: 10 }}>
        <div style={{ display: "grid", gridTemplateColumns: gridTpl, ...rowW, position: "sticky", top: 0, zIndex: 3, background: "var(--bg-3)", borderBottom: "1px solid var(--border)" }}>
          <span style={{ position: "sticky", left: 0, zIndex: 5, background: "var(--bg-3)", padding: "8px 11px", fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.3, color: "var(--text-3)", borderRight: "1px solid var(--border)" }}>시각</span>
          {displayCols.map((c, ci) => c.kind === "b"
            ? <span key={ci} className="wb-mono" style={{ padding: "8px 8px", fontSize: 10.5, fontWeight: 700, textAlign: "right", color: "var(--text-2)" }}>{times[c.i]}</span>
            : <span key={ci} className="wb-mono" title={`${times[c.from]} – ${times[c.to]} · ${c.count}개 봉 전원 유휴`} style={{ padding: "8px 2px", fontSize: 9.5, fontWeight: 700, textAlign: "center", color: "var(--text-3)", background: "var(--bg-2)", borderLeft: "1px dashed var(--border)", borderRight: "1px dashed var(--border)" }}>⋯{c.count}</span>)}
        </div>
        {series.filter((s) => s.key !== REST_KEY).map((s) => (
          <div key={s.key} style={{ display: "grid", gridTemplateColumns: gridTpl, ...rowW, background: "var(--bg-2)", borderBottom: "1px solid var(--border-subtle)" }}>
            <span style={{ position: "sticky", left: 0, zIndex: 4, background: "var(--bg-2)", padding: "6px 11px", display: "flex", alignItems: "center", gap: 6, borderRight: "1px solid var(--border)" }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: s.color, flex: "none" }} /><span style={{ fontSize: 11, fontWeight: 500, color: "var(--text-0)", whiteSpace: "nowrap" }}>{s.name}</span>
            </span>
            {displayCols.map((c, ci) => {
              if (c.kind === "gap") return <span key={ci} style={{ background: "var(--bg-1)", borderLeft: "1px dashed var(--border-subtle)", borderRight: "1px dashed var(--border-subtle)" }} />;
              const i = c.i;
              const md = meta.get(`${s.key}:${i}`);
              const v = s.cost[i] || 0;
              const fillH = v > 0 && md ? effortHeight(md.effort) : 0;
              const chg = changes.get(`${s.key}:${i}`);
              return (
                <span key={ci} className="wb-mono" style={{ position: "relative", padding: "6px 8px", fontSize: 10.5, textAlign: "right", color: v > 0 ? "var(--text-0)" : "var(--text-3)", overflow: "visible" }}>
                  {v > 0 && <span style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: `${fillH}%`, background: cellTint(md?.model), zIndex: 0 }} />}
                  {chg && <button title="모델·effort 변경" onClick={(e) => { e.stopPropagation(); const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setPin({ x: r.left, y: r.bottom + 4, series: s.name, time: times[i], prev: chg.prev, next: chg.next }); }} style={{ position: "absolute", left: 3, top: 3, zIndex: 2, width: 17, height: 14, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--live-dim)", border: "1px solid var(--live-bd)", borderRadius: 4, cursor: "pointer", padding: 0 }}><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="var(--live)" strokeWidth={2.4}><path d="M7 4L3 8l4 4M3 8h13M17 20l4-4-4-4M21 16H8" strokeLinecap="round" strokeLinejoin="round" /></svg></button>}
                  <span style={{ position: "relative", zIndex: 1 }}>{dataMode === "cost" ? fmtCost(v, "$") : (bucketTotals[i] > 0 ? `${Math.round(v / bucketTotals[i] * 100)}%` : "0%")}</span>
                </span>
              );
            })}
          </div>
        ))}
        <div style={{ display: "grid", gridTemplateColumns: gridTpl, ...rowW, background: "var(--bg-1)" }}>
          <span style={{ position: "sticky", left: 0, zIndex: 4, background: "var(--bg-1)", padding: "6px 11px", fontSize: 11, fontWeight: 700, color: "var(--text-0)", borderRight: "1px solid var(--border)" }}>합계</span>
          {displayCols.map((c, ci) => c.kind === "b"
            ? <span key={ci} className="wb-mono" style={{ padding: "6px 8px", fontSize: 10.5, textAlign: "right", color: "var(--text-0)", fontWeight: 600 }}>{dataMode === "cost" ? fmtCost(bucketTotals[c.i], "$") : "100%"}</span>
            : <span key={ci} style={{ background: "var(--bg-1)", borderLeft: "1px dashed var(--border-subtle)", borderRight: "1px dashed var(--border-subtle)" }} />)}
        </div>
      </div>
      <span style={{ fontSize: 10.5, color: "var(--text-3)", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        가로축 = 시간 봉(차트와 동일) · 배경=모델색, 채움 높이=effort · <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}><span style={{ width: 15, height: 12, background: "var(--live-dim)", border: "1px solid var(--live-bd)", borderRadius: 3, flex: "none" }} />= 모델·effort 변경 봉 (클릭)</span> · <span style={{ fontWeight: 600, color: "var(--text-2)" }}>⋯N</span> = 전원 유휴 N봉 접힘
        {["opus", "sonnet", "gpt-5", "haiku"].map((m) => <span key={m} style={{ display: "inline-flex", alignItems: "center", gap: 3 }}><span style={{ width: 9, height: 9, borderRadius: 2, background: modelColor(m), flex: "none" }} />{m}</span>)}
      </span>
      {pin && (
        <>
          <div onClick={() => setPin(null)} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
          <div style={{ position: "fixed", left: Math.min(pin.x, window.innerWidth - 220), top: pin.y, zIndex: 41, width: 200, background: "var(--bg-2)", border: "1px solid var(--live-bd)", borderRadius: 10, boxShadow: "0 16px 40px -10px rgba(0,0,0,.5)", padding: "10px 12px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}><span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-0)" }}>{pin.series}</span><span className="wb-mono" style={{ fontSize: 10, color: "var(--text-3)" }}>{pin.time}</span></div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11.5 }}>
              <span className="wb-mono" style={{ color: "var(--text-2)", background: "var(--bg-3)", padding: "2px 7px", borderRadius: 5 }}>{pin.prev}</span>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--live)" strokeWidth={2}><path d="M5 12h14M13 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" /></svg>
              <span className="wb-mono" style={{ color: "var(--text-0)", fontWeight: 600, background: "var(--live-dim)", border: "1px solid var(--live-bd)", padding: "2px 7px", borderRadius: 5 }}>{pin.next}</span>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// g. Who table — party ▸ member, cost-first
// ─────────────────────────────────────────────────────────────────────────────

function WhoTable(props: {
  agg: TokenUsageAggregate | null; parties: Array<{ id: string; name: string }>; activeIds: Set<string>;
  sort: { key: SortKey; dir: "asc" | "desc" }; setSort: (s: { key: SortKey; dir: "asc" | "desc" }) => void;
  expanded: Record<string, boolean>; setExpanded: (e: Record<string, boolean>) => void;
  hover: string | null; setHover: (h: string | null) => void; onDrill: (d: { partyId: string; member: string; color: string }) => void;
  tableQuery: string; setTableQuery: (q: string) => void; showArchived: boolean; setShowArchived: (v: boolean) => void; utilPct?: number;
}) {
  const { agg, parties, activeIds, sort, expanded, hover, utilPct } = props;
  const cols = "minmax(200px,1.7fr) 92px 54px 118px minmax(150px,1.4fr) 84px 58px 74px 78px";
  const heads: Array<{ k: SortKey; label: string; j: string }> = [
    { k: "name", label: "파티 / 멤버", j: "flex-start" }, { k: "active", label: "활성 시간", j: "flex-end" }, { k: "turns", label: "턴", j: "flex-end" },
    { k: "cost", label: "비용·토큰", j: "flex-end" }, { k: "share", label: "점유율", j: "flex-start" }, { k: "rate", label: "시간당", j: "flex-end" },
    { k: "cache", label: "캐시", j: "flex-end" }, { k: "overhead", label: "오버헤드", j: "flex-end" }, { k: "est", label: "~추정 한도%", j: "flex-end" },
  ];
  const partyRows = (agg?.parties || []).filter((p) => props.showArchived || activeIds.has(p.key));
  const q = props.tableQuery.trim().toLowerCase();
  const filtered = q ? partyRows.filter((p) => (partyName(p.key, parties)).toLowerCase().includes(q) || p.key.includes(q)) : partyRows;
  const grandEst = (agg?.parties || []).reduce((a, r) => a + r.estCostUsd, 0);
  const totalCost = agg?.parties.reduce((a, p) => a + p.estCostUsd, 0) || 0;
  const sv = (r: RollupRow, k: SortKey) => k === "active" ? r.activeMs : k === "turns" ? r.turns : k === "cost" || k === "share" ? r.estCostUsd : k === "rate" ? (r.ratePerHour || 0) : k === "cache" ? (r.cacheHitRate || 0) : k === "overhead" ? (r.overheadRatio || 0) : k === "est" ? r.estCostUsd : 0;
  const sortRows = (rows: RollupRow[]) => [...rows].sort((a, b) => sort.key === "name" ? (sort.dir === "desc" ? -1 : 1) * a.label.localeCompare(b.label) : (sort.dir === "desc" ? -1 : 1) * (sv(a, sort.key) - sv(b, sort.key)));
  const membersOf = (pid: string) => sortRows((agg?.members || []).filter((m) => m.key.startsWith(pid + ":")));
  const nActive = partyRows.filter((p) => activeIds.has(p.key)).length;

  return (
    <section style={{ background: "var(--bg-2)", border: "1px solid var(--border)", borderRadius: 14, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "14px 18px 10px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}><span style={sectionTitle}>누가 — 파티 ▸ 멤버</span><span style={{ fontSize: 10.5, color: "var(--text-3)" }}>소진 많은 순</span></div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className="wb-mono" style={{ fontSize: 10.5, color: "var(--text-2)" }}>{filtered.length}개 파티 · 활성 {nActive}</span>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 6, height: 28, padding: "0 9px", background: "var(--bg-1)", border: "1px solid var(--border)", borderRadius: 8 }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" strokeWidth={2}><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" strokeLinecap="round" /></svg>
            <input value={props.tableQuery} onChange={(e) => props.setTableQuery(e.target.value)} placeholder="파티 이름·#id 검색" style={{ background: "transparent", border: "none", outline: "none", fontSize: 11, color: "var(--text-0)", width: 130, fontFamily: "var(--font-sans)" }} />
          </div>
          <button onClick={() => props.setShowArchived(!props.showArchived)} style={{ height: 28, padding: "0 10px", borderRadius: 8, fontSize: 11, fontWeight: 600, cursor: "pointer", background: props.showArchived ? "var(--accent-dim)" : "var(--bg-1)", border: `1px solid ${props.showArchived ? "var(--accent-bd)" : "var(--border)"}`, color: props.showArchived ? "var(--accent)" : "var(--text-2)" }}>보관 파티 포함</button>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: cols, padding: "0 18px 8px", borderBottom: "1px solid var(--border-subtle)", fontSize: 10.5, fontWeight: 600, letterSpacing: 0.3, textTransform: "uppercase", color: "var(--text-3)" }}>
        {heads.map((h) => <button key={h.k} onClick={() => props.setSort({ key: h.k, dir: sort.key === h.k && sort.dir === "desc" ? "asc" : "desc" })} style={{ display: "flex", alignItems: "center", gap: 4, justifyContent: h.j as any, background: "transparent", border: "none", padding: 0, cursor: "pointer", font: "inherit", letterSpacing: 0.3, textTransform: "uppercase", color: sort.key === h.k ? "var(--text-1)" : "var(--text-3)" }}>{h.label}<span style={{ opacity: sort.key === h.k ? 1 : 0, fontSize: 9 }}>{sort.dir === "desc" ? "▼" : "▲"}</span></button>)}
      </div>
      <div>
        {sortRows(filtered).map((p) => {
          const open = !!expanded[p.key];
          const share = totalCost > 0 ? Math.min(p.estCostUsd / totalCost * 100, 100) : 0;
          const io = ioOf(p);
          const active = activeIds.has(p.key);
          return (
            <div key={p.key}>
              <div data-tu="party-row" data-pid={p.key} onClick={() => props.setExpanded({ ...expanded, [p.key]: !open })} style={{ display: "grid", gridTemplateColumns: cols, alignItems: "center", padding: "10px 18px", cursor: "pointer", background: open ? "var(--bg-1)" : "transparent", borderBottom: "1px solid var(--border-subtle)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" strokeWidth={2.2} style={{ flex: "none", transform: open ? "rotate(90deg)" : "none", transition: "transform .15s" }}><path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  <span style={{ width: 10, height: 10, borderRadius: 3, background: colorForKey(partyName(p.key, parties)), flex: "none" }} />
                  <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-0)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{partyName(p.key, parties)}</span>
                  <span className="wb-mono" style={{ fontSize: 9.5, color: "var(--text-3)", flex: "none" }}>#{p.key.slice(-4)}</span>
                  <span style={{ fontSize: 8.5, fontWeight: 700, flex: "none", padding: "1px 5px", borderRadius: 3, color: active ? "var(--success)" : "var(--text-2)", background: active ? "var(--success-dim)" : "var(--bg-3)" }}>{active ? "활성" : "보관"}</span>
                  <span className="wb-mono" style={{ fontSize: 10, color: "var(--text-3)", flex: "none" }}>{membersOf(p.key).length}명</span>
                </div>
                <span className="wb-mono" style={numCell("var(--text-1)")}>{fmtActive(p.activeMs)}</span>
                <span className="wb-mono" style={numCell("var(--text-2)")}>{p.turns}</span>
                <div style={{ textAlign: "right" }}><div className="wb-mono" style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text-0)" }}>{fmtCost(p.estCostUsd)}</div><div className="wb-mono" style={{ fontSize: 9.5, color: "var(--text-3)" }}>↑{fmtTokens(io.inTok)} ↓{fmtTokens(io.outTok)}</div></div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, paddingLeft: 14 }}><div style={barTrack}><div style={{ height: "100%", width: `${share}%`, background: "var(--accent)", borderRadius: 4 }} /></div><span className="wb-mono" style={{ fontSize: 12, fontWeight: 600, color: "var(--text-1)", width: 34, textAlign: "right" }}>{Math.round(share)}%</span></div>
                <span className="wb-mono" style={numCell("var(--text-1)")}>{fmtRate(p.ratePerHour)}</span>
                <span className="wb-mono" style={numCell((p.cacheHitRate ?? 1) < 0.5 ? "var(--live)" : "var(--text-1)")}>{p.cacheHitRate == null ? "—" : `${Math.round(p.cacheHitRate * 100)}%`}</span>
                <span className="wb-mono" style={numCell((p.overheadRatio ?? 0) >= 0.5 ? "var(--live)" : "var(--text-1)")}>{p.overheadRatio == null ? "—" : `${Math.round(p.overheadRatio * 100)}%`}</span>
                <span className="wb-mono" style={{ ...numCell("var(--text-3)"), fontStyle: "italic" }}>{active && grandEst > 0 && utilPct !== undefined ? `~${((p.estCostUsd / grandEst) * utilPct).toFixed(1)}%` : "—"}</span>
              </div>
              {open && membersOf(p.key).map((m) => {
                const mName = m.label; const color = colorForKey(mName); const io2 = ioOf(m);
                const mShare = p.estCostUsd > 0 ? Math.min(m.estCostUsd / p.estCostUsd * 100, 100) : 0;
                const model = m.lastModel ? { model: m.lastModel, effort: m.lastEffort } : undefined;
                return (
                  <div key={m.key} data-tu="member-row" data-member={mName} onClick={() => props.onDrill({ partyId: p.key, member: mName, color })} onMouseEnter={() => props.setHover(mName)} onMouseLeave={() => props.setHover(null)} style={{ display: "grid", gridTemplateColumns: cols, alignItems: "center", padding: "9px 18px", cursor: "pointer", borderBottom: "1px solid var(--border-subtle)", opacity: hover && hover !== mName ? 0.32 : 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, paddingLeft: 22 }}>
                      <span style={{ width: 9, height: 9, borderRadius: 3, background: color, flex: "none" }} />
                      <span style={{ fontSize: 12.5, fontWeight: 500, color: "var(--text-0)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{mName}</span>
                      {model && <span style={{ display: "inline-flex", alignItems: "center", gap: 4, flex: "none", fontSize: 9.5, fontFamily: "var(--font-mono)", color: "var(--text-2)", background: "var(--bg-3)", padding: "1px 5px", borderRadius: 4 }}>{modelLabel(model.model)} {model.effort}<span style={{ color: "var(--text-3)", letterSpacing: -1 }}>{tierBars(model.model)}</span></span>}
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" strokeWidth={1.8} style={{ flex: "none", opacity: 0.6 }}><path d="M7 17L17 7M9 7h8v8" strokeLinecap="round" strokeLinejoin="round" /></svg>
                    </div>
                    <span className="wb-mono" style={numCell("var(--text-1)")}>{fmtActive(m.activeMs)}</span>
                    <span className="wb-mono" style={numCell("var(--text-2)")}>{m.turns}</span>
                    <div style={{ textAlign: "right" }}><div className="wb-mono" style={{ fontSize: 12, fontWeight: 600, color: "var(--text-0)" }}>{fmtCost(m.estCostUsd)}</div><div className="wb-mono" style={{ fontSize: 9.5, color: "var(--text-3)" }}>↑{fmtTokens(io2.inTok)} ↓{fmtTokens(io2.outTok)}</div></div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, paddingLeft: 14 }}><div style={{ ...barTrack, height: 6 }}><div style={{ height: "100%", width: `${mShare}%`, background: color, borderRadius: 3 }} /></div><span className="wb-mono" style={{ fontSize: 11.5, color: "var(--text-1)", width: 34, textAlign: "right" }}>{Math.round(mShare)}%</span></div>
                    <span className="wb-mono" style={numCell("var(--text-1)")}>{fmtRate(m.ratePerHour)}</span>
                    <span className="wb-mono" style={numCell((m.cacheHitRate ?? 1) < 0.5 ? "var(--live)" : "var(--text-1)")}>{m.cacheHitRate == null ? "—" : `${Math.round(m.cacheHitRate * 100)}%`}</span>
                    <span className="wb-mono" style={numCell((m.overheadRatio ?? 0) >= 0.5 ? "var(--live)" : "var(--text-1)")}>{m.overheadRatio == null ? "—" : `${Math.round(m.overheadRatio * 100)}%`}</span>
                    <span className="wb-mono" style={{ ...numCell("var(--text-3)"), fontStyle: "italic" }}>{grandEst > 0 && utilPct !== undefined ? `~${((m.estCostUsd / grandEst) * utilPct).toFixed(1)}%` : "—"}</span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      <div style={{ padding: "9px 18px", display: "flex", alignItems: "center", gap: 10, fontSize: 10.5, color: "var(--text-3)", flexWrap: "wrap" }}>
        <span>↑ 입력 · ↓ 출력 · 비용 ≈ 리스트 단가 환산</span><span style={{ fontStyle: "italic" }}>기울임·~ 열은 추정값 (멤버별 한도 배분 근사) — 실측 아님</span><span>지운 파티는 보관으로 남고 · 이름 같아도 #id·기간으로 분리</span>
      </div>
    </section>
  );
}

function partyName(id: string, parties: Array<{ id: string; name: string }>): string { return parties.find((p) => p.id === id)?.name || id; }

// ─────────────────────────────────────────────────────────────────────────────
// Member drill-in
// ─────────────────────────────────────────────────────────────────────────────

function MemberDrillIn(props: { drill: { partyId: string; member: string; color: string }; agg: TokenUsageAggregate | null; windowBounds: { fromMs: number; toMs: number }; onBack: () => void; onOpenChat: () => void }) {
  const { drill, agg, windowBounds } = props;
  const row = (agg?.members || []).find((m) => m.key === `${drill.partyId}:${drill.member}`);
  const [turns, setTurns] = useState<TurnUsageRecord[] | null>(null);
  useEffect(() => {
    let alive = true; const api = window.agentParty.getTokenUsageTurns; if (!api) { setTurns([]); return; }
    setTurns(null);
    (api({ fromMs: windowBounds.fromMs, toMs: windowBounds.toMs, partyId: drill.partyId, member: drill.member }) as Promise<TurnUsageRecord[]>).then((r) => { if (alive) setTurns(Array.isArray(r) ? r : []); }).catch(() => { if (alive) setTurns([]); });
    return () => { alive = false; };
  }, [drill.partyId, drill.member, windowBounds]);

  const cost = useMemo(() => (turns || []).reduce((a, t) => a + turnCost(t.model, t.tokens), 0), [turns]);
  const io = row ? ioOf(row) : { inTok: 0, outTok: 0 };
  const segs = useMemo(() => segments(turns || []), [turns]);
  const dom = segs.slice().sort((a, b) => b.n - a.n)[0];

  return (
    <div style={{ ...dashboardRoot, gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <button onClick={props.onBack} title="대시보드로" style={{ width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg-2)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--text-2)", cursor: "pointer" }}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}><path d="M15 5l-7 7 7 7" strokeLinecap="round" strokeLinejoin="round" /></svg></button>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 14px", background: "var(--bg-2)", border: "1px solid var(--border)", borderRadius: 11 }}>
          <span style={{ width: 12, height: 12, borderRadius: 4, background: drill.color, flex: "none" }} /><span style={{ fontSize: 15, fontWeight: 600, color: "var(--text-0)" }}>{drill.member}</span><span className="wb-mono" style={{ fontSize: 11, color: "var(--text-3)" }}>#{drill.partyId.slice(-4)}</span>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <DrillStat label="환산 비용" value={fmtCost(cost)} sub={`↑${fmtTokens(io.inTok)} ↓${fmtTokens(io.outTok)}`} />
          <DrillStat label="지배 모델" value={dom ? `${modelLabel(dom.model)} ${dom.effort || ""}` : "—"} sub={dom ? tierBars(dom.model) : ""} />
          <DrillStat label="캐시 적중" value={row?.cacheHitRate == null ? "—" : `${Math.round(row.cacheHitRate * 100)}%`} color={(row?.cacheHitRate ?? 1) < 0.5 ? "var(--live)" : undefined} />
          <DrillStat label="활성 시간" value={fmtActive(row?.activeMs || 0)} />
        </div>
        <div style={{ flex: 1 }} />
        <button onClick={props.onOpenChat} style={{ display: "inline-flex", alignItems: "center", gap: 8, height: 38, padding: "0 15px", background: "var(--accent)", border: "none", borderRadius: 10, color: "var(--accent-fg)", fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}>이 세션 대화로 이동</button>
      </div>

      {/* 모델·effort 구간 */}
      <section style={cardSection}>
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}><span style={sectionTitle}>모델·effort 구간</span><span style={{ fontSize: 11.5, color: "var(--text-2)" }}>세션이 (모델×effort) 구간들의 합임을 보여줍니다 · 칸 너비=턴 수, 농도=effort.</span></div>
        {segs.length === 0 ? <div style={{ fontSize: 11.5, color: "var(--text-3)", padding: "16px 0", textAlign: "center" }}>아직 없음</div> : (
          <div style={{ display: "flex", height: 30, borderRadius: 8, overflow: "hidden", border: "1px solid var(--border-subtle)" }}>
            {segs.map((sg, i) => { const tot = segs.reduce((a, x) => a + x.n, 0) || 1; return (
              <div key={i} title={`${modelLabel(sg.model)} ${sg.effort || ""} · ${sg.n}턴`} style={{ width: `${sg.n / tot * 100}%`, background: effortMix(drill.color, sg.effort), borderLeft: i > 0 ? "1.5px solid var(--bg-2)" : "none", display: "flex", alignItems: "center", paddingLeft: 8, minWidth: 0, overflow: "hidden" }}>
                {sg.n / tot > 0.1 && <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-0)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{modelLabel(sg.model)} {sg.effort}</span>}
              </div>); })}
          </div>
        )}
      </section>

      {/* 컨텍스트 곡선 */}
      <section style={cardSection}>
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}><span style={sectionTitle}>세션 내 컨텍스트 증가 곡선</span><span style={{ fontSize: 11.5, color: "var(--text-2)" }}>기울기가 곧 비용입니다. 세로선은 compact 지점 — 끊긴 뒤 캐시가 다시 쌓입니다.</span></div>
        <ContextCurve turns={turns} color={drill.color} />
      </section>

      {/* 비싼 턴 */}
      <section style={{ ...cardSection, padding: "14px 18px 16px" }}>
        <span style={sectionTitle}>비싼 턴</span>
        {turns === null ? <div style={{ fontSize: 11.5, color: "var(--text-3)", padding: "24px 0", textAlign: "center" }}>불러오는 중…</div> : turns.length === 0 ? <div style={{ fontSize: 11.5, color: "var(--text-3)", padding: "24px 0", textAlign: "center" }}>이전 incarnation · 아직 없음</div> : <ExpensiveTurns turns={turns} />}
      </section>
    </div>
  );
}

function segments(turns: TurnUsageRecord[]): Array<{ model?: string; effort?: string; n: number }> {
  // Only the member's own turns define its model·effort run — exclude the gate
  // reviewer (a separate agent) so the drill-in segments and dominant model chip
  // don't show the reviewer's Sonnet as if the member had switched to it.
  const sorted = [...turns].filter((r) => isMemberModelTurn(r.trigger)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const out: Array<{ model?: string; effort?: string; n: number }> = [];
  for (const r of sorted) { const last = out[out.length - 1]; if (last && last.model === r.model && last.effort === r.effort) last.n += 1; else out.push({ model: r.model, effort: r.effort, n: 1 }); }
  return out;
}

function ContextCurve({ turns, color }: { turns: TurnUsageRecord[] | null; color: string }) {
  if (turns === null) return <div style={{ fontSize: 11.5, color: "var(--text-3)", padding: "40px 0", textAlign: "center" }}>불러오는 중…</div>;
  const withCtx = turns.filter((t) => typeof t.tokens.context === "number");
  if (!withCtx.length) return <div style={{ fontSize: 11.5, color: "var(--text-3)", padding: "40px 0", textAlign: "center" }}>아직 없음 — 컨텍스트 점유 값이 보고되지 않았습니다.</div>;
  const W = 1000, H = 220, x0 = 44, x1 = 980, y0 = 12, y1 = 180;
  const N = withCtx.length; const maxC = Math.max(...withCtx.map((t) => t.tokens.context || 0), 1) * 1.1;
  const ux = (i: number) => (N === 1 ? (x0 + x1) / 2 : x0 + (x1 - x0) * i / (N - 1));
  const uy = (v: number) => y1 - (v / maxC) * (y1 - y0);
  const kids: JSX.Element[] = [];
  for (let g = 0; g <= 4; g += 1) { const y = y1 - (y1 - y0) * g / 4; kids.push(<line key={`g${g}`} x1={x0} y1={y} x2={x1} y2={y} stroke="var(--grid)" strokeWidth={1} />); kids.push(<text key={`t${g}`} x={x0 - 6} y={y + 3} textAnchor="end" fontSize={10} fill="var(--text-3)" fontFamily="var(--font-mono)">{Math.round(maxC * g / 4 / 1000)}k</text>); }
  let seg: Array<[number, number]> = [];
  const flush = (key: string) => { if (!seg.length) return; let d = ""; seg.forEach(([i, v], k) => { d += (k ? "L" : "M") + ux(i) + " " + uy(v); }); kids.push(<path key={key} d={d} fill="none" stroke={color} strokeWidth={2.4} strokeLinejoin="round" />); };
  withCtx.forEach((t, i) => { if (t.trigger === "compact") { flush(`s${i}`); seg = []; kids.push(<line key={`cm${i}`} x1={ux(i)} y1={y0} x2={ux(i)} y2={y1} stroke="var(--live)" strokeWidth={1.4} strokeDasharray="3 3" />); kids.push(<text key={`cl${i}`} x={ux(i) + 4} y={y0 + 11} fontSize={9.5} fill="var(--live)" fontFamily="var(--font-mono)">compact</text>); } seg.push([i, t.tokens.context || 0]); });
  flush("se");
  return <div style={{ width: "100%" }}><svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block" }}>{kids}</svg></div>;
}

function ExpensiveTurns({ turns }: { turns: TurnUsageRecord[] }) {
  const top = [...turns].map((t) => ({ t, cost: turnCost(t.model, t.tokens) })).sort((a, b) => b.cost - a.cost).slice(0, 8);
  const maxOut = Math.max(...top.map((x) => x.t.tokens.output || 0), 1);
  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "34px 1fr 120px 120px 80px", padding: "0 4px 7px", borderBottom: "1px solid var(--border-subtle)", fontSize: 10.5, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.3, color: "var(--text-3)" }}><span>#</span><span>trigger · 모델</span><span style={{ textAlign: "right" }}>시각</span><span style={{ textAlign: "right" }}>출력</span><span style={{ textAlign: "right" }}>비용</span></div>
      {top.map(({ t, cost }, i) => (
        <div key={i} style={{ display: "grid", gridTemplateColumns: "34px 1fr 120px 120px 80px", alignItems: "center", padding: "10px 4px", borderBottom: "1px solid var(--border-subtle)" }}>
          <span className="wb-mono" style={{ fontSize: 12, color: "var(--text-3)" }}>{i + 1}</span>
          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}><span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-1)", background: "var(--bg-3)", padding: "1px 6px", borderRadius: 4, flex: "none" }}>{t.trigger}</span><span style={{ fontSize: 12, color: "var(--text-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{modelLabel(t.model)} {t.effort || ""}</span></div>
          <span className="wb-mono" style={{ textAlign: "right", fontSize: 11.5, color: "var(--text-2)" }}>{new Date(t.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</span>
          <div style={{ display: "flex", alignItems: "center", gap: 8, paddingLeft: 14 }}><div style={{ ...barTrack, height: 6 }}><div style={{ height: "100%", width: `${(t.tokens.output || 0) / maxOut * 100}%`, background: modelColor(t.model), borderRadius: 3 }} /></div></div>
          <span className="wb-mono" style={{ textAlign: "right", fontSize: 12.5, fontWeight: 600, color: "var(--text-0)" }}>{fmtCost(cost)}</span>
        </div>
      ))}
    </>
  );
}

// ── small components ─────────────────────────────────────────────────────────

function GaugeRow({ label, pct, reset, accent }: { label: string; pct?: number; reset?: string; accent?: boolean }) {
  const col = accent ? "var(--live)" : "var(--text-1)";
  return (
    <div style={{ display: "grid", gridTemplateColumns: "52px 1fr", alignItems: "center", gap: 14, position: "relative" }}>
      <div style={{ display: "flex", flexDirection: "column" }}><span style={{ fontSize: 10.5, color: "var(--text-3)" }}>{label}</span><span className="wb-mono" style={{ fontSize: 22, fontWeight: 600, color: col, lineHeight: 1 }}>{pct === undefined ? "—" : `${Math.round(pct)}%`}</span></div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{ height: 9, borderRadius: 5, background: "var(--bg-4)", overflow: "hidden" }}>{pct !== undefined && <div style={{ height: "100%", width: `${Math.min(pct, 100)}%`, background: accent ? "var(--live)" : "var(--text-2)", borderRadius: 5 }} />}</div>
        <span className="wb-mono" style={{ fontSize: 10, color: "var(--text-3)" }}>{pct === undefined ? "아직 없음" : reset ? `${reset} 후 리셋` : "리셋 시각 미보고"}</span>
      </div>
    </div>
  );
}

function DrillStat({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1, padding: "8px 14px", background: "var(--bg-2)", border: "1px solid var(--border-subtle)", borderRadius: 10 }}>
      <span style={{ fontSize: 10, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: 0.3 }}>{label}</span>
      <span className="wb-mono" style={{ fontSize: 15, fontWeight: 600, color: color || "var(--text-0)" }}>{value}</span>
      {sub && <span className="wb-mono" style={{ fontSize: 9.5, color: "var(--text-3)" }}>{sub}</span>}
    </div>
  );
}

function EmptyState() {
  return (
    <section style={{ background: "var(--bg-2)", border: "1px dashed var(--border)", borderRadius: 14, padding: 18, display: "flex", alignItems: "center", gap: 14 }}>
      <span style={{ width: 40, height: 40, flex: "none", borderRadius: 11, background: "var(--bg-3)", border: "1px solid var(--border-subtle)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-3)" }}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" strokeLinecap="round" strokeLinejoin="round" /></svg></span>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}><span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-1)" }}>아직 없음</span><span style={{ fontSize: 11.5, color: "var(--text-3)" }}>이 구간에 기록된 턴이 없습니다. 값을 <b style={{ color: "var(--text-2)" }}>지어내지 않고</b> "아직 없음"으로 둡니다.</span></div>
    </section>
  );
}

// ── style tokens ─────────────────────────────────────────────────────────────
const dashboardRoot: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 18, width: "100%", maxWidth: 1388, margin: "0 auto", padding: "20px 26px 44px", boxSizing: "border-box" };
const pillGroup: React.CSSProperties = { display: "inline-flex", padding: 3, background: "var(--bg-2)", border: "1px solid var(--border)", borderRadius: 10, gap: 2 };
const cardSection: React.CSSProperties = { background: "var(--bg-2)", border: "1px solid var(--border)", borderRadius: 14, padding: "16px 18px 12px", display: "flex", flexDirection: "column", gap: 12 };
const cardLabel: React.CSSProperties = { fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", color: "var(--text-2)" };
const sectionTitle: React.CSSProperties = { fontSize: 13.5, fontWeight: 600, color: "var(--text-0)" };
const miniLabel: React.CSSProperties = { fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: "var(--text-3)" };
const barTrack: React.CSSProperties = { flex: 1, height: 7, borderRadius: 4, background: "var(--bg-4)", overflow: "hidden" };
function segBtn(active: boolean): React.CSSProperties { return { height: 30, padding: "0 13px", border: "none", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "var(--font-sans)", background: active ? "var(--accent)" : "transparent", color: active ? "var(--accent-fg)" : "var(--text-2)" }; }
function segBtnSmall(active: boolean): React.CSSProperties { return { height: 26, padding: "0 10px", border: "none", borderRadius: 6, fontSize: 11.5, fontWeight: 600, cursor: "pointer", fontFamily: "var(--font-sans)", background: active ? "var(--accent)" : "transparent", color: active ? "var(--accent-fg)" : "var(--text-2)" }; }
function menuItem(active: boolean): React.CSSProperties { return { display: "flex", alignItems: "center", gap: 7, width: "100%", height: 30, padding: "0 9px", borderRadius: 7, border: "none", cursor: "pointer", fontSize: 11.5, fontWeight: active ? 600 : 500, fontFamily: "var(--font-sans)", background: active ? "var(--accent-dim)" : "transparent", color: active ? "var(--accent)" : "var(--text-1)", textAlign: "left" }; }
function numCell(color: string): React.CSSProperties { return { textAlign: "right", fontSize: 12, color }; }
