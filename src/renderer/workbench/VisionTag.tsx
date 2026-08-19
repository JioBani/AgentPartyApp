import { Image as ImageIcon, ImageOff, HelpCircle } from "lucide-react";
import { LocalizedText } from "../i18n/I18nProvider";

/**
 * Compact indicator for a model's image (vision) input support. Tri-state:
 * true = 지원, false = 미지원 (text-only), undefined = 알 수 없음 (unknown —
 * shown honestly rather than assumed either way).
 */
export function VisionTag({ image }: { image?: boolean }) {
  if (image === true) {
    return <strong className="wb-vision-tag is-yes"><ImageIcon size={16} />  <LocalizedText id="STR-2284" /></strong>;
  }
  if (image === false) {
    return <strong className="wb-vision-tag is-no"><ImageOff size={16} />  <LocalizedText id="STR-2285" /></strong>;
  }
  return <strong className="wb-vision-tag is-unknown"><HelpCircle size={16} />  <LocalizedText id="STR-2286" /></strong>;
}
