import { useState } from "react";
import type { MemberView } from "./types";
import type { WorkbenchActions } from "./actions";
import { memberLocationOf } from "./memberGroups";
import { sshMemberState } from "./MemberCwdTree";
import { SshConnectionBanner, type SshNoticeAction } from "./SshConnectionNotices";
import { SshFingerprintDialog } from "./SshServerDialogs";
import { sshApi, useSshServers } from "../app/sshClient";

/**
 * The one S8 banner above an open SSH member's transcript (§12-3 ③).
 *
 * Renders nothing for local members and for a healthy server, so Panel can
 * mount it unconditionally. It shares its wording and actions with the drawer
 * notice; only the density differs.
 */
export function SshPanelBanner({ view, actions }: { view: MemberView; actions: WorkbenchActions }) {
  const location = memberLocationOf(view);
  const server = location?.env === "ssh" ? location.server : undefined;
  return server ? <SshPanelBannerFor server={server} actions={actions} /> : null;
}

function SshPanelBannerFor({ server, actions }: { server: string; actions: WorkbenchActions }) {
  const { servers } = useSshServers();
  const [reviewing, setReviewing] = useState(false);
  const state = sshMemberState(server, servers);
  const entry = servers?.find((candidate) => candidate.name === server);
  if (!state) return null;
  return (
    <>
      <div className="wb-ssh-panel-banner">
        <SshConnectionBanner
          server={server}
          state={state}
          onAction={(action) => runSshNoticeAction(action, server, actions, () => setReviewing(true))}
          onRegisterServer={() => actions.openSshSettings()}
        />
      </div>
      {reviewing && entry?.fingerprintChange && (
        <SshFingerprintDialog
          serverName={server}
          fingerprint={entry.fingerprintChange.next}
          previous={entry.fingerprintChange.previous}
          onCancel={() => setReviewing(false)}
          onTrust={() => { setReviewing(false); void sshApi().sshTrustNewFingerprint(server); }}
        />
      )}
    </>
  );
}

/** The three notice actions, shared by the drawer notice and the panel banner. */
export function runSshNoticeAction(action: SshNoticeAction, server: string, actions: Pick<WorkbenchActions, "openSshSettings">, review: () => void) {
  if (action === "reconnect") void sshApi().sshReconnect(server);
  else if (action === "open-settings") actions.openSshSettings();
  else review();
}
