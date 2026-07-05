import { PointerEvent, useEffect } from "react";
import { ChevronDown, ChevronsDownUp, Plug, RotateCcw, Square } from "lucide-react";
import type { MemberView, PanelState } from "./types";
import type { WorkbenchActions } from "./actions";
import { memberColorVars } from "../theme/memberColors";
import { latestDiagnostic, statusLabel } from "./memberStatus";
import { useDensity } from "./useDensity";
import { TabStrip } from "./TabStrip";
import { Transcript } from "./Transcript";
import { Composer } from "./Composer";
import { SubagentDock } from "./SubagentDock";
import { SubagentDetail } from "./SubagentDetail";
import { buildSubDetail, buildSubDock } from "./subagentModel";

interface PanelProps {
  panel: PanelState;
  views: Map<string, MemberView>;
  focused: boolean;
  draggingMember: string | null;
  dropTarget: boolean;
  canAdd: boolean;
  actions: WorkbenchActions;
  onFocus: () => void;
  onSelectTab: (member: string) => void;
  onCloseTab: (member: string) => void;
  onAdd: () => void;
  onSplit: () => void;
  onOpenRuntime: (member: string) => void;
  onOpenMcp: (member: string) => void;
  onTabPointerDown: (member: string, event: PointerEvent) => void;
  /** Subagent dock/detail UI state for this panel's active member. */
  openSubId?: string;
  subDockCollapsed?: boolean;
  onToggleSubDock: () => void;
  onOpenSub: (id: string) => void;
  onCloseSub: () => void;
}

export function Panel(props: PanelProps) {
  const { panel, views, focused, draggingMember, dropTarget, canAdd, actions, onFocus, onSelectTab, onCloseTab, onAdd, onSplit, onOpenRuntime, onOpenMcp, onTabPointerDown, openSubId, subDockCollapsed, onToggleSubDock, onOpenSub, onCloseSub } = props;
  const { ref, density } = useDensity<HTMLDivElement>();
  const view = views.get(panel.active);

  // Subagent dock + drill-in detail, derived from the active member's subagents.
  const subagents = view?.subagents || [];
  const dock = subagents.length ? buildSubDock(subagents, view!.color, density, openSubId, Boolean(subDockCollapsed)) : null;
  const openSub = openSubId ? subagents.find((sub) => sub.id === openSubId) : undefined;
  const detail = buildSubDetail(openSub, view?.color || "");

  // Prewarm the visible member's session (init only, no turn) so its composer
  // palette can show the harness's real command/skill inventory before the
  // first message. Idempotent + at-most-once is enforced in the action.
  const activeName = view?.name;
  const hasSession = Boolean(view?.session);
  useEffect(() => {
    if (activeName && !hasSession) {
      actions.prewarm(activeName);
    }
  }, [activeName, hasSession, actions]);

  return (
    <div
      ref={ref}
      data-panel-id={panel.id}
      className={"wb-panel density-" + density + (focused ? " is-focused" : "")}
      style={{ ...(view ? memberColorVars(view.name) : {}), flexGrow: panel.weight, flexBasis: 0 }}
      onMouseDownCapture={onFocus}
    >
      <span className="wb-panel-bar" />
      <TabStrip
        panel={panel}
        views={views}
        density={density}
        draggingMember={draggingMember}
        canAdd={canAdd}
        onSelect={onSelectTab}
        onClose={onCloseTab}
        onAdd={onAdd}
        onSplit={onSplit}
        onTabPointerDown={onTabPointerDown}
      />

      {view && density !== "narrow" && (
        <div className="wb-toolbar">
          <div className="wb-toolbar-id">
            <span className="wb-dot" />
            <strong>{view.name}</strong>
            <span className={"wb-status-pill is-" + view.status}>{statusLabel(view.status)}</span>
            {(() => {
              const diag = latestDiagnostic(view.transcript);
              return diag ? <span className={"wb-diag-badge is-" + diag.severity} title={diag.title}>{diag.category}</span> : null;
            })()}
          </div>
          <div className="wb-toolbar-controls">
            <button type="button" className="wb-pill wb-model-pill" title="Model settings" onClick={() => onOpenRuntime(view.name)}>
              <span className="wb-mono">{view.model || "model"}</span>
              <ChevronDown size={11} className="wb-pill-caret" />
            </button>
            <button type="button" className="wb-tool-btn" title="MCP 서버" onClick={() => onOpenMcp(view.name)} disabled={!view.session}><Plug size={14} /></button>
            {density === "wide" && (
              <>
                <span className="wb-toolbar-divider" />
                <button type="button" className="wb-tool-btn" title="Compact context" onClick={() => actions.compact(view.name)} disabled={!view.session}><ChevronsDownUp size={14} /></button>
                <button type="button" className="wb-tool-btn" title="Restart session" onClick={() => actions.restart(view.name)} disabled={!view.session}><RotateCcw size={14} /></button>
              </>
            )}
            <button
              type="button"
              className={"wb-tool-btn wb-stop" + (view.busy ? " is-danger" : "")}
              title={view.busy ? "Stop" : "Restart session"}
              onClick={() => (view.busy ? actions.interrupt(view.name) : actions.restart(view.name))}
              disabled={!view.session}
            >
              {view.busy ? <Square size={12} /> : <RotateCcw size={14} />}
            </button>
          </div>
        </div>
      )}

      {dock && <SubagentDock view={dock} onToggle={onToggleSubDock} onOpen={onOpenSub} />}

      {view ? (
        <>
          <Transcript view={view} density={density} actions={actions} />
          <Composer view={view} density={density} actions={actions} />
        </>
      ) : (
        <div className="wb-panel-empty">No member in this panel.</div>
      )}

      {detail && view && (
        <SubagentDetail detail={detail} parentName={view.name} parentColor={view.color} density={density} onBack={onCloseSub} />
      )}

      {dropTarget && (
        <div className="wb-drop-overlay">
          <span>여기에 놓기</span>
        </div>
      )}
    </div>
  );
}
