import type { SVGProps } from "react";
import { harnessShort } from "./harnessLabel";
import { VendorMarkIcon, type VendorMark } from "./vendorMarks";

interface HarnessIconProps extends Omit<SVGProps<SVGSVGElement>, "children"> {
  harness: string | undefined;
  size?: number;
}

/** Which vendor drew the harness. An unknown id maps to nothing, not a guess. */
const HARNESS_MARK: Record<string, VendorMark> = {
  "claude-code": "claude",
  codex: "openai",
  cursor: "cursor",
  grok: "grok",
};

/**
 * The mark of the harness a member RUNS ON — Claude Code, Codex, Cursor, Grok.
 *
 * Distinct from `ProviderIcon`, which marks whose MODEL is answering: a Codex
 * member can run an Anthropic model, so the two are genuinely different facts
 * about one member. Both draw from `vendorMarks`, so the same brand can never
 * appear in two slightly different shapes.
 */
export function HarnessIcon({ harness, size = 14, className = "", ...props }: HarnessIconProps) {
  const mark = HARNESS_MARK[String(harness || "")];
  if (mark) {
    return (
      <VendorMarkIcon
        {...props}
        mark={mark}
        size={size}
        className={`wb-harness-icon ${className}`.trim()}
        data-harness={harness}
      />
    );
  }
  return (
    <span className={`wb-harness-icon wb-harness-icon-fallback ${className}`.trim()} aria-hidden="true" data-harness={harness}>
      {harnessShort(harness)}
    </span>
  );
}
