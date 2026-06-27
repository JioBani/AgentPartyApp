import { useLayoutEffect, useRef, useState } from "react";
import { Brain, Check, ChevronRight, ListChecks, Search, ShieldCheck } from "lucide-react";
import type { MemberView, PanelDensity, TranscriptBlock } from "./types";
import type { WorkbenchActions } from "./actions";

interface TranscriptProps {
  view: MemberView;
  density: PanelDensity;
  actions: WorkbenchActions;
}

export function Transcript({ view, density, actions }: TranscriptProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastText = lastBlockText(view.transcript);

  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (node) {
      node.scrollTop = node.scrollHeight;
    }
  }, [view.transcript.length, lastText]);

  return (
    <div className={"wb-transcript density-" + density} ref={scrollRef}>
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
          <div className="wb-assistant-body">{block.text}</div>
        </div>
      );
    case "tool":
      // AskUserQuestion is shown by its approval card (the interactive question),
      // so its duplicate tool entry is suppressed here to avoid a raw-JSON echo.
      if (block.name === "AskUserQuestion") {
        return null;
      }
      return <ToolBlock block={block} density={density} />;
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

function ToolBlock({ block, density }: { block: Extract<TranscriptBlock, { kind: "tool" }>; density: PanelDensity }) {
  const arg = summarizeArg(block.input);
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
      {result && <pre className="wb-pre wb-tool-result">{result}</pre>}
    </details>
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

/** Renders an AskUserQuestion interaction as selectable choices instead of a raw allow/deny prompt. */
function QuestionBlock({ block, questions, view, density, actions }: { block: Extract<TranscriptBlock, { kind: "approval" }>; questions: ParsedQuestion[]; view: MemberView; density: PanelDensity; actions: WorkbenchActions }) {
  const [selections, setSelections] = useState<Record<string, string[]>>({});
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

  const answers = Object.fromEntries(questions.map((q) => [q.question, (selections[q.question] || []).join(", ")]));
  const ready = questions.every((q) => (selections[q.question] || []).length > 0);
  const submit = () => actions.answerQuestion(view.name, block.requestId, block.input, answers);

  return (
    <div className={"wb-block wb-approval wb-question density-" + density}>
      <div className="wb-approval-head">
        <ListChecks size={14} />
        <strong>질문에 답해주세요</strong>
        {questions[0]?.header && <span className="wb-chip wb-mono">{questions[0].header}</span>}
      </div>
      {questions.map((q, qi) => {
        const picked = resolved ? answerLabels(block.answers, q.question) : selections[q.question] || [];
        return (
          <div className="wb-question-item" key={qi}>
            <p className="wb-question-text">{q.question}</p>
            <div className="wb-question-options">
              {q.options.map((opt, oi) => {
                const active = picked.includes(opt.label);
                return (
                  <button
                    key={oi}
                    type="button"
                    className={"wb-question-option" + (active ? " is-active" : "")}
                    disabled={resolved}
                    aria-pressed={active}
                    onClick={() => toggle(q, opt.label)}
                  >
                    <span className="wb-question-option-label">{opt.label}</span>
                    {opt.description && <span className="wb-question-option-desc">{opt.description}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
      {resolved ? (
        <span className="wb-status-badge is-allow">답변함{summarizeAnswers(block.answers) ? ` · ${summarizeAnswers(block.answers)}` : ""}</span>
      ) : (
        <div className="wb-approval-actions">
          <button type="button" className="wb-btn wb-btn-ghost" onClick={() => actions.approve(view.name, block.requestId, "deny")}>건너뛰기</button>
          <button type="button" className="wb-btn wb-btn-member" disabled={!ready} onClick={submit}>답변 보내기</button>
        </div>
      )}
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

function summarizeAnswers(answers: Record<string, string> | undefined): string {
  if (!answers) {
    return "";
  }
  return Object.values(answers).filter(Boolean).join(" / ");
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

function formatResult(result: unknown): string {
  if (result == null || result === "") {
    return "";
  }
  if (typeof result === "string") {
    return result;
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
