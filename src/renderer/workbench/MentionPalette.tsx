import type { MentionCandidate } from "./mentionModel";

interface MentionPaletteProps {
  members: MentionCandidate[];
  activeIndex: number;
  onHover: (index: number) => void;
  onSelect: (member: MentionCandidate) => void;
  /** Narrow panels drop the key hint and tighten the rows. */
  compact?: boolean;
}

/**
 * The `@` member popover. Each row carries the member's identity colour, so the
 * name reads the same here as it does on their tab and in the transcript.
 */
export function MentionPalette({ members, activeIndex, onHover, onSelect, compact = false }: MentionPaletteProps) {
  return (
    <div className={"wb-mention-pop" + (compact ? " is-compact" : "")} role="listbox" aria-label="멤버 멘션">
      <div className="wb-mention-head">
        <span>멤버</span>
        {!compact && <span className="wb-mono">↑↓ · Enter</span>}
      </div>
      {members.map((member, index) => (
        <button
          type="button"
          key={member.name}
          role="option"
          aria-selected={index === activeIndex}
          className={"wb-mention-row" + (index === activeIndex ? " is-active" : "")}
          style={{ ["--member" as string]: member.color }}
          // Without this the composer loses focus on mousedown and the caret
          // position — which is where the name has to be inserted — is gone.
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => onHover(index)}
          onClick={() => onSelect(member)}
        >
          <span className="wb-mention-dot" />
          <span className="wb-mention-name">@{member.name}</span>
          <span className="wb-mention-status wb-mono">{member.status}</span>
        </button>
      ))}
    </div>
  );
}
