/**
 * View model for the message queue panel — every label, every per-row
 * affordance, and the merge rail geometry, derived in one pure function.
 *
 * The rules are dense and density-dependent (a row shows five buttons at wide
 * and two at narrow; the "next up" badge only exists at wide and only with
 * merging off; the rail only spans the leading run). Deriving them here rather
 * than inside JSX keeps the component a straight rendering of a described
 * state, and lets the rules be asserted without a DOM.
 *
 * Mirrors `docs/디자인 핸드오프/design_handoff_message_queue` §2–§6.
 */

import type { MemberQueueState, QueuedMessage } from "../../shared/messageQueue";
import { hasMixedSenders, leadRun, mergeOn } from "../../shared/messageQueue";
import type { PanelDensity } from "./types";

export interface QueueRowView {
  id: string;
  text: string;
  /** 1-based position, as shown in the ordinal chip. */
  n: number;
  /** Sending member's name, or null for the user. */
  from: string | null;
  /** Chip label — the member's name, or "나" for the user. */
  fromLabel: string;
  /** True when a member sent it, which colours the chip with that member's channel colour. */
  fromMember: boolean;
  /**
   * True when this row cut in via interrupt / "지금 바로 처리". Shown so a
   * jumped order is never silent — the user can see WHY it is ahead.
   */
  cutIn: boolean;
  /** This row is the next one that will be delivered. */
  isNext: boolean;
  /** Highlight the row in the member's colour — only meaningful with merging OFF. */
  highlighted: boolean;
  /** Body is expanded (pre-wrap) rather than clipped to one line. */
  open: boolean;
  /**
   * The row carries an explicit expand control.
   *
   * A queued message is often several lines, and a queue that renders them in
   * full stops being a queue — six of them push the conversation off the panel.
   * So the row is one line by default and the full body is a deliberate ask.
   */
  showExpand: boolean;
  expandLabel: string;
  showNextBadge: boolean;
  showSendNowText: boolean;
  showSendNowIcon: boolean;
  showEdit: boolean;
  /**
   * The row can be picked up and dropped elsewhere. A grip rather than a 위로
   * button: reordering is "put this there", and saying that as a run of
   * single-step swaps makes the user do the arithmetic the gesture exists to
   * avoid. The grip is focusable and answers ArrowUp/ArrowDown, so the order is
   * reachable without a mouse.
   */
  showGrip: boolean;
  /** 0-based position — the drop target math and the keyboard step both need it. */
  index: number;
  showMergeUp: boolean;
  /** This row is part of the run that will leave as one message. */
  onRail: boolean;
  /** The rail is drawn from the row's midpoint when it starts the run, and to the midpoint when it ends it. */
  railTop: string;
  railBottom: string;
}

export interface QueueView {
  count: number;
  /** Nothing waiting anywhere — the panel renders nothing at all. */
  empty: boolean;
  /**
   * Messages the HARNESS is holding, which this app can no longer reach.
   *
   * The app queue is not the only queue: each adapter buffers turns on its own
   * `isTurnActive()`, and that is a different source of truth from the session
   * snapshot this app reads. The residual path is the genuine race where the
   * snapshot still reads idle but the adapter's turn has already begun.
   * Interrupt-on-send no longer feeds that buffer (#23) — it parks at the front
   * of THIS queue instead. Those harness-held items cannot be cancelled or
   * edited. Counting them into the main total would offer a 취소 button that
   * cannot work; hiding them would recreate, one layer down, exactly the
   * invisible queue this feature exists to abolish. So they are shown, apart,
   * and labelled as unreachable.
   */
  handedOver: number;
  collapsed: boolean;
  merge: boolean;
  narrow: boolean;
  /** "대기열 3" */
  title: string;
  /** "대기열 3건" — the narrow chip's shorter form. */
  chipLabel: string;
  /** Header status line: what will happen and when. */
  note: string;
  /** Merge-row explanation, which changes with mixed senders. */
  mergeNote: string;
  /** Primary send button label; names the count only when several items actually merge. */
  sendAllLabel: string;
  /** Per-row send button label — naming the stop when there is a turn to stop. */
  sendNowLabel: string;
  sendNowHint: string;
  toggleLabel: string;
  /** One-line preview shown while collapsed. */
  collapsedPreview: string;
  mergePillLabel: string;
  /** Up to three sender dots, deduplicated in first-appearance order. */
  senderDots: Array<{ key: string; from: string | null }>;
  rows: QueueRowView[];
}

export interface QueueViewInput {
  queue: MemberQueueState;
  density: PanelDensity;
  /** The member is mid-turn, which decides whether the header promises a later send or an idle one. */
  working: boolean;
  /** The member has no live session; nothing will be delivered until it starts. */
  detached: boolean;
  memberName: string;
  /** Row ids whose body the user expanded. */
  openRows: ReadonlySet<string>;
  /** `snapshot.queuedTurnCount` — turns the harness itself is holding. See {@link QueueView.handedOver}. */
  handedOver?: number;
}

export function buildQueueView(input: QueueViewInput): QueueView {
  const { queue, density, working, detached, memberName, openRows } = input;
  const handedOver = Math.max(0, input.handedOver || 0);
  const items = queue.items;
  const merge = mergeOn(queue);
  const narrow = density === "narrow";
  // Narrow panels start collapsed: at that width the queue would eat the
  // transcript it exists to protect. Wider ones start open, because the whole
  // point is that waiting messages are visible without being hunted for.
  const collapsed = queue.collapsed === undefined ? narrow : queue.collapsed;
  const run = leadRun(items);
  const mixed = hasMixedSenders(items);
  const mergedCount = merge ? run.length : 1;
  const cutInCount = items.filter((item) => item.cutIn).length;

  return {
    count: items.length,
    // Harness-held messages keep the panel open on their own. Otherwise an app
    // queue that just drained would hide the very items that are still in
    // flight, which is the invisible queue all over again.
    empty: items.length === 0 && handedOver === 0,
    handedOver,
    collapsed,
    merge,
    narrow,
    title: `대기열 ${items.length}`,
    chipLabel: `대기열 ${items.length}건`,
    note: headerNote({ memberName, working, detached, merge, count: items.length, cutInCount }),
    mergeNote: mergeNote({ merge, mixed, count: items.length }),
    // Naming a count that is not actually a merge would overstate what the
    // button does, so a single-item send is just "지금 보내기". While the member
    // is working, sending sooner means stopping the turn — see
    // `sendQueuedNow` — and a button that hides that would be asking for a
    // stop the user never agreed to.
    sendAllLabel: sendLabel({ working, merge, runLength: run.length }),
    sendNowLabel: working ? "중단하고 보내기" : "지금 보내기",
    sendNowHint: working
      ? "이 멤버의 작업을 중단하고 대기열을 바로 전달합니다"
      : "대기하지 않고 지금 전송합니다",
    toggleLabel: collapsed ? "펼치기" : "접기",
    collapsedPreview: collapsedPreview(items),
    mergePillLabel: merge ? "합침" : "개별",
    senderDots: senderDots(items),
    rows: items.map((item, index) => buildRow({ item, index, items, run, merge, density, openRows, mergedCount })),
  };
}

function buildRow(args: {
  item: QueuedMessage;
  index: number;
  items: QueuedMessage[];
  run: QueuedMessage[];
  merge: boolean;
  density: PanelDensity;
  openRows: ReadonlySet<string>;
  mergedCount: number;
}): QueueRowView {
  const { item, index, items, run, merge, density, openRows } = args;
  const narrow = density === "narrow";
  const previous = index > 0 ? items[index - 1] : undefined;
  const sameSenderAsPrevious = Boolean(previous && (previous.from ?? null) === (item.from ?? null));
  /*
   * Who goes next.
   *
   * With merging OFF exactly one row leaves, so only the first is next. With it
   * ON the whole LEADING RUN leaves together as one message — so every row in
   * that run is next, and marking only the first understated it.
   *
   * Deliberately the run and not the whole queue: a row behind a different
   * sender does NOT go with this turn, and badging it would promise a delivery
   * that is not about to happen.
   */
  const inLeadingRun = index < run.length;
  const highlighted = merge ? inLeadingRun : index === 0;
  const onRail = merge && run.length > 1 && index < run.length;

  return {
    id: item.id,
    text: item.text,
    n: index + 1,
    from: item.from ?? null,
    fromLabel: item.from || "나",
    fromMember: Boolean(item.from),
    cutIn: Boolean(item.cutIn),
    isNext: index === 0,
    highlighted,
    open: openRows.has(item.id),
    // Present at every width: reading what you queued must not require a
    // resize, the same rule that keeps 삭제 on the narrow row.
    showExpand: true,
    expandLabel: openRows.has(item.id) ? "접기" : "펼쳐서 전체 보기",
    // Two rules, both kept. With merge on, every row that will go out in this
    // turn says so — not just the first. And a cut-in row says 지금 처리
    // instead, which already explains why it is ahead; two chips on one row
    // would compete to answer the same question.
    // `run` respects the cut-in boundary (see leadRun), so a cut-in row at the
    // front forms its own run and the ordinary rows behind it stay unbadged.
    showNextBadge: density === "wide" && !item.cutIn && (merge ? inLeadingRun : index === 0),
    showSendNowText: index === 0 && !narrow && !merge,
    showSendNowIcon: index === 0 && narrow,
    // Narrow drops reordering and editing entirely rather than shrinking five
    // controls into an unhittable row; the handoff's escape hatch is to widen
    // the panel. Delete stays at every width — cancelling must never need one.
    showEdit: !narrow,
    // A single queued message has nowhere to go, so the grip would be a control
    // over an impossible action.
    showGrip: !narrow && items.length > 1,
    index,
    showMergeUp: index > 0 && sameSenderAsPrevious && Boolean(previous?.cutIn) === Boolean(item.cutIn) && !narrow,
    onRail,
    railTop: index === 0 ? "50%" : "0",
    railBottom: index === run.length - 1 ? "50%" : "0",
  };
}

function sendLabel(args: { working: boolean; merge: boolean; runLength: number }): string {
  const merged = args.merge && args.runLength > 1;
  if (args.working) {
    return merged ? `중단하고 합쳐서 보내기 · ${args.runLength}건` : "중단하고 보내기";
  }
  return merged ? `합쳐서 지금 보내기 · ${args.runLength}건` : "지금 보내기";
}

function headerNote(args: {
  memberName: string;
  working: boolean;
  detached: boolean;
  merge: boolean;
  count: number;
  cutInCount: number;
}): string {
  if (args.detached) {
    // Never imply an imminent send when there is nothing to send to. The queue
    // is kept, not dropped — but the user has to know it is parked.
    return "세션 재시작 대기 중 — 시작하면 전송됩니다";
  }
  if (args.cutInCount > 0) {
    // Interrupt / send-now cut ahead of ordinary waiting rows. Name that so the
    // jumped order is never a silent reshuffle of the list the user is watching.
    const head = args.cutInCount === 1 ? "지금 처리할 1건이 맨 앞에 있습니다" : `지금 처리할 ${args.cutInCount}건이 맨 앞에 있습니다`;
    if (args.working) {
      return `${head} — 턴이 끝나면 그것부터 전송됩니다`;
    }
    return `${head} — 지금 보내기를 누르면 그것부터 전송됩니다`;
  }
  if (!args.working) {
    return "지금 보내기를 누르면 전송됩니다";
  }
  const how = args.merge && args.count > 1 ? "합쳐서 한 번에" : "순서대로";
  return `${args.memberName} 응답이 끝나면 ${how} 전송됩니다`;
}

function mergeNote(args: { merge: boolean; mixed: boolean; count: number }): string {
  if (!args.merge) {
    return "한 건씩 순서대로 보냅니다";
  }
  // With several senders queued, promising "N건을 한 메시지로" would be wrong —
  // only the leading same-sender run merges.
  return args.mixed ? "보낸 사람이 같은 것끼리만 합쳐집니다" : `전송 시 ${args.count}건을 한 메시지로 합쳐서 보냅니다`;
}

function collapsedPreview(items: QueuedMessage[]): string {
  if (!items.length) {
    return "";
  }
  const first = items[0].text;
  return items.length > 1 ? `${first}  ··· 외 ${items.length - 1}건` : first;
}

/** Distinct senders in first-appearance order, capped at three — a density cue, not a roster. */
function senderDots(items: QueuedMessage[]): Array<{ key: string; from: string | null }> {
  // Deduplicated on the sender itself (null = the user), and the React key is
  // namespaced, so a member named "user" cannot collide with the user's own
  // dot. The key used to carry a raw NUL byte as that sentinel, which made git
  // treat this whole file as binary and refuse to merge it.
  const seen: Array<string | null> = [];
  const dots: Array<{ key: string; from: string | null }> = [];
  for (const item of items) {
    const from = item.from ?? null;
    if (seen.includes(from)) {
      continue;
    }
    seen.push(from);
    dots.push({ key: from === null ? "user" : `member:${from}`, from });
    if (dots.length === 3) {
      break;
    }
  }
  return dots;
}
