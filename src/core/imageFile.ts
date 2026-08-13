/**
 * Reading an image off disk, in the process the MEMBER runs in.
 *
 * That location is the whole point: a WSL member's `/home/…/shot.png` exists
 * only inside the distro, so the bytes must be decoded there and only the
 * decoded result may cross to the UI. Lives in `core` rather than `shared`
 * because it touches `node:fs`, which the renderer bundle must not pull in.
 *
 * Shared by every feature that turns a path into pixels — `attach-image`,
 * `discord-send-image`, and Codex's own `image_view` — so a file one of them
 * accepts cannot be rejected by another.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { base64ByteLength, DEFAULT_MAX_IMAGE_BYTES } from "../shared/attachments";

/** Image types Discord renders inline and every vision model accepts. */
export const IMAGE_MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export interface ReadImage {
  dataBase64: string;
  filename: string;
  mediaType: string;
}

/**
 * Reads an image file to base64.
 *
 * Every rejection states what is wrong so the agent can fix it instead of
 * retrying blindly: a missing file, a directory, an unsupported extension. The
 * "must exist on the machine YOU run on" wording matters — a member that just
 * wrote the file inside WSL and a user looking at a Windows path disagree about
 * what the path means, and that is the usual cause.
 */
export function readImageFile(filePath: string): ReadImage {
  const resolved = path.resolve(filePath);
  const mediaType = IMAGE_MEDIA_TYPES[path.extname(resolved).toLowerCase()];
  if (!mediaType) {
    throw new Error(`'${filePath}' is not a supported image (png, jpg, gif, webp). Nothing was sent.`);
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new Error(`No such file: '${resolved}'. Note the path must exist on the machine YOU run on.`);
  }
  if (!stat.isFile()) {
    throw new Error(`'${resolved}' is not a file.`);
  }
  return { dataBase64: fs.readFileSync(resolved).toString("base64"), filename: path.basename(resolved), mediaType };
}

/**
 * A tool result that SHOWS the image at `filePath`, for a harness tool whose own
 * output only names it (Codex's `image_view`).
 *
 * The payload is the MCP content-block shape — `{type:"image", data, mimeType}`
 * — which the transcript already handles end to end: the renderer collects it
 * into a picture (`collectDisplayImages`) and the persist path moves the bytes
 * out into the workspace image store (`externalizeImages`). Producing that shape
 * is therefore the entire integration; nothing downstream needs to change.
 *
 * Every failure comes back as TEXT in the same result rather than as nothing.
 * "The agent looked at a picture and the chat showed nothing" is exactly the
 * symptom this exists to fix, so a file that cannot be read has to say why.
 */
export function imageContentResult(filePath: unknown): unknown {
  const target = typeof filePath === "string" ? filePath.trim() : "";
  if (!target) {
    return undefined; // nothing was named — the tool box on its own is honest
  }
  let image: ReadImage;
  try {
    image = readImageFile(target);
  } catch (error) {
    return `이미지를 표시하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`;
  }
  const bytes = base64ByteLength(image.dataBase64);
  if (bytes > DEFAULT_MAX_IMAGE_BYTES) {
    // Inlining it would push megabytes through the event stream and into the
    // stored transcript. State the size rather than silently showing nothing.
    const mb = (limit: number) => Math.round(limit / (1024 * 1024));
    return `'${image.filename}' 은(는) ${mb(bytes)} MB 로 미리보기 한도(${mb(DEFAULT_MAX_IMAGE_BYTES)} MB)를 넘어 표시하지 않습니다.`;
  }
  return [{ type: "image", data: image.dataBase64, mimeType: image.mediaType }];
}
