import { PointerEvent, useEffect, useMemo, useState } from "react";
import { AlignLeft, ChevronDown, SquareSplitHorizontal, X } from "lucide-react";
import type { MemberView, PanelDensity, PanelState } from "./types";
import { memberColorVars } from "../theme/memberColors";
import { harnessLabel } from "./harnessLabel";
import { HarnessIcon } from "./HarnessIcon";
import { splitTabs } from "./tabOverflow";

interface TabStripProps {
  panel: PanelState;
  views: Map<string, MemberView>;
  density: PanelDensity;
  /** The panel's measured width; what the strip budgets tabs against. */
  width: number;
  draggingMember: string | null;
  onSelect: (member: string) => void;
  onClose: (member: string) => void;
  /** Bring a hidden tab to the front and activate it. */
  onPromote: (member: string) => void;
  onSplit: () => void;
  onTabPointerDown: (member: string, event: PointerEvent) => void;
}

/**
 * The live markers a member carries. Shared by the tab and the overflow row so
 * a member folded into `+N` still reports the same state — and so the width
 * estimator in `tabOverflow.ts` only has one rendering to model. Approval and
 * unread are mutually exclusive: an approval is the more urgent of the two and
 * saying both at once just makes the tab wider.
 */
function TabMarkers({ view }: { view: MemberView }) {
  const queued = view.member.queue?.items.length || 0;
  return (
    <>
      {view.pendingApproval && <span className="wb-tab-badge">승인</span>}
      {!view.pendingApproval && view.unread > 0 && <span className="wb-tab-unread">{view.unread}</span>}
      {/* A hidden member's queue is otherwise completely invisible: the panel
          that would show it sits behind another tab. Dashed, like every
          "not delivered yet" mark in the queue UI. */}
      {queued > 0 && (
        <span className="wb-tab-queue" title={`대기열 ${queued}건 — 응답 완료 후 순서대로 전송`}>
          <AlignLeft size={8} />{queued}
        </span>
      )}
    </>
  );
}

export function TabStrip({ panel, views, density, width, draggingMember, onSelect, onClose, onPromote, onSplit, onTabPointerDown }: TabStripProps) {
  const [overflowOpen, setOverflowOpen] = useState(false);
  const { visible, hidden } = useMemo(
    () => splitTabs(panel.tabs, panel.active, width, views, density),
    [panel.tabs, panel.active, width, views, density],
  );

  // Widening the panel (or closing a tab) can empty the overflow while its list
  // is open — leaving a popover anchored to a chip that no longer exists.
  useEffect(() => {
    if (hidden.length === 0) {
      setOverflowOpen(false);
    }
  }, [hidden.length]);

  const alertMember = hidden.find((name) => views.get(name)?.pendingApproval)
    || hidden.find((name) => (views.get(name)?.unread || 0) > 0);

  return (
    <div className="wb-tabstrip" data-drop-tabstrip={panel.id}>
      <div className="wb-tabs">
        {visible.map((member) => {
          const view = views.get(member);
          if (!view) {
            return null;
          }
          const active = member === panel.active;
          return (
            <div
              key={member}
              data-drop-tab={member}
              className={
                "wb-tab" +
                (active ? " is-active" : "") +
                (view.busy ? " is-working" : "") +
                (draggingMember === member ? " is-dragging" : "")
              }
              style={memberColorVars(member)}
              onPointerDown={(event) => onTabPointerDown(member, event)}
              onClick={() => onSelect(member)}
              title={`${member} · ${harnessLabel(view.member.runtime)}`}
            >
              <span className="wb-tab-accent" />
              <span className={"wb-dot" + (view.busy ? " is-working" : "")} />
              <span className="wb-tab-name">{member}</span>
              {/* Which harness this tab's member runs on — the model alone does
                  not identify a member, since the same model behaves differently
                  per harness. Full name is in the tab tooltip above. */}
              {density !== "narrow" && (
                <span className="wb-harness-chip" aria-label={harnessLabel(view.member.runtime)}>
                  <HarnessIcon harness={view.member.runtime} />
                </span>
              )}
              <TabMarkers view={view} />
              <button
                type="button"
                className="wb-tab-close"
                title="Close tab"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  onClose(member);
                }}
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
      </div>

      {hidden.length > 0 && (
        <div className="wb-tab-overflow-wrap">
          <button
            type="button"
            className={"wb-tab-overflow" + (overflowOpen ? " is-open" : "")}
            title={`탭 ${hidden.length}개 더 보기`}
            onClick={() => setOverflowOpen((open) => !open)}
          >
            <span className="wb-tab-overflow-n">+{hidden.length}</span>
            {/* A folded-away member waiting on an approval would otherwise be
                silent. The dot carries its colour so the count says WHO. */}
            {alertMember && (
              <span className="wb-tab-overflow-alert" style={{ background: views.get(alertMember)?.color }} />
            )}
            <ChevronDown size={10} className="wb-tab-overflow-caret" />
          </button>
          {overflowOpen && (
            <>
              <div className="wb-menu-catcher" onClick={() => setOverflowOpen(false)} />
              <div className="wb-tab-overflow-menu" role="menu">
                <div className="wb-tab-overflow-head">
                  <AlignLeft size={11} /> 숨겨진 탭 {hidden.length}
                </div>
                {hidden.map((member) => {
                  const view = views.get(member);
                  if (!view) {
                    return null;
                  }
                  return (
                    <div
                      key={member}
                      className="wb-tab-overflow-item"
                      style={memberColorVars(member)}
                      role="menuitem"
                      onClick={() => { setOverflowOpen(false); onPromote(member); }}
                    >
                      <span className={"wb-dot" + (view.busy ? " is-working" : "")} />
                      <span className="wb-tab-overflow-name">{member}</span>
                      <TabMarkers view={view} />
                      <button
                        type="button"
                        className="wb-tab-close"
                        title="Close tab"
                        onClick={(event) => {
                          event.stopPropagation();
                          onClose(member);
                        }}
                      >
                        <X size={12} />
                      </button>
                    </div>
                  );
                })}
                <div className="wb-tab-overflow-foot">선택한 탭은 맨 앞으로 이동합니다</div>
              </div>
            </>
          )}
        </div>
      )}

      <div className="wb-tab-actions">
        {/* No "add tab" button: members are opened from the party sidebar, which
            is the list that knows which ones exist. */}
        <button type="button" className="wb-icon-btn" title="Split into new panel" onClick={onSplit}><SquareSplitHorizontal size={15} /></button>
      </div>
    </div>
  );
}
