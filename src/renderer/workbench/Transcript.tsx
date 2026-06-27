import { useLayoutEffect, useRef } from "react";
import { Brain, Check, ChevronRight, Search, ShieldCheck } from "lucide-react";
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
        <Block key={block.id} block={block} view={view} density={density} actions={actions} />
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
