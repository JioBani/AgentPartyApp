/**
 * A segmented single-choice control — the same design language as the Runtime
 * modal's Effort/Thinking pickers, so settings, modals and the catalog read as
 * one system instead of the modal being polished and everywhere else falling
 * back to raw selects.
 */
export function Segmented<T extends string>({ value, options, onChange }: {
  value: T;
  options: Array<{ id: T; label: string }>;
  onChange: (id: T) => void;
}) {
  return (
    <div className="wb-segmented set-segmented">
      {options.map((option) => (
        <button
          type="button"
          key={option.id || "_default"}
          className={"wb-segment" + (option.id === value ? " is-active" : "")}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
