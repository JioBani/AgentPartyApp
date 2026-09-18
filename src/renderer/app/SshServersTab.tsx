import { useCallback, useEffect, useRef, useState } from "react";
import { TriangleAlert } from "lucide-react";
import type { SshConnectAttempt, SshFieldError, SshKeyInspection, SshServerDraft, SshServerView } from "../../shared/sshServers";
import { SshServerSettings } from "./SshServerSettings";
import { SshServerModal } from "../workbench/SshServerModal";
import { SshDeleteDialog, SshFingerprintDialog } from "../workbench/SshServerDialogs";
import { sshApi, useSshServers } from "./sshClient";
import { LocalizedText } from "../i18n/I18nProvider";

/**
 * Settings → SSH 서버, wired: the list plus every dialog it opens.
 *
 * The add-server flow itself lives in {@link useSshServerFlow} so the member
 * wizard can open the SAME modal over itself (§12-2) without a second copy of
 * the attempt state machine.
 */
export function SshServersTab({ now }: { now: number }) {
  const { servers, error, mocked } = useSshServers();
  const flow = useSshServerFlow();
  const [deleting, setDeleting] = useState<SshServerView | undefined>();
  const [reviewing, setReviewing] = useState<SshServerView | undefined>();
  const [actionError, setActionError] = useState<string | undefined>();

  const run = (action: () => Promise<unknown>) => {
    setActionError(undefined);
    void action().catch((cause) => setActionError(cause instanceof Error ? cause.message : String(cause)));
  };

  return (
    <>
      {mocked && (
        <div className="set-tab-note" data-ssh-mock>
          <TriangleAlert size={14} />
          <span><LocalizedText id="STR-3951" /></span>
        </div>
      )}
      {(error || actionError) && (
        <div className="set-ssh-alert" role="alert">
          <TriangleAlert size={13} />
          <span>{error || actionError}</span>
        </div>
      )}
      {servers && (
        <SshServerSettings
          servers={servers}
          now={now}
          onAdd={() => flow.open({ mode: "add" })}
          onEdit={(server) => flow.open({ mode: "edit", server })}
          onDelete={setDeleting}
          onTest={(server) => run(() => sshApi().sshTestServer(server.name))}
          onSetupAutoLogin={(server) => flow.open({ mode: "edit", server })}
          onReviewFingerprint={setReviewing}
          onCopyPublicKey={() => run(() => sshApi().sshCopyPublicKey())}
        />
      )}
      {flow.modal}
      {deleting && (
        <SshDeleteDialog
          serverName={deleting.name}
          memberNames={deleting.memberNames}
          hasAutoLogin={deleting.auth === "auto"}
          onCancel={() => setDeleting(undefined)}
          onDelete={(options) => {
            const name = deleting.name;
            setDeleting(undefined);
            run(async () => {
              const result = await sshApi().sshDeleteServer(name, options);
              // The server is gone either way; a key left behind on it must still be said.
              if (result.keyRemoval === "failed") {
                setActionError(`${name} 를 삭제했지만 서버의 자동 로그인 키를 제거하지 못했습니다${result.detail ? ` · ${result.detail}` : ""}`);
              }
            });
          }}
        />
      )}
      {reviewing?.fingerprintChange && (
        <SshFingerprintDialog
          serverName={reviewing.name}
          fingerprint={reviewing.fingerprintChange.next}
          previous={reviewing.fingerprintChange.previous}
          onCancel={() => setReviewing(undefined)}
          onTrust={() => { const name = reviewing.name; setReviewing(undefined); run(() => sshApi().sshTrustNewFingerprint(name)); }}
        />
      )}
    </>
  );
}

type FlowTarget = { mode: "add" } | { mode: "edit"; server: SshServerView };

/**
 * One add / edit session: the modal, the fingerprint question it can raise, and
 * the attempt pushed by the feature. `onSaved` receives the server name once the
 * flow finishes, which is how the member wizard selects the server it just added.
 */
export function useSshServerFlow(onSaved?: (serverName: string) => void) {
  const [target, setTarget] = useState<FlowTarget | undefined>();
  const [attempt, setAttempt] = useState<SshConnectAttempt | undefined>();
  const [fieldErrors, setFieldErrors] = useState<SshFieldError[] | undefined>();
  const [keyPath, setKeyPath] = useState<string | undefined>();
  const [keyInspection, setKeyInspection] = useState<SshKeyInspection | undefined>();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [seed, setSeed] = useState(0);
  // Which pushed attempts belong to the form on screen. A cancelled attempt can
  // still answer (its connect call resolving, a late event), and must not pull
  // the form back into "connecting" after the user stopped it.
  const submitGen = useRef(0);
  const awaitingId = useRef(false);
  const ownIds = useRef(new Set<string>());

  useEffect(() => {
    if (!target) return;
    let off: (() => void) | undefined;
    try {
      off = sshApi().onSshAttempt((next) => {
        if (!ownIds.current.has(next.attemptId) && !awaitingId.current) return;
        setAttempt((current) => (current && current.attemptId !== next.attemptId ? current : next));
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
    return () => off?.();
  }, [target]);

  const close = useCallback(() => {
    if (attempt && attempt.phase !== "done") void sshApi().sshCancelAttempt(attempt.attemptId).catch(() => undefined);
    setTarget(undefined);
    setAttempt(undefined);
    setFieldErrors(undefined);
    setKeyPath(undefined);
    setKeyInspection(undefined);
    setError(undefined);
  }, [attempt]);

  const open = useCallback((next: FlowTarget) => {
    setTarget(next);
    setAttempt(undefined);
    setFieldErrors(undefined);
    setKeyInspection(undefined);
    setKeyPath(undefined);
    setSeed((value) => value + 1);
  }, []);

  const guard = (action: () => Promise<unknown>) => {
    setError(undefined);
    void action().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  };

  /**
   * Stops the connection in progress and hands the form back as it was typed.
   * The modal is not remounted, so every field keeps its value; the next
   * [연결] starts a fresh attempt.
   */
  const cancelAttempt = useCallback(() => {
    submitGen.current += 1;
    awaitingId.current = false;
    if (attempt) {
      ownIds.current.delete(attempt.attemptId);
      void sshApi().sshCancelAttempt(attempt.attemptId).catch(() => undefined);
    }
    setAttempt(undefined);
    setSubmitting(false);
    setError(undefined);
  }, [attempt]);

  async function submit(draft: SshServerDraft) {
    const gen = ++submitGen.current;
    ownIds.current.clear();
    awaitingId.current = true;
    setSubmitting(true);
    setFieldErrors(undefined);
    setAttempt(undefined);
    try {
      const withKey = draft.auth.kind === "key" ? { ...draft, auth: { ...draft.auth, keyPath: keyPath ?? "" } } : draft;
      const result = await sshApi().sshConnectDraft(withKey);
      if (gen !== submitGen.current) {
        // Cancelled before the attempt had an id: stop it now that it has one.
        if ("attemptId" in result) void sshApi().sshCancelAttempt(result.attemptId).catch(() => undefined);
        return;
      }
      if ("attemptId" in result) ownIds.current.add(result.attemptId);
      if ("fieldErrors" in result) setFieldErrors(result.fieldErrors);
    } catch (cause) {
      if (gen === submitGen.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (gen === submitGen.current) {
        awaitingId.current = false;
        setSubmitting(false);
      }
    }
  }

  async function pickKey() {
    const picked = await sshApi().sshPickKeyFile();
    if (!picked) return;
    setKeyPath(picked);
    setKeyInspection(await sshApi().sshInspectKeyFile(picked));
  }

  const server = target?.mode === "edit" ? target.server : undefined;
  const modal = target ? (
    <>
      <SshServerModal
        key={seed}
        mode={target.mode}
        initial={server ? { name: server.name, host: server.host, port: server.port, user: server.user, authKind: server.auth, keyPath } : { name: "", host: "", port: 22, user: "", authKind: "password", keyPath }}
        attempt={attempt}
        fieldErrors={fieldErrors}
        keyInspection={keyInspection}
        submitting={submitting}
        onSubmit={(draft) => void submit(draft)}
        onTest={(draft) => void submit(draft)}
        onPickKeyFile={() => guard(pickKey)}
        onCancel={close}
        onCancelAttempt={cancelAttempt}
        onSetupAutoLogin={() => attempt && guard(() => sshApi().sshSetupAutoLogin(attempt.attemptId))}
        onContinueWithPassword={() => attempt && guard(() => sshApi().sshContinueWithPassword(attempt.attemptId))}
        onSavePasswordLogin={() => attempt && guard(() => sshApi().sshSavePasswordLogin(attempt.attemptId))}
        onRetest={() => attempt && guard(() => sshApi().sshRetest(attempt.attemptId))}
        onCopyPublicKey={() => guard(() => sshApi().sshCopyPublicKey())}
        onDone={() => { const name = attempt?.serverName; close(); if (name) onSaved?.(name); }}
        error={error}
      />
      {attempt?.phase === "fingerprint" && attempt.fingerprint && (
        <SshFingerprintDialog
          serverName={attempt.serverName}
          fingerprint={attempt.fingerprint.sha256}
          previous={attempt.fingerprint.previous}
          onCancel={cancelAttempt}
          onTrust={() => guard(() => sshApi().sshTrustFingerprint(attempt.attemptId))}
        />
      )}
    </>
  ) : null;

  return { open, close, modal, isOpen: Boolean(target) };
}
