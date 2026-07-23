import { SlidersHorizontal } from "lucide-react";
import type { MemberView } from "./types";
import type { WorkbenchActions } from "./actions";
import type { RouteLike } from "./routes";
import { DEFAULT_AUTO_COMPACT } from "../../shared/autoCompact";
import { ModelCatalogModal, type ModelCatalogValue } from "./ModelCatalogModal";

interface RuntimeModalProps {
  view: MemberView;
  routes: RouteLike[];
  debugEnabled: boolean;
  actions: WorkbenchActions;
  onClose: () => void;
}

/**
 * Per-member runtime settings — a thin wrapper over the shared
 * {@link ModelCatalogModal} with EVERY section enabled (harness, effort,
 * thinking, debug, auto-compact). Apply restarts the member's session.
 */
export function RuntimeModal({ view, routes, debugEnabled, actions, onClose }: RuntimeModalProps) {
  const currentHarness = view.member.runtime === "codex" ? "codex" : view.member.runtime === "cursor" ? "cursor" : "claude-code";
  const harnessLocked =
    (view.session?.snapshot.turnCount ?? 0) > 0 ||
    view.transcript.some((block) => block.kind === "user" || block.kind === "assistant");
  const initialCompact = view.autoCompact ?? DEFAULT_AUTO_COMPACT;

  const value: ModelCatalogValue = {
    model: view.model,
    harness: currentHarness,
    effort: view.effort,
    serviceTier: view.member.serviceTier,
    thinkingMode: view.thinkingMode,
    thinkingBudget: view.thinkingBudget,
    debug: debugEnabled,
    autoCompact: initialCompact,
  };

  function onApply(next: ModelCatalogValue) {
    actions.applyRuntime(view.name, {
      route: next.route,
      effort: next.effort,
      serviceTier: next.serviceTier,
      thinkingMode: next.thinkingMode,
      thinkingBudget: next.thinkingBudget,
      debug: Boolean(next.debug),
    });
    if (next.autoCompact && (next.autoCompact.on !== initialCompact.on || next.autoCompact.at !== initialCompact.at)) {
      actions.setAutoCompact(view.name, next.autoCompact);
    }
  }

  return (
    <ModelCatalogModal
      title="Runtime"
      icon={<SlidersHorizontal size={16} />}
      subtitle={
        <>
          <span className="wb-modal-target" style={{ ["--member" as string]: view.color }}>
            <span className="wb-dot" /> {view.name}
          </span>
          <span className="wb-mono wb-modal-sub">{currentHarness === "codex" ? "Codex" : currentHarness === "cursor" ? "Cursor CLI" : "Claude Code"}</span>
        </>
      }
      routes={routes}
      value={value}
      config={{ harness: true, effort: true, serviceTier: true, thinking: true, debug: true, autoCompact: true }}
      harnessLocked={harnessLocked}
      currentHarness={currentHarness}
      contextWindow={view.context?.total || view.member.lastContextWindow}
      dim
      onApply={onApply}
      onClose={onClose}
    />
  );
}
