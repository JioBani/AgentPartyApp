import type { ReactNode } from "react";
import { FolderOpen, Monitor, Terminal, TriangleAlert } from "lucide-react";
import type { CwdPreferences, ExecutionEnv, MemberExecutionLocation, RecentCwd } from "../../shared/memberLocation";
import { RECENT_CWD_LIMIT, memberLocationsEqual, preferencesFor } from "../../shared/memberLocation";
import { relativeDay } from "../../shared/relativeTime";
import { LocalizedText, localized } from "../i18n/I18nProvider";

/**
 * Picking the one directory a member will run in, for good.
 *
 * Presentational on purpose: everything it shows arrives as props and every
 * action leaves as a callback. That is what lets the design preview page render
 * all of its states — a WSL distro that will not start, a folder that was
 * deleted, no default set yet — without a harness, a filesystem, or an IPC
 * round trip. A picker that could only be seen by actually creating a member
 * would be a picker nobody reviews.
 *
 * Layout follows the claude.ai/design mockup (`workbench.html`
 * `#overlay-wizard-runtime`) class for class; the rules live in `styles.css`
 * under "파티 그룹 · 멤버 실행 위치(cwd)".
 */

/** Windows is a monitor, WSL is a shell prompt — the same pair everywhere. */
export function EnvIcon({ env, size = 13 }: { env: ExecutionEnv; size?: number }) {
  return env === "wsl" ? <Terminal size={size} /> : <Monitor size={size} />;
}

export const ENV_LABEL: Record<ExecutionEnv, string> = { windows: "Windows", wsl: "WSL" };

export interface CwdPickerProps {
  /** The chosen location, or undefined until the user picks one. */
  value?: MemberExecutionLocation;
  prefs: CwdPreferences;
  /** Frozen "now" for the recency column, so previews render deterministically. */
  now: number;
  onChange: (value: MemberExecutionLocation) => void;
  onChangeEnv: (env: ExecutionEnv) => void;
  /** Opens the platform folder picker for the current environment. */
  onBrowse: () => void;
  /**
   * The "save as this environment's default cwd" switch. Omitted where the
   * design does not offer it (the new-party dialog), rather than rendered
   * disabled — an unusable control still reads as a promise.
   */
  saveAsDefault?: { checked: boolean; onToggle: (checked: boolean) => void };
  /** Shown under the picker; the wizard and the party dialog say different things. */
  hint?: ReactNode;
}

export function CwdPicker({ value, prefs, now, onChange, onChangeEnv, onBrowse, saveAsDefault, hint }: CwdPickerProps) {
  const env: ExecutionEnv = value?.env ?? "windows";
  const { fallback, recent } = preferencesFor(prefs, env);

  return (
    <>
      <div className="wb-env-seg" role="group" aria-label={localized("STR-3257")}>
        {(["windows", "wsl"] as ExecutionEnv[]).map((candidate) => (
          <button
            key={candidate}
            type="button"
            className={candidate === env ? "is-active" : ""}
            aria-pressed={candidate === env}
            onClick={() => onChangeEnv(candidate)}
          >
            <EnvIcon env={candidate} />
            {ENV_LABEL[candidate]}
          </button>
        ))}
      </div>

      <div className="wb-cwd-field">
        <EnvIcon env={env} />
        {value?.distro && <span className="wb-cwd-distro">{value.distro}</span>}
        <span className="wb-mono wb-cwd-path">{value?.cwd || "경로를 선택하세요"}</span>
        <button type="button" className="wb-cwd-browse" onClick={onBrowse}>
          <FolderOpen size={13} />
          <LocalizedText id="STR-3259" />
        </button>
      </div>

      {recent.length > 0 && (
        <div className="wb-cwd-list">
          <div className="wb-cwd-list-label">
            <LocalizedText id="STR-3261" /> {ENV_LABEL[env]} <LocalizedText id="STR-3260" />
            <span><LocalizedText id="STR-3262" /> {RECENT_CWD_LIMIT}개</span>
          </div>
          {recent.map((entry) => (
            <CwdRecentItem
              key={`${entry.location.distro ?? ""}:${entry.location.cwd}`}
              entry={entry}
              now={now}
              isDefault={Boolean(fallback && memberLocationsEqual(fallback, entry.location))}
              isSelected={Boolean(value && memberLocationsEqual(value, entry.location))}
              onSelect={() => onChange(entry.location)}
            />
          ))}
        </div>
      )}

      {saveAsDefault && (
        <label className="wb-cwd-save">
          <input
            type="checkbox"
            className="wb-switch"
            checked={saveAsDefault.checked}
            onChange={(event) => saveAsDefault.onToggle(event.target.checked)}
          />
          <span><LocalizedText id="STR-3264" /> {ENV_LABEL[env]} <LocalizedText id="STR-3263" /></span>
        </label>
      )}

      {hint && <p className="wb-wizard-hint">{hint}</p>}
    </>
  );
}

/**
 * One remembered cwd.
 *
 * A broken entry stays in the list, greyed, WITH the reason it failed. Removing
 * it (or quietly selecting a different one) is exactly the silent substitution
 * the spec forbids: the user needs to see that the distro is down, not to find
 * their member running somewhere else.
 */
function CwdRecentItem({ entry, now, isDefault, isSelected, onSelect }: {
  entry: RecentCwd;
  now: number;
  isDefault: boolean;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const broken = Boolean(entry.problem);
  return (
    <button
      type="button"
      className={"wb-cwd-item" + (isSelected ? " is-selected" : "") + (broken ? " is-broken" : "")}
      aria-current={isSelected || undefined}
      onClick={onSelect}
    >
      {entry.location.distro && <span className="wb-cwd-distro">{entry.location.distro}</span>}
      <span className="wb-mono wb-cwd-item-path">{entry.location.cwd}</span>
      {isDefault && <span className="wb-cwd-pin"><LocalizedText id="STR-3265" /></span>}
      {entry.problem ? (
        <span className="wb-cwd-warn">
          <TriangleAlert size={12} />
          {entry.problem.message}
        </span>
      ) : (
        <span className="set-cwd-meta">{relativeDay(entry.usedAt, now)}</span>
      )}
    </button>
  );
}
