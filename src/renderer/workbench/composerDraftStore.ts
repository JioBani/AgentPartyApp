import type { ImageAttachment } from "../../shared/attachments";
import type { FileReference } from "../../shared/fileReferences";

/**
 * Everything the member composer treats as an unsent user turn.
 *
 * The module lives in one renderer, so the browser window is an implicit outer
 * scope. That is intentional: two windows may show the same member, but typing
 * in one must never appear in the other. Within a window the key survives React
 * tree changes such as closing a tab, folding a drawer, or leaving Workbench.
 */
export interface ComposerDraftSnapshot {
  text: string;
  attachments: ImageAttachment[];
  references: FileReference[];
}

export interface ComposerDraftTarget {
  partyId?: string;
  name: string;
  createdAt?: string;
}

const drafts = new Map<string, ComposerDraftSnapshot>();
/** Keys whose real target was deleted; late React cleanup must not revive them. */
const discardedKeys = new Set<string>();

export function composerDraftKey(target: ComposerDraftTarget): string {
  return `${target.partyId || "default"}::${target.name}::${target.createdAt || ""}`;
}

export function readComposerDraft(key: string): ComposerDraftSnapshot | undefined {
  const value = drafts.get(key);
  return value ? clone(value) : undefined;
}

export function writeComposerDraft(key: string, value: ComposerDraftSnapshot): void {
  if (discardedKeys.has(key)) return;
  if (!value.text && value.attachments.length === 0) {
    drafts.delete(key);
    return;
  }
  drafts.set(key, clone(value));
}

export function clearComposerDraft(key: string): void {
  drafts.delete(key);
}

/** Clear every incarnation of a member after an actual successful deletion. */
export function clearComposerDraftsForMember(partyId: string | undefined, name: string): void {
  const prefix = `${partyId || "default"}::${name}::`;
  for (const key of drafts.keys()) {
    if (key.startsWith(prefix)) {
      drafts.delete(key);
      discardedKeys.add(key);
    }
  }
}

/** Clear a party only after the backend confirms that the party was deleted. */
export function clearComposerDraftsForParty(partyId: string): void {
  const prefix = `${partyId}::`;
  for (const key of drafts.keys()) {
    if (key.startsWith(prefix)) {
      drafts.delete(key);
      discardedKeys.add(key);
    }
  }
}

function clone(value: ComposerDraftSnapshot): ComposerDraftSnapshot {
  return {
    text: value.text,
    attachments: value.attachments.map((attachment) => ({ ...attachment })),
    references: value.references.map((reference) => ({ ...reference })),
  };
}
