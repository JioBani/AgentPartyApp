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
import { LocalizedText, localized } from "../i18n/I18nProvider";

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

  /**
   * The slot the pointer is over, against the frozen layout.
   *
   * The midpoint belongs to the row it is the midpoint OF, with a pixel of
   * slack: pointer coordinates are whole numbers and a row's centre rarely is,
   * so on a one-line row — where the whole card is barely thirty pixels — a
   * half-pixel would otherwise decide which of two messages goes first, and
   * aiming squarely at a row would land the drop below it.
   */
  function slotUnder(clientY: number, slots: Array<{ top: number; height: number }>): number {
    for (let index = 0; index < slots.length; index += 1) {
      if (clientY <= slots[index].top + slots[index].height / 2 + 1) {
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
    <div className="wb-queue-handed" title={localized("STR-1809")}>
      <Lock size={10} />

      <LocalizedText id="STR-1811" /> {model.handedOver}<LocalizedText id="STR-1810" />
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
          {/* Inert below two messages, for the same reason as the wide switch:
              one waiting message has nothing to be merged with. */}
          <button
            type="button"
            className={"wb-queue-pill" + (model.merge ? " is-on" : "") + (model.canMerge ? "" : " is-inert")}
            title={model.canMerge ? localized("STR-1812") : undefined}
            aria-pressed={model.merge}
            disabled={!model.canMerge}
            onClick={() => void run({ action: "preference", merge: !model.merge })}
          >
            {model.mergePillLabel}
          </button>
          {confirmClear ? (
            <button
              type="button"
              className="wb-queue-x is-armed"
              title={localized("STR-1813", [model.count])}
              onClick={() => { setConfirmClear(false); void run({ action: "clear" }); }}
            >
              <X size={12} />  <LocalizedText id="STR-1814" />
            </button>
          ) : (
            <button type="button" className="wb-queue-x" title={localized("STR-1815")} onClick={() => setConfirmClear(true)}><X size={12} /></button>
          )}
        </div>
        {!model.collapsed && (
          <>
            {/* One line, like the wide row: order, sender, message, controls.
                Flat children in a column box gave every one of them a line of
                its own, which is how a one-line message became a tall card with
                a number, a dot and an × stacked down the middle of it. */}
            {model.rows.map((row) => (
              <div className={rowClass(row, null)} key={row.id} role="listitem">
                <div className="wb-queue-row-head">
                  <span className="wb-queue-ord" title={localized("STR-3786", [row.n])} aria-label={localized("STR-3786", [row.n])}>
                    <span className="wb-queue-n">{row.n}</span>
                  </span>
                  <div className="wb-queue-meta">
                    <span
                      className={"wb-queue-dot" + (row.fromMember ? " is-member" : "")}
                      style={row.from ? memberColorVars(row.from) : undefined}
                      title={localized("STR-1832", [row.fromLabel])}
                      aria-label={localized("STR-1832", [row.fromLabel])}
                    />
                    {row.cutIn && <span className="wb-queue-cutin" title={localized("STR-1817")}><LocalizedText id="STR-1816" /></span>}
                  </div>
                  <span className={"wb-queue-text" + (row.open ? " is-open" : "")} title={row.open ? undefined : row.text} onClick={() => { if (!row.open) { toggleRow(row.id); } }}>{row.text}</span>
                  <div className="wb-queue-row-actions">
                    <button type="button" className="wb-queue-btn" data-queue-action="expand" title={row.expandLabel} aria-label={row.expandLabel} aria-expanded={row.open} onClick={() => toggleRow(row.id)}>
                      {row.open ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
                    </button>
                    <button type="button" className="wb-queue-btn is-danger" data-queue-action="remove" title={localized("STR-1818")} aria-label={localized("STR-1818")} onClick={() => void run({ action: "cancel", itemId: row.id })}><X size={12} /></button>
                  </div>
                </div>
              </div>
            ))}
            {/* No room here for the wide layout's merge band, so the whole-queue
                send is its own full-width row under the list. */}
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
            <SendHorizontal size={13} />  <LocalizedText id="STR-1821" /> {model.sendNowLabel} — {model.sendNowHint}
          </span>
        </div>
      )}
      {/* Three bands: what this is, what will happen, and what you can do to
          the whole queue. They used to share one nowrap line, where the status
          sentence squeezed the title and the two buttons drifted apart at the
          widths a panel actually gets. Now the status wraps to its own line
          before anything is crushed. */}
      <div className="wb-queue-head">
        <button type="button" className="wb-queue-title" title={model.toggleLabel} aria-expanded={!model.collapsed} onClick={() => void run({ action: "preference", collapsed: !model.collapsed })}>
          <AlignLeft size={12} className="wb-queue-glyph" />
          <span className="wb-queue-title-text">{model.title}</span>
          <ChevronDown size={10} className={"wb-queue-caret" + (model.collapsed ? "" : " is-open")} />
        </button>
        {model.collapsed ? (
          <button type="button" className="wb-queue-preview" title={localized("STR-1822")} onClick={() => void run({ action: "preference", collapsed: false })}>
            {model.collapsedPreview}
          </button>
        ) : model.note ? (
          <span className="wb-queue-note">{model.note}</span>
        ) : null}
        {/* One well, so the two whole-queue controls stay together however the
            row wraps. */}
        <div className="wb-queue-head-actions">
          <button type="button" className="wb-queue-flat" aria-expanded={!model.collapsed} onClick={() => void run({ action: "preference", collapsed: !model.collapsed })}>{model.toggleLabel}</button>
          {confirmClear ? (
            <button
              type="button"
              className="wb-queue-flat is-danger is-armed"
              title={localized("STR-1823")}
              onClick={() => { setConfirmClear(false); void run({ action: "clear" }); }}
            >
              {model.count}<LocalizedText id="STR-1824" />
            </button>
          ) : (
            <button type="button" className="wb-queue-flat is-danger" onClick={() => setConfirmClear(true)}><LocalizedText id="STR-1825" /></button>
          )}
        </div>
      </div>

      {!model.collapsed && (
        <>
          {/* Merging needs two messages to mean anything. Below that the switch
              stays visible — so the setting does not appear and disappear — but
              inert, and the note beside it says why, rather than leaving a live
              control whose two positions do the same thing. */}
          <div className={"wb-queue-merge" + (model.canMerge ? "" : " is-inert")}>
            <button
              type="button"
              className="wb-queue-switch-btn"
              title={model.canMerge ? localized("STR-1826") : undefined}
              aria-pressed={model.merge}
              disabled={!model.canMerge}
              onClick={() => void run({ action: "preference", merge: !model.merge })}
            >
              <span className={"wb-queue-switch" + (model.merge ? " is-on" : "")}><span className="wb-queue-knob" /></span>
              <span className={"wb-queue-switch-label" + (model.merge ? " is-on" : "")}><LocalizedText id="STR-1827" /></span>
            </button>
            {model.mergeNote && <span className="wb-queue-merge-note">{model.mergeNote}</span>}
            {/* The whole-queue send, at the right end of the same thin band.
                Its own footer strip below the list cost a rule, a row and the
                vertical space the queue exists to save, for a control that was
                already legible here: it names the count it will send, which is
                what tells it apart from the setting beside it. */}
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
                <span className="wb-queue-merge-hint"><ArrowUpFromLine size={12} />  <LocalizedText id="STR-1829" /></span>
              )}
              <div className="wb-queue-row-head" data-queue-header>
                {row.showGrip ? (
                  <button
                    type="button"
                    className="wb-queue-grip"
                    title={localized("STR-1830")}
                    aria-label={localized("STR-1831", [row.n])}
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
                {/* Delivery order, first and in a fixed slot. What the number
                    MEANS — a position, not a count or an id — is said by the
                    tooltip and the accessible name rather than by a "번째" the
                    row cannot spare the width for: on one line the message
                    body is what that space is worth. */}
                <span className="wb-queue-ord" title={localized("STR-3786", [row.n])} aria-label={localized("STR-3786", [row.n])}>
                  <span className="wb-queue-n">{row.n}</span>
                </span>
                {/* Everything ABOUT this row's turn, in one band between the
                    order and the controls: who sent it, and whether it cut in or
                    is up next. It used to float beside the number, where the
                    chip read as part of the ordinal. */}
                <div className="wb-queue-meta">
                  <span
                    className={"wb-queue-from" + (row.fromMember ? " is-member" : "")}
                    style={row.from ? memberColorVars(row.from) : undefined}
                    title={localized("STR-1832", [row.fromLabel])}
                    aria-label={localized("STR-1832", [row.fromLabel])}
                  >
                    <span className="wb-queue-from-dot" />
                    {row.fromLabel}
                  </span>
                  {/* Facts about the turn, not about the message: they belong
                      with the sender rather than reserving a column beside every
                      body line. */}
                  {row.cutIn && (
                    <span className="wb-queue-cutin" title={localized("STR-1833")}>
                      <LocalizedText id="STR-1834" />
                    </span>
                  )}
                  {row.showNextBadge && <span className="wb-queue-next"><LocalizedText id="STR-1835" /></span>}
                </div>
                {/* The message, on the SAME line as everything else. Given a
                    band of its own it made a two-line card out of a five-word
                    message and left the controls floating beside empty space;
                    here it takes the row's slack and clips, and the full text
                    is one click (or the tooltip) away. */}
                <span className={"wb-queue-text" + (row.open ? " is-open" : "")} title={row.open ? undefined : row.text} onClick={() => { if (!row.open) { toggleRow(row.id); } }}>{row.text}</span>
                {/* One control well, right-aligned and in the same order on
                    every row, so the delete never lands where the expand was. */}
                <div className="wb-queue-row-actions">
                  <button type="button" className="wb-queue-btn" data-queue-action="expand" title={row.expandLabel} aria-label={row.expandLabel} aria-expanded={row.open} onClick={() => toggleRow(row.id)}>
                    {row.open ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
                  </button>
                  {/* Merging is done by dragging a row onto another, and sending
                      one row early is the toolbar's 중단하고 보내기 — neither
                      needs a per-row button competing for the same corner. */}
                  {row.showEdit && (
                    <button type="button" className="wb-queue-btn" data-queue-action="edit" title={localized("STR-1836")} aria-label={localized("STR-1836")} onClick={() => void run({ action: "edit", itemId: row.id })}><Pencil size={13} /></button>
                  )}
                  <button type="button" className="wb-queue-btn is-danger" data-queue-action="remove" title={localized("STR-1837")} aria-label={localized("STR-1837")} onClick={() => void run({ action: "cancel", itemId: row.id })}><X size={13} /></button>
                </div>
              </div>
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
