import { PointerEvent, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronUp, MoreHorizontal, Plug, RefreshCw, SplitSquareHorizontal, SplitSquareVertical, SquareTerminal } from "lucide-react";
import type { MemberView, PanelState } from "./types";
import type { WorkbenchActions } from "./actions";
import { memberColorVars } from "../theme/memberColors";
import { latestDiagnostic, statusLabel } from "./memberStatus";
import { useDensity } from "./useDensity";
import { TabStrip } from "./TabStrip";
import { Transcript } from "./Transcript";
import { Composer } from "./Composer";
import { SubagentDock } from "./SubagentDock";
import { MessageGateIcon } from "./MessageGateIcon";
import { SubagentDetail } from "./SubagentDetail";
import { ContextDonut } from "./ContextDonut";
import { WorkingDots } from "./StatusIndicator";
import { ENV_LABEL, EnvIcon } from "./CwdPicker";
import { memberLocationOf, splitPathTail } from "./memberGroups";
import { buildSubDetail, buildSubDock } from "./subagentModel";
import { workbenchPopupOpen } from "./workbenchPopups";
import { useModalEscape } from "./useModalEscape";
import { CliContinuationModal } from "./CliContinuationModal";
import { LocalizedText, localized } from "../i18n/I18nProvider";
import type { GridSide } from "../../shared/workbenchGrid";

interface PanelProps {
  panel: PanelState;
  views: Map<string, MemberView>;
  focused: boolean;
  draggingMember: string | null;
  dropTarget: boolean;
  /**
   * The edge a drop would split this panel along, drawn as the slot the new
   * panel would take. Null when the drop would join this panel instead.
   */
  dropSide: GridSide | null;
  /** Where a drop would insert the dragged tab, for the strip's marker. */
  dropAt: { tab: string; after: boolean } | null;
  actions: WorkbenchActions;
  onFocus: () => void;
  onSelectTab: (member: string) => void;
  onCloseTab: (member: string) => void;
  /**
   * Splits this panel, seeding the new slot with the member on show. The only
   * way to split a panel holding a SINGLE tab: dragging that tab to an edge
   * would just move the panel it is already alone in.
   */
  onSplit: (side: GridSide) => void;
  /**
   * The panel's folded bars. Collapsing the toolbar gives the transcript the
   * header row back; collapsing the composer turns the panel into a reading
   * view — useful once a grid puts four of them on one screen.
   */
  chrome: { toolbar: boolean; composer: boolean };
  onToggleChrome: (which: "toolbar" | "composer") => void;
  /** Move a tab to the front of this panel and activate it (overflow list). */
  onPromoteTab: (member: string) => void;
  onOpenRuntime: (member: string) => void;
  onOpenPermissions: (member: string) => void;
  onOpenMcp: (member: string) => void;
  onOpenStatus: (member: string) => void;
  onOpenCompact: (member: string) => void;
  onOpenUsage: () => void;
  onOpenGate: (member: string) => void;
  onTabPointerDown: (member: string, event: PointerEvent) => void;
  /** Subagent dock/detail UI state for this panel's active member. */
  openSubId?: string;
  subDockCollapsed?: boolean;
  onToggleSubDock: () => void;
  onOpenSub: (id: string) => void;
  onCloseSub: () => void;
}

export function Panel(props: PanelProps) {
  const { panel, views, focused, draggingMember, dropTarget, dropSide, dropAt, actions, onFocus, onSelectTab, onCloseTab, onSplit, chrome, onToggleChrome, onPromoteTab, onOpenRuntime, onOpenPermissions, onOpenMcp, onOpenStatus, onOpenCompact, onOpenUsage, onOpenGate, onTabPointerDown, openSubId, subDockCollapsed, onToggleSubDock, onOpenSub, onCloseSub } = props;
  const { ref, density, width } = useDensity<HTMLDivElement>();
  const view = views.get(panel.active);
  const cliOwned = view?.status === "external-cli";
  // The header's ⋯ overflow menu (session restart / MCP). Local to this panel.
  const [menuOpen, setMenuOpen] = useState(false);
  // `.wb-header-menu` is in POPUP_SELECTORS, so while it is open the turn-interrupt
  // below stands down. Something has to take the key, or Escape does nothing at all.
  useModalEscape(() => setMenuOpen(false), menuOpen);
  const [cliContinuationOpen, setCliContinuationOpen] = useState(false);

  // Subagent dock + drill-in detail, derived from the active member's subagents.
  const subagents = view?.subagents || [];
  const dock = subagents.length ? buildSubDock(subagents, view!.color, density, openSubId, Boolean(subDockCollapsed)) : null;
  const openSub = openSubId ? subagents.find((sub) => sub.id === openSubId) : undefined;
  const detail = buildSubDetail(openSub, view?.color || "");

  // Prewarm the visible member's session (init only, no turn) so its composer
  // palette can show the harness's real command/skill inventory before the
  // first message. Run on member activation / session loss / panel remount.
  // Deliberately exclude the `actions` object: App rebuilds it as state changes;
  // including it retried a failed prewarm on every render instead of only on a
  // meaningful panel lifecycle transition.
  const activeName = view?.name;
  const hasSession = Boolean(view?.session);
  // One object identity per (member, handlers) — the composer is memoized and an
  // inline literal here would re-render every open composer on every commit.
  const commandUi = useMemo(() => ({
    openRuntime: () => activeName && onOpenRuntime(activeName),
    openPermissions: () => activeName && onOpenPermissions(activeName),
    openMcp: () => activeName && onOpenMcp(activeName),
    openStatus: () => activeName && onOpenStatus(activeName),
    openUsage: onOpenUsage,
    openAutoCompact: () => activeName && onOpenCompact(activeName),
  }), [activeName, onOpenRuntime, onOpenPermissions, onOpenMcp, onOpenStatus, onOpenUsage, onOpenCompact]);
  useEffect(() => {
    if (activeName && !hasSession) {
      actions.prewarm(activeName);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeName, hasSession]);

  // R-12 / R-13: Escape stops the focused panel's in-flight turn, but only when
  // no Escape-owning popup is open — those close first on the same key.
  // Deliberately exclude the actions object (same reason as prewarm above).
  const turnStoppable = Boolean(view && (view.busy || view.status === "stalled"));
  useEffect(() => {
    if (!focused || !activeName || !turnStoppable) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      if (event.defaultPrevented) {
        return;
      }
      if (workbenchPopupOpen(document)) {
        return;
      }
      event.preventDefault();
      actions.interrupt(activeName);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused, activeName, turnStoppable]);

  const wide = density === "wide";
  const narrow = density === "narrow";

  // Where this member RUNS. Read from the member record on every render, so a
  // member that arrives before its location was backfilled — or one whose party
  // was just reloaded — picks the real path up as soon as it is known instead of
  // caching the gap.
  const location = view ? memberLocationOf(view) : undefined;
  const cwdParts = splitPathTail(location?.cwd || "");
  const locationTitle = location
    ? (location.distro ? `${ENV_LABEL[location.env]} · ${location.distro}: ${location.cwd}` : `${ENV_LABEL[location.env]}: ${location.cwd}`)
    : "";

  return (
    <div
      ref={ref}
      data-panel-id={panel.id}
      className={"wb-panel density-" + density + (focused ? " is-focused" : "") + (cliOwned ? " is-external-cli" : "")}
      style={{ ...(view ? memberColorVars(view.name) : {}), flexGrow: panel.weight, flexBasis: 0 }}
      onMouseDownCapture={onFocus}
    >
      <span className="wb-panel-bar" />
      <TabStrip
        panel={panel}
        views={views}
        density={density}
        width={width}
        draggingMember={draggingMember}
        dropAt={dropAt}
        onSelect={onSelectTab}
        onClose={onCloseTab}
        onPromote={onPromoteTab}
        onTabPointerDown={onTabPointerDown}
        chrome={chrome}
        onToggleChrome={onToggleChrome}
      />

      {view && !chrome.toolbar && (
        // The panel header is present at EVERY width (it no longer disappears
        // when narrow, as the design had it). Density only trims what's inside:
        // the status pill, the diagnostic badge, the K/K range and the effort
        // pill are wide-only — but the model pill and the ⋯ button are always
        // visible, so no control becomes unreachable by making a panel narrow.
        <div className="wb-toolbar">
          <div className="wb-toolbar-id">
            {/* Status leads the row. It is the one thing here that changes on its
                own, and reading it should not mean scanning past the location
                first. A running turn shows motion instead of the word "working";
                every other state is a stable fact and stays a label. Below wide
                the label is dropped, never the chip: the tone and the pulse
                still carry the state, and the tooltip spells it out. */}
            <span className={"wb-status-pill is-" + view.status} title={statusLabel(view.status)}>
              {view.status === "working"
                ? <WorkingDots label={localized("STR-1963")} />
                : wide ? statusLabel(view.status) : <span className="wb-dot" />}
            </span>
            {/* The member's NAME used to sit here, repeating the tab directly
                above it. Its cwd does not appear anywhere else in the panel, and
                it is what decides which files this member is actually editing —
                so the duplicated name gives the slot to the location. */}
            {location && (
              <span className="wb-toolbar-cwd" title={locationTitle} aria-label={locationTitle}>
                <EnvIcon env={location.env} size={12} />
                <span className="wb-toolbar-cwd-path">
                  {/* Ancestors absorb the ellipsis; the directory name is what
                      tells two checkouts apart and must survive a narrow panel. */}
                  <span className="wb-cwd-head">{cwdParts.head}</span>
                  <span className="wb-cwd-tail">{cwdParts.tail}</span>
                </span>
              </span>
            )}
            {wide && (() => {
              const diag = latestDiagnostic(view.transcript);
              return diag ? <span className={"wb-diag-badge is-" + diag.severity} title={diag.title}>{diag.category}</span> : null;
            })()}
          </div>
          <div className="wb-toolbar-controls">
            {/* Stop moved to the composer, BESIDE the send control — where the
                hand already is while typing. It is a separate button there, not
                the send slot itself: that slot is how you add to the queue while
                a member works, and taking it over left no way to queue at all. */}
            <button
              type="button"
              className="wb-pill wb-model-pill"
              style={{ maxWidth: narrow ? 116 : 240 }}
              title={localized("STR-1964")}
              onClick={() => onOpenRuntime(view.name)}
            >
              <span className="wb-mono">{modelLabel(view.model)}</span>
              <ChevronDown size={11} className="wb-pill-caret" />
            </button>
            {/* Effort sits beside the model because it only means anything
                against that model — and only when the model HAS levels, so a
                model without them shows nothing instead of an empty pill.
                Wide only: at mid the design trades it for the overflow menu.
                Editing happens in Runtime, which the model pill opens too. */}
            {wide && view.effortOptions.length > 0 && (
              <button
                type="button"
                className="wb-pill"
                title={localized("STR-1965")}
                onClick={() => onOpenRuntime(view.name)}
              >
                <span className="wb-mono">
                  {view.effortOptions.find((option) => option.id === view.effort)?.label || view.effort}
                </span>
                {/* Same caret as the model pill beside it: both open Runtime, so
                    without it this one reads as a label rather than a control. */}
                <ChevronDown size={11} className="wb-pill-caret" />
              </button>
            )}
            {view.context && (
              <ContextDonut
                context={view.context}
                autoCompact={view.autoCompact}
                color={view.color}
                showRange={wide}
                onClick={() => onOpenCompact(view.name)}
              />
            )}
            <div className="wb-header-menu-wrap">
              <button type="button" className="wb-header-more" title={localized("STR-1966")} onClick={() => setMenuOpen((open) => !open)}>
                <MoreHorizontal size={15} />
              </button>
              {menuOpen && (
                <>
                  <div className="wb-menu-catcher" onClick={() => setMenuOpen(false)} />
                  <div className="wb-header-menu" role="menu">
                    <button
                      type="button"
                      className="wb-menu-item"
                      title={localized("STR-1967")}
                      onClick={() => { setMenuOpen(false); actions.respawn(view.name); }}
                    >
                      <RefreshCw size={14} />  <LocalizedText id="STR-1968" />
                    </button>
                    <button
                      type="button"
                      className="wb-menu-item"
                      title={localized("STR-1969")}
                      onClick={() => { setMenuOpen(false); onOpenGate(view.name); }}
                    >
                      <MessageGateIcon size={14} className="wb-gate-accent" />  <LocalizedText id="STR-1970" />
                    </button>
                    <button
                      type="button"
                      className="wb-menu-item"
                      disabled={!view.session}
                      onClick={() => { setMenuOpen(false); onOpenMcp(view.name); }}
                    >
                      <Plug size={14} />  <LocalizedText id="STR-1971" />
                    </button>
                    <button
                      type="button"
                      className="wb-menu-item"
                      onClick={() => { setMenuOpen(false); setCliContinuationOpen(true); }}
                    >
                      <SquareTerminal size={14} />  <LocalizedText id="STR-1972" />
                    </button>
                    {/* Splitting is a layout action, not a member one, but it
                        lives here because this menu is the only per-panel one
                        the header has — and a split always starts from "this
                        panel, on that side". */}
                    <button
                      type="button"
                      className="wb-menu-item"
                      onClick={() => { setMenuOpen(false); onSplit("right"); }}
                    >
                      <SplitSquareHorizontal size={14} />  <LocalizedText id="STR-3821" />
                    </button>
                    <button
                      type="button"
                      className="wb-menu-item"
                      onClick={() => { setMenuOpen(false); onSplit("bottom"); }}
                    >
                      <SplitSquareVertical size={14} />  <LocalizedText id="STR-3822" />
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {dock && <SubagentDock view={dock} onToggle={onToggleSubDock} onOpen={onOpenSub} />}

      {view && cliOwned ? (
        <div className="wb-external-cli-state" role="status">
          <SquareTerminal size={28} />
          <strong><LocalizedText id="STR-1973" /></strong>
          <span><LocalizedText id="STR-1974" /></span>
          <small><LocalizedText id="STR-1975" /></small>
        </div>
      ) : view ? (
        <>
          <Transcript
            key={`${view.member.partyId || "default"}:${view.name}:${view.member.createdAt || ""}`}
            view={view}
            density={density}
            actions={actions}
          />
          {/* The composer folds from its OWN top-right corner, and unfolds from
              the stub that takes its place — the control stays with the thing it
              hides instead of being parked in the tab strip.

              Folding unmounts it rather than hiding it: the composer writes its
              draft to storage on every change and restores it on mount, so
              nothing typed is lost, and a folded panel stops paying for an
              editor it is not showing. */}
          {chrome.composer ? (
            <div className="wb-composer-stub">
              <button
                type="button"
                className="wb-composer-handle is-folded"
                title={localized("STR-3826")}
                aria-pressed
                onClick={() => onToggleChrome("composer")}
              >
                <ChevronUp size={14} />
                <span className="wb-composer-handle-label"><LocalizedText id="STR-3827" /></span>
              </button>
            </div>
          ) : (
            <div className="wb-composer-slot">
              {/* A pull on the composer's own top edge, right-aligned: it reads
                  as the handle of the thing it folds, and it takes no height
                  from the panel — the point of folding in the first place. */}
              <button
                type="button"
                className="wb-composer-handle"
                title={localized("STR-3825")}
                aria-pressed={false}
                onClick={() => onToggleChrome("composer")}
              >
                <ChevronDown size={14} />
              </button>
              <Composer
                key={`composer:${view.member.partyId || "default"}:${view.name}:${view.member.createdAt || ""}`}
                view={view}
                density={density}
                actions={actions}
                commandUi={commandUi}
              />
            </div>
          )}
        </>
      ) : (
        <div className="wb-panel-empty"><LocalizedText id="STR-1976" /></div>
      )}

      {detail && view && (
        <SubagentDetail detail={detail} parentName={view.name} parentColor={view.color} density={density} onBack={onCloseSub} />
      )}

      {cliContinuationOpen && view && (
        <CliContinuationModal member={view.name} color={view.color} onClose={() => setCliContinuationOpen(false)} />
      )}

      {dropTarget && (
        <div className="wb-drop-overlay">
          <span><LocalizedText id="STR-1977" /></span>
        </div>
      )}

      {dropSide && <div className={"wb-drop-side is-" + dropSide} />}
    </div>
  );
}

/** Model button label: strip a leading `claude-` (e.g. `sonnet-4.5`). */
function modelLabel(model: string | undefined): string {
  return (model || "model").replace(/^claude-/, "");
}
