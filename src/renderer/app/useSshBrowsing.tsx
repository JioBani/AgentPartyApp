import { useEffect, useMemo, useRef, useState } from "react";
import type { MemberExecutionLocation } from "../../shared/memberLocation";
import type { SshRemoteBrowseProblem, SshRemotePathCheck } from "../../shared/sshServers";
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
  const [homeProblem, setHomeProblem] = useState<SshRemoteBrowseProblem | undefined>();
  const [reviewing, setReviewing] = useState<string | undefined>();
  const flow = useSshServerFlow((serverName) => onChange({ env: "ssh", server: serverName, cwd: "" }));
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

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

  // §13-6: a server chosen with no path starts at the account's home. Once per
  // server choice, so a user who clears the field is not refilled while typing.
  const homeFilledFor = useRef<string | undefined>();
  useEffect(() => {
    if (!server) homeFilledFor.current = undefined;
    setHomeProblem(undefined);
    if (!available || !server || cwd || homeFilledFor.current === server) return;
    homeFilledFor.current = server;
    let alive = true;
    sshApi().sshRemoteHome(server).then(
      (home) => {
        if (!alive) return;
        if (home.ok) onChangeRef.current({ env: "ssh", server, cwd: home.path });
        else setHomeProblem(home.problem);
      },
      () => { if (alive) setHomeProblem("unreachable"); },
    );
    return () => { alive = false; };
  }, [available, server, cwd]);

  const ssh: SshBrowsing | undefined = available ? {
    servers,
    pathCheck,
    homeProblem,
    onAddServer: () => flow.open({ mode: "add" }),
    onReconnect: (name) => {
      setPathCheck("checking");
      void sshApi().sshReconnect(name).catch(() => undefined);
    },
    onReviewFingerprint: setReviewing,
    listDirectories: (name, remotePath) => remotePath === undefined ? sshApi().sshRemoteHome(name) : sshApi().sshListRemoteDirectories(name, remotePath),
    suggestPaths: (name, input) => sshApi().sshSuggestRemotePaths(name, input),
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
