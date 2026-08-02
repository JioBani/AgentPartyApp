import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, AlignLeft, ArrowDownLeft, ArrowRight, ArrowUpRight, Brain, Check, ChevronRight, Circle, CircleDot, Copy, CornerUpLeft, FastForward, FileDiff, ImageOff, Info, ListChecks, Maximize2, Minimize2, Search, ShieldCheck, Shuffle, Terminal, UserMinus, UserPlus, X } from "lucide-react";
import type { MemberView, PanelDensity, TranscriptBlock } from "./types";
import type { WorkbenchActions } from "./actions";
import { Markdown } from "./Markdown";
import { CopyButton } from "./copy";
import { CODEX_DECISION_HINTS, CODEX_DECISION_LABELS, codexApprovalOptions } from "../../shared/codexApproval";
import type { CodexApprovalKind, CodexApprovalMeta, CodexDecision } from "../../shared/codexApproval";
import { imageDataUrl, type ImageAttachment } from "../../shared/attachments";
import { memberColorVars } from "../theme/memberColors";
import { MessageText } from "./messageTokens";
import { usePartyMembers } from "../app/partyMemberPrefs";

interface TranscriptProps {
  view: MemberView;
  density: PanelDensity;
  actions: WorkbenchActions;
}

// A member's transcript holds up to 800 persisted blocks. Mounting all of them
// (each assistant block parses markdown) is what freezes the UI on a party
// switch, so only the most recent TAIL_BLOCKS render initially — the tail is
// what the user looks at first. Older history is revealed on demand, one page at
// a time, without disturbing scroll position. See docs research on tail-first
// message rendering; this bounds the switch-time render cost to a constant.
const TAIL_BLOCKS = 150;

export function Transcript({ view, density, actions }: TranscriptProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Whether the view is pinned to the bottom (true unless the user scrolled up).
  const stickRef = useRef(true);
  const lastText = lastBlockText(view.transcript);

  // How many trailing blocks to render. Reset to the tail whenever the panel
  // shows a different member, so switching members always opens at the latest.
  const [limit, setLimit] = useState(TAIL_BLOCKS);
  useEffect(() => { setLimit(TAIL_BLOCKS); }, [view.name]);
  const total = view.transcript.length;
  const hiddenCount = Math.max(0, total - limit);
  const shown = hiddenCount > 0 ? view.transcript.slice(hiddenCount) : view.transcript;

  // Reveal an older page while keeping the viewport anchored: capture the scroll
  // offset from the bottom before prepending, then restore it after, so the
  // content the user is reading stays put instead of jumping.
  const showOlder = () => {
    const node = scrollRef.current;
    const prevHeight = node?.scrollHeight ?? 0;
    const prevTop = node?.scrollTop ?? 0;
    stickRef.current = false;
    setLimit((n) => n + TAIL_BLOCKS);
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
      {view.status === "not-started" && view.transcript.length === 0 && (
        <div className="wb-transcript-empty">
          <p>Not started. The first message starts this member&apos;s session with the selected runtime.</p>
        </div>
      )}
      {hiddenCount > 0 && (
        <button type="button" className="wb-transcript-older" onClick={showOlder}>
          이전 대화 {Math.min(hiddenCount, TAIL_BLOCKS)}개 더 보기 · {hiddenCount}개 숨김
        </button>
      )}
      {shown.map((block) => (
        // Key by kind+id: an AskUserQuestion approval and its merged tool block
        // share the same tool-use id, so id alone would collide.
        <Block key={block.kind + ":" + block.id} block={block} view={view} density={density} actions={actions} />
      ))}
      {view.busy && <TypingIndicator />}
    </div>
  );
}

function Block({ block, view, density, actions }: { block: TranscriptBlock; view: MemberView; density: PanelDensity; actions: WorkbenchActions }) {
  switch (block.kind) {
    case "user":
      return (
        <div className={"wb-block wb-user" + (block.fromQueue ? " is-from-queue" : "")} style={block.from ? memberColorVars(block.from) : undefined}>
          <div className="wb-user-head">
            {/* Permanent, not transient. Scrolling back, this badge is the only
                way to tell that the message reached the agent LATER than it was
                typed — which is what makes the surrounding order read correctly. */}
            {block.fromQueue && (
              <span className="wb-user-origin" title="대기열에서 순서가 되어 전송된 메시지">
                <AlignLeft size={9} /> 대기열에서 전송됨
              </span>
            )}
            {(block.queuedN || 0) > 1 && <span className="wb-user-origin">{block.queuedN}건 합쳐서 보냄</span>}
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
          {block.text && <div className="wb-user-bubble"><ExpandableText text={block.text} title="보낸 메시지" chips /></div>}
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
            {block.text && <CopyButton text={block.text} title="응답 전체 복사" className="wb-assistant-copy" />}
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
      return <ToolBlock block={block} density={density} />;
    case "channel":
      return <ChannelBlock block={block} view={view} />;
    case "partyAction":
      return <PartyActionBlock block={block} />;
    case "gate":
      return <GateBlock block={block} view={view} />;
    case "status":
      return (
        <div className="wb-block wb-status">
          <Search size={13} /> <span className="wb-mono">{block.text}</span>
        </div>
      );
    case "error":
      return (
        <div className="wb-block wb-error">
          <span className="wb-mono">{block.text}</span>
        </div>
      );
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
          <button type="button" className="wb-gate-caret" onClick={() => setOpen((v) => !v)} title={open ? "접기" : "펼치기"}>
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
      <div className="wb-channel-head">
        <span className="wb-channel-icon">{incoming ? <ArrowDownLeft size={13} /> : <ArrowUpRight size={13} />}</span>
        <span className="wb-channel-route">
          {/* Same card as a member-to-member message, but the origin is stated:
              a Discord message comes from the USER on another device, not a peer. */}
          {fromDiscord && <span className="wb-channel-source">Discord</span>}
          <span className="wb-channel-peer">{from || "?"}</span>
          <ArrowRight size={12} className="wb-channel-arrow" />
          <span className="wb-channel-peer">{to || "?"}</span>
        </span>
        <span className="wb-channel-tag">{incoming ? "수신" : "송신"}</span>
        {/* This one waited in the queue before it was handed over — permanent,
            because in scrollback it is what explains why replies above it do
            not answer it. */}
        {block.fromQueue && (
          <span className="wb-user-origin" title="대기열에서 순서가 되어 전송된 메시지">
            <AlignLeft size={9} /> 대기열에서 전송됨
          </span>
        )}
        {(block.queuedN || 0) > 1 && <span className="wb-user-origin">{block.queuedN}건 합쳐서 보냄</span>}
        {block.at && <span className="wb-mono wb-time">{block.at}</span>}
      </div>
      {block.text && <div className="wb-channel-bubble"><ExpandableText text={block.text} title={`${from || "?"} → ${to || "?"}`} markdown /></div>}
      {failed && <div className="wb-channel-failed">전달 실패 — 상대가 실행 중이 아닙니다.</div>}
    </div>
  );
}

/**
 * A party write-action this member drove: creating or removing another member.
 * Rendered as a compact action card (with the new member's role/model/harness on
 * create) so spawning/removing is legible without expanding a raw tool box.
 */
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

function ToolBlock({ block, density }: { block: Extract<TranscriptBlock, { kind: "tool" }>; density: PanelDensity }) {
  const [full, setFull] = useState(false);
  const arg = summarizeArg(block.input);
  // The summary `arg` is ellipsis-clipped; the body shows a clipped PREVIEW of the
  // command/result. The full command + output live in the "전체 보기" popup so a
  // long bash run never floods the transcript inline.
  const fullInput = toolInputDetail(block.input);
  // Command execution streams live output separately from its final result.
  const result = block.output || formatResult(block.result);
  const failed = block.status === "failed";
  // Provenance/exit/duration line for Codex items (shell exit code, mcp:<server>…).
  const meta = toolMeta(block);
  // Anything long enough that the inline view is only a preview → offer the popup.
  const hasMore = needsClip(fullInput) || needsClip(result);
  const openFull = (event: { preventDefault(): void; stopPropagation(): void }) => { event.preventDefault(); event.stopPropagation(); setFull(true); };
  return (
    <details className={"wb-block wb-tool density-" + density} open={density === "wide" && Boolean(result)}>
      <summary>
        <ChevronRight size={13} className="wb-caret" />
        <span className={"wb-tool-check" + (failed ? " failed" : "")}><Check size={11} /></span>
        <span className="wb-mono wb-tool-name">{block.name}</span>
        {block.source && <span className="wb-tool-source">{block.source}</span>}
        {arg && <span className="wb-mono wb-tool-arg">{arg}</span>}
        {hasMore && (
          <button type="button" className="wb-tool-expand" title="전체 보기" aria-label="전체 보기" onClick={openFull}>
            <Maximize2 size={12} />
          </button>
        )}
      </summary>
      {meta && <div className="wb-tool-meta">{meta}</div>}
      {fullInput && <pre className="wb-pre wb-tool-cmd">{previewOf(fullInput)}</pre>}
      {result && <pre className={"wb-pre wb-tool-result" + (failed ? " is-failed" : "")}>{previewOf(result)}</pre>}
      {full && <ToolDetailModal name={block.name} command={fullInput} result={result} onClose={() => setFull(false)} />}
    </details>
  );
}

/** Compact meta line for a tool: cwd, exit code, duration. */
function toolMeta(block: Extract<TranscriptBlock, { kind: "tool" }>): string {
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
        <strong>계획</strong>
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
        <strong>파일 변경</strong>
        <span className="wb-chip">{block.changes.length}개 파일</span>
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

function needsClip(text: string): boolean {
  return Boolean(text) && (text.length > PREVIEW_CHARS || text.split("\n").length > PREVIEW_LINES);
}

/** The clipped preview of a longer text (first few lines / chars, trailing ellipsis). */
function previewOf(text: string): string {
  if (!needsClip(text)) {
    return text;
  }
  const byLines = text.split("\n").slice(0, PREVIEW_LINES).join("\n");
  const clipped = byLines.length > PREVIEW_CHARS ? byLines.slice(0, PREVIEW_CHARS) : byLines;
  return `${clipped.replace(/\s+$/, "")} …`;
}

/**
 * A message body shown as a preview by default; when it's long, a "전체 보기"
 * control opens the full text in a popup. Used for sent/received messages so the
 * transcript stays scannable (the full content is one click away), and by the
 * subagent detail view for the delegated task prompt.
 */
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
        <button type="button" className="wb-expand-inline" title="전체 보기" onClick={() => setFull(true)}>
          <Maximize2 size={11} /> 전체 보기
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
            <button type="button" className="wb-icon-btn" title="닫기" aria-label="닫기" onClick={onClose}><X size={15} /></button>
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
  const [viewer, setViewer] = useState(false);
  // Fit shrinks to the viewport; actual shows native pixels and scrolls when
  // the image is larger than the modal. Default to fit so a huge screenshot
  // does not blow past the screen on open.
  const [fit, setFit] = useState(true);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [copyError, setCopyError] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);

  if (!image.dataBase64) {
    return (
      <span className="wb-msg-image-stub" title={image.name}>
        <ImageOff size={12} /> {image.name || "이미지"}
      </span>
    );
  }

  const src = imageDataUrl(image);
  const label = image.name || "이미지";

  async function copyImage(event?: { preventDefault(): void; stopPropagation(): void }) {
    event?.preventDefault();
    event?.stopPropagation();
    try {
      await window.agentParty.copyImageToClipboard({ dataBase64: image.dataBase64!, mediaType: image.mediaType });
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
          title={`${label} — 클릭하면 크게 보기`}
          aria-label={`${label} 크게 보기`}
          onClick={() => setViewer(true)}
        >
          <img className="wb-msg-image" src={src} alt={label} />
        </button>
        <div className="wb-msg-image-toolbar">
          {copyBtn}
          <button
            type="button"
            className="wb-icon-btn"
            title="크게 보기"
            aria-label="크게 보기"
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
                title={fit ? "실제 크기로 보기" : "화면에 맞추기"}
                aria-label={fit ? "실제 크기로 보기" : "화면에 맞추기"}
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
            <img src={src} alt={label} />
          </div>
        </DetailModal>
      )}
    </>
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
  const command = approvalCommand(block.input);
  return (
    <div className={"wb-block wb-approval density-" + density}>
      <div className="wb-approval-head">
        <ShieldCheck size={14} />
        <strong>Approval required</strong>
        <span className="wb-chip wb-mono">{block.toolName}</span>
      </div>
      {block.description && <p className="wb-approval-desc">{block.description}</p>}
      {command && <pre className="wb-pre wb-approval-cmd">{command}</pre>}
      {block.resolved ? (
        <span className={"wb-status-badge " + (block.resolved === "allow" ? "is-allow" : "is-deny")}>{block.resolved === "allow" ? "Allowed" : "Denied"}</span>
      ) : (
        <div className="wb-approval-actions">
          <button type="button" className="wb-btn wb-btn-ghost" onClick={() => actions.approve(view.name, block.requestId, "deny")}>Deny</button>
          <button type="button" className="wb-btn wb-btn-member" onClick={() => actions.approve(view.name, block.requestId, "allow")}>Allow once</button>
        </div>
      )}
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
  return (
    <div className={"wb-block wb-approval wb-codex-approval density-" + density}>
      <div className="wb-approval-head">
        {CODEX_APPROVAL_ICON[codex.kind]}
        <strong>{block.title || "Codex 승인 요청"}</strong>
      </div>
      {codex.command && (
        <pre className="wb-pre wb-approval-cmd">$ {codex.command}</pre>
      )}
      {codex.cwd && <div className="wb-approval-meta"><span className="wb-mono">cwd</span> {codex.cwd}</div>}
      {codex.diff && <pre className="wb-pre wb-approval-diff">{codex.diff}</pre>}
      {codex.reason && !codex.command && <p className="wb-approval-desc">{codex.reason}</p>}
      {codex.canAlways && codex.alwaysHint && (
        <div className="wb-approval-meta"><span className="wb-mono">규칙</span> {codex.alwaysHint}</div>
      )}
      {block.resolved ? (
        <span className={"wb-status-badge " + (block.resolved === "allow" ? "is-allow" : "is-deny")}>{block.resolved === "allow" ? "승인함" : "거부함"}</span>
      ) : (
        <div className="wb-approval-actions wb-codex-approval-actions">
          {options.map((decision) => (
            <button
              key={decision}
              type="button"
              title={CODEX_DECISION_HINTS[decision]}
              className={"wb-btn " + (decision === "decline" ? "wb-btn-ghost" : decision === "once" ? "wb-btn-member" : "wb-btn-soft")}
              onClick={() => decide(decision)}
            >
              {CODEX_DECISION_LABELS[decision]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface ParsedOption { label: string; description?: string }
interface ParsedQuestion { question: string; header?: string; multiSelect: boolean; options: ParsedOption[]; secret?: boolean }

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
  const otherActive = currentPicked.includes(OTHER) || current.options.length === 0;
  const isLast = clampedStep === questions.length - 1;

  if (resolved) {
    return (
      <div className={"wb-block wb-approval wb-question density-" + density}>
        <div className="wb-approval-head">
          <ListChecks size={14} />
          <strong>질문에 답함</strong>
        </div>
        <div className="wb-question-summary">
          {questions.map((q, qi) => (
            <div className="wb-question-summary-row" key={qi}>
              <span className="wb-question-summary-q">{q.header || q.question}</span>
              <span className="wb-question-summary-a">{answerLabels(block.answers, q.question).join(", ") || "—"}</span>
            </div>
          ))}
        </div>
        <span className="wb-status-badge is-allow">답변함</span>
      </div>
    );
  }

  return (
    <div className={"wb-block wb-approval wb-question density-" + density}>
      <div className="wb-approval-head">
        <ListChecks size={14} />
        <strong>질문에 답해주세요</strong>
        {current.header && <span className="wb-chip wb-mono">{current.header}</span>}
        {multiple && <span className="wb-question-progress">{clampedStep + 1} / {questions.length}</span>}
      </div>
      <div className="wb-question-item">
        <p className="wb-question-text">{current.question}</p>
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
                <span className="wb-question-option-label">{opt.label}</span>
                {opt.description && <span className="wb-question-option-desc">{opt.description}</span>}
              </button>
            );
          })}
          {/* Claude Code always offers a free-text answer; mirror that here. A
              pure free-text question (no options) shows only the input, no button. */}
          {current.options.length > 0 && (
            <button
              type="button"
              className={"wb-question-option wb-question-other" + (otherActive ? " is-active" : "")}
              aria-pressed={otherActive}
              onClick={() => toggle(current, OTHER)}
            >
              <span className="wb-question-option-label">기타 (직접 입력)</span>
              <span className="wb-question-option-desc">원하는 답을 직접 적습니다.</span>
            </button>
          )}
          {otherActive && (
            <input
              type={current.secret ? "password" : "text"}
              className="wb-question-other-input"
              autoFocus
              placeholder="답을 입력하세요…"
              value={otherText[current.question] || ""}
              onChange={(event) => setOtherText((prev) => ({ ...prev, [current.question]: event.target.value }))}
              onKeyDown={(event) => { if (event.key === "Enter" && isLast && allAnswered) submit(); }}
            />
          )}
        </div>
      </div>
      <div className="wb-approval-actions">
        <button type="button" className="wb-btn wb-btn-ghost" onClick={() => actions.approve(view.name, block.requestId, "deny")}>건너뛰기</button>
        {multiple && clampedStep > 0 && (
          <button type="button" className="wb-btn wb-btn-ghost" onClick={() => setStep(clampedStep - 1)}>이전</button>
        )}
        {isLast ? (
          <button type="button" className="wb-btn wb-btn-member" disabled={!allAnswered} onClick={submit}>답변 보내기</button>
        ) : (
          <button type="button" className="wb-btn wb-btn-member" disabled={!isAnswered(current)} onClick={() => setStep(clampedStep + 1)}>다음</button>
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
      return { question: String(q.question ?? q.header ?? ""), header: q.header ? String(q.header) : undefined, multiSelect: Boolean(q.multiSelect), options, secret: Boolean(q.secret) };
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
      <span className="wb-typing-text">작업 중…</span>
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
      return `$ ${command}`;
    }
  }
  return "";
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
  try {
    return JSON.stringify(result, null, 2);
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
