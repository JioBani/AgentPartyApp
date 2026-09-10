import { useCallback, useEffect, useLayoutEffect, useRef, useState, type AriaRole, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Keep a floating menu clear of the window edge. */
const EDGE_MARGIN = 6;
/** Breathing room between the trigger and its menu. */
const GAP = 5;

/**
 * A menu layer anchored to a trigger but rendered directly under `body`.
 *
 * Workbench panels and composers deliberately clip overflow. They also create
 * containing blocks, so neither `position: fixed` nor a larger z-index can
 * rescue a descendant menu. Every composer permission surface therefore goes
 * through this component instead of implementing its own local popover.
 */
export function FloatingMenu({
  anchor,
  children,
  className,
  role,
  ariaLabel,
  onDismiss,
  drop = "down",
  align = "left",
}: {
  anchor: HTMLElement | null;
  children: ReactNode;
  className?: string;
  role?: AriaRole;
  ariaLabel?: string;
  onDismiss: () => void;
  drop?: "down" | "up";
  align?: "left" | "right";
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<CSSProperties>();

  const place = useCallback(() => {
    const menu = menuRef.current;
    if (!anchor || !menu) return;

    const trigger = anchor.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const { offsetHeight: height, offsetWidth: width } = menu;
    const above = trigger.top - GAP - EDGE_MARGIN;
    const below = viewportHeight - trigger.bottom - GAP - EDGE_MARGIN;

    // Prefer the requested side. If it cannot fit, use whichever side exposes
    // more of the menu; maxHeight makes the rest scrollable rather than clipped.
    let up = drop === "up";
    if (up ? above < height && below > above : below < height && above > below) {
      up = !up;
    }

    const preferredLeft = align === "left" ? trigger.left : trigger.right - width;
    const left = Math.max(EDGE_MARGIN, Math.min(preferredLeft, viewportWidth - EDGE_MARGIN - width));
    const next: CSSProperties = {
      position: "fixed",
      left,
      maxHeight: Math.max(0, up ? above : below),
      ...(up ? { bottom: viewportHeight - trigger.top + GAP } : { top: trigger.bottom + GAP }),
    };
    setPlacement(next);
  }, [align, anchor, drop]);

  // Measure before the menu is shown in its real position, avoiding a flash at
  // the viewport origin. ResizeObserver covers responsive panel movement and
  // content-height changes such as Codex warning rows appearing.
  useLayoutEffect(() => {
    place();
  }, [place]);

  useEffect(() => {
    const menu = menuRef.current;
    if (!anchor || !menu) return;
    const anchorElement = anchor;
    const menuElement = menu;

    const observer = new ResizeObserver(place);
    observer.observe(anchorElement);
    observer.observe(menuElement);

    function onPointer(event: MouseEvent) {
      const target = event.target as Node;
      if (!anchorElement.contains(target) && !menuElement.contains(target)) onDismiss();
    }
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onDismiss();
    }
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      observer.disconnect();
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor, onDismiss, place]);

  return createPortal(
    <div
      ref={menuRef}
      className={`wb-dd-menu is-floating${className ? ` ${className}` : ""}`}
      role={role}
      aria-label={ariaLabel}
      style={placement ?? { position: "fixed", top: 0, left: 0, visibility: "hidden" }}
    >
      {children}
    </div>,
    document.body,
  );
}
