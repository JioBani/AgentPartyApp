/**
 * Codex diagnostics — surfacing reroute / rate-limit / warnings instead of
 * silently swallowing them (Item 5, the project's "no silent fallback" rule).
 *
 * Pure, testable classifier: maps an app-server notification (method + params)
 * to a UI diagnostic with a severity, category, and — for recoverable problems
 * like the Windows sandbox ACL drift — a recovery hint. Returns null for
 * notifications that carry no user-actionable signal (so the transcript is not
 * spammed by every rolling rate-limit tick). Field names verified against
 * `codex app-server generate-ts` (ModelReroutedNotification, RateLimitSnapshot…).
 */

export type DiagnosticSeverity = "info" | "warning" | "error";

export type DiagnosticCategory =
  | "reroute"
  | "rate-limit"
  | "guardian"
  | "config"
  | "mcp"
  | "sandbox"
  | "deprecation"
  | "other";

export interface CodexDiagnostic {
  severity: DiagnosticSeverity;
  category: DiagnosticCategory;
  title: string;
  detail?: string;
  /** Actionable recovery guidance (e.g. the Windows sandbox fix command). */
  recovery?: string;
}

/** The recovery step for the known Windows sandbox ACL drift (openai/codex#9062). */
const WINDOWS_SANDBOX_RECOVERY = "Windows 샌드박스 문제일 수 있습니다 — /codex-fix-sandbox 로 복구를 시도하세요.";

export function classifyDiagnostic(method: string, params: any): CodexDiagnostic | null {
  switch (method) {
    case "model/rerouted":
      // A silent model swap is exactly what the no-fallback rule forbids: always show it.
      return {
        severity: "warning",
        category: "reroute",
        title: `모델이 ${params?.toModel || "다른 모델"}로 라우팅됨`,
        detail: [params?.fromModel && `${params.fromModel} → ${params.toModel}`, rerouteReason(params?.reason)].filter(Boolean).join(" · ") || undefined,
      };
    case "account/rateLimits/updated":
      return rateLimitDiagnostic(params?.rateLimits);
    case "guardianWarning":
      return { severity: "warning", category: "guardian", title: "Guardian 경고", detail: str(params?.message) };
    case "configWarning":
      return {
        severity: "warning",
        category: "config",
        title: str(params?.summary) || "설정 경고",
        detail: [str(params?.details), str(params?.path)].filter(Boolean).join(" · ") || undefined,
      };
    case "deprecationNotice":
      return { severity: "info", category: "deprecation", title: str(params?.summary) || "지원 중단 예정", detail: str(params?.details) };
    case "warning": {
      const message = str(params?.message);
      // Informational, not a fault: Codex has no built-in metadata entry for
      // arbitrary OpenRouter model slugs, so it uses a default context window.
      // The model runs normally and the selected model does NOT change (this is
      // not the model-selection fallback the no-silent-fallback rule guards).
      // Surface it as a calm info note (accent-colored, Info icon) with the
      // reassurance leading, so it reads as FYI rather than an error.
      if (/model metadata.*not found|fallback metadata/i.test(message || "")) {
        return {
          severity: "info",
          category: "config",
          title: "참고: OpenRouter 모델 (Codex 내장 정보 없음)",
          detail: "에러가 아닙니다. Codex에 이 모델의 내장 메타데이터가 없어 기본 컨텍스트 창으로 실행합니다 — 응답은 정상입니다. 아주 긴 세션에서 auto-compaction 시점만 근사치가 됩니다.",
        };
      }
      const sandbox = /sandbox|read-only|acl|world-?writable/i.test(message || "");
      return {
        severity: "warning",
        category: sandbox ? "sandbox" : "other",
        title: sandbox ? "샌드박스 경고" : "경고",
        detail: message,
        recovery: sandbox ? WINDOWS_SANDBOX_RECOVERY : undefined,
      };
    }
    case "windows/worldWritableWarning":
      return {
        severity: "warning",
        category: "sandbox",
        title: "쓰기 가능 경로 경고",
        detail: str(params?.message) || str(params?.path),
        recovery: WINDOWS_SANDBOX_RECOVERY,
      };
    case "mcpServer/startupStatus/updated":
      return mcpStatusDiagnostic(params);
    default:
      return null;
  }
}

function rerouteReason(reason: unknown): string | undefined {
  return reason === "highRiskCyberActivity" ? "high-risk cyber activity" : reason ? String(reason) : undefined;
}

/** Surface a rate-limit only when a window is (near) exhausted — not every rolling tick. */
function rateLimitDiagnostic(snapshot: any): CodexDiagnostic | null {
  if (!snapshot || typeof snapshot !== "object") {
    return null;
  }
  const windows = [snapshot.primary, snapshot.secondary].filter((w) => w && typeof w.usedPercent === "number");
  const worst = windows.sort((a, b) => b.usedPercent - a.usedPercent)[0];
  const reached = snapshot.rateLimitReachedType;
  if (!reached && (!worst || worst.usedPercent < 90)) {
    return null;
  }
  const pct = worst ? Math.round(worst.usedPercent) : 100;
  return {
    severity: reached || pct >= 100 ? "error" : "warning",
    category: "rate-limit",
    title: reached ? "사용량 한도 도달" : `사용량 한도 임박 (${pct}%)`,
    detail: [snapshot.limitName && String(snapshot.limitName), worst?.resetsAt && `resets ${new Date(worst.resetsAt * 1000).toISOString()}`].filter(Boolean).join(" · ") || undefined,
  };
}

/** Surface an MCP server only when it failed to start (needs-auth / error). */
function mcpStatusDiagnostic(params: any): CodexDiagnostic | null {
  const status = str(params?.status) || str(params?.state) || "";
  if (!/fail|error|needs?-?auth|unauth/i.test(status)) {
    return null;
  }
  return {
    severity: /needs?-?auth|unauth/i.test(status) ? "warning" : "error",
    category: "mcp",
    title: `MCP 서버 ${params?.server || params?.name || ""}: ${status}`.trim(),
    detail: str(params?.error) || str(params?.message),
  };
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
