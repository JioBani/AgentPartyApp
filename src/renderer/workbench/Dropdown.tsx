import { useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { FloatingMenu } from "./FloatingMenu";

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

/**
 * A small custom dropdown that renders an icon (and optional label) per option,
 * replacing the unstyled native <select>. Closes on outside click or Escape.
 *
 * FloatingMenu owns portal placement and dismissal. Keeping those mechanics out
 * of this leaf component ensures simple Claude menus and richer Codex/Cursor
 * permission panels obey the same clipping and viewport rules.
 */
export function Dropdown({ value, options, onChange, title, compact, drop = "down", align = "left" }: DropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = options.find((option) => option.id === value) || options[0];

  const menu = open ? (
    <FloatingMenu anchor={ref.current} role="listbox" onDismiss={() => setOpen(false)} drop={drop} align={align}>
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
    </FloatingMenu>
  ) : null;

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
      {menu}
    </div>
  );
}
