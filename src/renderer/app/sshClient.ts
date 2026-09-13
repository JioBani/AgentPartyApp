import { useEffect, useState } from "react";
import type {
  SshConnectAttempt, SshDeleteResult, SshFieldError, SshKeyInspection, SshRemotePathCheck, SshServerDraft, SshServerView,
} from "../../shared/sshServers";
import { sshMockApi } from "./sshMock";

/**
 * The renderer's one door to the SSH feature.
 *
 * Every SSH screen goes through here rather than calling `window.agentParty`
 * directly, so the screens stay presentational and there is exactly one place
 * that knows the preload method names (agreed with the feature in
 * `src/shared/sshServers.ts`).
 *
 * The mock is EXPLICIT: it answers only when `localStorage["agentparty.sshMock"]`
 * is `"1"`, and every screen that reads a mocked list says so. When neither the
 * real API nor the flag is present the calls throw a named error — never an
 * empty list that would read as "no servers registered".
 */

export interface SshApi {
  listSshServers: () => Promise<SshServerView[]>;
  onSshServers: (listener: (servers: SshServerView[]) => void) => () => void;
  onSshAttempt: (listener: (attempt: SshConnectAttempt) => void) => () => void;
  sshConnectDraft: (draft: SshServerDraft) => Promise<{ attemptId: string } | { fieldErrors: SshFieldError[] }>;
  sshTrustFingerprint: (attemptId: string) => Promise<void>;
  sshCancelAttempt: (attemptId: string) => Promise<void>;
  sshSetupAutoLogin: (attemptId: string) => Promise<void>;
  sshContinueWithPassword: (attemptId: string) => Promise<void>;
  sshSavePasswordLogin: (attemptId: string) => Promise<void>;
  sshRetest: (attemptId: string) => Promise<void>;
  sshPickKeyFile: () => Promise<string | null>;
  sshInspectKeyFile: (path: string) => Promise<SshKeyInspection>;
  sshTestServer: (name: string) => Promise<void>;
  sshReconnect: (name: string) => Promise<void>;
  sshTrustNewFingerprint: (name: string) => Promise<void>;
  sshDeleteServer: (name: string, options: { removeAutoLoginKey: boolean }) => Promise<SshDeleteResult>;
  sshCopyPublicKey: () => Promise<void>;
  sshCheckRemotePath: (server: string, cwd: string) => Promise<SshRemotePathCheck>;
}

export function sshMockEnabled(): boolean {
  try {
    return window.localStorage.getItem("agentparty.sshMock") === "1";
  } catch {
    return false;
  }
}

export function sshApi(): SshApi {
  const real = window.agentParty as unknown as Partial<SshApi>;
  if (typeof real.listSshServers === "function") {
    return real as SshApi;
  }
  if (sshMockEnabled()) {
    return sshMockApi;
  }
  throw new Error("SSH 서버 기능을 사용할 수 없습니다: 앱에 SSH API가 없습니다.");
}

/** Live server list, shared by every SSH screen. */
export function useSshServers(): { servers?: SshServerView[]; error?: string; mocked: boolean } {
  const [servers, setServers] = useState<SshServerView[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [mocked, setMocked] = useState(false);
  useEffect(() => {
    let api: SshApi;
    try {
      api = sshApi();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    setMocked(api === sshMockApi);
    let alive = true;
    api.listSshServers().then((list) => { if (alive) setServers(list); }, (cause) => { if (alive) setError(String(cause?.message ?? cause)); });
    const off = api.onSshServers((list) => setServers(list));
    return () => { alive = false; off(); };
  }, []);
  return { servers, error, mocked };
}
