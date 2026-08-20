import type { EnvironmentCheck, EnvironmentProbeStep } from "./environment";
import type { AuthProviderState, NativeCliAuthHost, NativeCliAuthProgress, NativeCliAuthProvider } from "./types";

interface StepPlan {
  id: string;
  label: string;
}

const WINDOWS_PLANS: Record<NativeCliAuthProvider, StepPlan[]> = {
  claude: [
    { id: "workspace", label: "작업공간" },
    { id: "executable", label: "실행 파일" },
    { id: "version", label: "버전 확인" },
    { id: "runtime", label: "프로세스 실행" },
    { id: "authentication", label: "로그인" },
  ],
  codex: [
    { id: "workspace", label: "작업공간" },
    { id: "executable", label: "실행 파일" },
    { id: "version", label: "버전 확인" },
    { id: "authentication", label: "로그인" },
    { id: "state", label: "상태 저장소" },
    { id: "runtime", label: "app-server 초기화" },
  ],
  cursor: [
    { id: "executable", label: "실행 파일" },
    { id: "version", label: "버전 확인" },
    { id: "authentication", label: "로그인" },
  ],
  grok: [
    { id: "executable", label: "실행 파일" },
    { id: "version", label: "버전 확인" },
    { id: "identity", label: "공식 CLI 확인" },
    { id: "credential", label: "자격 증명 파일" },
    { id: "authentication", label: "로그인" },
  ],
};

const WSL_PLANS: Record<NativeCliAuthProvider, StepPlan[]> = {
  claude: [
    { id: "distribution", label: "WSL 배포판" },
    { id: "workspace", label: "작업공간" },
    { id: "executable", label: "실행 파일" },
    { id: "version", label: "버전 확인" },
    { id: "runtime", label: "프로세스 실행" },
    { id: "authentication", label: "로그인" },
  ],
  codex: [
    { id: "distribution", label: "WSL 배포판" },
    { id: "workspace", label: "작업공간" },
    { id: "executable", label: "실행 파일" },
    { id: "version", label: "버전 확인" },
    { id: "authentication", label: "로그인" },
    { id: "runtime", label: "app-server 초기화" },
  ],
  cursor: [
    { id: "distribution", label: "WSL 배포판" },
    { id: "workspace", label: "작업공간" },
    { id: "executable", label: "실행 파일" },
    { id: "version", label: "버전 확인" },
    { id: "authentication", label: "로그인" },
  ],
  grok: [
    { id: "distribution", label: "WSL 배포판" },
    { id: "workspace", label: "작업공간" },
    { id: "executable", label: "실행 파일" },
    { id: "version", label: "버전 확인" },
    { id: "identity", label: "공식 CLI 확인" },
    { id: "authentication", label: "로그인" },
  ],
};

export function nativeCliAuthCardId(provider: NativeCliAuthProvider, host: NativeCliAuthHost): string {
  if (provider === "claude") return host === "windows" ? "claude-native" : "claude-native-wsl";
  return host === "windows" ? provider : `${provider}-wsl`;
}

export function nativeCliAuthStepPlan(provider: NativeCliAuthProvider, host: NativeCliAuthHost): StepPlan[] {
  return (host === "windows" ? WINDOWS_PLANS : WSL_PLANS)[provider];
}

function incompleteStep(plan: StepPlan, status: "pending" | "running" | "skipped"): EnvironmentProbeStep {
  return {
    ...plan,
    status,
    detail: status === "running"
      ? "검사 중…"
      : status === "skipped"
        ? "앞선 단계가 실패해 실행하지 않았습니다."
        : "검사 대기 중",
  };
}

/**
 * Keeps the full plan visible from the first frame while replacing each row
 * with the real probe result as that boundary completes.
 */
export function nativeCliAuthProgressCheck(
  provider: NativeCliAuthProvider,
  host: NativeCliAuthHost,
  completed: EnvironmentProbeStep[],
  phase: NativeCliAuthProgress["phase"],
  finalCheck?: EnvironmentCheck,
): EnvironmentCheck {
  const plan = nativeCliAuthStepPlan(provider, host);
  const actual = new Map(completed.map((step) => [step.id, step]));
  const firstIncomplete = plan.findIndex((step) => !actual.has(step.id));
  const planned = plan.map((step, index) => {
    const result = actual.get(step.id);
    if (result) return result;
    if (phase === "complete") return incompleteStep(step, "skipped");
    if (phase === "running" && index === firstIncomplete) return incompleteStep(step, "running");
    return incompleteStep(step, "pending");
  });
  const knownIds = new Set(plan.map((step) => step.id));
  const extras = completed.filter((step) => !knownIds.has(step.id));
  const label = provider === "claude" ? "Claude" : provider === "codex" ? "Codex" : provider === "cursor" ? "Cursor" : "Grok";
  const base: EnvironmentCheck = finalCheck || {
    id: `native.${provider}.${host}`,
    group: host === "wsl" ? "wsl" : "harness",
    label: `${label} · ${host === "windows" ? "Windows" : "WSL"}`,
    status: "unknown",
    detail: phase === "pending" ? "연결 검사를 준비하고 있습니다." : "연결 검사를 진행하고 있습니다.",
    host: host === "windows" ? { kind: "windows", label: "Windows" } : undefined,
  };
  return { ...base, steps: [...planned, ...extras] };
}

export function applyNativeCliAuthProgress(states: AuthProviderState[], progress: NativeCliAuthProgress): AuthProviderState[] {
  const id = nativeCliAuthCardId(progress.provider, progress.host);
  return states.map((state) => {
    if (state.id !== id) return state;
    const steps = progress.check.steps || [];
    const firstFailure = steps.find((step) => step.status === "failed");
    const usable = progress.check.status === "ok" || progress.check.status === "warn";
    const status: AuthProviderState["status"] = progress.phase !== "complete"
      ? "unknown"
      : usable
        ? "available"
        : progress.check.status === "missing"
          ? "missing"
          : progress.check.status === "unknown"
            ? "unknown"
            : "invalid";
    return {
      ...state,
      status,
      authenticated: progress.phase === "complete" && usable,
      source: progress.check.path || state.source,
      detail: firstFailure ? `${firstFailure.label} 단계 실패: ${firstFailure.detail}` : progress.check.detail,
      host: progress.check.host?.label || state.host,
      workspace: progress.check.host?.workspace || state.workspace,
      command: [...steps].reverse().find((step) => Boolean(step.command))?.command || state.command,
      test: {
        checkedAt: progress.checkedAt,
        status: progress.phase === "complete" ? "complete" : "running",
        steps,
      },
    };
  });
}
