import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

export interface DropdownOption {
  id: string;
  label: string;
  icon: JSX.Element;
  hint?: string;
}

interface DropdownProps {
  value: string;
  options: DropdownOption[];
  onChange: (id: string) => void;
  title?: string;
  /** Hide the label, showing only the current icon (for tight spots). */
  compact?: boolean;
  /** Open the menu upward (e.g. when anchored at the bottom composer). */
  drop?: "down" | "up";
  /** Preferred edge to anchor to. Flipped automatically when it would overflow. */
  align?: "left" | "right";
}

/** Keep a menu clear of the window edge rather than flush against it. */
const EDGE_MARGIN = 6;
/** Breathing room between the trigger and its menu. */
const GAP = 5;

/**
 * A small custom dropdown that renders an icon (and optional label) per option,
 * replacing the unstyled native <select>. Closes on outside click or Escape.
 *
 * The menu is portalled to `document.body` and positioned in viewport
 * coordinates. It has to be: the composer and the panel are both
 * `overflow: hidden`, and `.wb-panel` carries `container-type: inline-size`,
 * which makes it a containing block for fixed descendants too — so a menu left
 * in place is clipped to its container no matter how it is positioned. The
 * permission menu is ~250px against a ~110px composer, so four of its six
 * options were simply cut off, and the CSS `max-height: 60vh` guard could not
 * help because the limit was never the viewport.
 *
 * Consequences of portalling, each handled below: the menu is no longer inside
 * `.wb-dd` (so the outside-click test must accept it), it no longer inherits a
 * modal's stacking context (so it carries a z-index above every overlay), and
 * it no longer travels with a scrolling ancestor (so it is re-placed on scroll).
 */
export function Dropdown({ value, options, onChange, title, compact, drop = "down", align = "left" }: DropdownProps) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<CSSProperties>();
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const current = options.find((option) => option.id === value) || options[0];

  // Measured before paint, so the menu never shows in the wrong place first. It
  // renders hidden for one layout pass to get its own size, which is the only
  // way to know whether the preferred side actually fits.
  const place = useCallback(() => {
    const trigger = ref.current?.getBoundingClientRect();
    const menu = menuRef.current;
    if (!trigger || !menu) {
      return;
    }
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const { offsetHeight: height, offsetWidth: width } = menu;

    // Prefer the requested side; take the other only when it has more room, so
    // a menu that fits nowhere still opens where the most of it is readable.
    const above = trigger.top - GAP - EDGE_MARGIN;
    const below = viewportHeight - trigger.bottom - GAP - EDGE_MARGIN;
    let up = drop === "up";
    if (up ? above < height && below > above : below < height && above > below) {
      up = !up;
    }

    // One clamp does the old edge-flip and more: start from the preferred edge,
    // then pull the menu back inside the window if it would hang off either
    // side. A menu wider than the window lands at the left margin instead of
    // oscillating between the two edges.
    const preferred = align === "left" ? trigger.left : trigger.right - width;
    const left = Math.max(EDGE_MARGIN, Math.min(preferred, viewportWidth - EDGE_MARGIN - width));

    setPlacement({
      position: "fixed",
      left,
      maxHeight: Math.max(0, up ? above : below),
      ...(up ? { bottom: viewportHeight - trigger.top + GAP } : { top: trigger.bottom + GAP }),
    });
  }, [align, drop]);

  useLayoutEffect(() => {
    if (!open) {
      setPlacement(undefined);
      return;
    }
    place();
  }, [open, place, options.length]);

  useEffect(() => {
    if (!open) {
      return;
    }
    function onPointer(event: MouseEvent) {
      const target = event.target as Node;
      // The menu is portalled, so it is NOT inside `ref`. Without this second
      // test every option click would close the menu on mousedown and unmount
      // the button before its click could fire — the menu would look dead.
      if (!ref.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false);
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        // Consume it: a popover inside a dialog must not close the dialog too.
        event.preventDefault();
        setOpen(false);
      }
    }
    // A menu pinned to viewport coordinates would otherwise sit still while its
    // trigger scrolled away. Re-place it instead of closing: the transcript
    // auto-scrolls on its own while a member is working, and that is precisely
    // when this menu gets used — closing on scroll made it flicker shut the
    // moment it opened.
    function onViewportChange() {
      place();
    }
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("scroll", onViewportChange, true);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
    };
  }, [open, place]);

  const menu = open && (
    <div
      className="wb-dd-menu is-floating"
      role="listbox"
      ref={menuRef}
      // Hidden for the single pass before it is measured, so it is never seen
      // at the top-left corner on the way to its real place.
      style={placement ?? { position: "fixed", top: 0, left: 0, visibility: "hidden" }}
    >
      {options.map((option) => (
        <button
          type="button"
          key={option.id}
          className={"wb-dd-item" + (option.id === value ? " is-selected" : "")}
          onClick={() => {
            onChange(option.id);
            setOpen(false);
          }}
        >
          <span className="wb-dd-ic">{option.icon}</span>
          <span className="wb-dd-text">
            <span className="wb-dd-item-label">{option.label}</span>
            {option.hint && <span className="wb-dd-item-hint">{option.hint}</span>}
          </span>
          {option.id === value && <Check size={13} className="wb-dd-check" />}
        </button>
      ))}
    </div>
  );

  return (
    <div className="wb-dd" ref={ref}>
      <button
        type="button"
        className={"wb-pill wb-dd-trigger" + (compact ? " is-compact" : "")}
        title={title ? `${title}: ${current?.label}` : current?.label}
        onClick={() => setOpen(!open)}
      >
        <span className="wb-dd-ic">{current?.icon}</span>
        {!compact && <span className="wb-dd-label">{current?.label}</span>}
        <ChevronDown size={11} className="wb-pill-caret" />
      </button>
      {menu && createPortal(menu, document.body)}
    </div>
  );
}
