import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDownLeft, ArrowRight, ArrowUpRight, Brain, Check, ChevronRight, ListChecks, Maximize2, Search, ShieldCheck, UserMinus, UserPlus, X } from "lucide-react";
import type { MemberView, PanelDensity, TranscriptBlock } from "./types";
import type { WorkbenchActions } from "./actions";
import { Markdown } from "./Markdown";

interface TranscriptProps {
  view: MemberView;
  density: PanelDensity;
  actions: WorkbenchActions;
}

export function Transcript({ view, density, actions }: TranscriptProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Whether the view is pinned to the bottom (true unless the user scrolled up).
  const stickRef = useRef(true);
  const lastText = lastBlockText(view.transcript);

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
      {view.transcript.map((block) => (
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
        <div className="wb-block wb-user">
          <div className="wb-user-head"><span className="wb-user-who">You</span>{block.at && <span className="wb-mono wb-time">{block.at}</span>}</div>
          <div className="wb-user-bubble">{block.text}</div>
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
    case "approval":
      return <ApprovalBlock block={block} view={view} density={density} actions={actions} />;
    default:
      return null;
  }
}

/**
 * An inter-member (agentparty channel) message. `direction` is relative to this
 * member: "in" = received from a peer, "out" = this member sent to a peer. The
 * card shows the who→whom route so cross-session traffic is legible at a glance.
 */
function ChannelBlock({ block, view }: { block: Extract<TranscriptBlock, { kind: "channel" }>; view: MemberView }) {
  const incoming = block.direction === "in";
  const from = incoming ? block.from : view.name;
  const to = incoming ? view.name : block.to;
  const failed = block.state === "failed";
  return (
    <div className={"wb-block wb-channel" + (incoming ? " is-in" : " is-out") + (failed ? " is-failed" : "")}>
      <div className="wb-channel-head">
        <span className="wb-channel-icon">{incoming ? <ArrowDownLeft size={13} /> : <ArrowUpRight size={13} />}</span>
        <span className="wb-channel-route">
          <span className="wb-channel-peer">{from || "?"}</span>
          <ArrowRight size={12} className="wb-channel-arrow" />
          <span className="wb-channel-peer">{to || "?"}</span>
        </span>
        <span className="wb-channel-tag">{incoming ? "수신" : "송신"}</span>
        {block.at && <span className="wb-mono wb-time">{block.at}</span>}
      </div>
      {block.text && <div className="wb-channel-bubble"><Markdown text={block.text} /></div>}
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
  // The summary `arg` is ellipsis-clipped; show the FULL command/input in the body
  // so a long bash command (or other arg) is never lost when expanded.
  const fullInput = toolInputDetail(block.input);
  const result = formatResult(block.result);
  const failed = block.status === "failed";
  return (
    <details className={"wb-block wb-tool density-" + density} open={density === "wide" && Boolean(result)}>
      <summary>
        <ChevronRight size={13} className="wb-caret" />
        <span className={"wb-tool-check" + (failed ? " failed" : "")}><Check size={11} /></span>
        <span className="wb-mono wb-tool-name">{block.name}</span>
        {arg && <span className="wb-mono wb-tool-arg">{arg}</span>}
      </summary>
      {fullInput && (
        // Command body scrolls within a capped height; the expand button opens a
        // full, scrollable view (command + result) for very long content.
        <div className="wb-tool-cmd-wrap">
          <pre className="wb-pre wb-tool-cmd">{fullInput}</pre>
          <button
            type="button"
            className="wb-tool-expand"
            title="전체 보기"
            aria-label="전체 보기"
            onClick={(event) => { event.preventDefault(); event.stopPropagation(); setFull(true); }}
          >
            <Maximize2 size={12} />
          </button>
        </div>
      )}
      {result && <pre className="wb-pre wb-tool-result">{result}</pre>}
      {full && <ToolDetailModal name={block.name} command={fullInput} result={result} onClose={() => setFull(false)} />}
    </details>
  );
}

/** Full, scrollable view of a tool call's command + result (the "전체 보기" overlay). */
function ToolDetailModal({ name, command, result, onClose }: { name: string; command: string; result: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="wb-tool-modal-backdrop" onClick={onClose}>
      <div className="wb-tool-modal" onClick={(event) => event.stopPropagation()}>
        <div className="wb-tool-modal-head">
          <span className="wb-mono wb-tool-name">{name}</span>
          <button type="button" className="wb-icon-btn" title="닫기" aria-label="닫기" onClick={onClose}><X size={15} /></button>
        </div>
        <div className="wb-tool-modal-body">
          {command && <pre className="wb-pre wb-tool-cmd">{command}</pre>}
          {result && <pre className="wb-pre wb-tool-result">{result}</pre>}
        </div>
      </div>
    </div>
  );
}

function ApprovalBlock({ block, view, density, actions }: { block: Extract<TranscriptBlock, { kind: "approval" }>; view: MemberView; density: PanelDensity; actions: WorkbenchActions }) {
  const questions = parseQuestions(block.input);
  if (block.toolName === "AskUserQuestion" && questions.length > 0) {
    return <QuestionBlock block={block} questions={questions} view={view} density={density} actions={actions} />;
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

interface ParsedOption { label: string; description?: string }
interface ParsedQuestion { question: string; header?: string; multiSelect: boolean; options: ParsedOption[] }

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
  const otherActive = currentPicked.includes(OTHER);
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
          {/* Claude Code always offers a free-text answer; mirror that here. */}
          <button
            type="button"
            className={"wb-question-option wb-question-other" + (otherActive ? " is-active" : "")}
            aria-pressed={otherActive}
            onClick={() => toggle(current, OTHER)}
          >
            <span className="wb-question-option-label">기타 (직접 입력)</span>
            <span className="wb-question-option-desc">원하는 답을 직접 적습니다.</span>
          </button>
          {otherActive && (
            <input
              type="text"
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
      return { question: String(q.question ?? ""), header: q.header ? String(q.header) : undefined, multiSelect: Boolean(q.multiSelect), options };
    })
    .filter((q) => q.question && q.options.length > 0);
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
