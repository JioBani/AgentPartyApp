export interface SelectableCapabilityLike {
  supported: boolean;
  defaultValue?: string;
  options: ReadonlyArray<{ id: string }>;
}

/** Returns the catalog's canonical id for a case-insensitive selection. */
export function matchingCapabilityOption(
  capability: SelectableCapabilityLike | undefined,
  value: string | undefined,
): string | undefined {
  const wanted = value?.trim();
  if (!capability?.supported || !wanted) return undefined;
  return capability.options.find((option) => option.id.toLowerCase() === wanted.toLowerCase())?.id;
}

/**
 * Seeds a picker from a compatible saved value, then the model's declared
 * default, then its first option. It never invents an id the model omits.
 */
export function seedCapabilityOption(
  capability: SelectableCapabilityLike | undefined,
  savedValue?: string,
): string | undefined {
  if (!capability?.supported) return undefined;
  return matchingCapabilityOption(capability, savedValue)
    ?? matchingCapabilityOption(capability, capability.defaultValue)
    ?? capability.options[0]?.id;
}
