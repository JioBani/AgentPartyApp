import { Dropdown } from "./Dropdown";
import { PERMISSION_OPTIONS } from "./controls";
import { CodexPermissionControl } from "./CodexPermissionControl";
import { CursorPermissionControl } from "./CursorPermissionControl";
import { DEFAULT_CODEX_POLICY, type CodexPolicy } from "../../shared/codexPolicy";
import { cursorPolicyOf, type CursorPolicy } from "../../shared/cursorPolicy";
import { harnessCapabilities } from "../../shared/harnessCapabilities";
import type { HarnessId, PermissionModeSetting } from "../../shared/types";

/**
 * What "permission" means for a member, across every harness.
 *
 * The three harnesses do NOT share a permission model — Claude Code has one mode,
 * Codex has sandbox × approval (+ guardian), Cursor has agent mode × approval —
 * so this is a union of the three, not a lowest common denominator. Flattening
 * them into one "permission level" would have to invent equivalences the
 * harnesses do not have.
 */
export interface HarnessPermissionValue {
  permissionMode?: PermissionModeSetting;
  codexPolicy?: CodexPolicy;
  cursorPolicy?: CursorPolicy;
}

/**
 * The permission control for one harness — the single place that decides which
 * of the three controls a harness gets.
 *
 * Before this existed the same `codex ? … : cursor ? … : …` ladder was written
 * out at every call site (composer, member wizard, runtime settings), so adding
 * a harness meant finding all of them and a settings screen could silently drift
 * into offering a control the harness does not actually have.
 *
 * - `popover` — compact pill that opens a menu; for toolbars (the composer).
 * - `inline` — always-visible panel; for modals and settings cards, where a
 *   popover would be clipped by the container's overflow.
 *
 * `onChange` reports ONLY the axis that changed, so a caller can apply it as a
 * patch without having to know which harness owns which field.
 */
export function HarnessPermissionControl({
  harnessId,
  value,
  onChange,
  variant = "popover",
  selectClassName,
}: {
  harnessId: HarnessId;
  value: HarnessPermissionValue;
  onChange: (patch: HarnessPermissionValue) => void;
  variant?: "popover" | "inline";
  /** Class for the inline Claude `<select>`, so it matches its surroundings
   *  (the wizard's form inputs vs. a settings card's selects). */
  selectClassName?: string;
}) {
  // Codex is selected by its CAPABILITY, not its name — `harnessCapabilities` is
  // the declared source of truth for "this harness has two permission axes".
  if (harnessCapabilities(harnessId).twoAxisPermission) {
    return (
      <CodexPermissionControl
        policy={value.codexPolicy || DEFAULT_CODEX_POLICY}
        onChange={(codexPolicy) => onChange({ codexPolicy })}
        variant={variant}
      />
    );
  }
  if (harnessId === "cursor") {
    return (
      <CursorPermissionControl
        // A Cursor member created before the policy existed carries only the
        // Claude-shaped mode; `cursorPolicyOf` is the one place that translation
        // lives, so it is applied here rather than by each caller.
        policy={cursorPolicyOf(value.cursorPolicy, value.permissionMode)}
        onChange={(cursorPolicy) => onChange({ cursorPolicy })}
        variant={variant}
      />
    );
  }
  const mode = value.permissionMode || "default";
  if (variant === "inline") {
    return (
      <select
        className={selectClassName || "wb-wizard-input"}
        value={mode}
        onChange={(event) => onChange({ permissionMode: event.target.value as PermissionModeSetting })}
      >
        {PERMISSION_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>
    );
  }
  return (
    <Dropdown
      value={mode}
      options={PERMISSION_OPTIONS}
      onChange={(next) => onChange({ permissionMode: next as PermissionModeSetting })}
      title="권한"
      compact
      drop="up"
      align="right"
    />
  );
}
