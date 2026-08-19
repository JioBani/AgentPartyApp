import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, RefreshCw, ShieldCheck } from "lucide-react";
import type { TranscriptBlock } from "../../shared/transcript";
import type { EnvironmentCheck } from "../../shared/environment";
import { findEnvironmentCheck } from "../../shared/environment";
import { EnvironmentProbeSteps, EnvironmentRawDetail, EnvironmentRemedyButtons, EnvironmentRepairNote } from "./EnvironmentRemedies";
import type { WorkbenchActions } from "./actions";
import type { MemberView } from "./types";

type EnvironmentTranscriptBlock = Extract<TranscriptBlock, { kind: "environment" }>;

/**
 * "This member cannot start, and here is the button that fixes it."
 *
 * Replaces the wall of English CLI text a missing harness used to print into
 * the transcript on EVERY attempt. The block itself carries only a check id;
 * the label, explanation and fixes are read from the live environment report,
 * so this card and the 환경 settings tab can never give different advice.
 *
 * The report is fetched per card rather than held in app state because a card
 * is rare (a broken machine) and stale advice is worse than a short spinner:
 * after the user installs the CLI in another window, the next render must say
 * so rather than keep offering an install that already happened.
 */
export function EnvironmentBlock({ block, view, actions }: {
  block: EnvironmentTranscriptBlock;
  view: MemberView;
  actions: WorkbenchActions;
}) {
  const [check, setCheck] = useState<EnvironmentCheck | undefined>();
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState<{ ok: boolean; detail: string; output?: string } | undefined>();

  const load = useCallback(async (refresh: boolean) => {
    setLoading(true);
    try {
      const report = await window.agentParty.getEnvironment({ refresh });
      setCheck(findEnvironmentCheck(report, block.checkId));
    } catch {
      // Leave `check` undefined — the card falls back to the raw message it was
      // constructed with, which is still better than showing nothing.
      setCheck(undefined);
    } finally {
      setLoading(false);
    }
  }, [block.checkId]);

  useEffect(() => { void load(false); }, [load]);

  const resolved = check?.status === "ok";
  const detail = check?.detail || "이 멤버를 실행하려면 먼저 환경을 준비해야 합니다.";
  const remedies = check?.remedies || [];
  // A `settings` remedy already navigates to the environment tab, so the
  // standalone button would be the same action twice in a row.
  const showOpenEnvironment = !remedies.some((remedy) => remedy.kind === "settings");

  // The message that failed, so "다시 시도" does not make the user retype it.
  const lastUserText = [...(view.transcript || [])]
    .reverse()
    .flatMap((entry) => (entry.kind === "user" && entry.text.trim() ? [entry.text] : []))[0];

  return (
    <div className="wb-block wb-env" data-env-check={block.checkId} data-resolved={resolved ? "1" : "0"}>
      <div className="wb-env-head">
        {resolved ? <ShieldCheck size={15} /> : <AlertTriangle size={15} />}
        <span className="wb-env-title">{resolved ? `${check?.label} 준비가 끝났습니다. 이제 대화할 수 있습니다.` : block.text}</span>
      </div>
      {/* The heading is the thrown message and the detail comes from the live
          check; when a check phrases it the same way, one line is enough. */}
      {!resolved && detail !== block.text && <div className="wb-env-detail">{detail}</div>}
      {!resolved && Boolean(check?.steps?.length) && <EnvironmentProbeSteps steps={check?.steps || []} />}
      {resolved && lastUserText && <div className="wb-env-detail">보내지 못한 메시지는 자동 전송하지 않았습니다. 아래 버튼으로 다시 보내세요.</div>}

      <div className="wb-env-actions">
        {!resolved && (
          <EnvironmentRemedyButtons
            remedies={remedies}
            onRepaired={(result) => { setNote(result); void load(true); }}
            onOpenEnvironment={actions.openEnvironmentSettings}
          />
        )}
        {resolved && lastUserText && (
          <button
            type="button"
            className="set-btn-accent"
            data-env-remedy="retry"
            onClick={() => void actions.sendMessage(view.name, lastUserText)}
          >
            <RefreshCw size={14} /> 메시지 다시 보내기
          </button>
        )}
        {showOpenEnvironment && (
          <button type="button" className="set-btn-soft" data-env-remedy="open-environment" onClick={actions.openEnvironmentSettings}>
            <ShieldCheck size={14} /> 환경 탭 열기
          </button>
        )}
        <button type="button" className="set-link-btn wb-env-recheck" data-env-remedy="recheck" disabled={loading} onClick={() => void load(true)}>
          <RefreshCw size={14} /> {loading ? "확인 중…" : "다시 확인"}
        </button>
      </div>

      {note && !resolved && <EnvironmentRepairNote note={note} />}
      {block.raw && <EnvironmentRawDetail raw={block.raw} />}
    </div>
  );
}
