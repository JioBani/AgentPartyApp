import { useEffect, useRef, useState } from "react";
import type { PanelDensity } from "./types";

/**
 * Observes an element's own rendered width and reports both the raw width and a
 * density tier. Responsiveness is keyed off each panel's pixel width (per the
 * handoff), not the window size, so a narrow panel collapses its controls even
 * on a wide display. The width itself is what the tab strip budgets against
 * when deciding how many tabs fit.
 */
export function useDensity<T extends HTMLElement>(): { ref: React.RefObject<T>; density: PanelDensity; width: number } {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const node = ref.current;
    if (!node) {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      setWidth(entries[0]?.contentRect.width ?? node.clientWidth);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // Before the first observation a panel reports 0; treat that as wide so the
  // first paint matches the common case instead of flashing the narrow layout.
  const density: PanelDensity = width === 0 || width >= 600 ? "wide" : width >= 408 ? "mid" : "narrow";
  return { ref, density, width };
}
