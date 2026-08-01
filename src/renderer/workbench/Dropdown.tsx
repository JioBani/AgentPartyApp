import { useEffect, useLayoutEffect, useRef, useState } from "react";
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

/** Keep a flipped menu clear of the window edge rather than flush against it. */
const EDGE_MARGIN = 6;

/**
 * A small custom dropdown that renders an icon (and optional label) per option,
 * replacing the unstyled native <select>. Closes on outside click or Escape.
 */
export function Dropdown({ value, options, onChange, title, compact, drop = "down", align = "left" }: DropdownProps) {
  const [open, setOpen] = useState(false);
  // The edge actually used. `align` is only a preference: a trigger near the
  // window edge would otherwise push the menu (min-width 180px) off-screen,
  // where its tail is unreachable — the popup half of [#11], filed as [#18].
  const [anchor, setAnchor] = useState(align);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const current = options.find((option) => option.id === value) || options[0];

  // Measured before paint, so a flipped menu never shows in the wrong place
  // first. It runs once per open (opening resets to `align`), which also rules
  // out a menu wider than the window flip-flopping between the two edges.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!open || !el) {
      return;
    }
    const rect = el.getBoundingClientRect();
    if (align === "left" && rect.right > window.innerWidth - EDGE_MARGIN) {
      setAnchor("right");
    } else if (align === "right" && rect.left < EDGE_MARGIN) {
      setAnchor("left");
    }
  }, [open, align]);

  useEffect(() => {
    if (!open) {
      return;
    }
    function onPointer(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="wb-dd" ref={ref}>
      <button
        type="button"
        className={"wb-pill wb-dd-trigger" + (compact ? " is-compact" : "")}
        title={title ? `${title}: ${current?.label}` : current?.label}
        onClick={() => {
          if (!open) {
            setAnchor(align); // measure from the preferred side on every open
          }
          setOpen(!open);
        }}
      >
        <span className="wb-dd-ic">{current?.icon}</span>
        {!compact && <span className="wb-dd-label">{current?.label}</span>}
        <ChevronDown size={11} className="wb-pill-caret" />
      </button>
      {open && (
        <div className={`wb-dd-menu drop-${drop} align-${anchor}`} role="listbox" ref={menuRef}>
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
      )}
    </div>
  );
}
