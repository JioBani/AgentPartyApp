/**
 * Message Gate — shared data model + effective-gate resolution.
 *
 * The gate reviews member-to-member messages against user-defined communication
 * rules before delivery. Rules live at the PARTY level (a global default) and a
 * MEMBER may override them or flip the gate On/Off independently (3-state:
 * inherit / on / off). The reviewer is a headless model call (model + effort
 * only — no harness).
 *
 * This module is Electron/React-free so the main service, the core reviewer, and
 * the renderer all share one source of truth for how the three layers resolve.
 * See docs/MESSAGE_GATE.md.
 */

/** Per-member enablement relative to the party switch. */
export type GateMode = "inherit" | "on" | "off";

/** The headless reviewer model (no harness — runs as a raw completion). */
export interface GateReviewer {
  model: string;
  effort: string;
}

/** Party-level global default. */
export interface PartyGate {
  enabled: boolean;
  rule: string;
  /**
   * Party-wide reviewer. Absent = fall back to {@link AppSettings.gateDefaults}.
   * Sits between the member override and the settings default, so one party can
   * use a different model without changing the app-wide setting.
   */
  reviewer?: GateReviewer;
}

/**
 * A member's override of the party gate. Absent = full inherit. A `null` (vs
 * undefined) sub-field explicitly clears that axis back to inherit, which is how
 * "전역 규칙으로 되돌리기" / "설정 기본값 사용" are expressed.
 */
export interface MemberGateOverride {
  mode?: GateMode;
  rule?: string | null;
  reviewer?: GateReviewer | null;
}

/** The resolved gate actually applied to one member. */
export interface EffectiveGate {
  mode: GateMode;
  /** On/off after resolving the member override against the party switch. */
  enabled: boolean;
  rule: string;
  reviewer: GateReviewer;
  /** The member overrides the party rule text (drives the "Overridden" badge). */
  overridden: boolean;
  /** enabled AND a non-empty rule — only then is the reviewer actually invoked. */
  active: boolean;
}

export const GATE_MODES: GateMode[] = ["inherit", "on", "off"];

export function isGateMode(value: unknown): value is GateMode {
  return value === "inherit" || value === "on" || value === "off";
}

/** Reviewer verdict returned by the headless review call. */
export interface GateReviewResult {
  verdict: "allow" | "reject";
  reason: string;
  /** The reviewer call's own token spend, when the provider reported it — recorded
   *  to the usage ledger as a `gate-review` turn so the dashboard can price the
   *  gate's overhead honestly (measured, not fabricated). */
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

/**
 * Resolves the gate applied to a member: member override → party default →
 * settings reviewer default. Mirrors the doc's resolution table exactly.
 */
export function effectiveGate(
  member: MemberGateOverride | undefined,
  party: PartyGate | undefined,
  defaults: GateReviewer,
): EffectiveGate {
  const mode: GateMode = member?.mode ?? "inherit";
  const partyEnabled = party?.enabled ?? false;
  const enabled = mode === "on" || (mode === "inherit" && partyEnabled);
  const partyRule = party?.rule ?? "";
  const rule = typeof member?.rule === "string" ? member.rule : partyRule;
  // "Overridden" means the member actually enforces DIFFERENT text, not merely
  // that a string is stored. A stored rule identical to the party's is not an
  // override, and showing it as one made the badge look stuck after a reset.
  const overridden = typeof member?.rule === "string" && member.rule !== partyRule;
  const reviewer = member?.reviewer ?? party?.reviewer ?? defaults;
  const active = enabled && rule.trim().length > 0;
  return { mode, enabled, rule, reviewer, overridden, active };
}

/** Validates a reviewer object, returning undefined when malformed/empty. */
export function normalizeGateReviewer(value: unknown): GateReviewer | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const model = (value as { model?: unknown }).model;
  const effort = (value as { effort?: unknown }).effort;
  if (typeof model !== "string" || !model.trim() || typeof effort !== "string" || !effort.trim()) {
    return undefined;
  }
  return { model: model.trim(), effort: effort.trim() };
}

/** Validates a party-level gate; returns undefined when malformed. */
export function normalizePartyGate(value: unknown): PartyGate | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const enabled = Boolean((value as { enabled?: unknown }).enabled);
  const ruleRaw = (value as { rule?: unknown }).rule;
  const rule = typeof ruleRaw === "string" ? ruleRaw : "";
  const reviewer = normalizeGateReviewer((value as { reviewer?: unknown }).reviewer);
  return reviewer ? { enabled, rule, reviewer } : { enabled, rule };
}

/**
 * Applies a member-gate PATCH onto an existing override and returns the next
 * override (or undefined when the result is a full inherit, so no override is
 * persisted). Semantics per axis:
 *   - `mode`: any valid GateMode replaces; otherwise kept.
 *   - `rule`: a string sets the override; `null` clears it back to the party rule.
 *   - `reviewer`: a valid reviewer sets it; `null` clears back to the default.
 * A patch key that is `undefined` leaves that axis unchanged.
 */
export function applyMemberGatePatch(
  current: MemberGateOverride | undefined,
  patch: unknown,
): MemberGateOverride | undefined {
  const base: MemberGateOverride = {
    mode: current?.mode ?? "inherit",
    rule: current?.rule ?? null,
    reviewer: current?.reviewer ?? null,
  };
  if (patch && typeof patch === "object") {
    const p = patch as Record<string, unknown>;
    if ("mode" in p) {
      if (isGateMode(p.mode)) {
        base.mode = p.mode;
      }
    }
    if ("rule" in p) {
      base.rule = p.rule === null ? null : typeof p.rule === "string" ? p.rule : base.rule ?? null;
    }
    if ("reviewer" in p) {
      base.reviewer = p.reviewer === null ? null : normalizeGateReviewer(p.reviewer) ?? base.reviewer ?? null;
    }
  }
  return collapseMemberGate(base);
}

/** Collapses a full-inherit override to undefined so we never persist a no-op. */
export function collapseMemberGate(gate: MemberGateOverride | undefined): MemberGateOverride | undefined {
  if (!gate) {
    return undefined;
  }
  const mode = gate.mode ?? "inherit";
  const rule = gate.rule ?? null;
  const reviewer = gate.reviewer ?? null;
  if (mode === "inherit" && rule === null && reviewer === null) {
    return undefined;
  }
  const next: MemberGateOverride = { mode };
  if (rule !== null) {
    next.rule = rule;
  }
  if (reviewer !== null) {
    next.reviewer = reviewer;
  }
  return next;
}
