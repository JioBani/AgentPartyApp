/**
 * 버전 화면 — the rail's own screen for "what am I running, is there something
 * newer, and what changed".
 *
 * It replaces 설정 → 버전 without dropping anything that tab did: installed
 * version, install / restart, 업데이트 확인, 업데이트 창, the 안정/베타 channel,
 * every release's notes with its release page, and the list error + retry.
 *
 * Two things differ on purpose:
 *   - Notes are READ, not operated: one release at a time, headline + prose +
 *     full-width images, no fixed-height box.
 *   - Older releases are turned sideways (이전 ‹ [버전 ▾] › 다음, left = older),
 *     never stacked below the page, so every release reads the same way.
 *
 * Built from the settings design system (set-section / set-card / set-row /
 * set-btn-* / set-ver-* / set-update-channel-*); the few rules of its own are
 * the `ver-*` block in styles.css.
 *
 * The release list comes from the public releases API (updateService), so it
 * renders even where self-update is off — knowing what exists matters most
 * when the app cannot fetch it for you.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowDownToLine, ArrowRight, ChevronLeft, ChevronRight, FlaskConical, History, RefreshCw, RotateCw, ShieldCheck } from "lucide-react";
import type { ReleaseSummary, UpdateChannel, UpdateStatus } from "../../shared/appUpdate";
import { Markdown } from "../workbench/Markdown";
import { Dropdown } from "../workbench/Dropdown";
import { useI18n } from "../i18n/I18nProvider";
import { ipcErrorMessage } from "./ipcError";
import { openUpdateDialog } from "./updateDialog";

interface VersionsViewProps {
  /** The app-wide update status (the same push the titlebar pill reads). */
  status: UpdateStatus | undefined;
  /** Hands a fresher status back to the app after an action here. */
  onStatus: (status: UpdateStatus) => void;
}

function withoutGenericOpening(notes: string): string {
  return notes.trimStart().replace(/^##\s+(주요 변경|변경 사항|What's new|Changes|AgentParty[^\n]*)\s*\n+/i, "");
}

/** The `###` the notes open with, if they open with one — it becomes the release's headline. */
function leadingHeading(release: ReleaseSummary): RegExpMatchArray | null {
  return withoutGenericOpening(release.notes).match(/^###\s+(.+)\s*\n*/);
}

/** The release title, unless it just repeats the tag (`v0.2.0` for 0.2.0). */
function releaseTitle(release: ReleaseSummary): string {
  const name = release.name.trim();
  return name === release.version || name === `v${release.version}` ? "" : name;
}

export function releaseHeadline(release: ReleaseSummary): string {
  return leadingHeading(release)?.[1].trim() || releaseTitle(release);
}

/** A neighbour card's line when the release has no headline: its first line of prose. */
function firstLine(release: ReleaseSummary): string {
  return withoutGenericOpening(release.notes)
    .split("\n")
    .map((line) => line.replace(/^[-#*\s]+/, "").replace(/\*\*/g, "").trim())
    .find(Boolean) || `v${release.version}`;
}

/** The notes under the headline, without the headline and a generic opening heading repeated. */
function releaseBody(release: ReleaseSummary): string {
  const notes = withoutGenericOpening(release.notes);
  const lead = leadingHeading(release);
  return lead ? notes.slice(lead[0].length) : notes;
}

function shortDate(iso: string): string {
  return iso ? new Date(iso).toLocaleDateString() : "";
}

/** What the screen can ask the app to do. The app wires these to IPC; the design studio to no-ops. */
export interface VersionsActions {
  check: () => Promise<UpdateStatus>;
  download: () => Promise<UpdateStatus>;
  install: () => Promise<void>;
  setChannel: (channel: UpdateChannel) => Promise<UpdateStatus>;
  openDialog: () => void;
  openRelease: (url: string) => void;
  reloadReleases: () => void;
}

function UpdateCard({ status, onStatus, actions }: { status: UpdateStatus | undefined; onStatus: (s: UpdateStatus) => void; actions: VersionsActions }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState<"" | "check" | "download" | "install" | "channel">("");
  const [error, setError] = useState("");
  const [confirmInstall, setConfirmInstall] = useState(false);

  const run = async (kind: typeof busy, action: () => Promise<void>) => {
    setBusy(kind);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(ipcErrorMessage(e));
    } finally {
      setBusy("");
    }
  };

  const check = () => run("check", async () => {
    onStatus(await actions.check());
    actions.reloadReleases();
  });
  const download = () => run("download", async () => { onStatus(await actions.download()); });
  const install = () => run("install", actions.install);
  const changeChannel = (channel: UpdateChannel) => {
    if (channel === (status?.channel || "stable")) return;
    void run("channel", async () => {
      onStatus(await actions.setChannel(channel));
      actions.reloadReleases();
    });
  };

  const state = status?.state;
  const current = status?.currentVersion || "?";
  const latest = status?.latestVersion || "";
  const channel = status?.channel || "stable";
  const offered = state === "available" || state === "downloading" || state === "downloaded";
  const downgrade = Boolean(status?.downgrade);

  const title = state === "downloaded" ? t("versions.update.ready", { version: latest })
    : state === "downloading" ? t("versions.update.downloading", { version: latest, percent: Math.round(status?.progress?.percent || 0) })
      : state === "available" ? t(downgrade ? "versions.update.rollback" : "versions.update.available", { version: latest })
        : state === "checking" ? t("versions.update.checking")
          : state === "disabled" ? t("versions.update.disabled")
            : state === "error" ? t("versions.update.failed")
              : t("versions.update.current");
  const note = state === "disabled" ? status?.disabledReason : state === "error" ? status?.error : error;

  return (
    <section className="set-section">
      <div className="set-section-head"><span className="set-section-label">{t("versions.section.update")}</span><span className="set-section-rule" /></div>
      <div className="set-card" data-ver="update-card">
        <div className="set-row set-row-flush">
          <span className={`set-row-icon${offered ? " is-accent" : ""}`}>
            {state === "downloaded" ? <RotateCw size={18} /> : downgrade ? <History size={18} /> : <ArrowDownToLine size={18} />}
          </span>
          <div className="set-row-body">
            <span className="set-row-name" data-ver="update-title">{title}</span>
            <span className="ver-installed">
              <span className="wb-mono set-ver-badge" data-ver="installed">v{current}</span>
              {offered && latest && <><ArrowRight size={12} /><span className={`wb-mono set-ver-badge ${downgrade ? "is-warn" : "is-latest"}`}>v{latest}</span></>}
            </span>
            {note && <span className="set-row-desc ver-update-note">{note}</span>}
          </div>
          {state === "available" && (
            <button type="button" className="set-btn-accent" data-ver="download" disabled={Boolean(busy)} onClick={() => void download()}>
              <ArrowDownToLine size={14} /> {t(downgrade ? "versions.action.rollback" : "versions.action.install")}
            </button>
          )}
          {state === "downloading" && (
            <button type="button" className="set-btn-accent" disabled><RefreshCw size={14} className="wb-spin" /> {t("versions.action.downloading")}</button>
          )}
          {state === "downloaded" && (
            // Installing quits the app and stops every member — one explicit
            // confirm, same rule as the update dialog.
            <button type="button" className="set-btn-accent" data-ver="install" disabled={Boolean(busy)} onClick={() => (confirmInstall ? void install() : setConfirmInstall(true))}>
              <RotateCw size={14} /> {t(confirmInstall ? "versions.action.restartConfirm" : "versions.action.restart")}
            </button>
          )}
        </div>
        <div className="set-card-label ver-row-rule">{t("versions.channel.label")}</div>
        <div className="set-update-channel-options ver-channel" role="radiogroup" aria-label={t("versions.channel.label")} data-ver="channel-card">
          <button
            type="button"
            role="radio"
            aria-checked={channel === "stable"}
            className={`set-update-channel-option${channel === "stable" ? " is-active" : ""}`}
            data-ver="channel-stable"
            disabled={busy === "channel"}
            onClick={() => changeChannel("stable")}
          >
            <span><ShieldCheck size={13} /> {t("versions.channel.stable")}</span>
            <small>{t("versions.channel.stableHint")}</small>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={channel === "beta"}
            className={`set-update-channel-option${channel === "beta" ? " is-active" : ""}`}
            data-ver="channel-beta"
            disabled={busy === "channel"}
            onClick={() => changeChannel("beta")}
          >
            <span><FlaskConical size={13} /> {t("versions.channel.beta")}</span>
            <small>{t("versions.channel.betaHint")}</small>
          </button>
        </div>
        <div className="set-diag-actions">
          <button type="button" className="set-btn-soft" data-ver="check" disabled={Boolean(busy) || state === "checking" || state === "downloading"} onClick={() => void check()}>
            <RefreshCw size={14} className={busy === "check" || state === "checking" ? "wb-spin" : undefined} /> {t("versions.action.check")}
          </button>
          <button type="button" className="set-btn-soft" data-ver="open-dialog" onClick={actions.openDialog}>{t("versions.action.openDialog")}</button>
        </div>
      </div>
    </section>
  );
}

/** One release, read like an article: meta line, headline, prose and full-width images. */
function ReleaseArticle({ release, latest, installed, onOpen }: { release: ReleaseSummary; latest: boolean; installed: boolean; onOpen: (url: string) => void }) {
  const { t } = useI18n();
  const headline = releaseHeadline(release) || `AgentParty ${release.version}`;
  const body = releaseBody(release);
  return (
    <article className="ver-release" data-ver={`release-${release.version}`}>
      <div className="ver-release-meta">
        <span className={`wb-mono set-ver-badge${latest ? " is-latest" : ""}`}>v{release.version}</span>
        {latest && !installed && <span className="set-ver-tag is-new">{t("versions.tag.new")}</span>}
        {installed && <span className="set-ver-tag is-ok">{t("versions.tag.installed")}</span>}
        {release.prerelease && <span className="set-ver-tag">{t("versions.tag.beta")}</span>}
        <span className="ver-release-date">{shortDate(release.publishedAt)}</span>
        <button type="button" className="set-link-btn ver-release-link" onClick={() => onOpen(release.url)}>
          <ArrowRight size={12} /> {t("versions.releasePage")}
        </button>
      </div>
      <div className="ver-notes">
        <h2 className="ver-notes-title">{headline}</h2>
        {body ? <Markdown text={body} /> : <span className="set-ver-empty">{t("versions.noNotes")}</span>}
      </div>
    </article>
  );
}

/** The app's screen: owns the fetching, hands everything to {@link VersionsPage}. */
export function VersionsView({ status, onStatus }: VersionsViewProps) {
  const [releases, setReleases] = useState<ReleaseSummary[] | undefined>();
  const [listError, setListError] = useState("");
  const [loading, setLoading] = useState(false);

  const loadReleases = useCallback(async (refresh: boolean) => {
    setLoading(true);
    setListError("");
    try {
      setReleases((await window.agentParty.listUpdateVersions({ refresh })).releases);
    } catch (error) {
      setListError(ipcErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, []);

  // Opening the screen shows the cached list at once, then asks the feed quietly
  // so a release published since the last check is here without a click.
  useEffect(() => {
    let cancelled = false;
    void loadReleases(false);
    void (async () => {
      try {
        const res = await window.agentParty.checkForUpdate?.({ quiet: true });
        if (cancelled) return;
        if (res?.update) onStatus(res.update);
        await loadReleases(true);
      } catch (error) {
        if (!cancelled) setListError(ipcErrorMessage(error));
      }
    })();
    return () => { cancelled = true; };
  }, [loadReleases, onStatus]);

  const actions = useMemo<VersionsActions>(() => ({
    check: async () => (await window.agentParty.checkForUpdate()).update,
    download: async () => (await window.agentParty.downloadUpdate()).update,
    install: async () => { await window.agentParty.installUpdate(); },
    setChannel: async (channel) => (await window.agentParty.setUpdateChannel(channel)).update,
    openDialog: openUpdateDialog,
    openRelease: (url) => void window.agentParty.openExternal(url),
    reloadReleases: () => void loadReleases(true),
  }), [loadReleases]);

  return <VersionsPage status={status} onStatus={onStatus} releases={releases} listError={listError} loading={loading} actions={actions} />;
}

interface VersionsPageProps extends VersionsViewProps {
  releases: ReleaseSummary[] | undefined;
  listError: string;
  loading: boolean;
  actions: VersionsActions;
}

/** The screen itself, from data and actions only — the app and the design studio both mount this. */
export function VersionsPage({ status, onStatus, releases, listError, loading, actions }: VersionsPageProps) {
  const { t } = useI18n();
  const [index, setIndex] = useState(0);
  const pageRef = useRef<HTMLElement>(null);

  const list = releases || [];
  const current = status?.currentVersion || "";
  const safeIndex = Math.min(index, Math.max(0, list.length - 1));
  const release = list[safeIndex];
  const older = list[safeIndex + 1];
  const newer = list[safeIndex - 1];
  const isInstalled = (r: ReleaseSummary) => (current ? r.version === current : Boolean(r.current));

  /** Turn the page and bring its top into view — a long note would otherwise open mid-way. */
  function go(next: number) {
    setIndex(next);
    pageRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const options = list.map((r, i) => ({
    id: r.version,
    label: `v${r.version}`,
    hint: [i === 0 ? t("versions.tag.latest") : "", isInstalled(r) ? t("versions.tag.installed") : "", shortDate(r.publishedAt)].filter(Boolean).join(" · "),
  }));

  return (
    <div className="set-page ver-page" data-view-body="versions">
      <UpdateCard status={status} onStatus={onStatus} actions={actions} />

      {listError && (
        <div className="set-inline-note is-error ver-error" data-ver="list-error">
          <AlertTriangle size={14} />
          <span>{listError}</span>
          <button type="button" className="set-link-btn" onClick={actions.reloadReleases}><RefreshCw size={12} /> {t("versions.retry")}</button>
        </div>
      )}

      <section className="set-section" ref={pageRef}>
        <div className="set-section-head">
          <span className="set-section-label">{t(safeIndex === 0 ? "versions.section.latest" : "versions.section.older")}</span>
          <span className="set-section-rule" />
          {list.length > 0 && (
            // One joined control, read left → right like a timeline: older ‹ [this version ▾] › newer.
            <div className="ver-pager" role="group" aria-label={t("versions.pager")}>
              <button type="button" className="ver-pager-btn" data-ver="older" disabled={!older} onClick={() => go(safeIndex + 1)}><ChevronLeft size={14} /> {t("versions.older")}</button>
              <Dropdown value={release.version} options={options} onChange={(v) => go(list.findIndex((r) => r.version === v))} title={t("versions.jump")} align="right" />
              <button type="button" className="ver-pager-btn" data-ver="newer" disabled={!newer} onClick={() => go(safeIndex - 1)}>{t("versions.newer")} <ChevronRight size={14} /></button>
            </div>
          )}
        </div>
        {!release ? (
          <div className="set-ver-empty ver-empty">{loading ? t("versions.loading") : listError ? t("versions.listFailed") : t("versions.none")}</div>
        ) : (
          <>
            <ReleaseArticle key={release.version} release={release} latest={safeIndex === 0} installed={isInstalled(release)} onOpen={actions.openRelease} />
            {/* The end of a note is where the reader decides to keep going: both neighbours, by name. */}
            <nav className="ver-turn" aria-label={t("versions.pager")}>
              {older ? (
                <button type="button" className="ver-turn-card" onClick={() => go(safeIndex + 1)}>
                  <span className="ver-turn-dir"><ChevronLeft size={13} /> {t("versions.olderVersion", { version: older.version })}</span>
                  <span className="ver-turn-title">{releaseHeadline(older) || firstLine(older)}</span>
                </button>
              ) : <span />}
              {newer ? (
                <button type="button" className="ver-turn-card is-newer" onClick={() => go(safeIndex - 1)}>
                  <span className="ver-turn-dir">{t("versions.newerVersion", { version: newer.version })} <ChevronRight size={13} /></span>
                  <span className="ver-turn-title">{releaseHeadline(newer) || firstLine(newer)}</span>
                </button>
              ) : <span />}
            </nav>
          </>
        )}
      </section>
    </div>
  );
}
