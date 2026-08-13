import type { ImageAttachment } from "./attachments";

/**
 * One rendered block of a member's conversation.
 *
 * Shared rather than renderer-owned because the MAIN process is what persists a
 * transcript. It used to be written only by a window's debounced save, which
 * meant two windows on one member wrote the same file twice, and a member driven
 * with NO window open — the normal shape for an agent-run party — was never
 * written at all. Folding events into these blocks therefore has to run
 * somewhere both sides can reach. See `shared/transcriptEvents.ts`.
 */
export type TranscriptBlock =
  // `sent` marks a status line that is the harness echoing back a user turn the
  // app just submitted. It is the user's own message, not agent output, so it
  // does not end a reply that is still streaming (see appendText, [#14]).
  // `fromQueue` marks a user block that WAITED in the member's message queue
  // before being handed over. It is permanent on purpose: scrolling back, the
  // badge is the only way to tell that this message reached the agent later than
  // it was typed. `queuedN` > 1 means several queued items merged into it, and
  // `from` names the sending member (absent = the user). See shared/messageQueue.ts.
  | { id: string; kind: "user" | "assistant" | "reasoning" | "status" | "error"; text: string; attachments?: ImageAttachment[]; sent?: boolean; at?: string; fromQueue?: boolean; queuedN?: number; from?: string | null }
  | { id: string; kind: "tool"; name: string; status?: string; input?: unknown; result?: unknown; source?: string; cwd?: string; exitCode?: number; durationMs?: number; output?: string; at?: string }
  // A Codex plan/TODO card (from a plan item + turn/plan/updated); latest wins.
  | { id: string; kind: "plan"; steps: import("./codexItems").CodexPlanStep[]; explanation?: string; at?: string }
  // A Codex fileChange item: per-file diff with +/- stats.
  | { id: string; kind: "fileChange"; changes: import("./codexItems").CodexFileEdit[]; status?: string; at?: string }
  // The machine is not set up to run this member (harness CLI missing, or not
  // signed in). A SINGLETON per `checkId`: a permanently broken environment
  // fails on every turn, and stacking one identical red wall per attempt is the
  // behaviour this block replaces. Re-firing moves the card back to the bottom
  // instead of adding one, so it stays next to the message that just failed.
  // Carries only the check id — the card resolves label/detail/remedies from
  // the live environment report, so it can never disagree with the 환경 tab.
  | { id: string; kind: "environment"; checkId: string; text: string; raw?: string; at?: string }
  // A surfaced Codex diagnostic (reroute / rate-limit / warning); never silently dropped.
  // `repeat` counts consecutive identical occurrences folded into one block
  // (≥2 renders a ×N badge) — a re-firing diagnostic ticks a counter, never stacks.
  | { id: string; kind: "diagnostic"; severity: "info" | "warning" | "error"; category: string; title: string; detail?: string; recovery?: string; repeat?: number; at?: string }
  // Inter-member (agentparty channel) message. `direction` is relative to the
  // member whose transcript this is: "in" = received, "out" = this member sent.
  // `fromQueue` marks an inbound card whose message WAITED in this member's
  // queue before delivery. Member-to-member traffic renders as this card rather
  // than a user bubble, so the queue provenance rides here too — see applyEvents.
  | { id: string; kind: "channel"; direction: "in" | "out"; from: string; to: string; text: string; state?: "ok" | "failed"; error?: string; at?: string; /** Envelope origin: another member ("agentparty") or the Discord bridge. */ source?: "agentparty" | "discord"; fromQueue?: boolean; queuedN?: number }
  /**
   * An image the MEMBER attached for the user to look at (attach-image).
   *
   * Deliberately NOT a `user` block with `attachments`: those bytes are fed to
   * the model, and this card exists precisely so they are not. The member knows
   * only the path or URL it named — the picture rides here, outside the
   * conversation. `file` is a name in the workspace image store (served by
   * `GET /api/party/transcript-image/:file`); `url` is a remote address the
   * renderer loads directly, kept as given rather than downloaded.
   */
  | { id: string; kind: "image"; file?: string; url?: string; mediaType?: string; bytes?: number; caption?: string; origin?: string; state?: "ok" | "failed"; error?: string; at?: string }
  // A party write-action this member drove (member-create / member-remove).
  | { id: string; kind: "partyAction"; action: "create" | "remove"; member: string; role?: string; model?: string; harness?: string; state?: "ok" | "failed"; error?: string; at?: string }
  // A Message Gate outcome for an OUTGOING send by this member (inline badge).
  // rejected = blocked (not delivered) · forced = bypassed the gate · failed =
  // reviewer errored so it was delivered unreviewed (fail-open). UI-only.
  | { id: string; kind: "gate"; gate: "rejected" | "forced" | "failed"; to: string; from?: string; reason?: string; rule?: string; errcode?: string; at?: string }
  /**
   * A context compaction, as ONE block that is replaced in place rather than a
   * trail of raw log lines (`compacting` → `compacted: success` → `compact:
   * {"trigger":…}`). The numeric fields mirror the SDK's `compact_metadata` and
   * are ALL optional there too — Codex reports no numbers at all, and Claude
   * omits `post_tokens`/`duration_ms` on some boundaries — so the card shows
   * only what actually arrived instead of printing zeroes.
   */
  | { id: string; kind: "compact"; state: "running" | "done" | "failed"; trigger?: "manual" | "auto"; preTokens?: number; postTokens?: number; durationMs?: number; keptCount?: number; reason?: string; at?: string;
      /**
       * Epoch ms the compaction started. `at` cannot serve: it is a display
       * clock ("14:02"), so the elapsed counter would have had no origin to
       * count from and would have restarted on every remount.
       */
      startedMs?: number }
  | {
      id: string;
      kind: "approval";
      requestId: string;
      toolName: string;
      title?: string;
      description?: string;
      input?: unknown;
      resolved?: "allow" | "deny";
      /** Codex approval metadata (command/diff/decision options); Codex requests only. */
      codex?: import("./codexApproval").CodexApprovalMeta;
      /** Claude Code: the permission updates an "always allow" would store. */
      suggestions?: unknown[];
      /** Claude Code: the path that triggered the prompt (e.g. a write outside cwd). */
      blockedPath?: string;
      /** Claude Code: the subagent that raised it, when not the main loop. */
      agentID?: string;
      /** For AskUserQuestion: the user's chosen answers (question text -> label). */
      answers?: Record<string, string>;
      at?: string;
    };
