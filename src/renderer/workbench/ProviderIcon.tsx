import { Bot } from "lucide-react";
import type { SVGProps } from "react";
import { VendorMarkIcon, type VendorMark } from "./vendorMarks";
import { providerLabel, type ModelProvider } from "./modelProvider";

interface ProviderIconProps extends Omit<SVGProps<SVGSVGElement>, "children"> {
  /** The model's provider, or undefined when it could not be resolved yet. */
  provider: ModelProvider | undefined;
  size?: number;
}

/**
 * Marks WHOSE MODEL is answering — the thing a member's identity actually turns
 * on. The harness was showing here instead, which said "Codex" for a member
 * running Opus and "Claude Code" for one running a DeepSeek model: the icon
 * named the wrong company.
 *
 * Providers we hold no artwork for get ONE neutral mark rather than a blank
 * slot, a broken image, or — worst — the nearest brand we happen to have. The
 * provider's name is always reachable from the wrapper's tooltip and label, so
 * the fallback loses no information.
 */
const PROVIDER_MARK: Partial<Record<ModelProvider, VendorMark>> = {
  anthropic: "claude",
  openai: "openai",
  xai: "grok",
  cursor: "cursor",
  openrouter: "openrouter",
  deepseek: "deepseek",
};

export function ProviderIcon({ provider, size = 15, className = "", ...props }: ProviderIconProps) {
  const mark = provider ? PROVIDER_MARK[provider] : undefined;
  if (mark) {
    return (
      <VendorMarkIcon
        {...props}
        mark={mark}
        size={size}
        className={`wb-provider-icon ${className}`.trim()}
        data-provider={provider}
      />
    );
  }
  return (
    <Bot
      {...props}
      size={size}
      className={`wb-provider-icon wb-provider-icon-generic ${className}`.trim()}
      aria-hidden="true"
      data-provider={provider || "unknown"}
    />
  );
}

export { providerLabel };
