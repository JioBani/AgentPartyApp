import { Shield, X } from "lucide-react";
import type { PermissionModeSetting } from "../../shared/types";
import { harnessForRuntime, harnessLabel } from "../../shared/types";
import { HarnessPermissionControl } from "./HarnessPermissionControl";
import type { WorkbenchActions } from "./actions";
import type { MemberView } from "./types";

/** AgentParty-owned replacement for terminal-only /permissions pickers. */
export function PermissionModal({ view, actions, onClose }: { view: MemberView; actions: WorkbenchActions; onClose: () => void }) {
  const harness = harnessForRuntime(view.member.runtime);
  return (
    <div className="wb-modal-scrim">
      <div className="wb-modal wb-modal-sm wb-command-modal" role="dialog" aria-modal="true" aria-label="권한 설정">
        <header className="wb-modal-head">
          <div className="wb-modal-title">
            <Shield size={16} />
            <strong>권한 설정</strong>
            <span className="wb-modal-target" style={{ ["--member" as string]: view.color }}><span className="wb-dot" /> {view.name}</span>
          </div>
          <button type="button" className="wb-icon-btn" title="Close" onClick={onClose}><X size={16} /></button>
        </header>
        <div className="wb-modal-body wb-modal-body-col">
          <p className="wb-command-modal-note">{harnessLabel(harness)} 세션에 적용되며 멤버 설정으로 저장됩니다.</p>
          <HarnessPermissionControl
            harnessId={harness}
            variant="inline"
            value={{
              permissionMode: view.permissionMode as PermissionModeSetting,
              codexPolicy: view.session?.snapshot.codexPolicy || view.member.codexPolicy,
              cursorPolicy: view.session?.snapshot.cursorPolicy || view.member.cursorPolicy,
            }}
            onChange={(patch) => {
              if (patch.permissionMode) actions.setPermissionMode(view.name, patch.permissionMode);
              if (patch.codexPolicy) actions.setCodexPolicy(view.name, patch.codexPolicy);
              if (patch.cursorPolicy) actions.setCursorPolicy(view.name, patch.cursorPolicy);
            }}
          />
        </div>
        <footer className="wb-modal-foot wb-modal-foot-end">
          <button type="button" className="wb-btn wb-btn-accent" onClick={onClose}>완료</button>
        </footer>
      </div>
    </div>
  );
}
