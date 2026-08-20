import { Info, Lock, TriangleAlert } from "lucide-react";
import type { CwdPreferences, ExecutionEnv, MemberExecutionLocation, MemberLocationRow, RecentCwd } from "../../shared/memberLocation";
import { RECENT_CWD_LIMIT, memberLocationsEqual } from "../../shared/memberLocation";
import { relativeDay } from "../../shared/relativeTime";
import { ENV_LABEL, EnvIcon } from "../workbench/CwdPicker";
import { LocalizedText, localized } from "../i18n/I18nProvider";

/**
 * Settings → 작업 위치.
 *
 * Manages what the member-creation screens are PRE-FILLED with — the default
 * cwd per environment and the ten most recent ones. It deliberately cannot edit
 * an existing member's location: that is fixed for life, so the last card lists
 * members read-only and offers duplication instead of an edit that would have to
 * be refused (README §5.4).
 *
 * Presentational: preferences, member locations and every action are props, so
 * the design preview can show a broken distro and a deleted folder without a
 * filesystem.
 */

export type { MemberLocationRow };

export interface WorkspaceCwdSettingsProps {
  prefs: CwdPreferences;
  /** How many existing members run at each environment's default cwd. */
  defaultUsage: Partial<Record<ExecutionEnv, number>>;
  members: MemberLocationRow[];
  /** Frozen "now" for the recency column, so previews render deterministically. */
  now: number;
  onPickDefault: (env: ExecutionEnv) => void;
  onClearDefault: (env: ExecutionEnv) => void;
  onPromoteRecent: (entry: RecentCwd) => void;
  onRemoveRecent: (entry: RecentCwd) => void;
  /** Re-runs the check inside the environment the entry belongs to. */
  onRecheckRecent: (entry: RecentCwd) => void;
  onCloneMember: (row: MemberLocationRow) => void;
}

export function WorkspaceCwdSettings(props: WorkspaceCwdSettingsProps) {
  const { prefs, defaultUsage, members, now, onPickDefault, onClearDefault, onPromoteRecent, onRemoveRecent, onRecheckRecent, onCloneMember } = props;

  return (
    <>
      <div className="set-tab-note">
        <Info size={14} />
        <span><LocalizedText id="STR-3621" /> <b><LocalizedText id="STR-3620" /></b><LocalizedText id="STR-3622" /> <b><LocalizedText id="STR-3624" /></b><LocalizedText id="STR-3623" /></span>
      </div>

      <section className="set-card" data-layout-card="settings-workspace-defaults">
        <div className="set-card-label"><LocalizedText id="STR-3625" /><span className="set-card-sub wb-mono"><LocalizedText id="STR-3626" /></span></div>
        <div className="set-card-body set-cwd-card-body">
        {(["windows", "wsl"] as ExecutionEnv[]).map((env) => {
          const value = env === "wsl" ? prefs.wslDefault : prefs.windowsDefault;
          return (
            <div key={env} className="set-cwd-row">
              <span className="set-cwd-kind"><EnvIcon env={env} />{ENV_LABEL[env]}</span>
              {value?.distro && <span className="wb-cwd-distro">{value.distro}</span>}
              <span className="wb-mono set-cwd-path">{value?.cwd ?? "설정 안 됨"}</span>
              {value && <span className="wb-cwd-pin"><LocalizedText id="STR-3628" /></span>}
              <span className="set-cwd-meta">
                {value ? `멤버 ${defaultUsage[env] ?? 0}개가 사용` : "멤버 생성 시 직접 선택"}
              </span>
              <div className="set-cwd-actions">
                <button type="button" className="set-btn-soft" onClick={() => onPickDefault(env)}>{value ? "변경" : "선택"}</button>
                {value && <button type="button" className="set-btn-soft" onClick={() => onClearDefault(env)}><LocalizedText id="STR-3633" /></button>}
              </div>
            </div>
          );
        })}
        <p className="set-cwd-note"><LocalizedText id="STR-3634" /></p>
        </div>
      </section>

      <RecentCwdCard
        env="windows"
        sub={`최대 ${RECENT_CWD_LIMIT}개`}
        entries={prefs.windowsRecent}
        fallback={prefs.windowsDefault}
        now={now}
        note={localized("STR-3636")}
        onPromote={onPromoteRecent}
        onRemove={onRemoveRecent}
        onRecheck={onRecheckRecent}
      />

      <RecentCwdCard
        env="wsl"
        sub="배포판 + POSIX 경로"
        entries={prefs.wslRecent}
        fallback={prefs.wslDefault}
        now={now}
        note={localized("STR-3638")}
        onPromote={onPromoteRecent}
        onRemove={onRemoveRecent}
        onRecheck={onRecheckRecent}
      />

      <section className="set-card" data-layout-card="settings-workspace-members">
        <div className="set-card-label"><LocalizedText id="STR-3639" /><span className="set-card-sub wb-mono"><LocalizedText id="STR-3640" /></span></div>
        <div className="set-card-body set-cwd-card-body">
        <div className="set-inline-note">
          <Lock size={12} />
          <span><LocalizedText id="STR-3642" /> <b><LocalizedText id="STR-3643" /></b><LocalizedText id="STR-3641" /></span>
        </div>
        {members.map((row) => (
          <div key={`${row.partyName}/${row.member}`} className="set-cwd-row">
            <span className="set-cwd-kind"><EnvIcon env={row.location.env} />{ENV_LABEL[row.location.env]}</span>
            {row.location.distro && <span className="wb-cwd-distro">{row.location.distro}</span>}
            <span className="wb-mono set-cwd-path">{row.member} · {row.location.cwd}</span>
            <span className="set-cwd-meta">{row.partyName}</span>
            <div className="set-cwd-actions">
              <button type="button" className="set-btn-soft" onClick={() => onCloneMember(row)}><LocalizedText id="STR-3644" /></button>
            </div>
          </div>
        ))}
        </div>
      </section>
    </>
  );
}

function RecentCwdCard({ env, sub, entries, fallback, now, note, onPromote, onRemove, onRecheck }: {
  env: ExecutionEnv;
  sub: string;
  entries: RecentCwd[];
  fallback?: MemberExecutionLocation;
  now: number;
  note: string;
  onPromote: (entry: RecentCwd) => void;
  onRemove: (entry: RecentCwd) => void;
  onRecheck: (entry: RecentCwd) => void;
}) {
  return (
    <section className="set-card" data-layout-card={`settings-workspace-recent-${env}`}>
      <div className="set-card-label"><LocalizedText id="STR-3645" /> {ENV_LABEL[env]}<span className="set-card-sub wb-mono">{sub}</span></div>
      <div className="set-card-body set-cwd-card-body">
      {entries.map((entry) => {
        const isDefault = Boolean(fallback && memberLocationsEqual(fallback, entry.location));
        // A distro that will not start can be started; a folder that is gone
        // cannot be re-found by asking again, so only the first offers a retry.
        const retryable = entry.problem?.kind === "distro-missing" || entry.problem?.kind === "distro-unavailable";
        return (
          <div
            key={`${entry.location.distro ?? ""}:${entry.location.cwd}`}
            className={"set-cwd-row" + (entry.problem ? " is-broken" : "")}
          >
            <span className="set-cwd-kind"><EnvIcon env={env} />{ENV_LABEL[env]}</span>
            {entry.location.distro && <span className="wb-cwd-distro">{entry.location.distro}</span>}
            <span className="wb-mono set-cwd-path">{entry.location.cwd}</span>
            {isDefault && <span className="wb-cwd-pin"><LocalizedText id="STR-3646" /></span>}
            {entry.problem ? (
              <span className="wb-cwd-warn"><TriangleAlert size={12} />{entry.problem.message}</span>
            ) : (
              <span className="set-cwd-meta">{relativeDay(entry.usedAt, now)}</span>
            )}
            <div className="set-cwd-actions">
              {entry.problem
                ? retryable && <button type="button" className="set-btn-soft" onClick={() => onRecheck(entry)}><LocalizedText id="STR-3647" /></button>
                : (
                  // Kept (disabled) on the row that is already the default so the
                  // list does not reflow as the default moves between rows.
                  <button type="button" className="set-btn-soft" disabled={isDefault} onClick={() => onPromote(entry)}><LocalizedText id="STR-3648" /></button>
                )}
              {!isDefault && <button type="button" className="set-btn-soft" onClick={() => onRemove(entry)}><LocalizedText id="STR-3649" /></button>}
            </div>
          </div>
        );
      })}
      {entries.length === 0 && (
        <div className="set-cwd-row">
          <span className="set-cwd-kind"><EnvIcon env={env} />{ENV_LABEL[env]}</span>
          <span className="set-cwd-path"><LocalizedText id="STR-3650" /></span>
        </div>
      )}
      <p className="set-cwd-note">{note}</p>
      </div>
    </section>
  );
}
