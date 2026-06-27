import { useEffect, useRef, useState } from "react";
import type { PanelDensity } from "./types";

/**
 * Observes an element's own rendered width and reports a density tier.
 * Responsiveness is keyed off each panel's pixel width (per the handoff), not
 * the window size, so a narrow panel collapses its controls even on a wide
 * display.
 */
export function useDensity<T extends HTMLElement>(): { ref: React.RefObject<T>; density: PanelDensity } {
  const ref = useRef<T>(null);
  const [density, setDensity] = useState<PanelDensity>("wide");

  useEffect(() => {
    const node = ref.current;
    if (!node) {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? node.clientWidth;
      setDensity(width >= 600 ? "wide" : width >= 408 ? "mid" : "narrow");
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return { ref, density };
}
