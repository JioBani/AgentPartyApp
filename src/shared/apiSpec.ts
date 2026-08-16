/**
 * The automation API's self-description.
 *
 * The endpoint list is no longer written by hand: it is derived from the
 * capability table in `src/main/api/routes/`, which the local HTTP server and a
 * paired phone's RPC both dispatch. Register a capability there once and it
 * appears here, in `GET /api/spec`, and in the mobile method catalog.
 */
export interface AutomationApiSpec {
  version: 1;
  baseUrl: string;
  /** `"<VERB> /api/path"` for every endpoint this build serves. */
  endpoints: readonly string[];
  /**
   * `<domain>.<verb>` names a paired phone may call over the mobile link
   * (AgentPartyMobile/docs/아키텍처/08-메서드-카탈로그.md). A subset of
   * `endpoints`: desktop-local surfaces such as window chrome are excluded.
   */
  methods: readonly string[];
}

export function automationApiSpec(
  baseUrl: string,
  endpoints: readonly string[],
  methods: readonly string[],
): AutomationApiSpec {
  return {
    version: 1,
    baseUrl,
    endpoints,
    methods,
  };
}
