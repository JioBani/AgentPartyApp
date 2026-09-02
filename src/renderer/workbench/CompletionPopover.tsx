import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** One selectable row. `label` and `secondary` are the only text ever searched. */
export interface PopoverRow {
  key: string;
  label: string;
  /** Right-hand text: a member's status, a model's provider. */
  secondary?: string;
  /** Identity colour for the leading dot, when the row has one. */
  accent?: string;
  /** Replaces the leading dot (e.g. the `everyone` group icon). */
  icon?: ReactNode;
  /** Extra class for row-specific styling. */
  className?: string;
}

export interface PopoverSection {
  key: string;
  label: string;
  rows: PopoverRow[];
}

interface CompletionPopoverProps {
  /** Heading shown at the top-left — what this list IS. */
  title: string;
  /**
   * Filter typed inside the popover, drawn next to the heading.
   *
   * Only the chained stages use it: their trigger text is already gone from the
   * draft, so the keystrokes have nowhere visible to land. Showing them here is
   * what keeps the narrowing list from looking like a glitch.
   */
  query?: string;
  /** Key hint shown at the top-right; dropped on narrow panels. */
  hint?: string;
  sections: PopoverSection[];
  /** Index into the flattened row list. */
  activeIndex: number;
  onHover: (index: number) => void;
  onSelect: (index: number) => void;
  /** Narrow panels drop the key hint and tighten the rows. */
  compact?: boolean;
  /** Viewport position of the caret to sit against. */
  anchor: { left: number; top: number } | null;
  ariaLabel: string;
}

/** Gap between the caret and the popover. */
const CARET_GAP = 6;
/** Keeps the popover off the window edge. */
const EDGE = 8;

/**
 * The completion popover, anchored to the CARET like an editor's completion
 * rather than to the corner of the input — by the time a sentence is a few
 * words long, a corner-anchored list points at nothing.
 *
 * ## One popover for every list
 *
 * Members, providers, models and the chained model options all render through
 * this same component. They differ only in their rows, so a second
 * implementation would only be a second place for the placement maths and the
 * focus rules to go wrong — and the two lists would slowly stop looking alike.
 * The `/` command palette (F-05) is the next caller.
 *
 * ## The heading carries the discovery
 *
 * The popover says what it is showing ("멤버", "모델", "Effort") and what the
 * keys do. The list teaches its keyboard flow at the moment the user needs it.
 *
 * Rendered in a portal so it is never clipped by the composer's own box, and
 * flipped below the caret when there is no room above.
 */
export function CompletionPopover({
  title,
  query,
  hint,
  sections,
  activeIndex,
  onHover,
  onSelect,
  compact = false,
  anchor,
  ariaLabel,
}: CompletionPopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<{ left: number; top: number } | null>(null);
  const rowCount = sections.reduce((total, section) => total + section.rows.length, 0);

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
  }, [anchor, rowCount, compact, title]);

  // A running index across sections: the arrow keys walk rows, not sections, so
  // the caller only ever deals with one flat position.
  let flat = -1;

  const popover = (
    <div
      ref={ref}
      className={"wb-mention-pop" + (compact ? " is-compact" : "")}
      role="listbox"
      aria-label={ariaLabel}
      style={
        placement
          ? { left: placement.left, top: placement.top }
          // Measured before it is placed; kept invisible so it never flashes in
          // the wrong spot on the first frame.
          : { left: 0, top: 0, visibility: "hidden" }
      }
    >
      <div className="wb-mention-head">
        <span>
          {title}
          {query ? <span className="wb-comp-query wb-mono">{query}</span> : null}
        </span>
        {!compact && hint && <span className="wb-mono">{hint}</span>}
      </div>
      {sections.map((section, sectionIndex) => (
        <div key={section.key} className="wb-comp-section">
          {/* A section header that repeats the heading is noise — with a single
              section, or a first section named after the list itself ("모델" under
              the "모델" heading), the word is already on screen. Later sections
              still get one, because that is where the list changes subject. */}
          {sections.length > 1 && section.label !== title && (
            <div className={"wb-comp-section-label" + (sectionIndex === 0 ? " is-first" : "")}>{section.label}</div>
          )}
          {section.rows.map((row) => {
            flat += 1;
            const index = flat;
            return (
              <button
                type="button"
                key={row.key}
                role="option"
                aria-selected={index === activeIndex}
                className={"wb-mention-row" + (index === activeIndex ? " is-active" : "") + (row.className ? " " + row.className : "")}
                style={row.accent ? ({ ["--member" as string]: row.accent }) : undefined}
                // Without this the composer loses focus on mousedown and the
                // caret position — which is where the text has to be inserted —
                // is gone.
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => onHover(index)}
                onClick={() => onSelect(index)}
              >
                {row.icon ?? (row.accent ? <span className="wb-mention-dot" /> : null)}
                <span className="wb-mention-name">{row.label}</span>
                {row.secondary && <span className="wb-mention-status wb-mono">{row.secondary}</span>}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );

  return createPortal(popover, document.body);
}
