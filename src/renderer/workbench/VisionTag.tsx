import { Image as ImageIcon, ImageOff, HelpCircle } from "lucide-react";

/**
 * Compact indicator for a model's image (vision) input support. Tri-state:
 * true = 지원, false = 미지원 (text-only), undefined = 알 수 없음 (unknown —
 * shown honestly rather than assumed either way).
 */
export function VisionTag({ image }: { image?: boolean }) {
  if (image === true) {
    return <strong className="wb-vision-tag is-yes"><ImageIcon size={16} /> 지원</strong>;
  }
  if (image === false) {
    return <strong className="wb-vision-tag is-no"><ImageOff size={16} /> 미지원</strong>;
  }
  return <strong className="wb-vision-tag is-unknown"><HelpCircle size={16} /> 알 수 없음</strong>;
}
