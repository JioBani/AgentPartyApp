/** Runtime default for messages sent by one party member to another. */
export interface MemberMessagingSettings {
  interruptOnSend: boolean;
}

export const DEFAULT_MEMBER_MESSAGING_SETTINGS: MemberMessagingSettings = {
  interruptOnSend: false,
};

export function normalizeMemberMessagingSettings(value: unknown): MemberMessagingSettings {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return { interruptOnSend: input.interruptOnSend === true };
}

/** Explicit call > sender override > Runtime default. */
export function resolveMemberMessageInterrupt(
  explicit: boolean | undefined,
  memberOverride: boolean | undefined,
  runtimeDefault: MemberMessagingSettings | undefined,
): boolean {
  if (typeof explicit === "boolean") return explicit;
  if (typeof memberOverride === "boolean") return memberOverride;
  return runtimeDefault?.interruptOnSend === true;
}
