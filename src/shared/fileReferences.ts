/**
 * File and folder references dropped into a message.
 *
 * A dropped image becomes an attachment whose BYTES travel to the model. A
 * dropped file or folder does not: the member opens it itself, so what it needs
 * is the path, and there is no upload.
 *
 * The chip a person sees is nothing more than an abbreviated view of that path
 * — the name instead of the whole string. The message the model receives still
 * carries the path in full. If it ever stops doing so the feature has regressed
 * to worse than useless: the user believes they attached something the member
 * cannot open, and nothing on screen says otherwise.
 */

export type ReferenceKind = "file" | "folder";

/** One dropped file or folder. */
export interface FileReference {
  kind: ReferenceKind;
  /** Absolute path — this is what the model receives. */
  path: string;
  /** File or folder name only (the chip's label). */
  name: string;
  /** Everything before the name (tooltip context). */
  dir: string;
}

/** Splits a path into its last segment and the rest, for either separator. */
export function describePath(filePath: string): { name: string; dir: string } {
  const normalized = filePath.replace(/[\\/]+$/, "");
  const cut = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  if (cut < 0) {
    return { name: normalized, dir: "" };
  }
  return { name: normalized.slice(cut + 1), dir: normalized.slice(0, cut) };
}

/** Builds a reference from an absolute path. */
export function fileReference(filePath: string, kind: ReferenceKind = "file"): FileReference {
  const { name, dir } = describePath(filePath);
  return { kind, path: filePath, name: name || filePath, dir };
}

/**
 * Wraps a path in quotes when it contains whitespace, so a path with spaces
 * survives as ONE argument when a member hands it to a shell.
 */
export function quoteReferencePath(filePath: string): string {
  return /\s/.test(filePath) ? `"${filePath}"` : filePath;
}

/** The exact text a chip stands for — what serialization writes back out. */
export function referenceToken(reference: FileReference): string {
  return quoteReferencePath(reference.path);
}
