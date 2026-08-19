import { AlertTriangle, Play } from "lucide-react";
import { Markdown } from "../workbench/Markdown";
import { parseGuideSlideMarkers } from "../../shared/guideChat";
import { GUIDE_SLIDE_COUNT, sceneOf } from "../../shared/guide";
import { LocalizedText } from "../i18n/I18nProvider";

/**
 * Assistant text with `[[slide:N]]` turned into a button that jumps to that
 * slide. A number outside the deck is NOT swallowed — it is shown as a miss with
 * the range that does exist, because a stale number means the knowledge canon
 * has drifted and the user should see that, not a silently missing link.
 */
export function GuideMarkedText({
  text,
  onOpenSlide,
}: {
  text: string;
  onOpenSlide?: (index: number) => void;
}) {
  const parts = parseGuideSlideMarkers(text, GUIDE_SLIDE_COUNT);
  return (
    <>
      {parts.map((part, at) => {
        if (part.kind === "slide" && typeof part.index === "number") {
          const scene = sceneOf(part.index);
          return (
            <button
              key={at}
              type="button"
              className="guide-marker"
              onClick={() => onOpenSlide?.(part.index as number)}
            >
              <Play size={12} />

              <LocalizedText id="STR-1267" /> {part.index + 1} · {scene.title}
            </button>
          );
        }
        if (part.kind === "invalid") {
          return (
            <span key={at} className="guide-marker-miss">
              <AlertTriangle size={12} />

              <LocalizedText id="STR-1268" /> {String(part.index)}  <LocalizedText id="STR-1269" />{GUIDE_SLIDE_COUNT - 1})
            </span>
          );
        }
        // Model output is markdown — rendered with the workbench renderer so the
        // guide never shows raw `**` or backticks to a first-time user.
        return <Markdown key={at} text={part.text || ""} />;
      })}
    </>
  );
}
