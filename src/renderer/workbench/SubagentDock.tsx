import { ChevronRight, GitBranch } from "lucide-react";
import type { SubDockView } from "./subagentModel";

interface SubagentDockProps {
  view: SubDockView;
  onToggle: () => void;
  onOpen: (id: string) => void;
}

/**
 * Persistent subagent list — sits between the toolbar and the transcript
 * (`flex: none`), so it never scrolls away with the chat. Header always shows the
 * count + status dots + a rolled-up summary; expanding reveals one row per
 * subagent. Clicking a row drills into its detail view. Component 1 of the handoff.
 */
export function SubagentDock({ view, onToggle, onOpen }: SubagentDockProps) {
  return (
    <div className="wb-subdock">
      <div className="wb-subdock-head" onClick={onToggle} role="button" tabIndex={0}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); } }}>
        <ChevronRight size={11} className={"wb-subdock-caret" + (view.expanded ? " is-open" : "")} />
        <GitBranch size={13} className="wb-subdock-branch" />
        <span className="wb-subdock-label">서브에이전트</span>
        <span className="wb-subdock-count">{view.count}</span>
        <div className="wb-subdock-dots">
          {view.dots.map((dot, i) => (
            <span key={i} className="wb-subdot">
              <span className="wb-subdot-core" style={{ background: dot.color }} />
              {dot.working && <span className="wb-subdot-ring" style={{ borderColor: dot.color }} />}
            </span>
          ))}
        </div>
        <span className="wb-subdock-summary wb-mono">{view.summary}</span>
      </div>

      {view.expanded && (
        <div className="wb-subdock-list">
          {view.rows.map((row) => (
            <div key={row.id} className={"wb-subrow" + (row.rowActive ? " is-active" : "")}
              style={row.rowActive ? { background: "var(--member-ring)" } : undefined}
              onClick={() => onOpen(row.id)} role="button" tabIndex={0}
              onKeyDown={(e) => { if (e.key === "Enter") onOpen(row.id); }}>
              <span className="wb-subdot wb-subrow-dot">
                <span className="wb-subdot-core" style={{ background: row.dotColor }} />
                {row.working && <span className="wb-subdot-ring" style={{ borderColor: row.dotColor }} />}
              </span>
              <span className="wb-mono wb-subrow-name">{row.name}</span>
              {row.hint && <span className="wb-mono wb-subrow-hint">{row.hint}</span>}
              {row.showLine && <span className="wb-subrow-line">{row.line}</span>}
              <span className="wb-subrow-spacer" />
              {row.showMeta && row.meta && <span className="wb-mono wb-subrow-meta">{row.meta}</span>}
              <span className="wb-subrow-status" style={{ background: row.statusBg, color: row.statusColor }}>{row.statusLabel}</span>
              <ChevronRight size={13} className="wb-subrow-chevron" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
