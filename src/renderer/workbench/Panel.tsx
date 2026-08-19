import { PointerEvent, useEffect, useState } from "react";
import { ChevronDown, MoreHorizontal, Plug, RefreshCw, SquareTerminal } from "lucide-react";
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
import { buildSubDetail, buildSubDock } from "./subagentModel";
import { workbenchPopupOpen } from "./workbenchPopups";
import { CliContinuationModal } from "./CliContinuationModal";
import { LocalizedText, localized } from "../i18n/I18nProvider";

interface PanelProps {
  panel: PanelState;
  views: Map<string, MemberView>;
  focused: boolean;
  draggingMember: string | null;
  dropTarget: boolean;
  /** Where a drop would insert the dragged tab, for the strip's marker. */
  dropAt: { tab: string; after: boolean } | null;
  actions: WorkbenchActions;
  onFocus: () => void;
  onSelectTab: (member: string) => void;
  onCloseTab: (member: string) => void;
  /** Move a tab to the front of this panel and activate it (overflow list). */
  onPromoteTab: (member: string) => void;
  onOpenRuntime: (member: string) => void;
  onOpenPermissions: (member: string) => void;
  onOpenMcp: (member: string) => void;
  onOpenStatus: (member: string) => void;
  onOpenCompact: (member: string) => void;
  onOpenUsage: () => void;
  onOpenSessions: () => void;
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
  const { panel, views, focused, draggingMember, dropTarget, dropAt, actions, onFocus, onSelectTab, onCloseTab, onPromoteTab, onOpenRuntime, onOpenPermissions, onOpenMcp, onOpenStatus, onOpenCompact, onOpenUsage, onOpenSessions, onOpenGate, onTabPointerDown, openSubId, subDockCollapsed, onToggleSubDock, onOpenSub, onCloseSub } = props;
  const { ref, density, width } = useDensity<HTMLDivElement>();
  const view = views.get(panel.active);
  const cliOwned = view?.status === "external-cli";
  // The header's ⋯ overflow menu (session restart / MCP). Local to this panel.
  const [menuOpen, setMenuOpen] = useState(false);
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
      />

      {view && (
        // The panel header is present at EVERY width (it no longer disappears
        // when narrow, as the design had it). Density only trims what's inside:
        // the status pill, the diagnostic badge, the K/K range and the effort
        // pill are wide-only — but the model pill and the ⋯ button are always
        // visible, so no control becomes unreachable by making a panel narrow.
        <div className="wb-toolbar">
          <div className="wb-toolbar-id">
            <span className={"wb-dot" + (view.busy ? " is-working" : "")} />
            <strong>{view.name}</strong>
            {/* A running turn shows motion instead of the word "working"; every
                other state is a stable fact and stays a label. */}
            {wide && (
              <span className={"wb-status-pill is-" + view.status}>
                {view.status === "working" ? <WorkingDots label={localized("STR-1963")} /> : statusLabel(view.status)}
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
          <Composer
            view={view}
            density={density}
            actions={actions}
            commandUi={{
              openRuntime: () => onOpenRuntime(view.name),
              openPermissions: () => onOpenPermissions(view.name),
              openMcp: () => onOpenMcp(view.name),
              openStatus: () => onOpenStatus(view.name),
              openUsage: onOpenUsage,
              openSessions: onOpenSessions,
              openAutoCompact: () => onOpenCompact(view.name),
            }}
          />
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
    </div>
  );
}

/** Model button label: strip a leading `claude-` (e.g. `sonnet-4.5`). */
function modelLabel(model: string | undefined): string {
  return (model || "model").replace(/^claude-/, "");
}
