import { PointerEvent } from "react";
import { MoreHorizontal, Plus, SquareSplitHorizontal, X } from "lucide-react";
import type { MemberView, PanelDensity, PanelState } from "./types";
import { memberColorVars } from "../theme/memberColors";

interface TabStripProps {
  panel: PanelState;
  views: Map<string, MemberView>;
  density: PanelDensity;
  draggingMember: string | null;
  canAdd: boolean;
  onSelect: (member: string) => void;
  onClose: (member: string) => void;
  onAdd: () => void;
  onSplit: () => void;
  onTabPointerDown: (member: string, event: PointerEvent) => void;
}

export function TabStrip({ panel, views, density, draggingMember, canAdd, onSelect, onClose, onAdd, onSplit, onTabPointerDown }: TabStripProps) {
  return (
    <div className="wb-tabstrip" data-drop-tabstrip={panel.id}>
      <div className="wb-tabs">
        {panel.tabs.map((member) => {
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
              title={member}
            >
              <span className="wb-tab-accent" />
              <span className="wb-dot" />
              <span className="wb-tab-name">{member}</span>
              {view.pendingApproval && <span className="wb-tab-badge">승인</span>}
              {!view.pendingApproval && view.unread > 0 && <span className="wb-tab-unread">{view.unread}</span>}
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
      <div className="wb-tab-actions">
        <button type="button" className="wb-icon-btn" title="Add member tab" onClick={onAdd} disabled={!canAdd}><Plus size={15} /></button>
        {density === "narrow" && <button type="button" className="wb-icon-btn" title="More"><MoreHorizontal size={15} /></button>}
        <button type="button" className="wb-icon-btn" title="Split into new panel" onClick={onSplit}><SquareSplitHorizontal size={15} /></button>
      </div>
    </div>
  );
}
