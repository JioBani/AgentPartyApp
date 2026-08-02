/**
 * Provider-neutral user-turn attachments. The renderer, main process, and every
 * harness adapter pass this ONE shape; each adapter translates it to its own API
 * surface (Anthropic image block / OpenAI image_url / Codex localImage). Keeping
 * the transport neutral means the harness×model cross-matrix needs no branching
 * outside the three adapter translators.
 */

/** A single image attached to a user turn. */
export interface ImageAttachment {
  kind: "image";
  /** MIME type, e.g. "image/png" or "image/jpeg". */
  mediaType: string;
  /** Base64-encoded image bytes (NO `data:` prefix). */
  dataBase64: string;
  /** Optional source filename / display name (thumbnails, temp-file naming). */
  name?: string;
  /**
   * Absolute path of the saved file, AS THE RECEIVING SESSION SEES IT — win32
   * for a local member, posix for one inside a WSL distro. Stamped by
   * `SessionManager.sendUserTurn`, which runs inside the engine that owns the
   * session, so the path is openable there without any translation.
   *
   * Absent means the bytes were never persisted (an older payload, or a write
   * that failed and was reported); adapters still send the image itself then.
   */
  path?: string;
}

/** Only images are supported today; the union leaves room to grow. */
export type Attachment = ImageAttachment;

/** Default caps when a model's catalog entry does not specify its own. */
export const DEFAULT_MAX_IMAGES_PER_TURN = 20;
export const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB

/** Decoded byte length of a base64 string (without allocating the buffer). */
export function base64ByteLength(base64: string): number {
  const len = base64.length;
  if (len === 0) {
    return 0;
  }
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((len * 3) / 4) - padding;
}

/** A `data:` URL for an image attachment (used by Anthropic/OpenAI translators). */
export function imageDataUrl(attachment: ImageAttachment): string {
  return `data:${attachment.mediaType};base64,${attachment.dataBase64}`;
}

/**
 * The line appended to a user turn telling the model WHERE the attachments are.
 *
 * Without this the model only ever receives pixels, so "move this image into
 * src/assets" is impossible and it correctly says so. Every harness gets this
 * text — including ones whose model cannot see images at all, because copying
 * or renaming a file needs no vision.
 *
 * Attachments are numbered when there is more than one, so a later "the second
 * image" refers to something both sides can name.
 */
export function attachmentPathNote(attachments: ImageAttachment[] | undefined): string {
  const paths = (attachments || []).map((a) => a.path).filter((p): p is string => Boolean(p));
  if (!paths.length) {
    return "";
  }
  const list = paths.map((p, i) => (paths.length > 1 ? `${i + 1}. ${p}` : p)).join("\n");
  const heading = paths.length > 1
    ? `첨부한 이미지 ${paths.length}개는 아래 경로에 실제 파일로 저장되어 있습니다.`
    : "첨부한 이미지는 아래 경로에 실제 파일로 저장되어 있습니다.";
  return `\n\n[${heading} 파일 도구로 직접 읽거나 복사·이동할 수 있습니다.]\n${list}`;
}

/** Type guard: a value is a well-formed image attachment. */
export function isImageAttachment(value: unknown): value is ImageAttachment {
  const v = value as Partial<ImageAttachment> | null;
  return Boolean(v && v.kind === "image" && typeof v.mediaType === "string" && typeof v.dataBase64 === "string" && v.dataBase64.length > 0);
}

/** Filters an unknown array down to valid image attachments (drops junk safely). */
export function sanitizeAttachments(value: unknown): ImageAttachment[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isImageAttachment).map((a) => ({
    kind: "image" as const,
    mediaType: a.mediaType,
    dataBase64: a.dataBase64,
    name: a.name,
    // Carried through so a turn replayed from the queue keeps the file it was
    // already given, instead of being written to a second path.
    path: typeof a.path === "string" && a.path ? a.path : undefined,
  }));
}
