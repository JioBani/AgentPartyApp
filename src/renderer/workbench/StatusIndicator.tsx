/**
 * The graphical indicator for a member whose turn is in flight.
 *
 * A running turn used to read as the word "working" (the sidebar showed it as
 * plain grey text), which is easy to miss and reads as a label rather than as
 * motion. Three bouncing dots — the same motion the transcript's typing
 * indicator uses — say "in progress" at a glance in a space no wider than the
 * word it replaces.
 *
 * `label` is not decoration: the dots carry it as the accessible name and
 * tooltip, so the state is still readable to a screen reader and on hover.
 */
export function WorkingDots({ label }: { label: string }) {
  return (
    <span className="wb-working-dots" role="img" aria-label={label} title={label}>
      <i /><i /><i />
    </span>
  );
}
