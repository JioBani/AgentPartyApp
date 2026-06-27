import { useEffect, useRef, useState } from "react";
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
  align?: "left" | "right";
}

/**
 * A small custom dropdown that renders an icon (and optional label) per option,
 * replacing the unstyled native <select>. Closes on outside click or Escape.
 */
export function Dropdown({ value, options, onChange, title, compact, drop = "down", align = "left" }: DropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = options.find((option) => option.id === value) || options[0];

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
        onClick={() => setOpen((value) => !value)}
      >
        <span className="wb-dd-ic">{current?.icon}</span>
        {!compact && <span className="wb-dd-label">{current?.label}</span>}
        <ChevronDown size={11} className="wb-pill-caret" />
      </button>
      {open && (
        <div className={`wb-dd-menu drop-${drop} align-${align}`} role="listbox">
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
