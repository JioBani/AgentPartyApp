/**
 * Image payloads inside a tool result, and how they are stored out-of-line.
 *
 * A harness returns screenshots as Anthropic content blocks carrying the whole
 * image as base64 (`Read` on a .png, an MCP tool like UnityMCP's camera). Those
 * are by far the largest single things in a transcript — measured at 564 KB for
 * one block, against 46 KB for the largest text result — and base64-wrapped PNG
 * is the one payload compression cannot help (gzip returns 94% of the input).
 *
 * So the bytes are written to a content-addressed file and the block keeps only
 * a reference. Naming the file by its SHA-256 makes re-reading the same
 * screenshot free: the second write lands on the identical path.
 *
 * Shared because the MAIN process performs the extraction at persist time and
 * the RENDERER has to recognise the result to display it.
 */

/** Directory under the workspace store holding extracted image bytes. */
export const TRANSCRIPT_IMAGE_DIR = "images";

/** Marks a `source` whose bytes live in {@link TRANSCRIPT_IMAGE_DIR}, not inline. */
export const IMAGE_SOURCE_KIND = "agentparty-file";

export type StoredImageSource = {
  type: typeof IMAGE_SOURCE_KIND;
  /** File name within {@link TRANSCRIPT_IMAGE_DIR}; `<sha256>.<ext>`. */
  file: string;
  media_type?: string;
  /** Decoded byte length, for display without reading the file. */
  bytes: number;
};

type Base64Source = { type: "base64"; data: string; media_type?: string };

export type ImageContentBlock = { type: "image"; source: Base64Source | StoredImageSource | unknown };

export function isImageBlock(value: unknown): value is ImageContentBlock {
  return Boolean(value) && typeof value === "object" && (value as { type?: unknown }).type === "image";
}

export function isStoredImageSource(source: unknown): source is StoredImageSource {
  const s = source as { type?: unknown; file?: unknown } | null;
  return Boolean(s) && s!.type === IMAGE_SOURCE_KIND && typeof s!.file === "string";
}

function isBase64Source(source: unknown): source is Base64Source {
  const s = source as { type?: unknown; data?: unknown } | null;
  return Boolean(s) && s!.type === "base64" && typeof s!.data === "string" && (s!.data as string).length > 0;
}

/** `image/png` -> `png`. Unknown or absent media types fall back to `bin`. */
export function extensionFor(mediaType: string | undefined): string {
  const subtype = typeof mediaType === "string" ? mediaType.split("/")[1] : undefined;
  if (!subtype) {
    return "bin";
  }
  const clean = subtype.split("+")[0].replace(/[^a-z0-9]/gi, "").toLowerCase();
  return clean === "jpeg" ? "jpg" : clean || "bin";
}

/**
 * Rewrites every inline base64 image under `value` through `store`, which
 * persists the bytes and returns the reference to put in their place.
 *
 * Structure-preserving and idempotent: a value with no inline image (including
 * one already rewritten) is returned by identity, so re-persisting an unchanged
 * transcript neither rewrites files nor churns the JSON.
 */
export function externalizeImages(value: unknown, store: (data: string, mediaType?: string) => StoredImageSource): unknown {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const mapped = externalizeImages(item, store);
      changed ||= mapped !== item;
      return mapped;
    });
    return changed ? next : value;
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (isImageBlock(value) && isBase64Source(value.source)) {
    return { ...value, source: store(value.source.data, value.source.media_type) };
  }
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const mapped = externalizeImages(item, store);
    changed ||= mapped !== item;
    next[key] = mapped;
  }
  return changed ? next : value;
}

/**
 * An image a tool returned, in the form the UI needs to show it.
 *
 * Both forms occur in a live window: a block is persisted out-of-line, but the
 * renderer's copy of that same block still holds the bytes it was streamed
 * until the transcript is reloaded. Rendering only the stored form would leave
 * the current turn's screenshots invisible.
 */
export type DisplayImage =
  | { kind: "stored"; key: string; source: StoredImageSource }
  | { kind: "inline"; key: string; dataUrl: string; bytes: number; mediaType?: string };

/** Every image under `value` — stored reference or still-inline bytes. */
export function collectDisplayImages(value: unknown): DisplayImage[] {
  const found: DisplayImage[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== "object") {
      return;
    }
    if (isImageBlock(node)) {
      if (isStoredImageSource(node.source)) {
        found.push({ kind: "stored", key: node.source.file, source: node.source });
        return;
      }
      if (isBase64Source(node.source)) {
        const { data, media_type: mediaType } = node.source;
        found.push({
          kind: "inline",
          // Index-based: inline bytes have no identity, and hashing ~500 KB on
          // every render to invent one is not worth it.
          key: `inline-${found.length}`,
          dataUrl: `data:${mediaType || "image/png"};base64,${data}`,
          bytes: Math.floor((data.length * 3) / 4),
          mediaType,
        });
        return;
      }
      return;
    }
    Object.values(node as Record<string, unknown>).forEach(walk);
  };
  walk(value);
  return found;
}

/** True for a content block the UI renders as an image, not as text. */
export function isRenderableImage(value: unknown): boolean {
  return isImageBlock(value) && (isStoredImageSource(value.source) || isBase64Source(value.source));
}
