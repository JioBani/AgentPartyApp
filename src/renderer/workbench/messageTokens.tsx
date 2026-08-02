/**
 * Renders a sent message's text with its mentions and paths as chips.
 *
 * A message is stored as plain text — that is deliberate, because plain text is
 * exactly what the model receives. So the transcript re-recognises the two
 * things that were chips while typing and draws them the same way. Without this
 * a mention reads as bare `@name` and a dropped path fills the bubble with an
 * absolute path, and neither looks like what the user composed.
 *
 * Recognition is deliberately conservative: only a name the party ACTUALLY has
 * becomes a mention, and only something unmistakably a path becomes a path chip.
 * A false positive here would restyle ordinary prose, so the rules below fail
 * towards leaving text alone.
 */
import { describePath } from "../../shared/fileReferences";
import { EVERYONE, mentionTitle } from "./mentionModel";

export type MessageToken =
  | { kind: "text"; text: string }
  | { kind: "mention"; name: string }
  | { kind: "path"; path: string };

/** A quoted run, or a bare token that starts like an absolute path. */
const PATH_PATTERN = /"([^"\n]*[\\/][^"\n]*)"|(?<![^\s(\[{])((?:[A-Za-z]:[\\/]|\/|\\\\|~\/)[^\s"'<>|]*)/g;

/**
 * Splits `text` into chips and prose.
 *
 * Mentions are matched against the real member list, longest name first so
 * `@backend` is not eaten by a member called `@back`.
 */
export function tokenizeMessage(text: string, memberNames: readonly string[]): MessageToken[] {
  // `everyone` addresses the party rather than naming a member, so it is not in
  // the member list — but it is a mention and has to read like one here too.
  const names = [...new Set([...memberNames, EVERYONE])].sort((a, b) => b.length - a.length);
  const tokens: MessageToken[] = [];
  const push = (token: MessageToken) => {
    const last = tokens[tokens.length - 1];
    if (token.kind === "text" && last?.kind === "text") {
      last.text += token.text;
      return;
    }
    if (token.kind !== "text" || token.text) {
      tokens.push(token);
    }
  };

  // Paths first: a path can contain an `@`, and matching mentions first would
  // cut one in half.
  let cursor = 0;
  for (const match of text.matchAll(PATH_PATTERN)) {
    const at = match.index ?? 0;
    const raw = match[1] ?? match[2] ?? "";
    if (!raw) {
      continue;
    }
    pushMentions(text.slice(cursor, at), names, push);
    push({ kind: "path", path: raw });
    cursor = at + match[0].length;
  }
  pushMentions(text.slice(cursor), names, push);
  return tokens;
}

function pushMentions(text: string, names: readonly string[], push: (token: MessageToken) => void): void {
  let rest = text;
  while (rest) {
    const at = rest.indexOf("@");
    if (at < 0) {
      push({ kind: "text", text: rest });
      return;
    }
    // `@` must start a word; inside one it is an email or a handle in prose.
    const before = at > 0 ? rest[at - 1] : "";
    const name = before && !/[\s(\[{"']/.test(before) ? "" : names.find((candidate) => rest.startsWith(`@${candidate}`, at));
    if (!name) {
      push({ kind: "text", text: rest.slice(0, at + 1) });
      rest = rest.slice(at + 1);
      continue;
    }
    push({ kind: "text", text: rest.slice(0, at) });
    push({ kind: "mention", name });
    rest = rest.slice(at + 1 + name.length);
  }
}

interface MessageTextProps {
  text: string;
  members: { name: string; color: string }[];
}

/**
 * The message body with its chips drawn.
 *
 * A path chip carries a neutral icon rather than guessing file vs folder: the
 * message is plain text by then and no longer records which it was. Claiming
 * one would be a guess shown as fact — the full path stays in the tooltip and
 * the label is the last segment, which is what the user recognises anyway.
 */
export function MessageText({ text, members }: MessageTextProps) {
  const colorOf = new Map(members.map((member) => [member.name, member.color]));
  const tokens = tokenizeMessage(text, members.map((member) => member.name));
  return (
    <span className="wb-msg-text">
      {tokens.map((token, index) => {
        if (token.kind === "mention") {
          return (
            <span
              key={index}
              className="wb-mention-chip"
              style={{ ["--member" as string]: colorOf.get(token.name) || (token.name === EVERYONE ? "var(--text-1)" : undefined) }}
              title={mentionTitle(token.name)}
            >
              <span className="wb-mention-chip-at">@</span>{token.name}
            </span>
          );
        }
        if (token.kind === "path") {
          const { name } = describePath(token.path);
          return (
            <span key={index} className="wb-ref-chip is-static" title={token.path}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M14 3v5h5M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
              </svg>
              <span className="wb-ref-chip-name">{name || token.path}</span>
            </span>
          );
        }
        return <span key={index}>{token.text}</span>;
      })}
    </span>
  );
}
