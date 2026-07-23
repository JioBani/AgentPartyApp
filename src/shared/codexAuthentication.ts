/**
 * A ChatGPT/Codex OAuth credential normalized for Codex CLI's file store.
 *
 * This crosses the trusted desktop↔WSL engine RPC boundary. It must never be
 * returned by the public automation API, rendered, or written to logs.
 */
export interface CodexAuthenticationCredential {
  authMode: "chatgpt";
  lastRefresh: string;
  tokens: {
    accessToken: string;
    refreshToken: string;
    idToken: string;
    accountId: string;
  };
}

export interface CodexAuthenticationUpdate {
  /** Stable digest used only for deduplication; contains no token material. */
  generation: string;
  credential?: CodexAuthenticationCredential;
}

export interface CodexAuthenticationApplyResult {
  changed: boolean;
  generation: string;
  connected: boolean;
  restartedSessions: number;
  deferredSessions: number;
}
