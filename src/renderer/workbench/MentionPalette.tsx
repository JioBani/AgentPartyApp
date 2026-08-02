import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Users } from "lucide-react";
import { EVERYONE, type MentionCandidate } from "./mentionModel";

interface MentionPaletteProps {
  members: MentionCandidate[];
  activeIndex: number;
  onHover: (index: number) => void;
  onSelect: (member: MentionCandidate) => void;
  /** Narrow panels drop the key hint and tighten the rows. */
  compact?: boolean;
  /** Viewport position of the caret to sit against. */
  anchor: { left: number; top: number } | null;
}

/** Gap between the caret and the popover. */
const CARET_GAP = 6;
/** Keeps the popover off the window edge. */
const EDGE = 8;

/**
 * The `@` member popover, anchored to the CARET like an editor's completion
 * rather than to the corner of the input — by the time a sentence is a few
 * words long, a corner-anchored list points at nothing.
 *
 * Rendered in a portal so it is never clipped by the composer's own box, and
 * flipped below the caret when there is no room above.
 */
export function MentionPalette({ members, activeIndex, onHover, onSelect, compact = false, anchor }: MentionPaletteProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !anchor) {
      setPlacement(null);
      return;
    }
    const box = el.getBoundingClientRect();
    const above = anchor.top - CARET_GAP - box.height;
    setPlacement({
      left: Math.max(EDGE, Math.min(anchor.left, window.innerWidth - box.width - EDGE)),
      // Above the caret by default — that is where the eye already is — unless
      // the caret sits too near the top of the window to fit.
      top: above >= EDGE ? above : anchor.top + CARET_GAP + 18,
    });
  }, [anchor, members.length, compact]);

  const popover = (
    <div
      ref={ref}
      className={"wb-mention-pop" + (compact ? " is-compact" : "")}
      role="listbox"
      aria-label="멤버 멘션"
      style={
        placement
          ? { left: placement.left, top: placement.top }
          // Measured before it is placed; kept invisible so it never flashes in
          // the wrong spot on the first frame.
          : { left: 0, top: 0, visibility: "hidden" }
      }
    >
      <div className="wb-mention-head">
        <span>멤버</span>
        {!compact && <span className="wb-mono">↑↓ · Enter</span>}
      </div>
      {members.map((member, index) => (
        <button
          type="button"
          key={member.name}
          role="option"
          aria-selected={index === activeIndex}
          className={"wb-mention-row" + (index === activeIndex ? " is-active" : "") + (member.name === EVERYONE ? " is-everyone" : "")}
          style={{ ["--member" as string]: member.color }}
          // Without this the composer loses focus on mousedown and the caret
          // position — which is where the name has to be inserted — is gone.
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => onHover(index)}
          onClick={() => onSelect(member)}
        >
          {member.name === EVERYONE
            ? <Users size={11} className="wb-mention-everyone-icon" />
            : <span className="wb-mention-dot" />}
          <span className="wb-mention-name">@{member.name}</span>
          <span className="wb-mention-status wb-mono">{member.status}</span>
        </button>
      ))}
    </div>
  );

  return createPortal(popover, document.body);
}
