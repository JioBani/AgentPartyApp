import { useId, type SVGProps } from "react";

/**
 * Vendor marks, drawn once.
 *
 * The same four marks answer two different questions — "which harness runs this
 * member" and "whose model is it" — and those questions have different answers
 * for the same member (a Codex-harness member can run an Anthropic model). They
 * were therefore about to be drawn twice, which is how two copies of one logo
 * drift apart at 14px. The geometry lives here; `HarnessIcon` and `ProviderIcon`
 * only decide WHICH mark a thing gets.
 *
 * Claude Spark and OpenAI Blossom preserve the published vector geometry.
 * Cursor preserves its official 2.5D outer/fold geometry while reducing the five
 * vendor shades to two theme-aware tones for legibility at 14–16px.
 */

/** The marks we actually hold artwork for. Anything else gets a fallback. */
export type VendorMark = "claude" | "openai" | "grok" | "cursor";

export interface VendorMarkProps extends Omit<SVGProps<SVGSVGElement>, "children"> {
  mark: VendorMark;
  size?: number;
}

/**
 * Renders one mark. Always `aria-hidden`: the mark is a restatement of a name
 * that is already on screen (or in the wrapper's own label), and a screen reader
 * announcing "Claude" twice per row is noise, not access.
 */
export function VendorMarkIcon({ mark, size = 14, className = "", ...props }: VendorMarkProps) {
  const maskSeed = useId().replace(/:/g, "");
  const cursorMaskId = `cursor-mark-${maskSeed}`;
  const grokMaskId = `grok-mark-${maskSeed}`;
  const common = {
    ...props,
    className: `wb-vendor-mark ${className}`.trim(),
    width: size,
    height: size,
    focusable: false,
    "aria-hidden": true,
    "data-vendor-mark": mark,
  } as const;

  if (mark === "claude") {
    return (
      <svg {...common} viewBox="0 0 94 94" fill="currentColor">
        <path d="M18.7657 62.4437L37.1822 52.1167L37.4857 51.2122L37.1822 50.7085H36.2715L33.1852 50.5208L22.6615 50.2391L13.5545 49.8636L4.70044 49.3942L2.47428 48.9248L0.399902 46.1553L0.602281 44.794L2.47428 43.5266L5.15579 43.7613L11.0754 44.1837L19.98 44.794L26.4055 45.1695L35.9679 46.1553H37.4857L37.6881 45.545L37.1822 45.1695L36.7774 44.794L27.5692 38.5508L17.6021 31.9791L12.3908 28.1769L9.60812 26.2524L8.19147 24.4686L7.58433 20.5256L10.1141 17.7091L13.5545 17.9438L14.4146 18.1785L17.9056 20.8542L25.343 26.6279L35.0572 33.7629L36.4739 34.9364L37.0443 34.5514L37.1316 34.2792L36.4739 33.1996L31.212 23.6706L25.596 13.9539L23.0663 9.91695L22.4086 7.52296C22.1538 6.51831 22.0038 5.68714 22.0038 4.65957L24.8877 0.716544L26.5067 0.200195L30.4025 0.716544L32.0215 2.12477L34.4501 7.66379L38.3458 16.3478L44.4172 28.1769L46.188 31.6975L47.1493 34.9364L47.5035 35.9222H48.1106V35.3589L48.6166 28.6933L49.5273 20.5256L50.438 10.0108L50.7415 7.05356L52.2088 3.48605L55.1433 1.56148L57.42 2.64112L59.292 5.31674L59.039 7.05356L57.926 14.2824L55.7504 25.5952L54.3337 33.1996H55.1433L56.1046 32.2138L59.9497 27.1442L66.3752 19.0704L69.2085 15.8784L72.5478 12.3579L74.6728 10.668H78.7203L81.6548 15.0804L80.3394 19.6337L76.1906 24.8911L72.7502 29.3504L67.8172 35.9595L64.7562 41.2734L65.0307 41.7118L65.7681 41.6489L76.8989 39.255L82.9197 38.1753L90.1041 36.9549L93.3422 38.457L93.6963 40.006L92.4315 43.151L84.7411 45.0287L75.7353 46.8594L62.3244 50.0164L62.1759 50.1358L62.3512 50.3958L68.399 50.9432L70.9794 51.084H77.3037L89.0922 51.9759L92.1785 53.9944L93.9999 56.4822L93.6963 58.4068L88.9404 60.8008L82.5655 59.2987L67.6401 55.7312L62.5301 54.4638H61.8217V54.8862L66.0717 59.064L73.9139 66.1051L83.6786 75.2116L84.1845 77.4648L82.9197 79.2485L81.6042 79.0608L73.0032 72.5829L69.6639 69.6726L62.1759 63.3356H61.67V63.9928L63.3902 66.5276L72.5478 80.2812L73.0032 84.5059L72.3454 85.8672L69.9675 86.7121L67.3871 86.2427L61.9735 78.6852L56.4587 70.2359L52.0064 62.6315L51.4687 62.971L48.8189 91.2654L47.6047 92.7206L44.7714 93.8002L42.3934 92.0164L41.1286 89.1061L42.3934 83.3324L43.9113 75.8219L45.1255 69.8604L46.2386 62.4437L46.9184 59.9661L46.8583 59.8003L46.3153 59.8916L40.7238 67.5603L32.2239 79.0608L25.4948 86.2427L23.8758 86.8999L21.0931 85.4447L21.3461 82.863L22.9145 80.5629L32.2239 68.7338L37.8399 61.3641L41.4594 57.1337L41.4242 56.5218L41.2244 56.5048L16.489 72.6299L12.0873 73.1932L10.1647 71.4094L10.4176 68.4991L11.3283 67.5603L18.7657 62.4437Z" />
      </svg>
    );
  }

  // Grok's mark: a bold ring pierced by a diagonal slash with pointed tips.
  // Redrawn (not traced) at this simplified geometry so the break in the ring
  // and both spike tips survive the 12–16px sizes the app renders it at.
  if (mark === "grok") {
    return (
      <svg {...common} viewBox="0 0 24 24">
        <defs>
          <mask id={grokMaskId} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
            <rect width="24" height="24" fill="#fff" />
            <rect x="-4" y="9.9" width="32" height="4.2" fill="#000" transform="rotate(-45 12 12)" />
          </mask>
        </defs>
        <circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" strokeWidth="3.4" mask={`url(#${grokMaskId})`} />
        <path fill="currentColor" d="M22 2 L12.9 12.9 L2 22 L11.1 11.1 Z" />
      </svg>
    );
  }

  if (mark === "openai") {
    return (
      <svg {...common} viewBox="0 0 20 20" fill="currentColor">
        <path d="M11.248 18.25q-.825 0-1.568-.314a4.3 4.3 0 0 1-1.32-.874 4 4 0 0 1-1.304.214 4 4 0 0 1-2.046-.544 4.27 4.27 0 0 1-1.518-1.485 4 4 0 0 1-.56-2.095q0-.48.131-1.04A4.4 4.4 0 0 1 2.04 10.71a4.07 4.07 0 0 1 .017-3.4 4.2 4.2 0 0 1 1.056-1.418 3.8 3.8 0 0 1 1.6-.842 3.9 3.9 0 0 1 .76-1.683q.593-.759 1.451-1.188a4.04 4.04 0 0 1 1.832-.429q.825 0 1.567.313.742.314 1.32.875a4 4 0 0 1 1.304-.215q1.106 0 2.046.545a4.14 4.14 0 0 1 1.501 1.485q.578.941.578 2.095 0 .48-.132 1.04.66.61 1.023 1.419.363.792.363 1.666 0 .892-.38 1.717a4.3 4.3 0 0 1-1.072 1.435 3.8 3.8 0 0 1-1.584.825 3.8 3.8 0 0 1-.775 1.683 4.06 4.06 0 0 1-1.436 1.188 4.04 4.04 0 0 1-1.832.429m-4.076-2.062q.825 0 1.435-.347l3.103-1.782a.36.36 0 0 0 .164-.313v-1.42L7.881 14.62a.67.67 0 0 1-.726 0l-3.118-1.798a.5.5 0 0 1-.017.115v.198q0 .841.396 1.551.413.693 1.139 1.089a3.2 3.2 0 0 0 1.617.412m.165-2.69a.4.4 0 0 0 .181.05q.083 0 .165-.05l1.238-.71-3.977-2.31a.7.7 0 0 1-.363-.643v-3.58q-.825.362-1.32 1.122a2.9 2.9 0 0 0-.495 1.65q0 .809.413 1.55.412.743 1.072 1.123zm3.91 3.663q.875 0 1.585-.396a2.96 2.96 0 0 0 1.534-2.64v-3.564a.32.32 0 0 0-.165-.297l-1.254-.726v4.604a.7.7 0 0 1-.363.643l-3.119 1.799a3 3 0 0 0 1.783.577m.627-6.039V8.878L10.01 7.822 8.129 8.878v2.244l1.881 1.056zM7.057 5.859a.7.7 0 0 1 .363-.644l3.119-1.798a3 3 0 0 0-1.782-.578q-.874 0-1.584.396A2.96 2.96 0 0 0 6.05 4.324a3.07 3.07 0 0 0-.396 1.551v3.547q0 .199.165.314l1.237.726zm8.383 7.887q.825-.364 1.303-1.123.495-.758.495-1.65a3.15 3.15 0 0 0-.412-1.55q-.413-.743-1.073-1.123l-3.086-1.782q-.099-.065-.181-.049a.3.3 0 0 0-.165.05l-1.238.692 3.993 2.327a.6.6 0 0 1 .264.264.64.64 0 0 1 .1.363zm-3.317-8.382a.63.63 0 0 1 .726 0l3.135 1.831v-.297q0-.792-.396-1.501a2.86 2.86 0 0 0-1.105-1.155q-.71-.43-1.65-.43-.825 0-1.436.347L8.294 5.941a.36.36 0 0 0-.165.314v1.418z" />
      </svg>
    );
  }

  return (
      <svg {...common} viewBox="0 0 466.73 533.32">
        <defs>
          <mask id={cursorMaskId} maskUnits="userSpaceOnUse" x="0" y="0" width="466.73" height="533.32">
            <rect width="466.73" height="533.32" fill="#fff" />
            <path fill="#000" d="m448.35 142.54-216.42 124.95a10.8 10.8 0 0 0-3.92-3.92L20.62 143.83c-2.46-1.41-1.45-5.16 1.38-5.16h419.65c2.98 0 5.4 1.61 6.7 3.87Z" />
          </mask>
        </defs>
        <g mask={`url(#${cursorMaskId})`}>
          <path fill="currentColor" d="M224.29 2.43a18.14 18.14 0 0 1 18.14 0l216.06 124.74a16.5 16.5 0 0 1 8.24 14.27v250.44a16.5 16.5 0 0 1-8.24 14.27L242.44 530.89a18.14 18.14 0 0 1-18.14 0L8.24 406.15A16.5 16.5 0 0 1 0 391.88V141.44c0-5.89 3.14-11.32 8.24-14.27Z" />
          <path className="wb-vendor-mark-tone" d="M448.35 142.54a7.75 7.75 0 0 1 0 7.74L238.52 513.7c-1.41 2.46-5.16 1.45-5.16-1.38V272.84c0-1.91-.51-3.75-1.44-5.36l216.42-124.95Z" />
        </g>
      </svg>
  );
}
