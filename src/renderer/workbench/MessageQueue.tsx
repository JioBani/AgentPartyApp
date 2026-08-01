/**
 * The message queue panel — what a busy member has been sent but has not been
 * handed yet. Lives between the transcript and the composer, inside the same
 * bordered block, and does NOT scroll: the whole point is that waiting messages
 * are visible without being hunted for, so the transcript yields the space.
 *
 * Renders `queueView.ts` (all the label and affordance rules) and drives every
 * mutation through one `runQueueCommand` action, the same path the HTTP API
 * takes. Failures surface as a notice — a cancel that silently did nothing
 * would read as success while the agent answers the message anyway.
 *
 * Layout follows `docs/디자인 핸드오프/design_handoff_message_queue` §2–§5.
 */

import { useState } from "react";
import { AlignLeft, ArrowRight, ArrowUp, ArrowUpFromLine, ChevronDown, Pencil, X } from "lucide-react";
import type { QueueCommand } from "../../shared/messageQueue";
import { memberColorVars } from "../theme/memberColors";
import { buildQueueView, type QueueRowView } from "./queueView";
import type { MemberView, PanelDensity } from "./types";
import type { WorkbenchActions } from "./actions";

interface MessageQueueProps {
  view: MemberView;
  density: PanelDensity;
  actions: WorkbenchActions;
  /** Puts an edited message back in the composer — the composer owns the draft. */
  onEditBack: (text: string) => void;
}

export function MessageQueue({ view, density, actions, onEditBack }: MessageQueueProps) {
  const [openRows, setOpenRows] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState("");

  const queue = view.member.queue;
  const model = buildQueueView({
    queue: queue || { items: [] },
    density,
    working: view.busy,
    detached: !view.session,
    memberName: view.name,
    openRows,
  });

  // No queue, no panel. An empty queue must not hold space it is not using —
  // that space belongs to the conversation.
  if (model.empty) {
    return null;
  }

  async function run(command: QueueCommand) {
    try {
      const result = await actions.runQueueCommand(view.name, command);
      setError("");
      if (command.action === "edit" && result?.text) {
        onEditBack(result.text);
      }
    } catch (failure) {
      // Loud on purpose. The likeliest cause is that the item was delivered a
      // moment ago, and staying quiet would leave the user believing they
      // stopped a message the agent is already answering.
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }

  const toggleRow = (id: string) =>
    setOpenRows((current) => {
      const next = new Set(current);
      if (!next.delete(id)) {
        next.add(id);
      }
      return next;
    });

  const notice = error ? <div className="wb-queue-error" role="alert">{error}</div> : null;

  if (model.narrow) {
    return (
      <div className="wb-queue is-narrow" style={memberColorVars(view.name)} aria-live="polite">
        <div className="wb-queue-chip">
          <button type="button" className="wb-queue-chip-main" title={model.toggleLabel} onClick={() => void run({ action: "preference", collapsed: !model.collapsed })}>
            <AlignLeft size={11} className="wb-queue-glyph" />
            <span className="wb-queue-chip-label">{model.chipLabel}</span>
            <span className="wb-queue-dots">
              {model.senderDots.map((dot) => (
                <span key={dot.key} className={"wb-queue-dot" + (dot.from ? " is-member" : "")} style={dot.from ? memberColorVars(dot.from) : undefined} />
              ))}
            </span>
            <span className="wb-queue-spacer" />
            <ChevronDown size={10} className={"wb-queue-caret" + (model.collapsed ? "" : " is-open")} />
          </button>
          <button type="button" className={"wb-queue-pill" + (model.merge ? " is-on" : "")} title="합쳐서 한 번에 전송" onClick={() => void run({ action: "preference", merge: !model.merge })}>
            {model.mergePillLabel}
          </button>
          <button type="button" className="wb-queue-x" title="모두 취소" onClick={() => void run({ action: "clear" })}><X size={10} /></button>
        </div>
        {!model.collapsed && (
          <>
            {model.rows.map((row) => (
              <div className={rowClass(row)} key={row.id} role="listitem">
                <span className="wb-queue-n">{row.n}</span>
                <span className={"wb-queue-dot" + (row.fromMember ? " is-member" : "")} style={row.from ? memberColorVars(row.from) : undefined} title={row.fromLabel} />
                <span className={"wb-queue-text" + (row.open ? " is-open" : "")} title={row.text} onClick={() => toggleRow(row.id)}>{row.text}</span>
                {row.showSendNowIcon && (
                  <button type="button" className="wb-queue-send-icon" title="지금 보내기" onClick={() => void run({ action: "sendItem", itemId: row.id })}><ArrowRight size={10} /></button>
                )}
                <button type="button" className="wb-queue-del" title="삭제" onClick={() => void run({ action: "cancel", itemId: row.id })}><X size={10} /></button>
              </div>
            ))}
            <button type="button" className="wb-queue-send-all is-block" onClick={() => void run({ action: "send" })}>{model.sendAllLabel}</button>
          </>
        )}
        {notice}
      </div>
    );
  }

  return (
    <div className="wb-queue" style={memberColorVars(view.name)} aria-live="polite">
      <div className="wb-queue-head">
        <button type="button" className="wb-queue-title" onClick={() => void run({ action: "preference", collapsed: !model.collapsed })}>
          <AlignLeft size={12} className="wb-queue-glyph" />
          <span className="wb-queue-title-text">{model.title}</span>
          <ChevronDown size={10} className={"wb-queue-caret" + (model.collapsed ? "" : " is-open")} />
        </button>
        {model.collapsed ? (
          <button type="button" className="wb-queue-preview" title="펼쳐서 보기" onClick={() => void run({ action: "preference", collapsed: false })}>
            {model.collapsedPreview}
          </button>
        ) : (
          <span className="wb-queue-note">{model.note}</span>
        )}
        <button type="button" className="wb-queue-flat" onClick={() => void run({ action: "preference", collapsed: !model.collapsed })}>{model.toggleLabel}</button>
        <button type="button" className="wb-queue-flat is-danger" onClick={() => void run({ action: "clear" })}>모두 취소</button>
      </div>

      {!model.collapsed && (
        <>
          <div className="wb-queue-merge">
            <button type="button" className="wb-queue-switch-btn" title="전송할 때 대기열을 한 메시지로 합칩니다" onClick={() => void run({ action: "preference", merge: !model.merge })}>
              <span className={"wb-queue-switch" + (model.merge ? " is-on" : "")}><span className="wb-queue-knob" /></span>
              <span className={"wb-queue-switch-label" + (model.merge ? " is-on" : "")}>합쳐서 한 번에</span>
            </button>
            <span className="wb-queue-merge-note">{model.mergeNote}</span>
            <button type="button" className="wb-queue-send-all" onClick={() => void run({ action: "send" })}>{model.sendAllLabel}</button>
          </div>

          {model.rows.map((row) => (
            <div className={rowClass(row)} key={row.id} role="listitem">
              {row.onRail && <span className="wb-queue-rail" style={{ top: row.railTop, bottom: row.railBottom }} />}
              <span className="wb-queue-n">{row.n}</span>
              <span
                className={"wb-queue-from" + (row.fromMember ? " is-member" : "")}
                style={row.from ? memberColorVars(row.from) : undefined}
                title={`${row.fromLabel}가 보낸 메시지`}
              >
                <span className="wb-queue-from-dot" />
                {row.fromLabel}
              </span>
              <span className={"wb-queue-text" + (row.open ? " is-open" : "")} title={row.text} onClick={() => toggleRow(row.id)}>{row.text}</span>
              {row.showNextBadge && <span className="wb-queue-next">다음 차례</span>}
              {row.showSendNowText && (
                <button type="button" className="wb-queue-send-now" title="대기하지 않고 지금 전송" onClick={() => void run({ action: "sendItem", itemId: row.id })}>지금 보내기</button>
              )}
              {row.showMergeUp && (
                <button type="button" className="wb-queue-btn is-accent" title="위 메시지와 합치기" onClick={() => void run({ action: "mergeUp", itemId: row.id })}><ArrowUpFromLine size={12} /></button>
              )}
              {row.showMoveUp && (
                <button type="button" className="wb-queue-btn" title="위로" onClick={() => void run({ action: "move", itemId: row.id, direction: -1 })}><ArrowUp size={12} /></button>
              )}
              {row.showEdit && (
                <button type="button" className="wb-queue-btn" title="편집 — 입력창으로 되돌리기" onClick={() => void run({ action: "edit", itemId: row.id })}><Pencil size={12} /></button>
              )}
              <button type="button" className="wb-queue-btn is-danger" title="대기열에서 삭제" onClick={() => void run({ action: "cancel", itemId: row.id })}><X size={12} /></button>
            </div>
          ))}
        </>
      )}
      {notice}
    </div>
  );
}

function rowClass(row: QueueRowView): string {
  return "wb-queue-row" + (row.highlighted ? " is-next" : "");
}
