/**
 * Motion draws attention while the visible label makes a newly sent message's
 * in-progress state explicit. The same label names it for screen readers.
 */
export function WorkingDots({ label }: { label: string }) {
  return (
    <span className="wb-working-dots" role="img" aria-label={label} title={label}>
      <i /><i /><i /><span>{label}</span>
    </span>
  );
}
