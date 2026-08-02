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

import { useRef, useState } from "react";
import { AlignLeft, ArrowRight, ArrowUpFromLine, ChevronDown, GripVertical, Lock, Maximize2, Minimize2, Pencil, X } from "lucide-react";
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
  const [drag, setDrag] = useState<DragState | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const queue = view.member.queue;
  const model = buildQueueView({
    queue: queue || { items: [] },
    density,
    working: view.busy,
    detached: !view.session,
    memberName: view.name,
    openRows,
    handedOver: view.session?.snapshot.queuedTurnCount,
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

  /**
   * Where each row sat when the drag began.
   *
   * Frozen on purpose. Once rows start stepping aside they are no longer where
   * the layout put them, so reading live boxes to decide the target would make
   * the answer depend on the animation it is driving — the row would chase its
   * own gap. The slots do not move; only the pictures of them do.
   */
  function snapshotRows(): Array<{ top: number; height: number }> {
    return Array.from(listRef.current?.querySelectorAll(".wb-queue-row") || []).map((row) => {
      const box = row.getBoundingClientRect();
      return { top: box.top, height: box.height };
    });
  }

  /** The slot the pointer is over, against the frozen layout. */
  function slotUnder(clientY: number, slots: Array<{ top: number; height: number }>): number {
    for (let index = 0; index < slots.length; index += 1) {
      if (clientY < slots[index].top + slots[index].height / 2) {
        return index;
      }
    }
    return Math.max(0, slots.length - 1);
  }

  function startDrag(event: React.PointerEvent<HTMLElement>, row: QueueRowView) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ id: row.id, from: row.index, to: row.index, pointerY: event.clientY, offset: 0, slots: snapshotRows(), released: false });
  }

  function moveDrag(event: React.PointerEvent<HTMLElement>) {
    if (!drag || drag.released) {
      return;
    }
    setDrag({ ...drag, offset: event.clientY - drag.pointerY, to: slotUnder(event.clientY, drag.slots) });
  }

  /**
   * Lands the row where it was dropped.
   *
   * The carried row is parked at the target slot rather than released on the
   * spot, and the drag is only cleared once the new order has actually arrived.
   * Dropping the transform first would snap the row back to its old position for
   * the frame before the reorder lands — the one moment the eye is watching it.
   */
  async function endDrag(event: React.PointerEvent<HTMLElement>) {
    if (!drag || drag.released) {
      return;
    }
    event.currentTarget.releasePointerCapture(event.pointerId);
    const { id, from, to } = drag;
    if (to === from) {
      setDrag(null);
      return;
    }
    setDrag({ ...drag, released: true, offset: slotOffset(drag, to) });
    try {
      await run({ action: "move", itemId: id, toIndex: to });
    } finally {
      setDrag(null);
    }
  }

  /** Distance from the dragged row's own slot to the slot it is going into. */
  function slotOffset(state: DragState, to: number): number {
    const slots = state.slots;
    if (!slots[state.from] || !slots[to]) {
      return state.offset;
    }
    // Below its own slot, the row lands after the rows that moved up to fill in;
    // above, it lands at the target's top edge.
    return to > state.from
      ? slots[to].top + slots[to].height - (slots[state.from].top + slots[state.from].height)
      : slots[to].top - slots[state.from].top;
  }

  /** The keyboard half of the same gesture — the order must not need a mouse. */
  function stepRow(event: React.KeyboardEvent<HTMLElement>, row: QueueRowView) {
    const step = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
    if (!step) {
      return;
    }
    event.preventDefault();
    const toIndex = row.index + step;
    if (toIndex < 0 || toIndex >= model.rows.length) {
      return;
    }
    void run({ action: "move", itemId: row.id, toIndex });
  }

  /**
   * Messages already inside the harness. Shown apart from the list and WITHOUT
   * controls, because there is nothing left to control — they cannot be
   * cancelled or edited. Silence here would just move the invisible queue one
   * layer down: the count would read low and 취소 would appear to work.
   */
  const handedOver = model.handedOver > 0 ? (
    <div className="wb-queue-handed" title="이미 하네스로 전달되어 앱에서 취소할 수 없는 메시지입니다">
      <Lock size={10} />
      전달됨 {model.handedOver}건 — 이미 넘어가 취소할 수 없습니다
    </div>
  ) : null;

  // Nothing left that can still be acted on — only in-flight messages. Header,
  // merge row and 모두 취소 would all be controls over an empty set, so the
  // disclosure stands alone.
  if (model.count === 0) {
    return <div className="wb-queue" style={memberColorVars(view.name)} aria-live="polite">{handedOver}</div>;
  }

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
              <div className={rowClass(row, null)} key={row.id} role="listitem">
                <span className="wb-queue-n">{row.n}</span>
                <span className={"wb-queue-dot" + (row.fromMember ? " is-member" : "")} style={row.from ? memberColorVars(row.from) : undefined} title={row.fromLabel} />
                <span className={"wb-queue-text" + (row.open ? " is-open" : "")} title={row.text} onClick={() => toggleRow(row.id)}>{row.text}</span>
                <button type="button" className="wb-queue-expand" title={row.expandLabel} aria-expanded={row.open} onClick={() => toggleRow(row.id)}>
                  {row.open ? <Minimize2 size={10} /> : <Maximize2 size={10} />}
                </button>
                {row.showSendNowIcon && (
                  <button type="button" className="wb-queue-send-icon" title={model.sendNowHint} onClick={() => void run({ action: "sendItem", itemId: row.id })}><ArrowRight size={10} /></button>
                )}
                <button type="button" className="wb-queue-del" title="삭제" onClick={() => void run({ action: "cancel", itemId: row.id })}><X size={10} /></button>
              </div>
            ))}
            <button type="button" className="wb-queue-send-all is-block" onClick={() => void run({ action: "send" })}>{model.sendAllLabel}</button>
          </>
        )}
        {handedOver}
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

          <div className="wb-queue-list" ref={listRef}>
          {model.rows.map((row) => (
            <div className={rowClass(row, drag)} style={rowStyle(row, drag)} key={row.id} role="listitem" data-queue-index={row.index}>
              {row.onRail && !drag && <span className="wb-queue-rail" style={{ top: row.railTop, bottom: row.railBottom }} />}
              {row.showGrip ? (
                <button
                  type="button"
                  className="wb-queue-grip"
                  title="끌어서 순서 바꾸기 (↑ ↓ 로도 이동)"
                  aria-label={`${row.n}번째 — 끌어서 순서 바꾸기`}
                  onPointerDown={(event) => startDrag(event, row)}
                  onPointerMove={moveDrag}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                  onKeyDown={(event) => stepRow(event, row)}
                >
                  <GripVertical size={12} />
                </button>
              ) : (
                <span className="wb-queue-grip is-idle" aria-hidden="true" />
              )}
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
              <button type="button" className="wb-queue-expand" title={row.expandLabel} aria-expanded={row.open} onClick={() => toggleRow(row.id)}>
                {row.open ? <Minimize2 size={11} /> : <Maximize2 size={11} />}
              </button>
              {row.showNextBadge && <span className="wb-queue-next">다음 차례</span>}
              {row.showSendNowText && (
                <button type="button" className="wb-queue-send-now" title={model.sendNowHint} onClick={() => void run({ action: "sendItem", itemId: row.id })}>{model.sendNowLabel}</button>
              )}
              {row.showMergeUp && (
                <button type="button" className="wb-queue-btn is-accent" title="위 메시지와 합치기" onClick={() => void run({ action: "mergeUp", itemId: row.id })}><ArrowUpFromLine size={12} /></button>
              )}
              {row.showEdit && (
                <button type="button" className="wb-queue-btn" title="편집 — 입력창으로 되돌리기" onClick={() => void run({ action: "edit", itemId: row.id })}><Pencil size={12} /></button>
              )}
              <button type="button" className="wb-queue-btn is-danger" title="대기열에서 삭제" onClick={() => void run({ action: "cancel", itemId: row.id })}><X size={12} /></button>
            </div>
          ))}
          </div>
        </>
      )}
      {handedOver}
      {notice}
    </div>
  );
}

/** A drag in progress, before the new order has arrived. */
interface DragState {
  id: string;
  from: number;
  to: number;
  /** Pointer position when the row was picked up. */
  pointerY: number;
  /** How far the carried row has travelled from its own slot. */
  offset: number;
  /** The layout as it was at pick-up — see `snapshotRows`. */
  slots: Array<{ top: number; height: number }>;
  /** Dropped, and waiting for the reorder to come back. */
  released: boolean;
}

function rowClass(row: QueueRowView, drag: DragState | null): string {
  const className = "wb-queue-row" + (row.highlighted ? " is-next" : "");
  if (!drag) {
    return className;
  }
  if (drag.id === row.id) {
    return `${className} is-dragging${drag.released ? " is-landing" : ""}`;
  }
  return `${className} is-shifting`;
}

/**
 * How far a row steps aside so the carried one has somewhere to go.
 *
 * A gap that opens where the row will land says the same thing a drop line said,
 * but in the language of the thing being moved: the list makes room rather than
 * annotating itself. Every row moves by the carried row's own height, since that
 * is exactly the space its slot frees up — right even when rows differ in height
 * because one of them is expanded.
 */
function rowStyle(row: QueueRowView, drag: DragState | null): React.CSSProperties | undefined {
  if (!drag) {
    return undefined;
  }
  if (drag.id === row.id) {
    return { transform: `translateY(${drag.offset}px)` };
  }
  const carried = drag.slots[drag.from];
  if (!carried) {
    return undefined;
  }
  // Gap between rows, taken from the layout rather than assumed.
  const next = drag.slots[drag.from + 1];
  const gap = next ? Math.max(0, next.top - (carried.top + carried.height)) : 0;
  const step = carried.height + gap;
  if (drag.to > drag.from && row.index > drag.from && row.index <= drag.to) {
    return { transform: `translateY(${-step}px)` };
  }
  if (drag.to < drag.from && row.index >= drag.to && row.index < drag.from) {
    return { transform: `translateY(${step}px)` };
  }
  return undefined;
}
