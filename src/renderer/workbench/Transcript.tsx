import { Fragment, memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, AlignLeft, ArrowDownLeft, Ban, ArrowRight, ArrowUpRight, Brain, Check, ChevronRight, Circle, CircleDot, Copy, CornerUpLeft, FastForward, FileDiff, ImageOff, Info, ListChecks, Loader, LoaderCircle, Maximize2, Minimize2, Search, ShieldCheck, Shuffle, Terminal, UserMinus, UserPlus, X } from "lucide-react";
import type { MemberView, PanelDensity, TranscriptBlock } from "./types";
import type { WorkbenchActions } from "./actions";
import { Markdown } from "./Markdown";
import { CopyButton } from "./copy";
import { isToolProblem, toolOutcomeOf, type ToolOutcome } from "./toolOutcome";
import { CODEX_DECISION_HINTS, CODEX_DECISION_LABELS, codexApprovalOptions } from "../../shared/codexApproval";
import type { CodexApprovalKind, CodexApprovalMeta, CodexDecision } from "../../shared/codexApproval";
import { claudeAlwaysRule, extractToolFilePath, ruleAddsInformation } from "../../shared/approvalRequest";
import { harnessLabel, harnessShort } from "./harnessLabel";
import { EnvironmentBlock } from "./EnvironmentBlock";
import { imageDataUrl, type ImageAttachment } from "../../shared/attachments";
import { collectDisplayImages, hasDisplayImages, isRenderableImage, type DisplayImage } from "../../shared/transcriptImages";
import { isTranscriptAtCap } from "../../shared/transcriptCap";
import { memberColorVars } from "../theme/memberColors";
import { MessageText } from "./messageTokens";
import { usePartyMembers } from "../app/partyMemberPrefs";
import { LocalizedText, localized, useI18n } from "../i18n/I18nProvider";
import { nextTranscriptMountLimit, PROGRESSIVE_TRANSCRIPT_GAP_MS } from "./transcriptScheduling";
import type { SessionSpawnState } from "../../shared/sessionSpawn";

interface TranscriptProps {
  view: MemberView;
  density: PanelDensity;
  actions: WorkbenchActions;
  /**
   * How much machinery this surface shows.
   *
   * `"full"` (workbench): watching what the agent actually ran IS the work, so
   * text-only tool boxes open on sight and every `spawned` / `requesting` /
   * `turn complete` line is visible. Images returned by ordinary tools stay
   * collapsed until requested.
   *
   * `"answers"` (guide): the reader came for an answer, not to supervise an
   * agent. Tool boxes stay collapsed (they are the guide reading its own
   * knowledge files) and status lines are dropped entirely — including
   * `turn complete - $5 in / $25 out`, which contradicts the guide's rule that
   * cost is shown as 쓴다/안 쓴다 and never as a number.
   *
   * Errors are NOT status: a real failure is its own block kind and shows in
   * both modes. Every tool-returned image stays behind its tool disclosure;
   * user attachments are separate message blocks and remain immediately visible.
   */
  detail?: "full" | "answers";
}

// A member's transcript holds up to 800 persisted blocks. Mounting all of them
// (each assistant block parses markdown) is what freezes the UI on a party
// switch, so only the most recent TAIL_BLOCKS render initially — the tail is
// what the user looks at first. Older history is revealed on demand, one page at
// a time, without disturbing scroll position. See docs research on tail-first
// message rendering; this bounds the switch-time render cost to a constant.
const TAIL_BLOCKS = 150;
const INITIAL_PAINT_BLOCKS = 20;

function TranscriptView({ view, density, actions, detail = "full" }: TranscriptProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Whether the view is pinned to the bottom (true unless the user scrolled up).
  const stickRef = useRef(true);
  const lastText = lastBlockText(view.transcript);

  // The history WINDOW remains 150 blocks. Its DOM mounts progressively: the
  // newest 20 are enough to make the panel useful, while the offscreen prefix
  // fills over the next frames. Panel keys reset both values for each concrete
  // party/member identity, including same-named `main` members across parties.
  const [historyLimit, setHistoryLimit] = useState(TAIL_BLOCKS);
  const [mountedLimit, setMountedLimit] = useState(INITIAL_PAINT_BLOCKS);
  const total = view.transcript.length;
  const hiddenCount = Math.max(0, total - historyLimit);
  const mountedCount = Math.min(total, mountedLimit);
  const shown = mountedCount < total ? view.transcript.slice(total - mountedCount) : view.transcript;

  useEffect(() => {
    const target = Math.min(total, historyLimit);
    if (view.transcriptLoading || mountedLimit >= target) return;
    const timer = window.setTimeout(() => {
      setMountedLimit((current) => nextTranscriptMountLimit(current, target));
    }, PROGRESSIVE_TRANSCRIPT_GAP_MS);
    return () => clearTimeout(timer);
  }, [historyLimit, mountedLimit, total, view.transcriptLoading]);

  // Reveal an older page while keeping the viewport anchored: capture the scroll
  // offset from the bottom before prepending, then restore it after, so the
  // content the user is reading stays put instead of jumping.
  const showOlder = () => {
    const node = scrollRef.current;
    const prevHeight = node?.scrollHeight ?? 0;
    const prevTop = node?.scrollTop ?? 0;
    stickRef.current = false;
    // Explicit history expansion keeps its established one-click behavior;
    // only automatic first paint is progressive.
    setHistoryLimit((n) => n + TAIL_BLOCKS);
    setMountedLimit((n) => n + TAIL_BLOCKS);
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) {
        el.scrollTop = prevTop + (el.scrollHeight - prevHeight);
      }
    });
  };

  const stickToBottom = () => {
    const node = scrollRef.current;
    if (node && stickRef.current) {
      node.scrollTop = node.scrollHeight;
    }
  };

  // New content keeps the bottom pinned (only if the user hasn't scrolled up).
  useLayoutEffect(stickToBottom, [view.transcript.length, lastText]);

  // When the scroll area resizes (e.g. the composer auto-grows and shrinks this
  // pane), re-pin to the bottom so the whole conversation appears to scroll up
  // together — instead of the top staying put while the latest messages hide
  // behind the composer.
  useEffect(() => {
    const node = scrollRef.current;
    if (!node || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => stickToBottom());
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const onScroll = () => {
    const node = scrollRef.current;
    if (node) {
      stickRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
    }
  };

  return (
    <div className={"wb-transcript density-" + density} ref={scrollRef} onScroll={onScroll}>
      {view.transcriptLoading ? (
        <div className="wb-transcript-empty wb-transcript-loading" role="status" aria-live="polite">
          <LoaderCircle size={17} className="wb-spin" />
          <p><LocalizedText id="STR-2151" /></p>
          <span><LocalizedText id="STR-2152" /></span>
        </div>
      ) : view.status === "not-started" && view.transcript.length === 0 && (
        <div className="wb-transcript-empty">
          <p><LocalizedText id="STR-2153" /></p>
        </div>
      )}
      {!view.transcriptLoading && hiddenCount === 0 && isTranscriptAtCap(view.transcript) && <HarnessOriginalNote member={view.name} />}
      {!view.transcriptLoading && hiddenCount > 0 && (
        <button type="button" className="wb-transcript-older" onClick={showOlder}>

          <LocalizedText id="STR-2156" /> {Math.min(hiddenCount, TAIL_BLOCKS)}<LocalizedText id="STR-2154" /> {hiddenCount}<LocalizedText id="STR-2155" />
        </button>
      )}
      {!view.transcriptLoading && shown.map((block) => (
        // Key by kind+id: an AskUserQuestion approval and its merged tool block
        // share the same tool-use id, so id alone would collide.
        <Block key={block.kind + ":" + block.id} block={block} view={view} density={density} actions={actions} detail={detail} />
      ))}
      {!view.transcriptLoading && view.busy && <TypingIndicator />}
    </div>
  );
}

/**
 * A session event rebuilds the active member view, but it does not necessarily
 * change this transcript. Keep an untouched panel out of React's block walk;
 * the fields below are the complete set read by this component or its blocks.
 */
export const Transcript = memo(TranscriptView, (previous, next) => (
  previous.actions === next.actions
  && previous.density === next.density
  && previous.detail === next.detail
  && previous.view.name === next.view.name
  && previous.view.status === next.view.status
  && previous.view.busy === next.view.busy
  && previous.view.transcriptLoading === next.view.transcriptLoading
  && previous.view.transcript === next.view.transcript
  && previous.view.model === next.view.model
  && previous.view.member.runtime === next.view.member.runtime
));

interface BlockProps {
  block: TranscriptBlock;
  view: MemberView;
  density: PanelDensity;
  actions: WorkbenchActions;
  detail: "full" | "answers";
}

/**
 * Stream reducers retain object identity for every historical block and replace
 * only the block receiving the delta. Respect that structural sharing here: a
 * growing final answer should not rerun 149 unrelated cards and their derived
 * previews on every frame.
 */
const Block = memo(function TranscriptBlock({ block, view, density, actions, detail }: BlockProps) {
  // Most translated labels are context consumers themselves. A few attributes
  // use `localized()` directly, so subscribe here to keep memoized cards live
  // when the application locale changes.
  useI18n();
  switch (block.kind) {
    case "user":
      return (
        <div className={"wb-block wb-user" + (block.fromQueue ? " is-from-queue" : "")} style={block.from ? memberColorVars(block.from) : undefined}>
          <div className="wb-user-head">
            {/* Permanent, not transient. Scrolling back, this badge is the only
                way to tell that the message reached the agent LATER than it was
                typed — which is what makes the surrounding order read correctly. */}
            {block.fromQueue && (
              <span className="wb-user-origin" title={localized("STR-2157")}>
                <AlignLeft size={9} />  <LocalizedText id="STR-2158" />
              </span>
            )}
            {(block.queuedN || 0) > 1 && <span className="wb-user-origin">{block.queuedN}<LocalizedText id="STR-2159" /></span>}
            {/* A member's message keeps its author here too: the queue row named
                who was asking, and dropping that on delivery would make the
                conversation read as though the user had typed it. */}
            <span className="wb-user-who">
              {block.from ? <><span className="wb-user-who-dot" />{block.from}</> : "You"}
            </span>
            {block.at && <span className="wb-mono wb-time">{block.at}</span>}
          </div>
          {block.attachments && block.attachments.length > 0 && (
            <div className="wb-msg-images">
              {block.attachments.map((image, index) =>
                <MsgImage key={index} image={image} />,
              )}
            </div>
          )}
          {/* Mentions and dropped paths were chips while being typed, so they are
              drawn the same way here — a sent message should look like what was
              composed, not like raw `@name` and an absolute path. */}
          {block.text && <div className="wb-user-bubble"><ExpandableText text={block.text} title={localized("STR-2160")} chips /></div>}
        </div>
      );
    case "reasoning":
      return (
        <details className="wb-block wb-reasoning">
          <summary><Brain size={13} /> Reasoned · {block.text.length > 0 ? `${Math.max(1, Math.round(block.text.length / 120))}s` : ""}<ChevronRight size={13} className="wb-caret" /></summary>
          <div className="wb-reasoning-body">{block.text}</div>
        </details>
      );
    case "assistant":
      return (
        <div className="wb-block wb-assistant">
          <div className="wb-assistant-head">
            <span className="wb-dot" />
            <strong>{view.name}</strong>
            {block.at && <span className="wb-mono wb-time">{block.at}</span>}
            {/* Copies the reply's markdown SOURCE — that is what the user pastes
                back into an editor or another member, not the rendered HTML. */}
            {block.text && <CopyButton text={block.text} title={localized("STR-2161")} className="wb-assistant-copy" />}
          </div>
          <div className="wb-assistant-body"><Markdown text={block.text} /></div>
        </div>
      );
    case "tool":
      // AskUserQuestion is shown by its approval card (the interactive question),
      // so its duplicate tool entry is suppressed here to avoid a raw-JSON echo.
      if (block.name === "AskUserQuestion") {
        return null;
      }
      return <ToolBlock block={block} density={density} detail={detail} />;
    case "channel":
      return <ChannelBlock block={block} view={view} />;
    case "image":
      return <AttachedImageBlock block={block} />;
    case "partyAction":
      return <PartyActionBlock block={block} />;
    case "gate":
      return <GateBlock block={block} view={view} />;
    case "compact":
      return <CompactBlock block={block} view={view} actions={actions} />;
    case "sessionSpawn":
      // Session plumbing, like the status lines below: the guide's reader came
      // for an answer and never started this member, so the card is a workbench
      // surface only.
      return detail === "full" ? <SessionSpawnBlock block={block} view={view} density={density} /> : null;
    case "status":
      // Harness plumbing: requesting / responding / turn complete. Spawn lines
      // are NOT here any more — a session start is its own card, and a legacy
      // raw one is rewritten into that card on restore (shared/sessionSpawn.ts).
      return detail === "full" ? (
        <div className="wb-block wb-status">
          <Search size={13} /> <span className="wb-mono">{block.text}</span>
        </div>
      ) : null;
    case "error":
      return (
        <div className="wb-block wb-error">
          <span className="wb-mono">{block.text}</span>
        </div>
      );
    case "environment":
      return <EnvironmentBlock block={block} view={view} actions={actions} />;
    case "plan":
      return <PlanBlock block={block} />;
    case "fileChange":
      return <FileChangeBlock block={block} density={density} />;
    case "diagnostic":
      return <DiagnosticBlock block={block} />;
    case "approval":
      return <ApprovalBlock block={block} view={view} density={density} actions={actions} />;
    default:
      return null;
  }
}, sameBlockProps);

/** Exported for the small structural-sharing regression; rendering stays here. */
export function sameBlockProps(previous: BlockProps, next: BlockProps): boolean {
  if (previous.block !== next.block || previous.density !== next.density || previous.detail !== next.detail) {
    return false;
  }

  // These cards name their owning member even when their immutable block did
  // not change. Approval also shows the live runtime/model in its origin label.
  if (previous.block.kind === "assistant" || previous.block.kind === "channel" || previous.block.kind === "gate") {
    return previous.view.name === next.view.name;
  }
  if (previous.block.kind === "sessionSpawn") {
    return previous.view.name === next.view.name;
  }
  if (previous.block.kind === "compact") {
    return previous.view.name === next.view.name && previous.actions === next.actions;
  }
  if (previous.block.kind === "approval") {
    return previous.view.name === next.view.name
      && previous.view.model === next.view.model
      && previous.view.member.runtime === next.view.member.runtime
      && previous.actions === next.actions;
  }
  if (previous.block.kind === "environment") {
    // The retry action derives the latest user turn from the whole transcript.
    return previous.view.name === next.view.name
      && previous.view.transcript === next.view.transcript
      && previous.actions === next.actions;
  }
  return true;
}

const GATE_META = {
  rejected: { label: "반려됨", tone: "live", note: "전달 안 됨 · 재작성 필요", Icon: CornerUpLeft },
  forced: { label: "강제 전송", tone: "accent", note: "우회하여 전달됨", Icon: FastForward },
  failed: { label: "리뷰 실패", tone: "danger", note: "심사 없이 전달됨", Icon: AlertTriangle },
} as const;

/**
 * A Message Gate outcome for an OUTGOING send by this member — an inline badge
 * (rejected / forced / failed). Reason is clamped to 2 lines and expands; the
 * violated rule (rejected/forced) or error code (failed) shows when expanded.
 */
/** `823598` → `824K`. The card states a size, so a digit-exact count is noise. */
export function compactTokens(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "";
  }
  if (value >= 1_000_000) {
    return `${Math.round(value / 100_000) / 10}M`;
  }
  if (value >= 10_000) {
    return `${Math.round(value / 1000)}K`;
  }
  if (value >= 1000) {
    return `${Math.round(value / 100) / 10}K`;
  }
  return String(value);
}

/** `197155` → `3분 17초`. Sub-minute compactions read as plain seconds. */
export function compactDuration(ms: number | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
    return "";
  }
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes ? `${minutes}분 ${seconds}초` : `${seconds}초`;
}

/** Elapsed while running, as `m:ss` — the one figure no event carries. */
export function compactElapsed(sinceMs: number, nowMs: number): string {
  const total = Math.max(0, Math.round((nowMs - sinceMs) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** `824K → 6.9K` shrank by 99%. Empty unless BOTH figures actually arrived. */
export function compactReduction(pre: number | undefined, post: number | undefined): string {
  if (typeof pre !== "number" || typeof post !== "number" || !Number.isFinite(pre) || !Number.isFinite(post) || pre <= 0) {
    return "";
  }
  return `-${Math.min(99, Math.round(((pre - post) / pre) * 100))}%`;
}

/**
 * One compaction, as one line that is replaced in place.
 *
 * What it may show is decided by what the harness actually sent: Codex reports
 * no figures at all, and Claude declares `post_tokens`/`duration_ms` optional,
 * so every numeric part is conditional. Printing a zero where a number never
 * arrived would be a claim about the conversation that nothing supports.
 */
/**
 * State wording for the session card. Kept as data so the card body has one
 * shape for three states — and so the words the user reads live next to each
 * other rather than inside three branches of JSX.
 */
const SESSION_SPAWN_META: Record<SessionSpawnState, { title: string; tone: string; note: string }> = {
  starting: { title: "세션 시작 중", tone: "live", note: "하네스를 준비하는 중입니다" },
  running: { title: "세션 시작됨", tone: "ok", note: "" },
  failed: { title: "세션 시작 실패", tone: "danger", note: "" },
};

const SESSION_SPAWN_HOSTS: Record<string, string> = { windows: "Windows", wsl: "WSL" };

/**
 * A member's session START.
 *
 * Replaces the raw `spawned: <the entire command line>` status line: the
 * executable path, the CLI arguments, the MCP wiring with its local port, the
 * party/member ids and the auth-store settings are not fields of this block, so
 * there is nothing here to print or to hang in a tooltip — see
 * shared/sessionSpawn.ts for where that decision is enforced.
 *
 * What it shows instead is what a reader actually wants from a start: whether
 * it worked, who started, on what harness and model, on which side of the
 * machine, in roughly which directory, and when. A failure adds a classified
 * one-line reason and says whether trying again is worth it — never the command
 * that failed. Detailed diagnosis stays in the session debug log, which is
 * opened deliberately rather than pushed into the conversation.
 *
 * One attempt owns one card (`applyEvents` upserts it), so a start that
 * progresses or dies REPLACES its own line rather than stacking a second.
 */
function SessionSpawnBlock({ block, view, density }: { block: Extract<TranscriptBlock, { kind: "sessionSpawn" }>; view: MemberView; density: PanelDensity }) {
  const meta = SESSION_SPAWN_META[block.state] || SESSION_SPAWN_META.running;
  const harness = harnessLabel(block.harness || view.member.runtime);
  const host = block.host ? SESSION_SPAWN_HOSTS[block.host] : "";
  // Below `mid` the panel is barely wider than the chips, so the layout has to
  // give something its own line rather than share.
  const narrow = density === "narrow";
  const retryNote = block.state === "failed"
    ? (block.retryable ? "다시 시작할 수 있습니다" : "설정을 고친 뒤 다시 시작하세요")
    : "";
  // One sentence for a screen reader, because the visual card is a row of
  // chips: read apart they are a list of words, not a state.
  const label = [meta.title, view.name, harness, block.model, host, block.cwd, block.reason]
    .filter(Boolean)
    .join(", ");

  return (
    <div
      className={"wb-block wb-spawn is-" + meta.tone}
      role="group"
      aria-label={label}
      // A start in flight is the one state that changes under the reader, so it
      // is the only one announced; a settled card would re-announce on scroll.
      aria-live={block.state === "starting" ? "polite" : undefined}
    >
      <div className="wb-spawn-head">
        <span className="wb-spawn-icon" aria-hidden="true">
          {block.state === "starting" && <LoaderCircle size={13} className="wb-spawn-spin" />}
          {block.state === "running" && <Check size={13} />}
          {block.state === "failed" && <AlertTriangle size={13} />}
        </span>
        <span className="wb-spawn-title">{meta.title}</span>
        {/* Three things compete for the first row: the state, whose session it
            is, and when. State and time are short and fixed, so they keep the
            row. The member name is the one field that can be long, so in a
            narrow panel it takes its own line below instead of being squeezed
            to a single character and an ellipsis. The full name is on the
            element either way, for the pointer and the screen reader. */}
        {!narrow && <span className="wb-spawn-member" title={view.name}>{view.name}</span>}
        <span className="wb-spawn-spacer" />
        {block.at && <span className="wb-mono wb-time wb-spawn-time">{block.at}</span>}
      </div>
      {narrow && <div className="wb-spawn-who" title={view.name}>{view.name}</div>}
      <div className="wb-spawn-facts">
        {harness && <span className="wb-spawn-chip">{harness}</span>}
        {block.model && <span className="wb-spawn-chip wb-mono">{block.model}</span>}
        {host && <span className="wb-spawn-chip">{host}</span>}
        {/* The path is already shortened to its last segments upstream; the
            chip still truncates so a long segment cannot widen a narrow panel. */}
        {block.cwd && <span className="wb-spawn-chip wb-mono wb-spawn-cwd">{block.cwd}</span>}
        {meta.note && <span className="wb-spawn-note">{meta.note}</span>}
      </div>
      {block.state === "failed" && (
        <div className="wb-spawn-fail">
          <span className="wb-spawn-reason">{block.reason || "세션을 시작하지 못했습니다."}</span>
          {retryNote && <span className="wb-spawn-retry">{retryNote}</span>}
        </div>
      )}
    </div>
  );
}

function CompactBlock({ block, view, actions }: { block: Extract<TranscriptBlock, { kind: "compact" }>; view: MemberView; actions: WorkbenchActions }) {
  const running = block.state === "running";
  const [elapsed, setElapsed] = useState(() => compactElapsed(startedAtMs(block), Date.now()));
  useEffect(() => {
    if (!running) {
      return;
    }
    setElapsed(compactElapsed(startedAtMs(block), Date.now()));
    const timer = setInterval(() => setElapsed(compactElapsed(startedAtMs(block), Date.now())), 1000);
    return () => clearInterval(timer);
  }, [running, block.startedMs]);

  const delta = block.state === "done" && compactTokens(block.preTokens) && compactTokens(block.postTokens)
    ? `${compactTokens(block.preTokens)} → ${compactTokens(block.postTokens)}`
    : "";
  const reduction = block.state === "done" ? compactReduction(block.preTokens, block.postTokens) : "";
  const note = block.state === "done" && typeof block.keptCount === "number" ? `최근 ${block.keptCount}건 유지` : "";
  const duration = block.state === "done" ? compactDuration(block.durationMs) : "";

  return (
    <div className={"wb-block wb-compact is-" + block.state}>
      <div className="wb-compact-row">
        {/* The design draws its own glyphs. Substituting near-matches from the
            icon set would quietly change the shapes, so these are its paths. */}
        {running && (
          <svg className="wb-compact-icon wb-compact-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--live)" strokeWidth="1.9">
            <path d="M4 9h7V2M20 15h-7v7M4 15h7v7M20 9h-7V2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
        {block.state === "done" && (
          <svg className="wb-compact-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--success)" strokeWidth="2.4">
            <path d="M5 12l4.5 4.5L19 7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
        {block.state === "failed" && (
          <svg className="wb-compact-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" strokeWidth="1.9">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8v5M12 17h.01" strokeLinecap="round" />
          </svg>
        )}
        <span className="wb-compact-title">{running ? "대화 압축 중" : block.state === "failed" ? "압축 실패" : "대화 압축됨"}</span>
        {delta && <span className="wb-compact-delta wb-mono">{delta}</span>}
        {reduction && <span className="wb-compact-pct">{reduction}</span>}
        <span className="wb-compact-note">{note}</span>
        {running && <span className="wb-compact-elapsed wb-mono">{elapsed}</span>}
        {duration && <span className="wb-compact-dur wb-mono">{duration}</span>}
        {block.state === "failed" && (
          <button type="button" className="wb-compact-retry" onClick={() => actions.compact(view.name)}><LocalizedText id="STR-2174" /></button>
        )}
      </div>
      {running && <div className="wb-compact-bar"><span /></div>}
    </div>
  );
}

/** When the running card started, so the elapsed clock has an origin. */
function startedAtMs(block: Extract<TranscriptBlock, { kind: "compact" }>): number {
  return typeof block.startedMs === "number" && Number.isFinite(block.startedMs) ? block.startedMs : Date.now();
}

function GateBlock({ block, view }: { block: Extract<TranscriptBlock, { kind: "gate" }>; view: MemberView }) {
  const [open, setOpen] = useState(false);
  const meta = GATE_META[block.gate];
  const Icon = meta.Icon;
  const extra = block.gate === "failed" ? (block.errcode ? `오류 · ${block.errcode}` : "") : (block.rule ? `위반 규칙 · ${block.rule}` : "");
  return (
    <div className={"wb-block wb-gate is-" + meta.tone}>
      <div className="wb-gate-head">
        <span className="wb-gate-icon"><Icon size={14} /></span>
        <span className="wb-gate-label">{meta.label}</span>
        <span className="wb-gate-route wb-mono">{(block.from || view.name)} → {block.to}</span>
        <span className="wb-gate-passnote">{meta.note}</span>
        {block.reason && (
          <button type="button" className="wb-gate-caret" onClick={() => setOpen((v) => !v)} title={open ? localized("STR-2177") : localized("STR-2178")}>
            <ChevronRight size={13} className={"wb-caret" + (open ? " is-open" : "")} />
          </button>
        )}
      </div>
      {block.reason && <div className={"wb-gate-reason" + (open ? " is-open" : "")}>{block.reason}</div>}
      {open && extra && <div className="wb-gate-meta wb-mono">{extra}</div>}
    </div>
  );
}

/**
 * An inter-member (agentparty channel) message. `direction` is relative to this
 * member: "in" = received from a peer, "out" = this member sent to a peer. The
 * card shows the who→whom route so cross-session traffic is legible at a glance.
 */
function ChannelBlock({ block, view }: { block: Extract<TranscriptBlock, { kind: "channel" }>; view: MemberView }) {
  const incoming = block.direction === "in";
  const fromDiscord = block.source === "discord";
  const from = incoming ? block.from : view.name;
  const to = incoming ? view.name : block.to;
  const failed = block.state === "failed";
  return (
    <div className={"wb-block wb-channel" + (incoming ? " is-in" : " is-out") + (failed ? " is-failed" : "") + (fromDiscord ? " is-discord" : "")}>
      {/* Two bands, not one line. Who sent it to whom is one fact and how it
          was delivered is another; sharing a single nowrap row meant the status
          chips pushed the participants until a member name broke a character
          per line and collided with the arrow between them. */}
      <div className="wb-channel-head">
        <span className="wb-channel-route">
          <span className="wb-channel-icon">{incoming ? <ArrowDownLeft size={13} /> : <ArrowUpRight size={13} />}</span>
          {/* Same card as a member-to-member message, but the origin is stated:
              a Discord message comes from the USER on another device, not a peer. */}
          {fromDiscord && <span className="wb-channel-source">Discord</span>}
          <span className="wb-channel-peer" title={from || "?"}>{from || "?"}</span>
          <ArrowRight size={12} className="wb-channel-arrow" />
          <span className="wb-channel-peer" title={to || "?"}>{to || "?"}</span>
        </span>
        {/* Delivery facts. They wrap as whole chips onto their own line rather
            than squeezing the names beside them. */}
        <span className="wb-channel-flags">
          <span className="wb-channel-tag">{incoming ? "수신" : "송신"}</span>
          {/* This one waited in the queue before it was handed over — permanent,
              because in scrollback it is what explains why replies above it do
              not answer it. */}
          {block.fromQueue && (
            <span className="wb-user-origin" title={localized("STR-2181")}>
              <AlignLeft size={9} />  <LocalizedText id="STR-2182" />
            </span>
          )}
          {(block.queuedN || 0) > 1 && <span className="wb-user-origin">{block.queuedN}<LocalizedText id="STR-2183" /></span>}
          {block.at && <span className="wb-mono wb-time">{block.at}</span>}
        </span>
      </div>
      {block.text && <div className="wb-channel-bubble"><ExpandableText text={block.text} title={`${from || "?"} → ${to || "?"}`} markdown /></div>}
      {failed && <div className="wb-channel-failed"><LocalizedText id="STR-2185" />{block.error ? ` — ${block.error}` : " — 상대가 실행 중이 아닙니다."}</div>}
    </div>
  );
}

/**
 * A party write-action this member drove: creating or removing another member.
 * Rendered as a compact action card (with the new member's role/model/harness on
 * create) so spawning/removing is legible without expanding a raw tool box.
 */
/**
 * An image the MEMBER put in the conversation for the user to look at.
 *
 * A stored file is fetched from the workspace image store; a `url` is loaded
 * from its own source, because the member asked for that address rather than a
 * copy of it. Either way the picture only ever exists here — the member has not
 * seen it, which is why the card names what it asked for.
 */
function AttachedImageBlock({ block }: { block: Extract<TranscriptBlock, { kind: "image" }> }) {
  const [fetched, setFetched] = useState<string>();
  const [loadError, setLoadError] = useState<string>();
  const file = block.file;
  useEffect(() => {
    if (!file) {
      return;
    }
    let live = true;
    setFetched(undefined);
    setLoadError(undefined);
    window.agentParty
      .getTranscriptImage(file)
      .then((result) => { if (live) setFetched(result.dataUrl); })
      .catch((cause: unknown) => { if (live) setLoadError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { live = false; };
  }, [file]);

  const src = file ? fetched : block.url;
  const label = block.caption || block.origin || "이미지";

  if (block.state === "failed") {
    return (
      <div className="wb-block wb-attached-image is-failed">
        <ImageOff size={13} />
        <span><LocalizedText id="STR-2187" />{block.origin ? ` — ${block.origin}` : ""}</span>
        {block.error && <span className="wb-attached-image-error">{block.error}</span>}
      </div>
    );
  }
  return (
    <div className="wb-block wb-attached-image">
      {loadError && <div className="wb-tool-image-missing"><ImageOff size={13} />  <LocalizedText id="STR-2188" /> {loadError}</div>}
      {!loadError && !src && <div className="wb-tool-image-missing"><LoaderCircle size={13} className="wb-spin" />  <LocalizedText id="STR-2189" /></div>}
      {!loadError && src && (
        <>
          <ImageFigure src={src} label={label} copySource={() => imageBytesFrom(src)} />
          {block.caption && <span className="wb-attached-image-caption">{block.caption}</span>}
        </>
      )}
    </div>
  );
}

function PartyActionBlock({ block }: { block: Extract<TranscriptBlock, { kind: "partyAction" }> }) {
  const isCreate = block.action === "create";
  const failed = block.state === "failed";
  return (
    <div className={"wb-block wb-party-action" + (isCreate ? " is-create" : " is-remove") + (failed ? " is-failed" : "")}>
      <div className="wb-party-action-head">
        <span className="wb-party-action-icon">{isCreate ? <UserPlus size={13} /> : <UserMinus size={13} />}</span>
        <span className="wb-party-action-label">{isCreate ? "멤버 생성" : "멤버 삭제"}</span>
        <span className="wb-party-action-member">{block.member || "?"}</span>
        {block.at && <span className="wb-mono wb-time">{block.at}</span>}
      </div>
      {isCreate && !failed && (block.role || block.model || block.harness) && (
        <div className="wb-party-action-meta">
          {block.role && <span className="wb-party-action-role">{block.role}</span>}
          {block.harness && <span className="wb-chip wb-mono">{block.harness}</span>}
          {block.model && <span className="wb-chip wb-mono">{block.model}</span>}
        </div>
      )}
      {failed && <div className="wb-party-action-failed">{block.error || (isCreate ? "생성 실패" : "삭제 실패")}</div>}
    </div>
  );
}

/**
 * The mirror case: tools that read a file INTO the model's context. When the
 * file happens to be a .png the harness returns the bytes, but the user did not
 * ask to look at anything — the agent did. Showing the picture there fills the
 * transcript with images nobody asked for, so these tools render as an ordinary
 * tool box and the bytes stay out of the view.
 */
const IMAGE_HIDDEN_TOOLS = new Set(["Read", "read_file"]);

type ToolTranscriptBlock = Extract<TranscriptBlock, { kind: "tool" }>;
interface ToolPresentation {
  arg: string;
  fullInput: string;
  result: string;
  hasImages: boolean;
  meta: string;
  hasMore: boolean;
}

// Persisted blocks are immutable and retain identity across party switches.
// Keep their JSON formatting/image discovery work with that identity so a warm
// return does not stringify the same large tool results all over again. The
// WeakMap releases entries with the transcript block; it is not a second store.
const toolPresentations = new WeakMap<ToolTranscriptBlock, ToolPresentation>();
const NO_TOOL_IMAGES: DisplayImage[] = [];

function toolPresentationFor(block: ToolTranscriptBlock): ToolPresentation {
  const cached = toolPresentations.get(block);
  if (cached) return cached;
  const arg = summarizeArg(block.input);
  const fullInput = toolInputDetail(block.input);
  const result = block.output || formatResult(block.result);
  // Only answer WHETHER a collapsed tool has images here. Building DisplayImage
  // objects for inline results duplicates the base64 as data URLs, while stored
  // results would immediately start renderer -> main file reads when mounted.
  const hasImages = !IMAGE_HIDDEN_TOOLS.has(block.name) && hasDisplayImages(block.result);
  const meta = toolMeta(block);
  const presentation = { arg, fullInput, result, hasImages, meta, hasMore: needsClip(fullInput) || needsClip(result) };
  toolPresentations.set(block, presentation);
  return presentation;
}

/**
 * One wording per outcome, so the tooltip, the accessible label and the inline
 * badge cannot describe the same result three different ways.
 */
const TOOL_OUTCOME_STR: Record<ToolOutcome, "STR-3788" | "STR-3789" | "STR-3790" | "STR-3791"> = {
  ok: "STR-3788",
  failed: "STR-3789",
  denied: "STR-3790",
  running: "STR-3791",
};

function ToolBlock({ block, density, detail }: { block: ToolTranscriptBlock; density: PanelDensity; detail: "full" | "answers" }) {
  const [full, setFull] = useState(false);
  const { arg, fullInput, result, hasImages, meta, hasMore } = toolPresentationFor(block);
  // The summary `arg` is ellipsis-clipped; the body shows a clipped PREVIEW of the
  // command/result. The full command + output live in the "전체 보기" popup so a
  // long bash run never floods the transcript inline.
  // What HAPPENED, not merely whether the call closed. A red check still reads
  // as "done, fine", so a refusal and a clean run must not share a glyph.
  const outcome = toolOutcomeOf(block);
  const failed = isToolProblem(outcome);
  const openFull = (event: { preventDefault(): void; stopPropagation(): void }) => { event.preventDefault(); event.stopPropagation(); setFull(true); };
  // Pictures returned by a tool are evidence the agent consumed, not a message
  // to the user. Even a native image_view in a wide workbench stays collapsed.
  const openByDefault = !hasImages && detail === "full" && density === "wide" && Boolean(result);
  const [open, setOpen] = useState(openByDefault);
  useEffect(() => {
    setOpen(openByDefault);
  }, [openByDefault]);
  // This is the lazy boundary: before a tool opens, no inline data URL
  // is built and no ToolImage effect can ask the main process for stored bytes.
  const images = hasImages && (open || full) ? collectDisplayImages(block.result) : NO_TOOL_IMAGES;

  return (
    <details
      className={"wb-block wb-tool density-" + density}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <ChevronRight size={13} className="wb-caret" />
        <span
          className={"wb-tool-check is-" + outcome + (failed ? " failed" : "")}
          title={localized(TOOL_OUTCOME_STR[outcome])}
          aria-label={localized(TOOL_OUTCOME_STR[outcome])}
        >
          {outcome === "denied" ? <Ban size={11} /> : outcome === "failed" ? <X size={11} /> : outcome === "running" ? <Loader size={11} /> : <Check size={11} />}
        </span>
        {/* Colour alone cannot carry this: the whole point is that the two red
            states mean different things, and one of them is not a fault. */}
        {failed && <span className="wb-tool-outcome"><LocalizedText id={TOOL_OUTCOME_STR[outcome]} /></span>}
        <span className="wb-mono wb-tool-name">{block.name}</span>
        {block.source && <span className="wb-tool-source">{block.source}</span>}
        {arg && <span className="wb-mono wb-tool-arg">{arg}</span>}
        {hasMore && (
          <button type="button" className="wb-tool-expand" title={localized("STR-2194")} aria-label={localized("STR-2194")} onClick={openFull}>
            <Maximize2 size={12} />
          </button>
        )}
      </summary>
      {(open || full) && (
        <>
          {meta && <div className="wb-tool-meta">{meta}</div>}
          {fullInput && <pre className="wb-pre wb-tool-cmd">{previewOf(fullInput)}</pre>}
          {result && <pre className={"wb-pre wb-tool-result" + (failed ? " is-failed" : "")}>{previewOf(result)}</pre>}
          {images.map((image) => <ToolImage key={image.key} image={image} />)}
          {full && <ToolDetailModal name={block.name} command={fullInput} result={result} onClose={() => setFull(false)} />}
        </>
      )}
    </details>
  );
}

/** Compact meta line for a tool: cwd, exit code, duration. */
function toolMeta(block: ToolTranscriptBlock): string {
  const parts: string[] = [];
  if (block.cwd) {
    parts.push(`cwd ${block.cwd}`);
  }
  if (typeof block.exitCode === "number") {
    parts.push(`exit ${block.exitCode}`);
  }
  if (typeof block.durationMs === "number") {
    parts.push(block.durationMs >= 1000 ? `${(block.durationMs / 1000).toFixed(1)}s` : `${block.durationMs}ms`);
  }
  return parts.join("  ·  ");
}

const PLAN_ICON: Record<string, JSX.Element> = {
  completed: <Check size={13} />,
  inProgress: <CircleDot size={13} />,
  pending: <Circle size={13} />,
};

/** Codex plan/TODO card: a checklist with per-step status (pending/in-progress/done). */
function PlanBlock({ block }: { block: Extract<TranscriptBlock, { kind: "plan" }> }) {
  const done = block.steps.filter((s) => s.status === "completed").length;
  return (
    <div className="wb-block wb-plan">
      <div className="wb-plan-head">
        <ListChecks size={14} />
        <strong><LocalizedText id="STR-2195" /></strong>
        {block.steps.length > 0 && <span className="wb-plan-count">{done}/{block.steps.length}</span>}
      </div>
      {block.steps.length > 0 ? (
        <ol className="wb-plan-steps">
          {block.steps.map((step, i) => (
            <li key={i} className={"wb-plan-step is-" + step.status}>
              <span className="wb-plan-step-ic">{PLAN_ICON[step.status] || PLAN_ICON.pending}</span>
              <span className="wb-plan-step-text">{step.step}</span>
            </li>
          ))}
        </ol>
      ) : (
        block.explanation && <p className="wb-plan-text"><Markdown text={block.explanation} /></p>
      )}
    </div>
  );
}

/** Codex fileChange item: each affected file with +/- stats and a collapsible diff. */
function FileChangeBlock({ block, density }: { block: Extract<TranscriptBlock, { kind: "fileChange" }>; density: PanelDensity }) {
  const total = block.changes.reduce((acc, c) => ({ added: acc.added + c.added, removed: acc.removed + c.removed }), { added: 0, removed: 0 });
  return (
    <div className={"wb-block wb-filechange density-" + density}>
      <div className="wb-filechange-head">
        <FileDiff size={14} />
        <strong><LocalizedText id="STR-2196" /></strong>
        <span className="wb-chip">{block.changes.length}<LocalizedText id="STR-2197" /></span>
        <span className="wb-diff-stat"><span className="wb-diff-add">+{total.added}</span> <span className="wb-diff-del">-{total.removed}</span></span>
        {block.status && <span className="wb-mono wb-filechange-status">{block.status}</span>}
      </div>
      {block.changes.map((change, i) => (
        <details key={i} className="wb-filechange-file" open={density === "wide" && block.changes.length === 1}>
          <summary>
            <ChevronRight size={12} className="wb-caret" />
            <span className={"wb-filechange-kind is-" + change.kind}>{change.kind}</span>
            <span className="wb-mono wb-filechange-path">{change.path}</span>
            <span className="wb-diff-stat"><span className="wb-diff-add">+{change.added}</span> <span className="wb-diff-del">-{change.removed}</span></span>
          </summary>
          {change.diff && <pre className="wb-pre wb-approval-diff">{change.diff}</pre>}
        </details>
      ))}
    </div>
  );
}

const DIAGNOSTIC_ICON: Record<string, JSX.Element> = {
  reroute: <Shuffle size={14} />,
  info: <Info size={14} />,
};

/**
 * A surfaced Codex diagnostic — reroute, rate-limit, guardian/config warning,
 * or sandbox/MCP problem — shown as a severity-colored banner (never dropped
 * silently). Recoverable problems (Windows sandbox) show a recovery hint.
 */
function DiagnosticBlock({ block }: { block: Extract<TranscriptBlock, { kind: "diagnostic" }> }) {
  const icon = DIAGNOSTIC_ICON[block.category] || DIAGNOSTIC_ICON[block.severity] || <AlertTriangle size={14} />;
  return (
    <div className={"wb-block wb-diagnostic is-" + block.severity}>
      <div className="wb-diagnostic-head">
        <span className="wb-diagnostic-ic">{icon}</span>
        <strong>{block.title}</strong>
        {(block.repeat || 1) > 1 && <span className="wb-diagnostic-repeat">×{block.repeat}</span>}
        <span className="wb-diagnostic-cat">{block.category}</span>
      </div>
      {block.detail && <div className="wb-diagnostic-detail">{block.detail}</div>}
      {block.recovery && <div className="wb-diagnostic-recovery">{block.recovery}</div>}
    </div>
  );
}

// Inline content (a sent message, a bash run) shows only a clipped preview; the
// full text opens in a popup. Keeps the transcript scannable when a message or
// command output is long, without ever losing the full content.
const PREVIEW_LINES = 6;
const PREVIEW_CHARS = 320;

export function needsClip(text: string): boolean {
  if (!text) {
    return false;
  }
  if (text.length > PREVIEW_CHARS) {
    return true;
  }
  let newlines = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10 && ++newlines >= PREVIEW_LINES) {
      return true;
    }
  }
  return false;
}

/** The clipped preview of a longer text (first few lines / chars, trailing ellipsis). */
export function previewOf(text: string): string {
  if (!needsClip(text)) {
    return text;
  }
  // Locate only the prefix we can show. `split("\n")` allocated an array for
  // every line of multi-megabyte command output, twice per render, even though
  // the card keeps at most six lines / 320 characters.
  let end = Math.min(text.length, PREVIEW_CHARS);
  let newlines = 0;
  for (let index = 0; index < end; index += 1) {
    if (text.charCodeAt(index) === 10 && ++newlines >= PREVIEW_LINES) {
      end = index;
      break;
    }
  }
  const clipped = text.slice(0, end);
  return `${clipped.replace(/\s+$/, "")} …`;
}

/**
 * A message body shown as a preview by default; when it's long, a "전체 보기"
 * control opens the full text in a popup. Used for sent/received messages so the
 * transcript stays scannable (the full content is one click away), and by the
 * subagent detail view for the delegated task prompt.
 */
/**
 * What the user answered, after the question card is done with.
 *
 * ONE line per question. Joining them into a single ellipsized sentence fit the
 * card but hid every answer after the first — the second and third simply could
 * not be read, which for a record of one's own decisions is the whole point of
 * it being there. Long answers clip to their line and open in the same
 * "전체 보기" popup the rest of the transcript uses.
 */
function AnsweredQuestion({ questions, answers, density }: { questions: ParsedQuestion[]; answers?: Record<string, string>; density: PanelDensity }) {
  const [full, setFull] = useState(false);
  const [clipped, setClipped] = useState(false);
  const rowsRef = useRef<HTMLSpanElement>(null);
  const rows = questions.map((q) => ({
    label: q.header || q.question,
    // The full question is the tooltip and the popup heading: a header like
    // "적용 여부" is a filing label, not the thing that was actually asked.
    question: q.question,
    value: answerLabels(answers, q.question).join(", ") || "—",
  }));
  /*
   * "Too long" is not a character count — it is whether the text fits, which
   * depends on how wide the panel happens to be right now. A fixed threshold
   * offered the popup for answers that were fully visible and withheld it for
   * short ones in a narrow panel. So ask the layout: an answer is clipped when
   * it overflows its own line, re-checked whenever the card is resized.
   */
  useEffect(() => {
    const host = rowsRef.current;
    if (!host) {
      return;
    }
    const check = () => setClipped(
      Array.from(host.querySelectorAll(".wb-answered-a")).some((el) => el.scrollWidth > el.clientWidth + 1),
    );
    check();
    const observer = new ResizeObserver(check);
    observer.observe(host);
    return () => observer.disconnect();
  }, [questions, answers]);

  return (
    <div className={"wb-block wb-approval wb-question is-resolved is-answered density-" + density}>
      <Check size={14} />
      <span className="wb-approval-resolved-label"><LocalizedText id="STR-2198" /></span>
      <span className="wb-answered-rows" ref={rowsRef}>
        {rows.map((row, index) => (
          <span className="wb-answered-row" key={index}>
            <span className="wb-answered-q" title={row.question}>{row.label}</span>
            <span className="wb-answered-a">{row.value}</span>
          </span>
        ))}
      </span>
      {clipped && (
        <button type="button" className="wb-answered-expand" title={localized("STR-2199")} onClick={() => setFull(true)}>
          <Maximize2 size={12} />
        </button>
      )}
      {full && (
        <DetailModal title={localized("STR-2200")} onClose={() => setFull(false)}>
          <div className="wb-answered-full">
            {rows.map((row, index) => (
              <div className="wb-answered-full-row" key={index}>
                <div className="wb-answered-full-q">{row.question}</div>
                <div className="wb-answered-full-a">{row.value}</div>
              </div>
            ))}
          </div>
        </DetailModal>
      )}
    </div>
  );
}

export function ExpandableText({ text, title, markdown, chips }: { text: string; title: string; markdown?: boolean; chips?: boolean }) {
  const [full, setFull] = useState(false);
  const members = usePartyMembers();
  const clip = needsClip(text);
  const shown = clip ? previewOf(text) : text;
  const body = (value: string) =>
    markdown ? <Markdown text={value} /> : chips
      ? <span className="wb-expandable-text"><MessageText text={value} members={members} /></span>
      : <span className="wb-expandable-text">{value}</span>;
  return (
    <>
      {body(shown)}
      {clip && (
        <button type="button" className="wb-expand-inline" title={localized("STR-2201")} onClick={() => setFull(true)}>
          <Maximize2 size={11} />  <LocalizedText id="STR-2202" />
        </button>
      )}
      {full && (
        <DetailModal title={title} onClose={() => setFull(false)}>
          {/* The full view stays literal: this is where someone goes to read the
              exact string that was sent, paths and all. */}
          {markdown ? <Markdown text={text} /> : <pre className="wb-pre wb-expandable-full">{text}</pre>}
        </DetailModal>
      )}
    </>
  );
}

/**
 * A centered popup with a titled body — the shared shell for "전체 보기" overlays.
 *
 * The backdrop does not dismiss: selecting text inside a long command or result
 * regularly ends with the pointer outside the popup, which closed it and lost
 * the selection. Closing is explicit (✕) or Escape — a key the user presses on
 * purpose, unlike a stray click.
 *
 * `actions` sits in the header before ✕ so image fit/copy controls reuse this
 * shell instead of inventing a second overlay (R-19).
 */
function DetailModal({ title, onClose, actions, wide, children }: {
  title: string;
  onClose: () => void;
  actions?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      // Claim Escape so a focused panel's R-12 interrupt does not also fire
      // while this overlay is open (R-13: popup first).
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="wb-tool-modal-backdrop">
      <div className={"wb-tool-modal" + (wide ? " is-wide" : "")}>
        <div className="wb-tool-modal-head">
          <span className="wb-mono wb-tool-name">{title}</span>
          <div className="wb-tool-modal-actions">
            {actions}
            <button type="button" className="wb-icon-btn" title={localized("STR-2203")} aria-label={localized("STR-2203")} onClick={onClose}><X size={15} /></button>
          </div>
        </div>
        <div className="wb-tool-modal-body">{children}</div>
      </div>
    </div>
  );
}

/**
 * An image that stayed in the transcript (R-18 / R-19). Copy and full-size view
 * live HERE — not on the composer attachment strip (that was the mis-wired
 * earlier attempt). Bytes already gone (persisted stub) get a label only; there
 * is nothing left to copy or enlarge.
 */
function MsgImage({ image }: { image: ImageAttachment }) {
  if (!image.dataBase64) {
    return (
      <span className="wb-msg-image-stub" title={image.name}>
        <ImageOff size={12} /> {image.name || "이미지"}
      </span>
    );
  }
  return (
    <ImageFigure
      src={imageDataUrl(image)}
      label={image.name || localized("STR-2205")}
      copySource={async () => ({ dataBase64: image.dataBase64!, mediaType: image.mediaType })}
    />
  );
}

/**
 * Bytes for the clipboard, fetched only when the user actually asks to copy.
 * A member's attached image may live behind a URL, where the app deliberately
 * holds no copy — so the source is a function, not a value.
 */
type ImageCopySource = () => Promise<{ dataBase64: string; mediaType?: string }>;

/**
 * Clipboard bytes for whatever a rendered `src` points at.
 *
 * A stored image is already a `data:` URL, so it is split apart. A remote one is
 * fetched at copy time — the app holds no copy of a URL the member attached, by
 * design. A fetch the host refuses surfaces through the copy button's failed
 * state rather than as a silent no-op.
 */
async function imageBytesFrom(src: string): Promise<{ dataBase64: string; mediaType?: string }> {
  const fromDataUrl = (value: string) => {
    const comma = value.indexOf(",");
    const mediaType = /^data:([^;,]+)/.exec(value)?.[1];
    return { dataBase64: value.slice(comma + 1), mediaType };
  };
  if (src.startsWith("data:")) {
    return fromDataUrl(src);
  }
  const response = await fetch(src);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`.trim());
  }
  const blob = await response.blob();
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error("이미지를 읽지 못했습니다."));
    reader.readAsDataURL(blob);
  });
  return fromDataUrl(dataUrl);
}

/**
 * One image with the affordances every image in a transcript has: click to
 * enlarge (fit / actual size) and copy to the clipboard.
 *
 * Split out of {@link MsgImage} so an image a MEMBER attached behaves exactly
 * like one the user pasted. The two differ only in where the bytes come from,
 * which is what `copySource` abstracts.
 */
function ImageFigure({ src, label, copySource }: { src: string; label: string; copySource?: ImageCopySource }) {
  const [viewer, setViewer] = useState(false);
  // Fit shrinks to the viewport; actual shows native pixels and scrolls when
  // the image is larger than the modal. Default to fit so a huge screenshot
  // does not blow past the screen on open.
  const [fit, setFit] = useState(true);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [copyError, setCopyError] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copyImage(event?: { preventDefault(): void; stopPropagation(): void }) {
    event?.preventDefault();
    event?.stopPropagation();
    try {
      if (!copySource) {
        throw new Error("복사할 수 있는 원본이 없습니다.");
      }
      const bytes = await copySource();
      await window.agentParty.copyImageToClipboard({ dataBase64: bytes.dataBase64, mediaType: bytes.mediaType });
      setCopyError("");
      setCopyState("copied");
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopyState("idle"), 1400);
    } catch (error) {
      // Never a silent no-op: a failed copy must say so, or the user pastes
      // stale clipboard content and blames the other app.
      setCopyState("failed");
      setCopyError(`이미지를 클립보드로 복사하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopyState("idle"), 1800);
    }
  }

  const copyTitle = copyState === "copied" ? "복사됨" : copyState === "failed" ? "복사 실패" : "클립보드로 복사";
  const copyBtn = (
    <button
      type="button"
      className={"wb-icon-btn wb-msg-image-copy is-" + copyState}
      title={copyTitle}
      aria-label={copyTitle}
      data-copy-state={copyState}
      onClick={(event) => void copyImage(event)}
    >
      {copyState === "copied" ? <Check size={13} /> : copyState === "failed" ? <X size={13} /> : <Copy size={13} />}
    </button>
  );

  return (
    <>
      <div className="wb-msg-image-wrap">
        <button
          type="button"
          className="wb-msg-image-hit"
          title={localized("STR-2212", [label])}
          aria-label={localized("STR-2213", [label])}
          onClick={() => setViewer(true)}
        >
          <img className="wb-msg-image" src={src} alt={label} loading="lazy" decoding="async" />
        </button>
        <div className="wb-msg-image-toolbar">
          {copyBtn}
          <button
            type="button"
            className="wb-icon-btn"
            title={localized("STR-2214")}
            aria-label={localized("STR-2215")}
            onClick={() => setViewer(true)}
          >
            <Maximize2 size={13} />
          </button>
        </div>
        {copyError && <div className="wb-msg-image-error" role="alert">{copyError}</div>}
      </div>
      {viewer && (
        <DetailModal
          title={label}
          wide
          onClose={() => setViewer(false)}
          actions={
            <>
              <button
                type="button"
                className="wb-icon-btn"
                title={fit ? localized("STR-2216") : localized("STR-2217")}
                aria-label={fit ? localized("STR-2218") : localized("STR-2219")}
                data-image-zoom={fit ? "fit" : "actual"}
                onClick={() => setFit((current) => !current)}
              >
                {fit ? <Maximize2 size={14} /> : <Minimize2 size={14} />}
              </button>
              {copyBtn}
            </>
          }
        >
          <div className={"wb-image-viewer" + (fit ? " is-fit" : " is-actual")}>
            <img src={src} alt={label} decoding="async" />
          </div>
        </DetailModal>
      )}
    </>
  );
}

/** Byte size for display. Scales the unit so a small file is not shown as "0 MB". */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${bytes} B`;
}

/**
 * Shown at the very top of a transcript that is sitting at its retention cap.
 *
 * Scrolling to the top of a trimmed transcript looks exactly like reaching the
 * beginning of the conversation, so the user reads a retention window as data
 * loss. The harness keeps its own untrimmed copy, so the honest thing to say is
 * where the rest is.
 *
 * Renders nothing until the lookup answers, and nothing at all if there is no
 * original to point at — a note that says "the rest is somewhere" without
 * naming it would be worse than silence.
 */
function HarnessOriginalNote({ member }: { member: string }) {
  const [original, setOriginal] = useState<{ harness: string; path: string; exists: boolean; bytes?: number } | null>();
  useEffect(() => {
    let live = true;
    setOriginal(undefined);
    window.agentParty
      .getHarnessOriginal(member)
      .then((result) => { if (live) setOriginal(result.original); })
      .catch(() => { if (live) setOriginal(null); });
    return () => { live = false; };
  }, [member]);
  if (!original) {
    return null;
  }
  return (
    <div className="wb-transcript-origin">
      <Info size={13} />
      <div>
        <div><LocalizedText id="STR-2220" /></div>
        {original.exists ? (
          <div className="wb-transcript-origin-path">
            <span className="wb-mono">{original.path}</span>
            {typeof original.bytes === "number" && <span> · {formatBytes(original.bytes)}</span>}
            <CopyButton text={original.path} title={localized("STR-2221")} />
          </div>
        ) : (
          // Claude Code keys its directory on the absolute cwd, so a moved
          // project folder orphans the history. Say that instead of printing a
          // path that leads nowhere.
          <div className="wb-transcript-origin-path">
            {original.harness}  <LocalizedText id="STR-2222" />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * A screenshot a tool returned, whose bytes live outside the transcript.
 *
 * Fetched on mount rather than carried in the block: one of these is ~500 KB of
 * base64, and a transcript holds many. Keeping them out of the file is the point
 * of storing them out-of-line, so the renderer pays for the ones it shows.
 *
 * A read failure surfaces as visible text. The bytes are on disk and could have
 * been moved or deleted, and a broken image icon would not say which.
 */
function ToolImage({ image }: { image: DisplayImage }) {
  const file = image.kind === "stored" ? image.source.file : undefined;
  const [fetched, setFetched] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!file) {
      return;
    }
    let live = true;
    setFetched(undefined);
    setError(undefined);
    window.agentParty
      .getTranscriptImage(file)
      .then((result) => { if (live) setFetched(result.dataUrl); })
      .catch((cause: unknown) => { if (live) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { live = false; };
  }, [file]);
  const dataUrl = image.kind === "inline" ? image.dataUrl : fetched;
  const bytes = image.kind === "inline" ? image.bytes : image.source.bytes;
  const mediaType = image.kind === "inline" ? image.mediaType : image.source.media_type;
  if (error) {
    return <div className="wb-tool-image-missing"><ImageOff size={13} />  <LocalizedText id="STR-2223" /> {error}</div>;
  }
  if (!dataUrl) {
    return <div className="wb-tool-image-missing"><LoaderCircle size={13} className="wb-spin" />  <LocalizedText id="STR-2224" /></div>;
  }
  return (
    <img
      className="wb-tool-image"
      src={dataUrl}
      alt={`${mediaType || "image"} · ${Math.round(bytes / 1024)} KB`}
      loading="lazy"
      decoding="async"
    />
  );
}

/** Full, scrollable view of a tool call's command + result (the "전체 보기" overlay). */
function ToolDetailModal({ name, command, result, onClose }: { name: string; command: string; result: string; onClose: () => void }) {
  return (
    <DetailModal title={name} onClose={onClose}>
      {command && <pre className="wb-pre wb-tool-cmd">{command}</pre>}
      {result && <pre className="wb-pre wb-tool-result">{result}</pre>}
    </DetailModal>
  );
}

function ApprovalBlock({ block, view, density, actions }: { block: Extract<TranscriptBlock, { kind: "approval" }>; view: MemberView; density: PanelDensity; actions: WorkbenchActions }) {
  const questions = parseQuestions(block.input);
  // AskUserQuestion and Codex's request-user-input both drive the question card.
  if ((block.toolName === "AskUserQuestion" || block.codex?.kind === "userInput") && questions.length > 0) {
    return <QuestionBlock block={block} questions={questions} view={view} density={density} actions={actions} />;
  }
  // Codex approvals get the richer once/session/prefix-rule/decline card.
  if (block.codex) {
    return <CodexApprovalBlock block={block} codex={block.codex} view={view} density={density} actions={actions} />;
  }
  return <ClaudeApprovalBlock block={block} view={view} density={density} actions={actions} />;
}

/**
 * Claude Code approval card.
 *
 * Shows what the SDK actually sends (measured, see scripts/fixtures/approvals):
 * the command or the edit's before/after, the path that triggered the prompt,
 * and — when the request carries one — the rule "always allow" would store, in
 * words. That last part is why the choice can be offered at all: the SDK hands
 * over ready-made permission updates, so agreeing to a stated rule is a real
 * action rather than a promise the app cannot keep.
 */
function ClaudeApprovalBlock({ block, view, density, actions }: { block: Extract<TranscriptBlock, { kind: "approval" }>; view: MemberView; density: PanelDensity; actions: WorkbenchActions }) {
  const command = approvalCommand(block.input);
  const edit = approvalEdit(block.input);
  const rule = claudeAlwaysRule(block.suggestions);
  const decide = (scope?: "always") =>
    actions.approve(view.name, block.requestId, "allow", scope ? { __approvalScope: scope } : undefined);
  const filePath = extractToolFilePath(block.input);

  if (block.resolved) {
    return (
      <ResolvedApproval
        block={block}
        density={density}
        summary={command || filePath || block.description || block.toolName}
        scope={block.resolved === "allow" ? "이번만" : undefined}
      />
    );
  }
  return (
    <div className={"wb-block wb-approval density-" + density}>
      <div className="wb-approval-head">
        <ShieldCheck size={15} />
        <strong>{block.title || "승인 요청"}</strong>
        <span className="wb-chip wb-mono">{block.toolName}</span>
        <span className="wb-approval-head-spacer" />
        <span className="wb-approval-origin">{approvalOrigin(view)}</span>
      </div>
      <div className="wb-approval-body">
        {/* For an edit the SDK's description is just the file name, which the
            file row below already states — so it would read twice. */}
        {block.description && !(filePath && filePath.endsWith(block.description)) && (
          <p className="wb-approval-desc">{block.description}</p>
        )}
        {command && <pre className="wb-pre wb-approval-cmd"><span className="wb-approval-diff-mark">$</span> {command}</pre>}
        {edit && (
          <>
            {filePath && (
              <div className="wb-approval-file">
                <span className="wb-approval-file-kind"><LocalizedText id="STR-2227" /></span>
                <span className="wb-approval-file-path">{shortPath(filePath)}</span>
              </div>
            )}
            <DiffLines before={edit.before} after={edit.after} />
          </>
        )}
        {/* No label/value grid here. Codex sends two rows that need aligning
            (실행 + 작업 폴더); Claude sends one path, and borrowing the grid left
            a 76px label column holding a single item with empty space beside it.
            The harnesses send different data, so they get different bodies. */}
        {block.blockedPath && <div className="wb-approval-path">{block.blockedPath}</div>}
        {block.agentID && <div className="wb-approval-path"><LocalizedText id="STR-2228" /> {block.agentID}</div>}
      </div>
      <div className="wb-approval-actions">
        <button type="button" className="wb-btn wb-btn-ghost" onClick={() => actions.approve(view.name, block.requestId, "deny")}><LocalizedText id="STR-2229" /></button>
        <button type="button" className="wb-btn wb-btn-member" onClick={() => decide()}><LocalizedText id="STR-2230" /></button>
        {/* States what gets stored, not that the asking stops. Measured: a later
            turn can still be held up by a separate gate (a write outside the
            allowed directories), and THAT one is only ever grantable for the
            session — so no choice here can promise silence, and claiming
            otherwise is the lie the user notices first. */}
        {rule && (
          <button
            type="button"
            className={"wb-btn wb-btn-soft wb-btn-widest" + (ruleAddsInformation(rule.hint, command) ? " wb-btn-rule" : "")}
            title={localized("STR-2231", [rule.hint])}
            onClick={() => decide("always")}
          >
            <span><LocalizedText id="STR-2232" /></span>
            {ruleAddsInformation(rule.hint, command) && <span className="wb-btn-rule-hint">{rule.hint}</span>}
          </button>
        )}
      </div>
    </div>
  );
}

/** Harness · model, shown small on the right of the head. */
function approvalOrigin(view: MemberView): string {
  const harness = harnessShort((view.member as { runtime?: string } | undefined)?.runtime);
  return [harness, view.model].filter(Boolean).join(" · ");
}

/** Trims a long absolute path to its tail, which is the part that identifies it. */
function shortPath(value: string): string {
  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? value : `…/${parts.slice(-2).join("/")}`;
}

/** Before/after as tinted −/+ rows rather than one undifferentiated block. */
function DiffLines({ before, after, diff }: { before?: string; after?: string; diff?: string }) {
  const rows: Array<{ mark: string; text: string; cls: string }> = [];
  if (typeof diff === "string") {
    for (const line of diff.split("\n")) {
      if (!line) continue;
      const add = line.startsWith("+");
      const del = line.startsWith("-");
      rows.push({ mark: add ? "+" : del ? "−" : " ", text: add || del ? line.slice(1) : line, cls: add ? "is-add" : del ? "is-del" : "" });
    }
  } else {
    for (const line of (before || "").split("\n")) rows.push({ mark: "−", text: line, cls: "is-del" });
    for (const line of (after || "").split("\n")) rows.push({ mark: "+", text: line, cls: "is-add" });
  }
  if (!rows.length) {
    return null;
  }
  return (
    <div className="wb-approval-diff">
      {rows.map((row, index) => (
        <div className={`wb-approval-diff-line ${row.cls}`} key={index}>
          <span className="wb-approval-diff-mark">{row.mark}</span>
          {row.text}
        </div>
      ))}
    </div>
  );
}

/**
 * A handled approval, collapsed to one line.
 *
 * It stays in the transcript rather than disappearing: scrolling back is how
 * someone answers "what did I agree to", and that needs the WHAT and the scope
 * on the same line, not just a coloured badge.
 */
function ResolvedApproval({ block, density, summary, scope }: { block: Extract<TranscriptBlock, { kind: "approval" }>; density: PanelDensity; summary: string; scope?: string }) {
  const allowed = block.resolved === "allow";
  return (
    <div className={`wb-block wb-approval is-resolved density-${density}${allowed ? "" : " is-denied"}`}>
      {allowed ? <Check size={14} /> : <X size={14} />}
      <span className="wb-approval-resolved-label">{allowed ? "허용함" : "거부함"}</span>
      <span className="wb-approval-resolved-summary" title={summary}>{summary}</span>
      {allowed && scope && <span className="wb-approval-resolved-scope">{scope}</span>}
    </div>
  );
}

const CODEX_APPROVAL_ICON: Record<CodexApprovalKind, JSX.Element> = {
  command: <Terminal size={14} />,
  fileChange: <FileDiff size={14} />,
  permissions: <ShieldCheck size={14} />,
  userInput: <ListChecks size={14} />,
  elicitation: <ShieldCheck size={14} />,
  generic: <ShieldCheck size={14} />,
};

/**
 * Codex approval card. Shows the exact command / file diff and the full decision
 * set the harness supports (once / this session / prefix rule / decline). "always"
 * only appears when Codex offered a prefix rule for the command. Each choice rides
 * to the harness via `updatedInput.codexDecision`.
 */
function CodexApprovalBlock({ block, codex, view, density, actions }: { block: Extract<TranscriptBlock, { kind: "approval" }>; codex: CodexApprovalMeta; view: MemberView; density: PanelDensity; actions: WorkbenchActions }) {
  const options = codexApprovalOptions(codex);
  const decide = (decision: CodexDecision) =>
    actions.approve(view.name, block.requestId, decision === "decline" ? "deny" : "allow", { codexDecision: decision });
  if (block.resolved) {
    return (
      <ResolvedApproval
        block={block}
        density={density}
        summary={codex.commandDisplay || codex.command || codex.edits?.map((edit) => edit.path).join(", ") || block.title || localized("STR-2235")}
        scope="이번만"
      />
    );
  }
  return (
    <div className={"wb-block wb-approval wb-codex-approval density-" + density}>
      <div className="wb-approval-head">
        {CODEX_APPROVAL_ICON[codex.kind]}
        <strong>{block.title || "Codex 승인 요청"}</strong>
        <span className="wb-approval-head-spacer" />
        <span className="wb-approval-origin">{approvalOrigin(view)}</span>
      </div>
      <div className="wb-approval-body">
      {/* The reason used to render only when there was no command — which meant
          it never showed on a command approval, the one kind that always has
          both. Measured: the reason is a full sentence explaining the ask. */}
      {codex.reason && <p className="wb-approval-desc">{codex.reason}</p>}
      {codex.command && (
        // Lead with Codex's own parse; the wrapper underneath is what actually
        // runs, so it stays visible rather than being quietly swapped out.
        <pre className="wb-pre wb-approval-cmd"><span className="wb-approval-diff-mark">$</span> {codex.commandDisplay || codex.command}</pre>
      )}
      <div className="wb-approval-meta">
        {codex.commandDisplay && codex.command !== codex.commandDisplay && (
          <><span className="wb-mono"><LocalizedText id="STR-2238" /></span><span>{codex.command}</span></>
        )}
        {codex.cwd && <><span className="wb-mono"><LocalizedText id="STR-2239" /></span><span>{codex.cwd}</span></>}
      </div>
      {codex.diff && <DiffLines diff={codex.diff} />}
      {/* A file-change approval carries no diff of its own; these are joined from
          the item it names, so the user can see the edit before allowing it. */}
      {!codex.diff && codex.edits?.map((edit) => (
        <Fragment key={edit.path}>
          <div className="wb-approval-file">
            <span className="wb-approval-file-kind">{edit.kind}</span>
            <span className="wb-approval-file-path">{shortPath(edit.path)}</span>
            {(edit.added || edit.removed) ? <span className="wb-approval-file-stat">+{edit.added} −{edit.removed}</span> : null}
          </div>
          {edit.diff && <DiffLines diff={edit.diff} />}
        </Fragment>
      ))}
      </div>
      <div className="wb-approval-actions wb-codex-approval-actions">
        {options.map((decision) => (
          <button
            key={decision}
            type="button"
            title={CODEX_DECISION_HINTS[decision]}
            className={
              "wb-btn "
              + (decision === "decline" ? "wb-btn-ghost" : decision === "once" ? "wb-btn-member" : "wb-btn-soft")
              // Emphasis drops as the scope widens, so "이번만" stays the default.
              + (decision === "always" ? " wb-btn-widest wb-btn-rule" : decision === "session" ? " wb-btn-widest" : "")
            }
            onClick={() => decide(decision)}
          >
            {decision === "always" && ruleAddsInformation(codex.alwaysHint, codex.commandDisplay || codex.command) ? (
              <>
                <span><LocalizedText id="STR-2240" /></span>
                <span className="wb-btn-rule-hint">{codex.alwaysHint}</span>
              </>
            ) : (
              CODEX_DECISION_LABELS[decision]
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

interface ParsedOption { label: string; description?: string }
/** `other` = the asker allows a free-text answer besides the listed options. */
interface ParsedQuestion { question: string; header?: string; multiSelect: boolean; options: ParsedOption[]; secret?: boolean; other: boolean }

/**
 * Renders an AskUserQuestion interaction as selectable choices. When the model
 * asks several questions, they are stepped through one at a time (like VS Code /
 * the Claude Code desktop app) instead of dumping them all at once.
 */
const OTHER = "__other__";

function QuestionBlock({ block, questions, view, density, actions }: { block: Extract<TranscriptBlock, { kind: "approval" }>; questions: ParsedQuestion[]; view: MemberView; density: PanelDensity; actions: WorkbenchActions }) {
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  const [otherText, setOtherText] = useState<Record<string, string>>({});
  const [step, setStep] = useState(0);
  const resolved = Boolean(block.resolved);

  const toggle = (q: ParsedQuestion, label: string) => {
    setSelections((current) => {
      const prev = current[q.question] || [];
      if (q.multiSelect) {
        const next = prev.includes(label) ? prev.filter((item) => item !== label) : [...prev, label];
        return { ...current, [q.question]: next };
      }
      return { ...current, [q.question]: [label] };
    });
  };

  // Resolve a question's picks to answer text, substituting free-typed text for the Other option.
  const answerFor = (q: ParsedQuestion): string =>
    (selections[q.question] || [])
      .map((pick) => (pick === OTHER ? (otherText[q.question] || "").trim() : pick))
      .filter(Boolean)
      .join(", ");
  const isAnswered = (q: ParsedQuestion): boolean => {
    const picks = selections[q.question] || [];
    if (picks.length === 0) {
      return false;
    }
    return picks.includes(OTHER) ? Boolean((otherText[q.question] || "").trim()) : true;
  };

  const answers = Object.fromEntries(questions.map((q) => [q.question, answerFor(q)]));
  const allAnswered = questions.every(isAnswered);
  const submit = () => actions.answerQuestion(view.name, block.requestId, block.input, answers);

  const multiple = questions.length > 1;
  const clampedStep = Math.min(step, questions.length - 1);
  const current = questions[clampedStep];
  const currentPicked = selections[current.question] || [];
  // A question with no preset options is pure free text: the input is always shown.
  // Otherwise the free-text choice appears only when the asker allows it —
  // Codex marks that per question (`isOther`), and offering it regardless would
  // invite an answer the tool is going to refuse.
  const allowsOther = current.other || current.options.length === 0;
  const otherActive = allowsOther && (currentPicked.includes(OTHER) || current.options.length === 0);
  const isLast = clampedStep === questions.length - 1;

  if (resolved) {
    // An answered question collapses to the SAME one-line record as a resolved
    // approval. It used to keep the full pending shell — head band, a
    // space-between Q/A row that flung the answer to the far edge, and a badge
    // floating on its own line — so the one card in the transcript that is
    // finished and needs the least room took the most.
    return <AnsweredQuestion questions={questions} answers={block.answers} density={density} />;
  }

  return (
    <div className={"wb-block wb-approval wb-question density-" + density}>
      {/* Same shell as an approval, deliberately without its temperature: this
          is a question, not a risk, so nothing here is red and the actions read
          "답변 보내기 / 건너뛰기" rather than allow/deny. */}
      <div className="wb-approval-head">
        <ListChecks size={15} />
        <strong><LocalizedText id="STR-2241" /></strong>
        {current.header && <span className="wb-chip">{current.header}</span>}
        <span className="wb-approval-head-spacer" />
        {multiple && <span className="wb-approval-origin">{clampedStep + 1} / {questions.length}</span>}
      </div>
      <div className="wb-question-item">
        <div className="wb-question-prompt">
          <span className="wb-question-text">{current.question}</span>
          {current.multiSelect && <span className="wb-question-hint"><LocalizedText id="STR-2242" /></span>}
        </div>
        <div className="wb-question-options">
          {current.options.map((opt, oi) => {
            const active = currentPicked.includes(opt.label);
            const advance = !current.multiSelect && !isLast;
            return (
              <button
                key={oi}
                type="button"
                className={"wb-question-option" + (active ? " is-active" : "")}
                aria-pressed={active}
                onClick={() => { toggle(current, opt.label); if (advance) setStep(clampedStep + 1); }}
              >
                {/* Round for one-of, square for many-of: the shape says how many
                    answers are allowed before anything is clicked. */}
                <span className={current.multiSelect ? "wb-question-mark is-box" : "wb-question-mark"}>
                  {active && (current.multiSelect ? <Check size={10} strokeWidth={3.4} /> : <span className="wb-question-mark-dot" />)}
                </span>
                <span className="wb-question-option-body">
                  <span className="wb-question-option-label">{opt.label}</span>
                  {opt.description && <span className="wb-question-option-desc">{opt.description}</span>}
                </span>
              </button>
            );
          })}
          {/* Offered only when the asker accepts a written-in answer. A pure
              free-text question (no options) shows just the input, no button.
              Dashed, because it is the one choice that is not on the list. */}
          {allowsOther && current.options.length > 0 && (
            <button
              type="button"
              className={"wb-question-option wb-question-other" + (otherActive ? " is-active" : "")}
              aria-pressed={otherActive}
              onClick={() => toggle(current, OTHER)}
            >
              <span className={current.multiSelect ? "wb-question-mark is-box" : "wb-question-mark"}>
                {otherActive && (current.multiSelect ? <Check size={10} strokeWidth={3.4} /> : <span className="wb-question-mark-dot" />)}
              </span>
              <span className="wb-question-option-body">
                <span className="wb-question-option-label"><LocalizedText id="STR-2243" /></span>
                <span className="wb-question-option-desc"><LocalizedText id="STR-2244" /></span>
              </span>
            </button>
          )}
          {otherActive && (
            <input
              type={current.secret ? "password" : "text"}
              className="wb-question-other-input"
              autoFocus
              placeholder={localized("STR-2245")}
              value={otherText[current.question] || ""}
              onChange={(event) => setOtherText((prev) => ({ ...prev, [current.question]: event.target.value }))}
              onKeyDown={(event) => { if (event.key === "Enter" && isLast && allAnswered) submit(); }}
            />
          )}
        </div>
      </div>
      <div className="wb-approval-actions">
        {/* How many are picked, on the left, so a multi-select says what state
            it is in without the user recounting the ticks. */}
        {current.multiSelect && currentPicked.length > 0 && (
          <span className="wb-approval-actions-note">{currentPicked.length}<LocalizedText id="STR-2246" /></span>
        )}
        <button type="button" className="wb-btn wb-btn-ghost wb-btn-widest" onClick={() => actions.approve(view.name, block.requestId, "deny")}><LocalizedText id="STR-2247" /></button>
        {multiple && clampedStep > 0 && (
          <button type="button" className="wb-btn wb-btn-ghost wb-btn-widest" onClick={() => setStep(clampedStep - 1)}><LocalizedText id="STR-2248" /></button>
        )}
        {isLast ? (
          <button type="button" className="wb-btn wb-btn-member" disabled={!allAnswered} onClick={submit}><LocalizedText id="STR-2249" /></button>
        ) : (
          <button type="button" className="wb-btn wb-btn-member" disabled={!isAnswered(current)} onClick={() => setStep(clampedStep + 1)}><LocalizedText id="STR-2250" /></button>
        )}
      </div>
    </div>
  );
}

function parseQuestions(input: unknown): ParsedQuestion[] {
  const record = input && typeof input === "object" ? (input as Record<string, unknown>) : undefined;
  const raw = record?.questions;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((item) => {
      const q = item as Record<string, unknown>;
      const options = Array.isArray(q.options)
        ? (q.options as Record<string, unknown>[]).map((o) => ({ label: String(o.label ?? ""), description: o.description ? String(o.description) : undefined })).filter((o) => o.label)
        : [];
      // `other` defaults to true: AskUserQuestion always accepts a written-in
      // answer, and only Codex states the restriction explicitly.
      return { question: String(q.question ?? q.header ?? ""), header: q.header ? String(q.header) : undefined, multiSelect: Boolean(q.multiSelect), options, secret: Boolean(q.secret), other: q.other === undefined ? true : Boolean(q.other) };
    })
    // Options are optional: a request-user-input question may be pure free text
    // (the card always offers a "직접 입력" fallback), so only require the prompt.
    .filter((q) => q.question);
}

function answerLabels(answers: Record<string, string> | undefined, question: string): string[] {
  const value = answers?.[question];
  return value ? value.split(",").map((item) => item.trim()).filter(Boolean) : [];
}

function TypingIndicator() {
  return (
    <div className="wb-block wb-typing">
      <span className="wb-typing-pill"><span className="wb-typing-dots"><i /><i /><i /></span></span>
      <span className="wb-typing-text"><LocalizedText id="STR-2251" /></span>
    </div>
  );
}

function summarizeArg(input: unknown): string {
  if (input == null) {
    return "";
  }
  if (typeof input === "string") {
    return input;
  }
  if (typeof input === "object") {
    const record = input as Record<string, unknown>;
    const candidate = record.path ?? record.file ?? record.command ?? record.pattern ?? record.query;
    if (typeof candidate === "string") {
      return candidate;
    }
  }
  return "";
}

function approvalCommand(input: unknown): string {
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    const command = record.command ?? record.cmd;
    if (typeof command === "string") {
      return command;
    }
  }
  return "";
}

/**
 * Before/after of an Edit approval.
 *
 * Claude's Edit input carries `old_string`/`new_string`, so the card can show
 * what the file change is before it happens — measured, and the reason a file
 * diff is renderable here while a Codex approval has none to show at all.
 */
function approvalEdit(input: unknown): { before: string; after: string } | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  const before = record.old_string;
  const after = record.new_string;
  if (typeof before !== "string" || typeof after !== "string") {
    return undefined;
  }
  return { before, after };
}

/**
 * Full input shown in the expanded tool body (the summary `arg` is clipped). For
 * a command (bash) it's the raw command; otherwise the full input as JSON — so a
 * long path/query/command is fully visible when expanded, never truncated.
 */
function toolInputDetail(input: unknown): string {
  if (!input || typeof input !== "object") {
    return "";
  }
  const record = input as Record<string, unknown>;
  const command = record.command ?? record.cmd;
  if (typeof command === "string") {
    return `$ ${command}`;
  }
  if (Object.keys(record).length === 0) {
    return "";
  }
  try {
    return JSON.stringify(record, null, 2);
  } catch {
    return "";
  }
}

function formatResult(result: unknown): string {
  if (result == null || result === "") {
    return "";
  }
  if (typeof result === "string") {
    return result;
  }
  // Anthropic tool_result content is an array of blocks (or one block); pull the
  // text out so bash/tool output reads as plain text instead of escaped JSON.
  const blocks = Array.isArray(result) ? result : [result];
  const texts = blocks
    .filter((b): b is { type: string; text: string } => Boolean(b) && typeof b === "object" && (b as any).type === "text" && typeof (b as any).text === "string")
    .map((b) => b.text);
  if (texts.length > 0) {
    return texts.join("\n");
  }
  // Images render as images (see StoredImage). Falling through to stringify
  // printed the whole base64 payload as text — half a megabyte of characters
  // that showed the user nothing.
  const withoutImages = blocks.filter((b) => !isRenderableImage(b));
  if (withoutImages.length === 0) {
    return "";
  }
  try {
    return JSON.stringify(Array.isArray(result) ? withoutImages : withoutImages[0], null, 2);
  } catch {
    return String(result);
  }
}

function lastBlockText(blocks: TranscriptBlock[]): string {
  const last = blocks.at(-1);
  if (!last) {
    return "";
  }
  return "text" in last ? last.text : last.kind;
}
