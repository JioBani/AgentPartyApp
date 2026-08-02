/**
 * The composer's editing surface, where a dropped path renders as a chip inside
 * the sentence.
 *
 * ## Why the input is rich text at all
 *
 * The point of dropping a file is to write "read this" about it — drop, type,
 * drop again, type again. That only works if the chip sits WHERE it was dropped,
 * because the words around it ("이거", "이것도") are what say which file is
 * meant. A list of attachments above the box cannot carry that.
 *
 * ## The chip is a view of the path, never a replacement for it
 *
 * A chip is an element holding `data-path`; {@link serializeDraft} writes that
 * path back out in full. The message the model receives is therefore the same
 * string it would have been if the user had pasted the path by hand — the chip
 * only shortens what is DISPLAYED. Every function here exists to keep that true:
 * a chip that got split, or edited from the inside, would take its path with it
 * and the loss would be silent.
 */
import { quoteReferencePath, type FileReference, type ReferenceKind } from "../../shared/fileReferences";

/** Marks a chip element and carries the path it stands for. */
const PATH_ATTR = "data-path";
const KIND_ATTR = "data-ref-kind";

/* Two clearly different silhouettes — a document versus a folder tab — because
   "is this a folder?" has to be answerable at a glance, not by reading. */
const ICONS: Record<ReferenceKind, string> = {
  file: "M14 3v5h5M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z",
  folder: "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z",
};

/** True when the node is (or sits inside) a chip. */
export function chipAncestor(node: Node | null): HTMLElement | null {
  let current: Node | null = node;
  while (current) {
    if (current.nodeType === Node.ELEMENT_NODE) {
      const el = current as HTMLElement;
      if (el.hasAttribute?.(PATH_ATTR)) {
        return el;
      }
    }
    current = current.parentNode;
  }
  return null;
}

/** Builds a chip element for a reference. */
export function createChip(doc: Document, reference: FileReference): HTMLElement {
  const chip = doc.createElement("span");
  chip.className = "wb-ref-chip";
  chip.setAttribute("contenteditable", "false");
  chip.setAttribute(PATH_ATTR, reference.path);
  chip.setAttribute(KIND_ATTR, reference.kind);
  chip.title = reference.path;

  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICONS[reference.kind]);
  svg.appendChild(path);

  const label = doc.createElement("span");
  label.className = "wb-ref-chip-name";
  label.textContent = reference.name;

  chip.appendChild(svg);
  chip.appendChild(label);
  return chip;
}

/**
 * Reads the editor back as the text that will be sent.
 *
 * Non-breaking spaces (used to keep chips from fusing) become ordinary spaces,
 * so nothing invisible reaches the model.
 */
export function serializeDraft(root: HTMLElement): string {
  let out = "";
  const walk = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        out += (child.nodeValue || "").replace(/ /g, " ");
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) {
        continue;
      }
      const el = child as HTMLElement;
      const chipPath = el.getAttribute(PATH_ATTR);
      if (chipPath) {
        out += quoteReferencePath(chipPath);
        continue;
      }
      if (el.tagName === "BR") {
        out += "\n";
        continue;
      }
      if (el.tagName === "DIV" && out && !out.endsWith("\n")) {
        out += "\n";
      }
      walk(el);
    }
  };
  walk(root);
  return out;
}

/** Every reference currently in the editor, in document order. */
export function draftReferences(root: HTMLElement): FileReference[] {
  return Array.from(root.querySelectorAll(`[${PATH_ATTR}]`)).map((el) => {
    const path = el.getAttribute(PATH_ATTR) || "";
    const kind = (el.getAttribute(KIND_ATTR) as ReferenceKind) || "file";
    return { kind, path, name: el.textContent || path, dir: "" };
  });
}

/**
 * Moves a range out of any chip it landed in.
 *
 * A drop point resolved from coordinates can land on the text INSIDE a chip.
 * Inserting there splits the chip, and a split chip loses its path on the next
 * serialize — the reference disappears with nothing reporting it. So the range
 * is pushed to just after the chip instead.
 */
export function clampOutOfChip(range: Range): Range {
  const chip = chipAncestor(range.startContainer);
  if (chip && chip.parentNode) {
    range.setStartAfter(chip);
    range.collapse(true);
  }
  return range;
}

/**
 * Inserts a chip at `range`, padding it so chips never fuse into one another or
 * into adjacent words, and returns a range positioned after the insertion.
 */
export function insertChipAt(root: HTMLElement, range: Range, reference: FileReference): Range {
  const doc = root.ownerDocument;
  clampOutOfChip(range);
  range.deleteContents();

  const chip = createChip(doc, reference);
  const fragment = doc.createDocumentFragment();

  // A separator before the chip unless the text already ends in whitespace or
  // the chip would start the message.
  const before = range.startContainer;
  const needsLead = (() => {
    if (before.nodeType === Node.TEXT_NODE) {
      const text = (before.nodeValue || "").slice(0, range.startOffset);
      return text.length > 0 && !/\s$/.test(text);
    }
    return root.childNodes.length > 0 && range.startOffset > 0;
  })();
  if (needsLead) {
    fragment.appendChild(doc.createTextNode(" "));
  }
  fragment.appendChild(chip);
  fragment.appendChild(doc.createTextNode(" "));

  range.insertNode(fragment);

  const after = doc.createRange();
  after.setStartAfter(chip.nextSibling || chip);
  after.collapse(true);
  return after;
}

/** Places the caret at `range` inside the editor. */
export function setCaret(root: HTMLElement, range: Range): void {
  const selection = root.ownerDocument.defaultView?.getSelection();
  if (!selection) {
    return;
  }
  selection.removeAllRanges();
  selection.addRange(range);
}

/** A range at the very end of the editor — the fallback insertion point. */
export function endOfDraft(root: HTMLElement): Range {
  const range = root.ownerDocument.createRange();
  range.selectNodeContents(root);
  range.collapse(false);
  return range;
}

/**
 * Rebuilds the editor from plain text, turning any known reference path back
 * into a chip.
 *
 * Used only when the draft changes from OUTSIDE the editor (cleared after send,
 * restored from the queue). A path that no longer has a known reference stays
 * visible as plain text rather than vanishing — the same thing the user saw
 * before chips existed, and never a silent loss.
 */
export function rehydrateDraft(root: HTMLElement, text: string, references: readonly FileReference[]): void {
  const doc = root.ownerDocument;
  root.textContent = "";
  if (!text) {
    return;
  }
  // Longest first, so a folder does not shadow a file nested beneath it.
  const known = [...references].sort((a, b) => b.path.length - a.path.length);
  let rest = text;
  const appendText = (value: string) => {
    if (value) {
      root.appendChild(doc.createTextNode(value));
    }
  };

  while (rest) {
    let bestAt = -1;
    let bestRef: FileReference | undefined;
    let bestToken = "";
    for (const reference of known) {
      for (const token of [quoteReferencePath(reference.path), reference.path]) {
        const at = rest.indexOf(token);
        if (at >= 0 && (bestAt < 0 || at < bestAt)) {
          bestAt = at;
          bestRef = reference;
          bestToken = token;
        }
      }
    }
    if (!bestRef || bestAt < 0) {
      appendText(rest);
      return;
    }
    appendText(rest.slice(0, bestAt));
    root.appendChild(createChip(doc, bestRef));
    rest = rest.slice(bestAt + bestToken.length);
  }
}
