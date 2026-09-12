/** Shared Message Gate model. Legacy single-axis values normalize to `send`. */

export type GateAxis = "send" | "recv";
export type GateMode = "inherit" | "on" | "off";

export interface GateReviewer {
  model: string;
  effort: string;
  /** Concrete provider serving tier. Omitted means the ordinary tier. */
  serviceTier?: string;
}

export interface PartyGateAxis {
  enabled: boolean;
  rule: string;
  reviewer?: GateReviewer;
}

export interface PartyGate {
  send: PartyGateAxis;
  recv: PartyGateAxis;
}

export interface MemberGateAxisOverride {
  mode?: GateMode;
  rule?: string | null;
  reviewer?: GateReviewer | null;
}

export interface MemberGateOverride {
  send?: MemberGateAxisOverride;
  recv?: MemberGateAxisOverride;
}

export interface MemberGatePatch extends MemberGateAxisOverride { axis?: GateAxis }
export type MemberGateUpdate = MemberGatePatch | MemberGateOverride;
export interface PartyGatePatch {
  axis?: GateAxis;
  enabled?: boolean;
  rule?: string;
  reviewer?: GateReviewer | null;
}

export interface EffectiveGate {
  axis: GateAxis;
  mode: GateMode;
  enabled: boolean;
  rule: string;
  reviewer: GateReviewer;
  /** Explicit member/party reviewer, before the settings fallback. */
  configuredReviewer?: GateReviewer;
  overridden: boolean;
  active: boolean;
}

export type GateScope = GateAxis | "both";
export type GateViolation = GateScope;

export interface GateReviewPlan {
  active: boolean;
  scope?: GateScope;
  sender: EffectiveGate;
  recipient: EffectiveGate;
  reviewer: GateReviewer;
}

export const GATE_AXES: GateAxis[] = ["send", "recv"];
export const GATE_MODES: GateMode[] = ["inherit", "on", "off"];

export function isGateAxis(value: unknown): value is GateAxis {
  return value === "send" || value === "recv";
}

export function isGateMode(value: unknown): value is GateMode {
  return value === "inherit" || value === "on" || value === "off";
}

export interface GateReviewResult {
  verdict: "allow" | "reject";
  reason: string;
  violation?: GateViolation;
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

const offAxis = (): PartyGateAxis => ({ enabled: false, rule: "" });

export function effectiveGate(
  axis: GateAxis,
  member: MemberGateOverride | undefined,
  party: PartyGate | undefined,
  defaults: GateReviewer,
): EffectiveGate {
  const memberValue = member?.[axis];
  const partyValue = party?.[axis] ?? offAxis();
  const mode: GateMode = memberValue?.mode ?? "inherit";
  const enabled = mode === "on" || (mode === "inherit" && partyValue.enabled);
  const rule = typeof memberValue?.rule === "string" ? memberValue.rule : partyValue.rule;
  const configuredReviewer = memberValue?.reviewer ?? partyValue.reviewer;
  return {
    axis,
    mode,
    enabled,
    rule,
    reviewer: configuredReviewer ?? defaults,
    configuredReviewer,
    overridden: typeof memberValue?.rule === "string" && memberValue.rule !== partyValue.rule,
    active: enabled && rule.trim().length > 0,
  };
}

/** Resolves the single review used for A -> B. */
export function resolveGateReviewPlan(
  senderGate: MemberGateOverride | undefined,
  recipientGate: MemberGateOverride | undefined,
  party: PartyGate | undefined,
  defaults: GateReviewer,
): GateReviewPlan {
  const sender = effectiveGate("send", senderGate, party, defaults);
  const recipient = effectiveGate("recv", recipientGate, party, defaults);
  const scope: GateScope | undefined = sender.active && recipient.active
    ? "both"
    : sender.active ? "send" : recipient.active ? "recv" : undefined;
  return {
    active: Boolean(scope),
    scope,
    sender,
    recipient,
    reviewer: (recipient.active ? recipient.configuredReviewer : undefined)
      ?? (sender.active ? sender.configuredReviewer : undefined)
      ?? defaults,
  };
}

export function normalizeGateReviewer(value: unknown): GateReviewer | undefined {
  if (!value || typeof value !== "object") return undefined;
  const model = (value as { model?: unknown }).model;
  const effort = (value as { effort?: unknown }).effort;
  if (typeof model !== "string" || !model.trim() || typeof effort !== "string" || !effort.trim()) return undefined;
  const rawTier = (value as { serviceTier?: unknown }).serviceTier;
  const serviceTier = typeof rawTier === "string" && rawTier.trim() && rawTier.trim() !== "inherit"
    ? rawTier.trim()
    : undefined;
  return { model: model.trim(), effort: effort.trim(), ...(serviceTier ? { serviceTier } : {}) };
}

function normalizePartyGateAxis(value: unknown): PartyGateAxis | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const reviewer = normalizeGateReviewer(raw.reviewer);
  const axis = { enabled: Boolean(raw.enabled), rule: typeof raw.rule === "string" ? raw.rule : "" };
  return reviewer ? { ...axis, reviewer } : axis;
}

/** Accepts canonical and legacy `{enabled,rule,reviewer}` storage. */
export function normalizePartyGate(value: unknown): PartyGate | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if ("send" in raw || "recv" in raw) {
    return { send: normalizePartyGateAxis(raw.send) ?? offAxis(), recv: normalizePartyGateAxis(raw.recv) ?? offAxis() };
  }
  const send = normalizePartyGateAxis(raw);
  return send ? { send, recv: offAxis() } : undefined;
}

function collapseMemberGateAxis(gate: MemberGateAxisOverride | undefined): MemberGateAxisOverride | undefined {
  if (!gate) return undefined;
  const mode = gate.mode ?? "inherit";
  const rule = gate.rule ?? null;
  const reviewer = gate.reviewer ?? null;
  if (mode === "inherit" && rule === null && reviewer === null) return undefined;
  return { mode, ...(rule !== null ? { rule } : {}), ...(reviewer !== null ? { reviewer } : {}) };
}

function normalizeMemberGateAxis(value: unknown): MemberGateAxisOverride | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const next: MemberGateAxisOverride = {};
  if (isGateMode(raw.mode)) next.mode = raw.mode;
  if (typeof raw.rule === "string" || raw.rule === null) next.rule = raw.rule as string | null;
  if (raw.reviewer === null) next.reviewer = null;
  else {
    const reviewer = normalizeGateReviewer(raw.reviewer);
    if (reviewer) next.reviewer = reviewer;
  }
  return collapseMemberGateAxis(next);
}

/** Accepts canonical and legacy `{mode,rule,reviewer}` storage. */
export function normalizeMemberGate(value: unknown): MemberGateOverride | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if ("send" in raw || "recv" in raw) {
    return collapseMemberGate({ send: normalizeMemberGateAxis(raw.send), recv: normalizeMemberGateAxis(raw.recv) });
  }
  const send = normalizeMemberGateAxis(raw);
  return send ? { send } : undefined;
}

/** Applies an axis patch; a missing axis means `send` for API compatibility. */
export function applyMemberGatePatch(current: MemberGateOverride | undefined, patch: unknown): MemberGateOverride | undefined {
  const normalized = normalizeMemberGate(current);
  if (!patch || typeof patch !== "object") return normalized;
  const raw = patch as Record<string, unknown>;
  if ("axis" in raw && raw.axis !== undefined && !isGateAxis(raw.axis)) {
    throw new Error("Message Gate axis must be 'send' or 'recv'.");
  }
  if (!isGateAxis(raw.axis) && ("send" in raw || "recv" in raw)) {
    let next = normalized;
    for (const axis of GATE_AXES) {
      if (axis in raw) next = applyMemberGatePatch(next, { ...(raw[axis] as object), axis });
    }
    return next;
  }
  const axis: GateAxis = isGateAxis(raw.axis) ? raw.axis : "send";
  const existing = normalized?.[axis];
  const next: MemberGateAxisOverride = {
    mode: existing?.mode ?? "inherit",
    rule: existing?.rule ?? null,
    reviewer: existing?.reviewer ?? null,
  };
  if ("mode" in raw && isGateMode(raw.mode)) next.mode = raw.mode;
  if ("rule" in raw) next.rule = raw.rule === null ? null : typeof raw.rule === "string" ? raw.rule : next.rule;
  if ("reviewer" in raw) next.reviewer = raw.reviewer === null ? null : normalizeGateReviewer(raw.reviewer) ?? next.reviewer;
  return collapseMemberGate({ ...normalized, [axis]: collapseMemberGateAxis(next) });
}

/** Applies an axis patch; a missing axis means `send` for API compatibility. */
export function applyPartyGatePatch(current: PartyGate | undefined, patch: unknown): PartyGate {
  const normalized = normalizePartyGate(current) ?? { send: offAxis(), recv: offAxis() };
  if (!patch || typeof patch !== "object") return normalized;
  const raw = patch as Record<string, unknown>;
  if ("axis" in raw && raw.axis !== undefined && !isGateAxis(raw.axis)) {
    throw new Error("Message Gate axis must be 'send' or 'recv'.");
  }
  const axis: GateAxis = isGateAxis(raw.axis) ? raw.axis : "send";
  const value = raw[axis] && typeof raw[axis] === "object" ? raw[axis] as Record<string, unknown> : raw;
  const previous = normalized[axis];
  const reviewer = "reviewer" in value
    ? value.reviewer === null ? undefined : normalizeGateReviewer(value.reviewer) ?? previous.reviewer
    : previous.reviewer;
  const next: PartyGateAxis = {
    enabled: "enabled" in value ? Boolean(value.enabled) : previous.enabled,
    rule: typeof value.rule === "string" ? value.rule : previous.rule,
    ...(reviewer ? { reviewer } : {}),
  };
  return { ...normalized, [axis]: next };
}

export function collapseMemberGate(gate: MemberGateOverride | undefined): MemberGateOverride | undefined {
  if (!gate) return undefined;
  const send = collapseMemberGateAxis(gate.send);
  const recv = collapseMemberGateAxis(gate.recv);
  if (!send && !recv) return undefined;
  return { ...(send ? { send } : {}), ...(recv ? { recv } : {}) };
}

export type GateFailureLayer = "parsing" | "timeout" | "transport" | "unknown";

export function classifyGateFailure(error: unknown): GateFailureLayer {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if (/abort|timed?\s*out|ETIMEDOUT/i.test(text)) return "timeout";
  if (/verdict was invalid|JSON|parse|unexpected token|schema/i.test(text)) return "parsing";
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|socket|network|certificate|\b(401|403|404|429|5\d\d)\b|unavailable|not connected|proxy/i.test(text)) return "transport";
  return "unknown";
}
