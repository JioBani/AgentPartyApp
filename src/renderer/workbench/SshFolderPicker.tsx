import { Fragment, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, CornerLeftUp, Folder, FolderOpen, LoaderCircle, TriangleAlert } from "lucide-react";
import type { SshRemoteBrowseProblem, SshRemoteDirectoryResult } from "../../shared/sshServers";
import { useModalEscape } from "./useModalEscape";
import { LocalizedText, localized } from "../i18n/I18nProvider";

/**
 * The remote folder picker behind [찾아보기…] on the SSH path field (§13-6).
 *
 * A remote machine has no OS folder dialog, so this is ours: folders only, one
 * click enters a folder, the path above is clickable per segment, and
 * [이 폴더 선택] confirms the folder being shown. A folder that cannot be read
 * stays on screen as that folder, with one line saying why, so the user can
 * step back up instead of being dropped somewhere else.
 */

export function browseProblemText(problem: SshRemoteBrowseProblem): string {
  switch (problem) {
    case "permission-denied": return localized("STR-4215");
    case "missing": return localized("STR-4216");
    case "not-absolute": return localized("STR-4217");
    case "unreachable":
    case "auth-failed":
    case "fingerprint-changed": return localized("STR-4218");
    case "server-missing": return localized("STR-4219");
    case "read-failed": return localized("STR-4220");
  }
}

/** The folder one level up; `undefined` at the root. */
function parentOf(remotePath: string): string | undefined {
  const trimmed = remotePath.replace(/\/+$/, "");
  if (!trimmed) return undefined;
  const cut = trimmed.lastIndexOf("/");
  return cut <= 0 ? "/" : trimmed.slice(0, cut);
}

/** `/home/dev` → `/`, `home`, `dev`, each carrying the path it opens. */
function segmentsOf(remotePath: string): Array<{ name: string; path: string }> {
  if (!remotePath.startsWith("/")) return remotePath ? [{ name: remotePath, path: remotePath }] : [];
  const names = remotePath.split("/").filter(Boolean);
  return [{ name: "/", path: "/" }, ...names.map((name, index) => ({ name, path: "/" + names.slice(0, index + 1).join("/") }))];
}

export function SshFolderPickerDialog({ server, startPath, list, onChoose, onCancel }: {
  server: string;
  /** Opens here when it is an absolute path; otherwise at the account's home. */
  startPath?: string;
  /** Lists one folder; `undefined` asks for the home folder. */
  list: (remotePath: string | undefined) => Promise<SshRemoteDirectoryResult>;
  onChoose: (remotePath: string) => void;
  onCancel: () => void;
}) {
  const [target, setTarget] = useState<string | undefined>(startPath?.startsWith("/") ? startPath : undefined);
  const [listing, setListing] = useState<SshRemoteDirectoryResult | undefined>();
  const [lastPath, setLastPath] = useState(target ?? "");
  useModalEscape(onCancel);

  useEffect(() => {
    let alive = true;
    setListing(undefined);
    list(target).then(
      (result) => { if (!alive) return; setListing(result); setLastPath(result.path); },
      (cause) => { if (alive) setListing({ ok: false, path: target ?? "~", problem: "read-failed", detail: cause instanceof Error ? cause.message : String(cause) }); },
    );
    return () => { alive = false; };
    // `list` is a fresh closure each render; the folder shown is decided by `target` alone.
  }, [target]);

  const loading = !listing;
  const shownPath = listing?.path ?? target ?? lastPath;
  const parent = listing?.ok ? listing.parent : parentOf(shownPath);
  const segments = segmentsOf(shownPath);
  const title = localized("STR-4207", [server]);

  return createPortal(
    <div className="wb-modal-scrim">
      <div className="wb-modal wb-ssh-browse" role="dialog" aria-modal="true" aria-label={title} data-ssh-dialog="folder">
        <header className="wb-modal-head">
          <div className="wb-modal-title"><FolderOpen size={16} className="wb-ssh-accent" /><strong>{title}</strong></div>
        </header>
        <div className="wb-ssh-browse-bar">
          <button
            type="button"
            className="wb-ssh-browse-up"
            disabled={loading || !parent}
            onClick={() => parent && setTarget(parent)}
            aria-label={localized("STR-4208")}
            title={localized("STR-4208")}
            data-ssh-folder-parent
          >
            <CornerLeftUp size={14} />
          </button>
          <nav className="wb-mono wb-ssh-crumbs" aria-label={localized("STR-4224")}>
            {segments.map((segment, index) => {
              const current = index === segments.length - 1;
              return (
                <Fragment key={segment.path}>
                  {index > 1 && <ChevronRight size={11} className="wb-ssh-crumb-sep" aria-hidden="true" />}
                  <button
                    type="button"
                    className={"wb-ssh-crumb" + (current ? " is-current" : "")}
                    aria-current={current ? "location" : undefined}
                    disabled={loading}
                    onClick={() => setTarget(segment.path)}
                    title={segment.path}
                    data-ssh-crumb={segment.path}
                  >
                    {segment.name}
                  </button>
                </Fragment>
              );
            })}
          </nav>
        </div>
        <div className="wb-ssh-browse-list" role="list" aria-label={localized("STR-4223")} data-ssh-folder-list>
          {loading ? (
            <p className="wb-ssh-browse-state"><LoaderCircle size={13} className="wb-spin" /> <LocalizedText id="STR-4212" /></p>
          ) : !listing.ok ? (
            <p className="wb-ssh-browse-state is-fail" data-ssh-browse-error={listing.problem}>
              <TriangleAlert size={13} />
              <span><b className="wb-mono">{listing.path}</b> <LocalizedText id="STR-4214" />: {browseProblemText(listing.problem)}{listing.problem === "read-failed" && listing.detail ? ` · ${listing.detail}` : ""}</span>
            </p>
          ) : listing.directories.length === 0 ? (
            <p className="wb-ssh-browse-state" data-ssh-browse-empty><LocalizedText id="STR-4211" /></p>
          ) : (
            <>
              {listing.directories.map((directory) => (
                <button
                  key={directory.path}
                  type="button"
                  role="listitem"
                  className={"wb-ssh-folder" + (directory.hidden ? " is-hidden" : "")}
                  onClick={() => setTarget(directory.path)}
                  title={directory.path}
                  data-ssh-folder={directory.name}
                >
                  <Folder size={14} className="wb-ssh-folder-icon" />
                  <span className="wb-mono wb-ssh-folder-name">{directory.name}</span>
                  <ChevronRight size={13} className="wb-ssh-folder-go" />
                </button>
              ))}
              {listing.truncated && <p className="wb-ssh-browse-note"><LocalizedText id="STR-4213" /></p>}
            </>
          )}
        </div>
        <footer className="wb-modal-foot wb-ssh-browse-foot">
          {/* rtl only to cut a long path from its start; bdi keeps `/` in front. */}
          <span className="wb-mono wb-ssh-browse-picked" title={shownPath}><bdi dir="ltr">{shownPath}</bdi></span>
          <div className="wb-modal-actions">
            <button type="button" className="wb-btn wb-btn-ghost" onClick={onCancel}><LocalizedText id="STR-4210" /></button>
            <button
              type="button"
              className="wb-btn wb-btn-accent"
              disabled={!listing?.ok}
              onClick={() => listing?.ok && onChoose(listing.path)}
              data-ssh-folder-choose
            >
              <LocalizedText id="STR-4209" />
            </button>
          </div>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
