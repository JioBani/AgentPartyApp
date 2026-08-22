import { PointerEvent, useEffect, useMemo, useState } from "react";
import { AlignLeft, ChevronDown, X } from "lucide-react";
import type { MemberView, PanelDensity, PanelState } from "./types";
import { memberColorVars } from "../theme/memberColors";
import { harnessLabel } from "./harnessLabel";
import { ProviderIcon } from "./ProviderIcon";
import { providerLabel } from "./modelProvider";
import { splitTabs } from "./tabOverflow";
import { LocalizedText, localized } from "../i18n/I18nProvider";

interface TabStripProps {
  panel: PanelState;
  views: Map<string, MemberView>;
  density: PanelDensity;
  /** The panel's measured width; what the strip budgets tabs against. */
  width: number;
  draggingMember: string | null;
  /** The tab a drop would land on, and on which side — drawn as the marker line. */
  dropAt: { tab: string; after: boolean } | null;
  onSelect: (member: string) => void;
  onClose: (member: string) => void;
  /** Bring a hidden tab to the front and activate it. */
  onPromote: (member: string) => void;
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
      {view.pendingApproval && <span className="wb-tab-badge"><LocalizedText id="STR-2143" /></span>}
      {!view.pendingApproval && view.unread > 0 && <span className="wb-tab-unread">{view.unread}</span>}
      {/* A hidden member's queue is otherwise completely invisible: the panel
          that would show it sits behind another tab. Dashed, like every
          "not delivered yet" mark in the queue UI. */}
      {queued > 0 && (
        <span className="wb-tab-queue" title={localized("STR-2144", [queued])}>
          <AlignLeft size={8} />{queued}
        </span>
      )}
    </>
  );
}

export function TabStrip({ panel, views, density, width, draggingMember, dropAt, onSelect, onClose, onPromote, onTabPointerDown }: TabStripProps) {
  const [overflowOpen, setOverflowOpen] = useState(false);
  const { visible, hidden } = useMemo(
    () => splitTabs(panel.tabs, panel.active, width),
    [panel.tabs, panel.active, width],
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
    <div className={"wb-tabstrip" + (hidden.length > 0 ? " has-overflow" : "")} data-drop-tabstrip={panel.id}>
      <div className="wb-tabs">
        {visible.map((member) => {
          const view = views.get(member);
          if (!view) {
            return null;
          }
          const active = member === panel.active;
          const cliOwned = view.status === "external-cli";
          // The insertion marker rides the tab the cursor is over, on the side
          // the drop would land — without it a reorder is invisible until it has
          // already happened.
          const marker = dropAt?.tab === member && draggingMember !== member
            ? (dropAt.after ? " is-drop-after" : " is-drop-before")
            : "";
          return (
            <div
              key={member}
              data-drop-tab={member}
              className={
                "wb-tab" +
                (active ? " is-active" : "") +
                (view.busy ? " is-working" : "") +
                (cliOwned ? " is-external-cli" : "") +
                (draggingMember === member ? " is-dragging" : "") +
                marker
              }
              style={memberColorVars(member)}
              onPointerDown={(event) => { if (!cliOwned) onTabPointerDown(member, event); }}
              onClick={() => { if (!cliOwned) onSelect(member); }}
              aria-disabled={cliOwned}
              title={cliOwned ? localized("STR-2145", [member]) : `${member} · ${harnessLabel(view.member.runtime)}`}
            >
              <span className="wb-tab-accent" />
              {/* Whose MODEL is answering, ahead of the name — the same identity
                  mark the sidebar row carries, so a member looks like itself in
                  both places. It replaces the status dot that used to sit here:
                  the tab already shows its own working state. */}
              <span className="wb-member-mark" title={providerLabel(view.provider)} aria-label={providerLabel(view.provider)}>
                <ProviderIcon provider={view.provider} size={15} />
              </span>
              <span className="wb-tab-name">{member}</span>
              <TabMarkers view={view} />
              <button
                type="button"
                className="wb-tab-close"
                title={localized("STR-2146")}
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
            title={localized("STR-2147", [hidden.length])}
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
                  <AlignLeft size={11} />  <LocalizedText id="STR-2148" /> {hidden.length}
                </div>
                {hidden.map((member) => {
                  const view = views.get(member);
                  if (!view) {
                    return null;
                  }
                  const cliOwned = view.status === "external-cli";
                  return (
                    <div
                      key={member}
                      className={"wb-tab-overflow-item" + (cliOwned ? " is-external-cli" : "")}
                      style={memberColorVars(member)}
                      role="menuitem"
                      onClick={() => { if (!cliOwned) { setOverflowOpen(false); onPromote(member); } }}
                      aria-disabled={cliOwned}
                    >
                      <span className="wb-member-mark" title={providerLabel(view.provider)} aria-label={providerLabel(view.provider)}>
                        <ProviderIcon provider={view.provider} size={14} />
                      </span>
                      <span className="wb-tab-overflow-name">{member}</span>
                      <TabMarkers view={view} />
                      <button
                        type="button"
                        className="wb-tab-close"
                        title={localized("STR-2149")}
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
                <div className="wb-tab-overflow-foot"><LocalizedText id="STR-2150" /></div>
              </div>
            </>
          )}
        </div>
      )}

      {/* No buttons on the strip. Members are opened from the party sidebar, which
          is the list that knows which ones exist, and a panel is split by dragging
          a tab into the work area — the same gesture that moves one between
          panels, so there is nothing a button would say that the drag does not. */}
    </div>
  );
}
