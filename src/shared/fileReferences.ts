/**
 * File references attached to a message — the NON-image half of an attachment.
 *
 * A dropped image becomes an {@link ImageAttachment}: its bytes travel to the
 * model. A dropped file does not. The member reads files itself, so what it
 * needs is the **path**, and there is no upload.
 *
 * That difference is the whole point of this module. The chip a person sees says
 * `auth-500-trace.har`; what the model receives is still the full path. If the
 * path stops reaching the model the feature has regressed to worse than useless
 * — the user believes they attached a file and the member cannot open it, with
 * nothing on screen saying so.
 *
 * So the display name is derived here and never stored as the thing that is
 * sent: {@link composeMessageWithReferences} always writes `path`.
 */

/** One non-image file attached to a draft. */
export interface FileReference {
  kind: "file";
  /** Absolute path — this is what the model receives. */
  path: string;
  /** File name only (the chip's label). */
  name: string;
  /** Everything before the file name (the chip's tooltip context). */
  dir: string;
}

/** Splits a path into its file name and directory, tolerating either separator. */
export function describePath(filePath: string): { name: string; dir: string } {
  const normalized = filePath.replace(/[\\/]+$/, "");
  const cut = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  if (cut < 0) {
    return { name: normalized, dir: "" };
  }
  return { name: normalized.slice(cut + 1), dir: normalized.slice(0, cut) };
}

/** Builds a reference from an absolute path. */
export function fileReference(filePath: string): FileReference {
  const { name, dir } = describePath(filePath);
  return { kind: "file", path: filePath, name: name || filePath, dir };
}

/**
 * Wraps a path in quotes when it contains whitespace, so a path with spaces
 * survives as ONE argument when a member passes it to a shell.
 */
export function quoteReferencePath(filePath: string): string {
  return /\s/.test(filePath) ? `"${filePath}"` : filePath;
}

/**
 * The text actually sent for a draft plus its file references.
 *
 * Paths are appended after the message so the sentence the user wrote stays
 * intact, and they go out even when the message is empty — dropping a file and
 * pressing send is a complete request on its own.
 */
export function composeMessageWithReferences(draft: string, references: readonly FileReference[]): string {
  const text = draft.trim();
  if (references.length === 0) {
    return text;
  }
  const paths = references.map((reference) => quoteReferencePath(reference.path)).join(" ");
  return text ? `${text} ${paths}` : paths;
}

/** Drops references already present, so the same file cannot be attached twice. */
export function addFileReference(current: readonly FileReference[], reference: FileReference): FileReference[] {
  return current.some((existing) => existing.path === reference.path) ? [...current] : [...current, reference];
}
