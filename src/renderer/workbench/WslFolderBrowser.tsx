import { useCallback, useEffect, useState } from "react";
import { CornerLeftUp, Folder, House, RefreshCw, Terminal, TriangleAlert, X } from "lucide-react";
import type { WslDirectoryListing } from "../../shared/memberLocation";
import { LocalizedText, localized } from "../i18n/I18nProvider";

/**
 * Browsing a distro's own filesystem to pick a member's cwd.
 *
 * The Windows folder dialog cannot do this job. It reaches a distro only
 * through the `\\wsl$\` redirector, which answers for distros that are running
 * and simply fails for the ones that are not — so a picker built on it would
 * offer a path the member then cannot start in. Every level here is listed by
 * `sh` INSIDE the distro, which is the same place the member will run.
 *
 * Opens at `$HOME` because that is where a WSL user's work lives; `/` opens
 * onto `proc`, `sys` and `mnt` — a first screen made of directories nobody
 * wanted. Going up from home is still allowed, all the way to the root.
 *
 * Presentational like the rest of the picker: the listing arrives through the
 * `list` callback, so the design preview drives it with a fixture tree and the
 * screen can be reviewed without a distro installed.
 */

export interface WslFolderBrowserProps {
  distro: string;
  /** Where to open. Omitted (or empty) means the distro's `$HOME`. */
  initialCwd?: string;
  /** One directory level, as the distro sees it. */
  list: (distro: string, cwd?: string) => Promise<WslDirectoryListing>;
  onCancel: () => void;
  onSelect: (cwd: string) => void;
}

export function WslFolderBrowser({ distro, initialCwd, list, onCancel, onSelect }: WslFolderBrowserProps) {
  const [listing, setListing] = useState<WslDirectoryListing | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  // A failed navigation must not look like an empty folder, so the last good
  // listing stays on screen underneath the reason the new one did not load.
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [showHidden, setShowHidden] = useState(false);

  const load = useCallback(async (cwd?: string) => {
    setLoading(true);
    setFailure(undefined);
    try {
      const next = await list(distro, cwd);
      if (next.problem) {
        setFailure(next.problem.message);
      } else {
        setListing(next);
      }
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [distro, list]);

  useEffect(() => {
    void load(initialCwd || undefined);
  }, [load, initialCwd]);

  const cwd = listing?.cwd;
  const directories = listing?.directories ?? [];
  const visible = showHidden ? directories : directories.filter((name) => !name.startsWith("."));
  const hiddenCount = directories.length - visible.length;

  return (
    <div className="wb-modal-scrim">
      <div className="wb-modal wb-gate-modal wb-new-party-modal" role="dialog" aria-modal="true">
        <header className="wb-modal-head">
          <div className="wb-modal-title">
            <Terminal size={16} />
            <strong><LocalizedText id="STR-3348" /></strong>
            <span className="wb-cwd-distro">{distro}</span>
          </div>
          <button type="button" className="wb-icon-btn" title={localized("STR-3349")} onClick={onCancel}><X size={16} /></button>
        </header>

        <div className="wb-modal-body wb-gate-modal-body">
          <div className="wb-cwd-crumbs">
            <span className="wb-mono wb-cwd-crumb-path">{cwd || "…"}</span>
            <button
              type="button"
              className="wb-cwd-browse"
              disabled={loading || !listing?.home || cwd === listing?.home}
              onClick={() => { void load(listing?.home); }}
            >
              <House size={13} />
              <LocalizedText id="STR-3350" />
            </button>
            <button
              type="button"
              className="wb-cwd-browse"
              disabled={loading || !listing?.parent}
              onClick={() => { void load(listing?.parent); }}
            >
              <CornerLeftUp size={13} />
              <LocalizedText id="STR-3351" />
            </button>
            <button type="button" className="wb-cwd-browse" disabled={loading} onClick={() => { void load(cwd); }}>
              <RefreshCw size={13} />
              <LocalizedText id="STR-3352" />
            </button>
          </div>

          {failure && (
            <p className="wb-cwd-browser-error">
              <TriangleAlert size={13} />
              {failure}
            </p>
          )}

          <div className="wb-cwd-list wb-cwd-browser-list">
            {visible.map((name) => (
              <button
                type="button"
                key={name}
                className="wb-cwd-item"
                onClick={() => { void load(joinPosix(cwd, name)); }}
              >
                <Folder size={13} />
                <span className="wb-mono wb-cwd-item-path">{name}</span>
              </button>
            ))}
            {!loading && !visible.length && (
              <div className="wb-cwd-browser-empty">
                {localized(directories.length ? "STR-3353" : "STR-3354")}
              </div>
            )}
            {loading && <div className="wb-cwd-browser-empty"><LocalizedText id="STR-3355" /></div>}
          </div>

          <label className="wb-cwd-save">
            <input
              type="checkbox"
              className="wb-switch"
              checked={showHidden}
              onChange={(event) => setShowHidden(event.target.checked)}
            />
            <span><LocalizedText id="STR-3357" />{hiddenCount > 0 ? ` (${hiddenCount}개)` : ""}</span>
          </label>

          <p className="wb-wizard-hint"><LocalizedText id="STR-3358" /></p>
        </div>

        <footer className="wb-modal-foot">
          <span className="wb-flex-spacer" />
          <div className="wb-modal-actions">
            <button type="button" className="wb-btn wb-btn-ghost" onClick={onCancel}><LocalizedText id="STR-3359" /></button>
            <button
              type="button"
              className="wb-btn wb-btn-accent"
              disabled={!cwd}
              onClick={() => { if (cwd) onSelect(cwd); }}
            >
              <LocalizedText id="STR-3360" />
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

/** POSIX join that keeps `/foo` out of `//foo` at the root. */
function joinPosix(cwd: string | undefined, name: string): string {
  const base = cwd && cwd !== "/" ? cwd.replace(/\/+$/, "") : "";
  return `${base}/${name}`;
}
