/**
 * Mock subagent scenarios — the mock-driven design/QA fixtures.
 *
 * Rather than spawn real subagents (slow, non-reproducible, costs tokens) to see
 * or tweak the subagent UI, these scenarios reproduce each harness's subagent
 * shape as a stream of `subagent` normalized events. Injecting a scenario drives
 * the UI through the EXACT same normalization + renderer fold a live harness
 * would, so a demo/QA never touches a real subagent. See
 * docs/codex-ux-research/08-subagent-activity.md for the raw upstream shapes each
 * scenario mirrors.
 */

import type { SubagentActivity, SubagentBlock, SubagentPhase } from "./subagentActivity";

/** Structural mirror of the core `subagent` normalized event (kept here so this
 *  shared module needs no core import; compatible at the injection boundary). */
export interface SubagentMockEvent {
  type: "subagent";
  agentId: string;
  lifecycle?: {
    phase?: SubagentPhase;
    label?: string;
    role?: string;
    hint?: string;
    assignedTask?: string;
    model?: string;
    tools?: string;
    dur?: string;
  };
  activity?: SubagentActivity;
  block?: SubagentBlock;
  at: string;
}

/** One subagent's authored shape (expanded into events by `expandScenario`). */
interface MockSubagent {
  id: string;
  name: string;
  hint?: string;
  role?: string;
  phase: SubagentPhase;
  task: string;
  tools?: string;
  dur?: string;
  blocks: SubagentBlock[];
}

export interface SubagentScenario {
  /** Which harness's subagent model this mirrors (documentation only). */
  harness: "claude-code" | "codex";
  description: string;
  subagents: MockSubagent[];
}

/**
 * Claude Code flavor — a `tester` member that fanned out `Agent` (formerly `Task`)
 * subagents, one shard per domain. Mirrors the handoff's tester tab: mixed
 * done/working/queued, nested tool blocks, live typing on the working shards.
 * Raw upstream: `Agent` tool_use with input.{description, subagent_type, prompt}
 * + nested child tool_use tagged by `parent_tool_use_id`.
 */
const CLAUDE_TEST_SHARDS: SubagentScenario = {
  harness: "claude-code",
  description: "tester가 도메인별로 띄운 shard-runner 서브에이전트 6개 (2 실행 · 2 완료 · 2 대기)",
  subagents: [
    {
      id: "shard-auth", name: "shard-runner", hint: "auth/**", role: "test-runner", phase: "done", tools: "318 tests", dur: "2m 04s",
      task: "auth 도메인 테스트 샤드를 격리 실행하고 실패·플레이키를 보고.",
      blocks: [
        { kind: "assistant", text: "auth 도메인 318개 테스트를 실행했습니다. 전부 통과, 플레이키 없음." },
        { kind: "tool", name: "run_tests", arg: "shard 1 · auth/**", durationMs: 124000, result: "318 passed · 0 failed · 0 flaky", status: "completed" },
        { kind: "status", text: "done · 0 failures" },
      ],
    },
    {
      id: "shard-api", name: "shard-runner", hint: "api/**", role: "test-runner", phase: "done", tools: "241 tests", dur: "1m 47s",
      task: "api 도메인 테스트 샤드를 격리 실행하고 실패·플레이키를 보고.",
      blocks: [
        { kind: "assistant", text: "api 샤드 완료. 1건이 재시도 후 통과 — 플레이키로 표시했습니다." },
        { kind: "tool", name: "run_tests", arg: "shard 2 · api/**", durationMs: 107000, result: "241 passed · 0 failed · 1 flaky\n~ api/rate-limit.spec.ts › burst (retry 1)", status: "completed" },
        { kind: "status", text: "done · 1 flaky" },
      ],
    },
    {
      id: "shard-billing", name: "shard-runner", hint: "billing/**", role: "test-runner", phase: "working", tools: "2 failures", dur: "1m 12s…",
      task: "billing 도메인 테스트 샤드를 격리 실행하고 실패·플레이키를 보고.",
      blocks: [
        { kind: "assistant", text: "billing 샤드 실행 중. 현재까지 2건 실패 — 세금 반올림 스냅샷 불일치로 보입니다." },
        { kind: "tool", name: "run_tests", arg: "shard 4 · billing/**", result: "204/271 running…\n✗ invoice.spec.ts › applies tax\n✗ invoice.spec.ts › rounds half-cent", status: "started" },
        { kind: "status", text: "working · 204/271 · 2 failures" },
        { kind: "typing" },
      ],
    },
    {
      id: "shard-webhooks", name: "shard-runner", hint: "webhooks/**", role: "test-runner", phase: "working", tools: "0 failures", dur: "0m 51s…",
      task: "webhooks 도메인 테스트 샤드를 격리 실행하고 실패·플레이키를 보고.",
      blocks: [
        { kind: "assistant", text: "webhooks 샤드 실행 중. 아직 실패 없음." },
        { kind: "tool", name: "run_tests", arg: "shard 5 · webhooks/**", result: "88/163 running… · 0 failed", status: "started" },
        { kind: "status", text: "working · 88/163" },
        { kind: "typing" },
      ],
    },
    {
      id: "shard-ui", name: "shard-runner", hint: "ui/**", role: "test-runner", phase: "queued", tools: "대기", dur: "—",
      task: "ui 도메인 테스트 샤드를 격리 실행하고 실패·플레이키를 보고.",
      blocks: [{ kind: "status", text: "queued · 앞선 샤드 완료 대기 중" }],
    },
    {
      id: "shard-e2e", name: "shard-runner", hint: "e2e/**", role: "test-runner", phase: "queued", tools: "대기", dur: "—",
      task: "e2e 스모크 샤드를 격리 실행하고 실패·플레이키를 보고.",
      blocks: [{ kind: "status", text: "queued · 앞선 샤드 완료 대기 중" }],
    },
  ],
};

/**
 * Codex flavor — a `backend` member that spawned a collab agent thread to trace a
 * call graph. Mirrors the handoff's backend `call-tracer`. Raw upstream:
 * `collabAgentToolCall` (spawnAgent, prompt, model, receiverThreadIds) +
 * `subAgentActivity` markers + the child thread's own item stream.
 */
const CODEX_CALL_TRACER: SubagentScenario = {
  harness: "codex",
  description: "backend가 collab 스레드로 띄운 call-tracer 서브에이전트 (완료)",
  subagents: [
    {
      id: "thread-a3f2", name: "call-tracer", hint: "#a3f2", role: "code-explorer", phase: "done", tools: "6 files", dur: "9s",
      task: "verifyRefresh() 를 호출하는 모든 코드 경로를 추적하고, 좁힌 catch 패치의 영향 반경을 보고.",
      blocks: [
        { kind: "assistant", text: "verifyRefresh 호출부를 전수 추적했습니다. 3개 라우트에서 직접 호출하며 모두 동일한 auth 미들웨어 뒤에 있습니다 — 좁힌 catch 패치의 영향 반경은 이 3곳으로 한정됩니다." },
        { kind: "tool", name: "grep", arg: "verifyRefresh 호출부 · 6 matches", durationMs: 40, result: "src/auth/login.ts:31\nsrc/auth/session.ts:77\nsrc/auth/refresh.ts:48\nsrc/mw/requireAuth.ts:22", status: "completed" },
        { kind: "tool", name: "read_file", arg: "src/mw/requireAuth.ts", durationMs: 18, result: "19  const p = await verifyRefresh(token)\n20  // 만료 시 여기서 throw → 상위 500", status: "completed" },
        { kind: "status", text: "done · 위험 반경 3개 라우트 · 회귀 위험 낮음" },
      ],
    },
  ],
};

/**
 * Codex flavor — a `researcher` member whose collab child does WEB RESEARCH.
 * Mirrors the exact block stream the CodexSubagentTracker emits for a
 * web-searching child (verified by replaying the tracker): each `webSearch` item
 * yields a tool card that carries only a query (the harness returns no result
 * body), interleaved with `agentMessage` items — some of which complete empty.
 * This is the regression the user hit: many resultless web_search cards +
 * empty assistant blocks render as a stack of thin "line-like" strips.
 */
const CODEX_WEB_RESEARCH: SubagentScenario = {
  harness: "codex",
  description: "researcher가 collab 스레드로 띄운 웹 리서치 서브에이전트 (웹서치 다수 · 완료)",
  subagents: [
    {
      id: "thread-77e7", name: "agent-77e7", hint: "#77e7", role: "web-researcher", phase: "done", tools: "5 web", dur: "22s",
      task: "2025년에 시행된 고3 영어 3개 시험의 1·2등급 인원/비율을 공식 출처로 확인하고 URL과 함께 정리.",
      blocks: [
        { kind: "tool", name: "web_search", arg: "2026학년도 수능 영어 1등급 비율", status: "completed" },
        { kind: "tool", name: "web_search", arg: "2026학년도 6월 모의평가 영어 등급 인원", status: "completed" },
        { kind: "tool", name: "web_search", arg: "2026학년도 9월 모의평가 영어 절대평가", status: "completed" },
        { kind: "tool", name: "web_search", arg: "한국교육과정평가원 채점 결과 보도자료 PDF", status: "completed" },
        { kind: "tool", name: "web_search", arg: "수능 영어 등급별 인원 누적 비율", status: "completed" },
        {
          kind: "assistant",
          text: "조사 결과, 수능 영어는 절대평가라 개인별 \"백분위\"가 아니라 **등급별 인원·비율**로 공표됩니다.\n\n| 시행 | 공식 명칭 |\n| --- | --- |\n| 2025년 6월 | 2026학년도 6월 모의평가 |\n| 2025년 11월 | 2026학년도 수능 |\n\n- 확인 대상: 한국교육과정평가원 https://www.kice.re.kr/",
        },
      ],
    },
  ],
};

export const SUBAGENT_SCENARIOS: Record<string, SubagentScenario> = {
  "claude-test-shards": CLAUDE_TEST_SHARDS,
  "codex-call-tracer": CODEX_CALL_TRACER,
  "codex-web-research": CODEX_WEB_RESEARCH,
};

export function scenarioNames(): string[] {
  return Object.keys(SUBAGENT_SCENARIOS);
}

/**
 * Expands a scenario into an ordered event stream: each subagent gets a spawn
 * (lifecycle) event, one event per transcript block, and a terminal lifecycle
 * event carrying its final phase + meta. The fold in the renderer merges these
 * by `agentId` exactly as it would a live stream.
 */
export function expandScenario(scenario: SubagentScenario, at: string): SubagentMockEvent[] {
  const events: SubagentMockEvent[] = [];
  for (const sub of scenario.subagents) {
    const spawnPhase: SubagentPhase = sub.phase === "queued" ? "queued" : "working";
    events.push({
      type: "subagent", agentId: sub.id, at,
      lifecycle: { phase: spawnPhase, label: sub.name, hint: sub.hint, role: sub.role, assignedTask: sub.task },
    });
    for (const block of sub.blocks) {
      events.push({ type: "subagent", agentId: sub.id, at, block });
    }
    events.push({ type: "subagent", agentId: sub.id, at, lifecycle: { phase: sub.phase, tools: sub.tools, dur: sub.dur } });
  }
  return events;
}

/** Expands a named scenario, or null if unknown. */
export function expandScenarioByName(name: string, at: string): SubagentMockEvent[] | null {
  const scenario = SUBAGENT_SCENARIOS[name];
  return scenario ? expandScenario(scenario, at) : null;
}
