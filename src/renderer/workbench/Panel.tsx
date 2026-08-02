import { PointerEvent, useEffect, useState } from "react";
import { ChevronDown, CircleStop, Gauge, MoreHorizontal, Plug, RefreshCw } from "lucide-react";
import type { MemberView, PanelState } from "./types";
import type { WorkbenchActions } from "./actions";
import { memberColorVars } from "../theme/memberColors";
import { latestDiagnostic, statusLabel } from "./memberStatus";
import { Dropdown } from "./Dropdown";
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
  onOpenCompact: (member: string) => void;
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
  const { panel, views, focused, draggingMember, dropTarget, canAdd, actions, onFocus, onSelectTab, onCloseTab, onAdd, onSplit, onOpenRuntime, onOpenMcp, onOpenCompact, onOpenGate, onTabPointerDown, openSubId, subDockCollapsed, onToggleSubDock, onOpenSub, onCloseSub } = props;
  const { ref, density } = useDensity<HTMLDivElement>();
  const view = views.get(panel.active);
  // The header's ⋯ overflow menu (session restart / MCP). Local to this panel.
  const [menuOpen, setMenuOpen] = useState(false);

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

  const wide = density === "wide";
  const narrow = density === "narrow";

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

      {view && (
        // The panel header is present at EVERY width (it no longer disappears
        // when narrow). Density only trims what's inside: the status pill + K/K
        // range are wide-only, and effort is hidden when narrow — but the ⋯
        // button is always visible.
        <div className="wb-toolbar">
          <div className="wb-toolbar-id">
            <span className={"wb-dot" + (view.busy ? " is-working" : "")} />
            <strong>{view.name}</strong>
            {/* A running turn shows motion instead of the word "working"; every
                other state is a stable fact and stays a label. */}
            {wide && (
              <span className={"wb-status-pill is-" + view.status}>
                {view.status === "working" ? <WorkingDots label="작업 중" /> : statusLabel(view.status)}
              </span>
            )}
            {wide && (() => {
              const diag = latestDiagnostic(view.transcript);
              return diag ? <span className={"wb-diag-badge is-" + diag.severity} title={diag.title}>{diag.category}</span> : null;
            })()}
          </div>
          <div className="wb-toolbar-controls">
            {/* Stop lives HERE, not in the composer's Send slot. While a member
                works, that slot is how you add to its queue — if Stop took it
                over (as it used to) there would be no way to queue a message
                from the UI at all, which is the entire feature. */}
            {view.busy && (
              <button type="button" className="wb-pill wb-stop-pill" title="Stop" onClick={() => actions.interrupt(view.name)}>
                <CircleStop size={12} /> Stop
              </button>
            )}
            <button
              type="button"
              className="wb-pill wb-model-pill"
              style={{ maxWidth: narrow ? 116 : 240 }}
              title="모델 설정"
              onClick={() => onOpenRuntime(view.name)}
            >
              <span className="wb-mono">{modelLabel(view.model)}</span>
              <ChevronDown size={11} className="wb-pill-caret" />
            </button>
            {!narrow && (view.effortOptions?.length ?? 0) > 0 && (
              <Dropdown
                value={view.effort}
                options={view.effortOptions.map((option) => ({ id: option.id, label: option.label, icon: <Gauge size={13} /> }))}
                onChange={(id) => actions.setEffort(view.name, id)}
                title="Effort"
              />
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
              <button type="button" className="wb-header-more" title="더보기" onClick={() => setMenuOpen((open) => !open)}>
                <MoreHorizontal size={15} />
              </button>
              {menuOpen && (
                <>
                  <div className="wb-menu-catcher" onClick={() => setMenuOpen(false)} />
                  <div className="wb-header-menu" role="menu">
                    <button
                      type="button"
                      className="wb-menu-item"
                      title="세션을 다시 시작합니다(대화 유지 · MCP/설정 적용)"
                      onClick={() => { setMenuOpen(false); actions.respawn(view.name); }}
                    >
                      <RefreshCw size={14} /> 세션 재시작
                    </button>
                    <button
                      type="button"
                      className="wb-menu-item"
                      title="이 멤버가 보내는 메시지를 전달 전에 심사합니다"
                      onClick={() => { setMenuOpen(false); onOpenGate(view.name); }}
                    >
                      <MessageGateIcon size={14} className="wb-gate-accent" /> Message Gate 설정
                    </button>
                    <button
                      type="button"
                      className="wb-menu-item"
                      disabled={!view.session}
                      onClick={() => { setMenuOpen(false); onOpenMcp(view.name); }}
                    >
                      <Plug size={14} /> MCP 서버
                    </button>
                  </div>
                </>
              )}
            </div>
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

/** Model button label: strip a leading `claude-` (e.g. `sonnet-4.5`). */
function modelLabel(model: string | undefined): string {
  return (model || "model").replace(/^claude-/, "");
}
