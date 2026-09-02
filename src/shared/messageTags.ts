/**
 * Durable inline tags written by the composer and restored by conversation UI.
 *
 * The wire form is intentionally recognizable but highly unlikely to occur in
 * prose by accident:
 *
 *   ⟦ap-tag:v1:model:gpt-5.6-sol:GPT-5.6%20Sol⟧
 *
 * Both payload fields are canonical `encodeURIComponent` output. Rendering
 * requires the uncommon brackets, fixed product prefix, version, allow-listed
 * kind, two non-empty components, successful decoding, and an exact canonical
 * re-encode. A merely similar sentence therefore stays literal text.
 */

export const MESSAGE_TAG_OPEN = "⟦ap-tag:v1:";
export const MESSAGE_TAG_CLOSE = "⟧";

export const MESSAGE_TAG_KINDS = ["provider", "model", "harness", "effort", "thinking", "serviceTier"] as const;
export type MessageTagKind = typeof MESSAGE_TAG_KINDS[number];

export interface MessageTag {
  kind: MessageTagKind;
  value: string;
  label: string;
}

export interface MessageTagMatch extends MessageTag {
  raw: string;
  index: number;
  end: number;
}

const MAX_VALUE_LENGTH = 512;
const MAX_LABEL_LENGTH = 256;

/** Creates the only canonical representation the parser accepts. */
export function createMessageTag(tag: MessageTag): string {
  if (!MESSAGE_TAG_KINDS.includes(tag.kind) || !tag.value || !tag.label) {
    throw new Error("AgentParty message tags require a supported kind, value, and label.");
  }
  if (tag.value.length > MAX_VALUE_LENGTH || tag.label.length > MAX_LABEL_LENGTH) {
    throw new Error("AgentParty message tag value or label is too long.");
  }
  return `${MESSAGE_TAG_OPEN}${tag.kind}:${encodeURIComponent(tag.value)}:${encodeURIComponent(tag.label)}${MESSAGE_TAG_CLOSE}`;
}

export function isMessageTagKind(value: string | null): value is MessageTagKind {
  return value !== null && MESSAGE_TAG_KINDS.includes(value as MessageTagKind);
}

/** Parses one complete canonical tag. Similar-looking or malformed text fails. */
export function parseMessageTag(raw: string): MessageTag | null {
  if (!raw.startsWith(MESSAGE_TAG_OPEN) || !raw.endsWith(MESSAGE_TAG_CLOSE)) {
    return null;
  }
  const fields = raw.slice(MESSAGE_TAG_OPEN.length, -MESSAGE_TAG_CLOSE.length).split(":");
  if (fields.length !== 3 || !isMessageTagKind(fields[0]) || !fields[1] || !fields[2]) {
    return null;
  }
  try {
    const value = decodeURIComponent(fields[1]);
    const label = decodeURIComponent(fields[2]);
    if (!value || !label || value.length > MAX_VALUE_LENGTH || label.length > MAX_LABEL_LENGTH) {
      return null;
    }
    // Canonical encoding is part of the discriminator. This rejects unescaped
    // Unicode/whitespace, lowercase percent escapes and other near-matches.
    if (encodeURIComponent(value) !== fields[1] || encodeURIComponent(label) !== fields[2]) {
      return null;
    }
    return { kind: fields[0], value, label };
  } catch {
    return null;
  }
}

/** Every valid tag in source order, with its source range. */
export function messageTagMatches(text: string): MessageTagMatch[] {
  const matches: MessageTagMatch[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const index = text.indexOf(MESSAGE_TAG_OPEN, cursor);
    if (index < 0) {
      break;
    }
    const closeAt = text.indexOf(MESSAGE_TAG_CLOSE, index + MESSAGE_TAG_OPEN.length);
    if (closeAt < 0) {
      break;
    }
    const end = closeAt + MESSAGE_TAG_CLOSE.length;
    const raw = text.slice(index, end);
    const tag = parseMessageTag(raw);
    if (tag) {
      matches.push({ ...tag, raw, index, end });
      cursor = end;
      continue;
    }
    // A malformed/open lookalike must not swallow a later valid tag. Resume
    // after this prefix so a nested next prefix is considered independently.
    cursor = index + MESSAGE_TAG_OPEN.length;
  }
  return matches;
}

/** Plain readable text used by tooltips and other non-rich surfaces. */
export function messageTagsToDisplayText(text: string): string {
  const matches = messageTagMatches(text);
  if (!matches.length) {
    return text;
  }
  let output = "";
  let cursor = 0;
  for (const match of matches) {
    output += text.slice(cursor, match.index) + match.label;
    cursor = match.end;
  }
  return output + text.slice(cursor);
}
