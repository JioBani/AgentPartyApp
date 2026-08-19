import { Check, ChevronLeft, ChevronRight, ListChecks, Search } from "lucide-react";
import type { PanelDensity } from "./types";
import type { SubDetailView } from "./subagentModel";
import { formatSubDuration } from "./subagentModel";
import { Markdown } from "./Markdown";
import { ExpandableText } from "./Transcript";
import { LocalizedText, localized } from "../i18n/I18nProvider";

interface SubagentDetailProps {
  detail: SubDetailView;
  parentName: string;
  parentColor: string;
  density: PanelDensity;
  onBack: () => void;
}

/**
 * Drill-in detail — an overlay over the session panel (below the tab strip) that
 * makes it feel like you stepped INTO the subagent's session, while a breadcrumb
 * keeps the parent context. Shows the delegated task band + the subagent's own
 * transcript. Component 2 of the handoff.
 */
export function SubagentDetail({ detail, parentName, parentColor, density, onBack }: SubagentDetailProps) {
  return (
    <div className="wb-subdetail">
      <div className="wb-subdetail-head">
        <button type="button" className="wb-subdetail-back" title={localized("STR-2130")} aria-label={localized("STR-2130")} onClick={onBack}>
          <ChevronLeft size={16} />
        </button>
        <span className="wb-subdetail-crumb">
          <span className="wb-subdetail-parent-dot" style={{ background: parentColor }} />
          <span className="wb-subdetail-parent">{parentName}</span>
          <ChevronRight size={12} className="wb-subdetail-crumb-sep" />
        </span>
        <span className="wb-subdetail-id">
          <span className="wb-mono wb-subdetail-name">{detail.name}</span>
          {detail.hint && <span className="wb-mono wb-subdetail-hint">{detail.hint}</span>}
        </span>
        <span className="wb-subdetail-status" style={{ background: detail.statusBg, color: detail.statusColor }}>
          {detail.working && <span className="wb-subdetail-status-dot" style={{ background: detail.statusColor }} />}
          {detail.statusLabel}
        </span>
      </div>

      {detail.task && (
        <div className="wb-subdetail-task">
          <ListChecks size={13} className="wb-subdetail-task-ic" />
          <div className="wb-subdetail-task-body">
            <span className="wb-subdetail-task-label"><LocalizedText id="STR-2131" /></span>
            {/* A delegated prompt is often hundreds of lines; rendering it whole
                pushed the subagent's actual work off screen. Same preview +
                "전체 보기" popup the transcript uses for long messages. */}
            <span className="wb-subdetail-task-text"><ExpandableText text={detail.task} title={localized("STR-2132")} /></span>
          </div>
        </div>
      )}

      <div className="wb-subdetail-body">
        {detail.blocks.map((block, i) => {
          if (block.kind === "assistant") {
            return <div key={i} className="wb-subblock-asst"><Markdown text={block.text} /></div>;
          }
          if (block.kind === "status") {
            return (
              <div key={i} className="wb-subblock-status wb-mono">
                <Search size={12} /> <span>{block.text}</span>
              </div>
            );
          }
          if (block.kind === "typing") {
            return (
              <div key={i} className="wb-subblock-typing">
                <span className="wb-typing-pill" style={{ ["--member" as string]: parentColor }}>
                  <span className="wb-typing-dots"><i /><i /><i /></span>
                </span>
                <span className="wb-typing-text"><LocalizedText id="STR-2133" /></span>
              </div>
            );
          }
          return (
            <div key={i} className="wb-subblock-tool">
              <div className="wb-subblock-tool-head">
                <span className="wb-subblock-tool-check"><Check size={11} /></span>
                <span className="wb-mono wb-subblock-tool-name">{block.toolName}</span>
                {block.arg && <span className="wb-mono wb-subblock-tool-arg">{block.arg}</span>}
                {typeof block.durationMs === "number" && <span className="wb-mono wb-subblock-tool-ms">{formatSubDuration(block.durationMs)}</span>}
              </div>
              {block.result && <pre className={"wb-pre wb-subblock-tool-res" + (density === "narrow" ? " is-wrap" : "")}>{block.result}</pre>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
