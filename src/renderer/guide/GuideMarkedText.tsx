import { GUIDE_SLIDE_COUNT } from "../../shared/guide";
import { parseGuideSlideMarkers } from "../../shared/guideChat";

export function GuideMarkedText({
  text,
  onOpenSlide,
}: {
  text: string;
  onOpenSlide?: (index: number) => void;
}) {
  const parts = parseGuideSlideMarkers(text, GUIDE_SLIDE_COUNT);
  if (!parts.length) {
    return <span>{text}</span>;
  }
  return (
    <span>
      {parts.map((part, i) => {
        if (part.kind === "text") {
          return <span key={i}>{part.text}</span>;
        }
        if (part.kind === "slide" && typeof part.index === "number") {
          return (
            <button key={i} type="button" className="guide-slide-link" onClick={() => onOpenSlide?.(part.index!)}>
              슬라이드 {part.index + 1}
            </button>
          );
        }
        return (
          <span key={i} className="guide-slide-missing" role="status">
            슬라이드 {part.index} 은(는) 없습니다 (0…{GUIDE_SLIDE_COUNT - 1})
          </span>
        );
      })}
    </span>
  );
}
