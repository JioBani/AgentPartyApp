import { useEffect, useMemo, useState } from "react";
import type { MemberExecutionLocation } from "../../shared/memberLocation";
import type { SshRemotePathCheck } from "../../shared/sshServers";
import type { SshBrowsing } from "../workbench/SshLocationSection";
import { SshFingerprintDialog } from "../workbench/SshServerDialogs";
import { sshApi, useSshServers } from "./sshClient";
import { useSshServerFlow } from "./SshServersTab";

/** How long typing must pause before the remote path is checked. */
const PATH_CHECK_DELAY_MS = 350;

/**
 * Everything the SSH tab of the location picker needs, for one wizard.
 *
 * Returns `ssh: undefined` when the app has no SSH feature at all, which keeps
 * the tab out of builds that cannot use it. Once the feature exists an error
 * reading the list is SHOWN by the picker (via `servers` staying undefined plus
 * the returned `error`), never turned into an empty list.
 *
 * `modals` must be rendered by the caller after the wizard, so the add-server
 * modal and the fingerprint dialog paint over it (§12-2).
 */
export function useSshBrowsing(location: MemberExecutionLocation | undefined, onChange: (value: MemberExecutionLocation) => void) {
  const available = useMemo(() => {
    try {
      sshApi();
      return true;
    } catch {
      return false;
    }
  }, []);
  const { servers, error } = useSshServers();
  const [pathCheck, setPathCheck] = useState<"checking" | SshRemotePathCheck | undefined>();
  const [reviewing, setReviewing] = useState<string | undefined>();
  const flow = useSshServerFlow((serverName) => onChange({ env: "ssh", server: serverName, cwd: "" }));

  const server = location?.env === "ssh" ? location.server : undefined;
  const cwd = location?.env === "ssh" ? location.cwd : "";
  useEffect(() => {
    if (!available || !server || !cwd) {
      setPathCheck(undefined);
      return;
    }
    let alive = true;
    setPathCheck("checking");
    const timer = window.setTimeout(() => {
      sshApi().sshCheckRemotePath(server, cwd).then(
        (result) => { if (alive) setPathCheck(result); },
        () => { if (alive) setPathCheck({ ok: false, problem: "unreachable" }); },
      );
    }, PATH_CHECK_DELAY_MS);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [available, server, cwd]);

  const ssh: SshBrowsing | undefined = available ? {
    servers,
    pathCheck,
    onAddServer: () => flow.open({ mode: "add" }),
    onReconnect: (name) => {
      setPathCheck("checking");
      void sshApi().sshReconnect(name).catch(() => undefined);
    },
    onReviewFingerprint: setReviewing,
  } : undefined;

  const review = reviewing ? servers?.find((entry) => entry.name === reviewing) : undefined;
  const modals = (
    <>
      {flow.modal}
      {review?.fingerprintChange && (
        <SshFingerprintDialog
          serverName={review.name}
          fingerprint={review.fingerprintChange.next}
          previous={review.fingerprintChange.previous}
          onCancel={() => setReviewing(undefined)}
          onTrust={() => { setReviewing(undefined); void sshApi().sshTrustNewFingerprint(review.name); }}
        />
      )}
    </>
  );

  return { ssh, modals, error, pathCheck };
}
