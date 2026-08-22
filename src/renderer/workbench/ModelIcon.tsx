import { Bot } from "lucide-react";
import type { SVGProps } from "react";
import type { RouteLike } from "./routes";
import { modelMarkForModel, modelMarkForRoute } from "./modelMark";
import { VendorMarkIcon } from "./vendorMarks";

interface ModelIconProps extends Omit<SVGProps<SVGSVGElement>, "children"> {
  model?: string;
  route?: RouteLike;
  size?: number;
}

/**
 * The model maker/family mark. This deliberately does not reuse ProviderIcon:
 * OpenRouter and Cursor are valid route providers, but they do not become the
 * maker of every model they serve.
 */
export function ModelIcon({ model, route, size = 16, className = "", ...props }: ModelIconProps) {
  const mark = route ? modelMarkForRoute(route) : modelMarkForModel(model);
  if (mark) {
    return (
      <VendorMarkIcon
        {...props}
        mark={mark}
        size={size}
        className={`wb-model-icon ${className}`.trim()}
        data-model-mark={mark}
      />
    );
  }
  return (
    <Bot
      {...props}
      size={size}
      className={`wb-model-icon wb-model-icon-generic ${className}`.trim()}
      aria-hidden="true"
      data-model-mark="generic"
    />
  );
}
