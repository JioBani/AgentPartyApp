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

import { useEffect, useRef, useState } from "react";
import { AlignLeft, ArrowUpFromLine, ChevronDown, GripVertical, Lock, Maximize2, Minimize2, Pencil, SendHorizontal, X } from "lucide-react";
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
  /** The queue block itself — used to find this panel's conversation area. */
  const rootRef = useRef<HTMLDivElement | null>(null);
  /**
   * 모두 취소 asks twice.
   *
   * It throws away every message waiting — text the user typed and cannot get
   * back, since cancelling is not undoable. One misplaced click beside 접기
   * should not be able to do that. Armed state expires on its own so the button
   * cannot sit primed indefinitely, waiting to be triggered by a click meant for
   * something else.
   */
  const [confirmClear, setConfirmClear] = useState(false);
  useEffect(() => {
    if (!confirmClear) {
      return;
    }
    const timer = setTimeout(() => setConfirmClear(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmClear]);

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

  /**
   * The row the pointer is over, for merging.
   *
   * Deliberately forgiving. Merging is aimed at a THING, not at a boundary, so
   * the target is the whole row minus a thin strip at each edge that stays
   * reserved for "between these two". Without that the target flickers on and
   * off along a one-pixel line, which is what made this feel like threading a
   * needle.
   *
   * Horizontal position is ignored on purpose: the pointer leaves the list
   * sideways all the time while dragging, and losing the target for that would
   * punish the hand for moving in a direction that means nothing here.
   *
   * A row is acquired from where it is DRAWN — that is what the hand aimed at.
   * But engaging the merge closes the gap the reorder had opened, and that moves
   * the rows below it by a whole slot. Asking again afterwards answers about the
   * NEW layout, so the target slides to the next message down. An engaged row is
   * therefore held by the box it was CAUGHT in, which does not move; the pointer
   * has to leave that box to release it.
   *
   * That is not a nicety. Without it you aim at one message and your words are
   * folded into a different one, and nothing on screen admits the swap.
   */
  function mergeTargetUnder(
    clientY: number,
    held: DragState["mergeBox"],
  ): { row: QueueRowView; top: number; bottom: number } | null {
    if (held && clientY >= held.top && clientY <= held.bottom) {
      const row = model.rows.find((candidate) => candidate.id === held.id);
      if (row) {
        return { row, top: held.top, bottom: held.bottom };
      }
    }
    const rows = Array.from(listRef.current?.querySelectorAll(".wb-queue-row") || []);
    for (let index = 0; index < rows.length; index += 1) {
      const box = rows[index].getBoundingClientRect();
      const row = model.rows[index];
      if (!row) {
        continue;
      }
      const edge = Math.min(box.height * 0.22, 9);
      if (clientY >= box.top + edge && clientY <= box.bottom - edge) {
        return { row, top: box.top, bottom: box.bottom };
      }
    }
    return null;
  }

  function startDrag(event: React.PointerEvent<HTMLElement>, row: QueueRowView) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ id: row.id, from: row.index, to: row.index, pointerX: event.clientX, pointerY: event.clientY, offsetX: 0, offset: 0, slots: snapshotRows(), released: false });
  }

  function moveDrag(event: React.PointerEvent<HTMLElement>) {
    if (!drag || drag.released) {
      return;
    }
    const over = mergeTargetUnder(event.clientY, drag.mergeBox);
    // Only a row that can actually receive the merge counts as a target, so the
    // "합치기" affordance never appears where the drop would be refused.
    const source = model.rows.find((row) => row.id === drag.id);
    const receives = over && over.row.id !== drag.id && source && over.row.from === source.from;
    const mergeInto = receives ? over.row.id : null;
    // Dragged clear of the queue and over the conversation: dropping there hands
    // the message over immediately.
    const throwZone = mergeInto ? null : transcriptUnder(event.clientX, event.clientY);
    setDrag({
      ...drag,
      offsetX: event.clientX - drag.pointerX,
      offset: event.clientY - drag.pointerY,
      to: slotUnder(event.clientY, drag.slots),
      mergeInto,
      mergeBox: receives ? { id: over.row.id, top: over.top, bottom: over.bottom } : null,
      overTranscript: Boolean(throwZone),
      throwZone,
    });
  }

  /**
   * This panel's conversation area, when the pointer is inside it.
   *
   * Returns the box as well, so the affordance can be drawn over the
   * conversation itself rather than floating in the middle of the window.
   */
  function transcriptUnder(clientX: number, clientY: number): { top: number; left: number; width: number; height: number } | null {
    const transcript = rootRef.current?.closest(".wb-panel")?.querySelector(".wb-transcript");
    if (!transcript) {
      return null;
    }
    const box = transcript.getBoundingClientRect();
    const inside = clientX >= box.left && clientX <= box.right && clientY >= box.top && clientY <= box.bottom;
    return inside ? { top: box.top, left: box.left, width: box.width, height: box.height } : null;
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
    const { id, from, to, mergeInto, overTranscript } = drag;
    // Thrown into the conversation: that is the same "send this one now" the row
    // offers as a button, reached by putting the message where it would go.
    if (overTranscript) {
      setDrag(null);
      void run({ action: "sendItem", itemId: id });
      return;
    }
    // Merging removes the carried row entirely, so there is no slot for it to
    // land in — the parking animation below would be animating towards a place
    // that is about to stop existing.
    if (mergeInto) {
      setDrag(null);
      void run({ action: "mergeInto", itemId: id, targetId: mergeInto });
      return;
    }
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
          {confirmClear ? (
            <button
              type="button"
              className="wb-queue-x is-armed"
              title={`${model.count}건을 모두 버립니다 — 한 번 더 누르면 실행됩니다`}
              onClick={() => { setConfirmClear(false); void run({ action: "clear" }); }}
            >
              <X size={12} /> 한 번 더
            </button>
          ) : (
            <button type="button" className="wb-queue-x" title="모두 취소" onClick={() => setConfirmClear(true)}><X size={12} /></button>
          )}
        </div>
        {!model.collapsed && (
          <>
            {model.rows.map((row) => (
              <div className={rowClass(row, null)} key={row.id} role="listitem">
                <span className="wb-queue-n">{row.n}</span>
                <span className={"wb-queue-dot" + (row.fromMember ? " is-member" : "")} style={row.from ? memberColorVars(row.from) : undefined} title={row.fromLabel} />
                {row.cutIn && <span className="wb-queue-cutin" title="턴을 끊고 이 메시지를 먼저 보냅니다">지금</span>}
                <span className={"wb-queue-text" + (row.open ? " is-open" : "")} title={row.text} onClick={() => toggleRow(row.id)}>{row.text}</span>
                <button type="button" className="wb-queue-expand" title={row.expandLabel} aria-expanded={row.open} onClick={() => toggleRow(row.id)}>
                  {row.open ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
                </button>
                <button type="button" className="wb-queue-del" title="삭제" onClick={() => void run({ action: "cancel", itemId: row.id })}><X size={12} /></button>
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
    <div className={"wb-queue" + (drag ? " is-dragging-row" : "")} ref={rootRef} style={memberColorVars(view.name)} aria-live="polite">
      {/* Dragged out of the queue and over the conversation. Shown THERE, where
          the message would land, rather than back in the list it is leaving. */}
      {drag?.throwZone && (
        <div className="wb-queue-throw" role="status" style={drag.throwZone}>
          {/* Says what dropping REALLY does. On a working member this is the
              same path as 지금 보내기: the turn is stopped, and with merging on
              the whole leading run leaves together — so the card names the
              stop and the count instead of promising that one row goes alone. */}
          <span className="wb-queue-throw-card">
            <SendHorizontal size={13} /> 놓으면 {model.sendNowLabel} — {model.sendNowHint}
          </span>
        </div>
      )}
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
        {confirmClear ? (
          <button
            type="button"
            className="wb-queue-flat is-danger is-armed"
            title="대기 중인 메시지를 모두 버립니다 — 되돌릴 수 없습니다"
            onClick={() => { setConfirmClear(false); void run({ action: "clear" }); }}
          >
            {model.count}건 버리기 · 한 번 더 클릭
          </button>
        ) : (
          <button type="button" className="wb-queue-flat is-danger" onClick={() => setConfirmClear(true)}>모두 취소</button>
        )}
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
              {/* Says what the drop will DO, on the row it will do it to —
                  otherwise "merge" and "reorder" look identical mid-gesture.
                  Anchored LEFT, over the grip: the hand is there, so that is
                  where the answer to "what happens if I let go" belongs. */}
              {drag?.mergeInto === row.id && (
                <span className="wb-queue-merge-hint"><ArrowUpFromLine size={12} /> 이 메시지와 합치기</span>
              )}
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
                  <GripVertical size={14} />
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
              {/* Reads with the controls, not against the message: these are
                  facts about this row's turn, so they sit with the row's other
                  affordances rather than trailing the text.
                  The expand button that used to sit here is the one below — it
                  moved right of the badges and grew, so it is not duplicated. */}
              {row.cutIn && (
                <span className="wb-queue-cutin" title="턴을 끊고 이 메시지를 먼저 보냅니다 — 기다리면 뒤에 있던 메시지보다 앞서 나갑니다">
                  지금 처리
                </span>
              )}
              {row.showNextBadge && <span className="wb-queue-next">다음 차례</span>}
              <button type="button" className="wb-queue-btn" title={row.expandLabel} aria-expanded={row.open} onClick={() => toggleRow(row.id)}>
                {row.open ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
              </button>
              {/* Merging is done by dragging a row onto another, and sending one
                  row early is the toolbar's 중단하고 보내기 — neither needs a
                  per-row button competing with 편집 and 삭제 for the same corner. */}
              {row.showEdit && (
                <button type="button" className="wb-queue-btn" title="편집 — 입력창으로 되돌리기" onClick={() => void run({ action: "edit", itemId: row.id })}><Pencil size={13} /></button>
              )}
              <button type="button" className="wb-queue-btn is-danger" title="대기열에서 삭제" onClick={() => void run({ action: "cancel", itemId: row.id })}><X size={13} /></button>
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
  /** Row this would be folded INTO, when the pointer is over a row's body. */
  mergeInto?: string | null;
  /**
   * Where that row was when the pointer caught it. Held rather than re-measured,
   * because engaging the merge moves the rows — see `mergeTargetUnder`.
   */
  mergeBox?: { id: string; top: number; bottom: number } | null;
  /** Pointer position when the row was picked up. */
  pointerX: number;
  pointerY: number;
  /** Sideways travel — the row follows the hand rather than riding a rail. */
  offsetX: number;
  /** How far the carried row has travelled from its own slot. */
  offset: number;
  /** The layout as it was at pick-up — see `snapshotRows`. */
  slots: Array<{ top: number; height: number }>;
  /** Dropped, and waiting for the reorder to come back. */
  released: boolean;
  /** Over the conversation, where dropping sends the message immediately. */
  overTranscript?: boolean;
  /** That conversation's box, so the affordance is drawn where it applies. */
  throwZone?: { top: number; left: number; width: number; height: number } | null;
}

function rowClass(row: QueueRowView, drag: DragState | null): string {
  const className = "wb-queue-row" + (row.highlighted ? " is-next" : "") + (row.open ? " is-expanded" : "");
  if (!drag) {
    return className;
  }
  if (drag.id === row.id) {
    return `${className} is-dragging${drag.released ? " is-landing" : ""}`;
  }
  // Merging outranks the reorder motion: rows must NOT step aside, because
  // nothing is going to be inserted between them. They keep `is-shifting`
  // anyway — that class only carries the transition, so the gap CLOSES at the
  // same speed it opened. Dropping the class here made it slam shut on the way
  // in and glide open on the way out, and one gesture cannot have two speeds.
  if (drag.mergeInto === row.id) {
    return `${className} is-merge-target is-shifting`;
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
    return { transform: `translate(${drag.offsetX}px, ${drag.offset}px)` };
  }
  // While a merge or a send is on offer the list stays put: opening a gap would
  // promise an insertion that is not what the drop does.
  if (drag.mergeInto || drag.overTranscript) {
    return undefined;
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
