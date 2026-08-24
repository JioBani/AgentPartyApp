/**
 * The party-member primer — the system/developer prompt every member session
 * starts with.
 *
 * It is stored as a LIST OF SECTIONS rather than one blob for two reasons:
 *   1. a human has to be able to read it. "파티 통신 규약", "Message Gate 규약"
 *      and "Discord" are separate concerns and are edited separately in
 *      Agent → 파티 프롬프트;
 *   2. a user override then replaces only the section it targets, so the rest of
 *      the primer keeps tracking the app (new tools, new protocol rules) instead
 *      of freezing at whatever the text said the day it was edited.
 *
 * Section bodies are STATIC templates with `{{party}}` / `{{member}}` / `{{role}}`
 * placeholders, resolved at session start. That is what lets an edited section
 * stay identity-independent: the same override text works for every member.
 *
 * Lives in `shared` (not `core`) because the renderer's settings screen shows the
 * same defaults the session is built from — one source of truth, no second copy
 * of the prompt to drift.
 */

/** The identity the app binds to a member session; never model-supplied. */
export interface PartyIdentity {
  /** The party this session's member belongs to. */
  party: string;
  /** This session's member name — stamped as `from` on every send. */
  member: string;
  /** This member's role/requirement, surfaced in the session primer. */
  role?: string;
}

export const PARTY_MCP_SERVER = "agentparty-app";

/** Fully-qualified prefix of the in-process party tools (`mcp__<server>__<tool>`). */
export const PARTY_TOOL_PREFIX = `mcp__${PARTY_MCP_SERVER}__`;

const tool = (name: string) => `${PARTY_TOOL_PREFIX}${name}`;

export const PARTY_PRIMER_SECTION_IDS = ["identity", "tools", "protocol", "discipline", "gate", "discord"] as const;

export type PartyPrimerSectionId = (typeof PARTY_PRIMER_SECTION_IDS)[number];

export interface PartyPrimerSectionDef {
  id: PartyPrimerSectionId;
  /** Section name in the settings UI. */
  title: string;
  /** One line telling the user what turning this section off would cost. */
  summary: string;
  /**
   * Sections the app itself depends on: identity and the tool surface are how a
   * member knows who it is and which tools are real, so they can be edited but
   * not switched off.
   */
  required?: boolean;
  /** Default text, with `{{party}}` / `{{member}}` / `{{role}}` placeholders. */
  body: string;
}

const IDENTITY_BODY = [
  "# AgentParty — party member session",
  "",
  "You are a member running inside the **AgentParty** desktop app, where several AI coding sessions (members) share one workspace and message each other. You can drive the app's party features directly through its in-process tools.",
  "",
  "Your identity is fixed by the app (never restate or change it):",
  "- Party: {{party}}",
  "- Your member name: {{member}}",
  "- Your role: {{role}}",
].join("\n");

const TOOLS_BODY = [
  "## Party tools — use ONLY this surface",
  "All party actions go through the `agentparty-app` server. These are the only party tools you may call:",
  `- \`${tool("send")}\` — message another member of your party (errors if the recipient is not running). Your \`from\` is set automatically to \`{{member}}\` — never supply it. When \`interrupt\` is omitted, your saved member override and then the Runtime default apply. Pass \`true\` to cut in or \`false\` to be explicitly QUEUED behind the recipient's current turn (a Codex member receives it at its next tool call).`,
  `- \`${tool("broadcast")}\` — send one message to EVERY other member at once (same QUEUE-then-current-turn timing, and the same optional \`interrupt\`).`,
  `- \`${tool("member-status")}\` — check whether a member's turn is running (busy) or stopped; omit \`name\` for all members.`,
  `- \`${tool("interrupt")}\` — stop a member's in-flight turn (\`target\`: member name, or 'all' for everyone except you). You cannot interrupt yourself.`,
  `- \`${tool("member-create")}\` — create a new member and start its session (call \`${tool("list-models")}\` for harness/model settings and \`${tool("list-locations")}\` for recent cwd suggestions). Pass \`location: {host, cwd, distro?}\` to choose Windows/WSL explicitly; omit it to inherit your location.`,
  `- \`${tool("member-remove")}\` — remove a member from your party (cannot remove 'main').`,
  `- \`${tool("member-permission")}\` — change another member's permission; use \`permissionMode\` (Claude Code), \`codexPolicy\` (Codex), or \`cursorPolicy\` (Cursor).`,
  `- \`${tool("gate-set")}\` — set another member's Message Gate (the reviewer of that member's OUTGOING messages): \`mode\` (inherit|on|off), \`rule\` (text to enforce, null to inherit the party rule), \`reviewer\` ({model, effort}, null for the default).`,
  `- \`${tool("party-gate-set")}\` — set the PARTY-WIDE gate every inheriting member follows: \`enabled\`, \`rule\`, \`reviewer\`. It moves every inheriting member at once, so reach for \`${tool("gate-set")}\` when only one member should change.`,
  `- \`${tool("list")}\` — list your party's members and their status.`,
  `- \`${tool("list-locations")}\` — list supported execution hosts and recent/default cwd suggestions for \`${tool("member-create")}\`.`,
  `- \`${tool("list-models")}\` — discover available harnesses, models, and reasoning options.`,
  `- \`${tool("attach-image")}\` — show the user a local or web image in your conversation without putting its bytes in model context.`,
  `- \`${tool("discord-connect")}\` / \`${tool("discord-send")}\` / \`${tool("discord-send-image")}\` / \`${tool("discord-disconnect")}\` — bridge YOURSELF to Discord so the user can follow you from a phone or another PC. See the section below.`,
  "",
  "⚠️ Other similarly-named tools — e.g. `mcp__agentparty__*` or `mcp__plugin_*_agentparty__*` — are LEGACY and must not be used. Drive every party action through the `agentparty-app__*` tools above.",
].join("\n");

const PROTOCOL_BODY = [
  "## Communication protocol",
  '- Messages from other members arrive as a user turn wrapped in `<channel source="agentparty" from="…" to="…">…</channel>`.',
  `- To reply or initiate, call \`${tool("send")}\` with the recipient's member name. Replies are asynchronous: the other member's response arrives later as its own incoming message.`,
  '- **Turn timing (read this to avoid "tangled" turns).** Each member handles ONE turn at a time. A message you send lands in the recipient\'s queue and is only read when their CURRENT turn ends — for a Codex member, at its next tool call. So right after you send: they have NOT seen it yet if they were busy, and a slow reply means they are still finishing earlier work, not that your message was dropped. It will be handled in order once their turn completes.',
  `- Before assuming a message was missed, check \`${tool("member-status")}\` (or \`${tool("list")}\`) to see if the member is busy. When a message genuinely cannot wait for their current turn, use \`interrupt: true\` on \`${tool("send")}\`/\`${tool("broadcast")}\`, or call \`${tool("interrupt")}\` — this stops their turn so your message is seen immediately.`,
  `- **Do not poll member status.** After assigning work, wait for the member's asynchronous reply. Call \`${tool("member-status")}\` only when its answer changes what you will do next; do not repeat unchanged status checks merely to watch progress.`,
].join("\n");

const DISCIPLINE_BODY = [
  "## Talking to other members — keep it tight",
  "- **Preserve the user's priorities.** Keep the user's current priorities in place unless the user explicitly changes them.",
  "- **Unblock short dependencies first when that preserves the user's priorities.** If another member is waiting for your output, decision, or status, and a brief response can unblock them without changing or disrupting the current priority while reducing total task time, send the minimum useful answer or output first. It must contain actionable information that lets them proceed, never a bare acknowledgement.",
  "- After unblocking them, continue your primary task and parallelize independent work. If their request is long or would change the current priority, keep the user's priority, queue the request, or coordinate the ordering explicitly instead of silently switching tasks.",
  "- Default to choices that reduce the overall task's critical path and other members' waiting time.",
  "- **Be short without losing information.** Compress the wording, never the facts the recipient needs to act: the decision, the concrete target (file, member, branch), and what you want back.",
  "- **No emotional language.** Drop praise, apologies, enthusiasm and reassurance — short sentences carrying only the substance. Say what is true and what you need; a fact needs no feeling attached to it.",
  "- **Send only what that member needs.** Do not push context, logs, transcripts or side-findings to someone just because you have them. Broadcasting something one member cares about costs every other member a turn.",
  "- **Let each member stay on its own concern.** Members work efficiently precisely because they are each focused on their own piece, so over-sharing what the other does not need to know is not generosity — it pulls their attention off their task. Tell them what changes what they must do; keep the rest.",
  "- **Watch the shape of the exchange.** Every few messages, check the thread against the task: are you drilling into a problem that does not actually matter here, or amplifying a small issue into a big one? If so, say it plainly in one line and pull the thread back to the task instead of continuing it.",
].join("\n");

const GATE_BODY = [
  "## Message Gate — your outgoing messages may be reviewed",
  `- Your party may enable a **Message Gate**: before a message you send (\`${tool("send")}\` or \`${tool("broadcast")}\`) is delivered, a lightweight reviewer model checks it against the party's communication rules (e.g. "be concise", "don't route through the orchestrator — talk to the owner directly").`,
  `- If the reviewer **rejects** your message, it is NOT delivered and the \`${tool("send")}\` tool returns \`{ok:false, error:"<reason>"}\`. The reason tells you exactly which rule you broke and how to fix it — rewrite your message to comply and send again. This is normal, not an error on your side.`,
  "- **Work with the feedback inside this session.** Take the rejection reason seriously and genuinely try to satisfy it in your next attempt, rather than resending the same text or giving up on the message.",
  `- **Your judgement outranks the gate.** The gate is a reviewer, not an authority: when the message truly must go through as it is (a real blocker, an urgent correction, content the rule would mangle), send it with \`force: true\` and a short \`forceReason\`. Use it deliberately — every forced send is surfaced to the user — but do not let the gate stop necessary information.`,
  "- **Never write gate feedback to memory.** It is per-message review of one message, not a lasting fact about the user, the party, or the project. Storing it would keep applying a one-off correction long after it stopped being true.",
  "- The gate is fail-open: if the reviewer itself errors, your message is delivered unreviewed (with a visible notice), so a gate problem never blocks your work.",
  `- You can also configure another member's gate with \`${tool("gate-set")}\` when coordinating (e.g. tighten or relax a teammate's outgoing-message rules).`,
].join("\n");

const DISCORD_BODY = [
  "## Discord bridge — reporting to the user when they are away",
  `- If the user asks you to "connect to Discord" (or to report there), call \`${tool("discord-connect")}\` once. It creates or reuses a channel named after you in the user's server. Then use \`${tool("discord-send")}\` to report.`,
  '- Messages the user types in that channel arrive here as an ordinary user turn wrapped in `<channel source="discord" from="…">…</channel>`. Reply the same way you reply to the user in the app — and when the reply is meant for Discord, send it with `discord-send` as well, because the user is reading there, not in the app.',
  "- **Write for a person on a phone.** Summarize the situation in a few lines. Do NOT paste raw logs, diffs, stack traces or file dumps.",
  `- **2000 characters is a hard limit.** \`${tool("discord-send")}\` REJECTS longer content instead of truncating it — split the report into several sends yourself.`,
  "- **Rate limits are yours to handle.** Nothing is queued or retried for you. If the tool returns an error containing `retry_after_ms`, wait at least that long, then send again.",
  `- **Images work both ways.** \`${tool("discord-send-image")}\` uploads a screenshot or chart from this machine; an image the user attaches in Discord arrives as an ordinary attachment on the user turn. Everything else (buttons, menus, modals, non-image files) does not exist — never claim the user can click something.`,
  "- Approvals and permission prompts are NOT available over Discord. If you are blocked on one, say so in the channel and ask the user to handle it in the app.",
  '- **Do not send a bare acknowledgement** ("받았습니다", "on it"). The app already marks the user\'s message 📨 delivered → ⚙️ working → ✅ done from the harness itself, so a receipt message only costs a turn. Send content, not confirmation.',
  "- The user can also drive the app from Discord with `!` commands (`!상태`, `!연결`, `!중단`, `!재시작`). Those are handled by the app, never by you — you will not see them.",
].join("\n");

/**
 * The primer, in the order it is assembled. Editing this list is the only way to
 * change what a member is told at session start.
 */
export const PARTY_PRIMER_SECTIONS: readonly PartyPrimerSectionDef[] = [
  { id: "identity", title: "정체성", summary: "앱·파티·멤버 이름을 알려주는 도입부입니다.", required: true, body: IDENTITY_BODY },
  { id: "tools", title: "파티 툴", summary: "멤버가 호출할 수 있는 툴 목록과 레거시 툴 경고입니다.", required: true, body: TOOLS_BODY },
  { id: "protocol", title: "통신 규약", summary: "메시지 도착 형식과 턴 타이밍(큐잉·인터럽트) 설명입니다.", body: PROTOCOL_BODY },
  { id: "discipline", title: "소통 원칙", summary: "감정 빼고 짧게 · 상대에게 필요한 것만 · 삼천포·과잉증폭 방지 — 멤버 간 대화 태도입니다.", body: DISCIPLINE_BODY },
  { id: "gate", title: "Message Gate 규약", summary: "검문 피드백 수용, 강제 전송, 게이트보다 세션 판단이 우선임을 알립니다.", body: GATE_BODY },
  { id: "discord", title: "Discord 브리지", summary: "Discord 채널로 사용자에게 보고하는 방법과 한계입니다.", body: DISCORD_BODY },
];

export function partyPrimerSection(id: string): PartyPrimerSectionDef | undefined {
  return PARTY_PRIMER_SECTIONS.find((section) => section.id === id);
}

/** One section's user override. Absent = built-in text, enabled. */
export interface PartyPrimerSectionOverride {
  /** Replacement text; absent/empty = use the built-in body. */
  text?: string;
  /** `false` drops the section from the primer entirely (ignored for required sections). */
  enabled?: boolean;
}

/**
 * A stored Korean reading of one section. The primer itself stays English (that
 * is what the models are given); this exists so a human can check what the
 * members are actually told.
 */
export interface PartyPrimerTranslation {
  text: string;
  /**
   * Hash of the ENGLISH text this was translated from. The translation is stale
   * exactly when that no longer matches the section's current text — which is
   * how editing the prompt marks its translation out of date without anyone
   * having to remember to.
   */
  sourceHash: string;
  /** Catalog model id that produced it, so a bad translation is attributable. */
  model: string;
  /** ISO timestamp of the call. */
  at: string;
}

/** User customization of the primer, persisted in `AppSettings.partyPrimer`. */
export interface PartyPrimerSettings {
  sections?: Partial<Record<PartyPrimerSectionId, PartyPrimerSectionOverride>>;
  /**
   * Saved translations, keyed by section. Kept separate from `sections` so
   * resetting a section's TEXT does not throw away its translation — the
   * translation simply reads as stale until it is re-run.
   */
  translations?: Partial<Record<PartyPrimerSectionId, PartyPrimerTranslation>>;
}

/**
 * FNV-1a over the source text — a change detector, not a security hash. Written
 * here rather than pulled from `node:crypto` because the renderer computes it
 * too (it decides whether to draw the "번역본이 최신이 아님" banner).
 */
export function primerTextHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** The placeholders an override may use; anything else is left verbatim. */
export const PARTY_PRIMER_VARIABLES = ["{{party}}", "{{member}}", "{{role}}"] as const;

/** Substitutes the identity placeholders. Unknown `{{…}}` text is left alone. */
export function renderPartyPrimerText(template: string, identity: PartyIdentity): string {
  return template
    .replace(/\{\{party\}\}/g, identity.party)
    .replace(/\{\{member\}\}/g, identity.member)
    .replace(/\{\{role\}\}/g, identity.role?.trim() || "(none specified)");
}

/** The text a section contributes before placeholder substitution. */
export function partyPrimerSectionText(section: PartyPrimerSectionDef, settings?: PartyPrimerSettings): string {
  const override = settings?.sections?.[section.id]?.text;
  return typeof override === "string" && override.trim() ? override : section.body;
}

/** Whether a section is included; required sections are always on. */
export function isPartyPrimerSectionEnabled(section: PartyPrimerSectionDef, settings?: PartyPrimerSettings): boolean {
  if (section.required) {
    return true;
  }
  return settings?.sections?.[section.id]?.enabled !== false;
}

/**
 * Session-start primer injected into a member's system prompt. Gives the model
 * deterministic knowledge of the app, its identity, the communication protocol,
 * and — critically — which tool surface to drive, so it never confuses our
 * in-process `agentparty-app` tools with legacy `agentparty` MCP servers that
 * may also be present (project `.mcp.json`, plugins). This is how we avoid
 * relying on model memory: the correct surface is installed when the harness
 * session starts (system/developer instructions where the harness supports it).
 */
export function buildPartyPrimer(identity: PartyIdentity, settings?: PartyPrimerSettings): string {
  return PARTY_PRIMER_SECTIONS
    .filter((section) => isPartyPrimerSectionEnabled(section, settings))
    .map((section) => renderPartyPrimerText(partyPrimerSectionText(section, settings), identity))
    .join("\n\n");
}

/**
 * Rough token footprint of a piece of prompt text.
 *
 * An ESTIMATE, and labelled as one everywhere it is shown: the app has no
 * tokenizer for the models it drives, and the providers' counts differ from each
 * other anyway. Counted per script because one ratio for both is wrong by more
 * than 2x: Latin prompt text runs ~3.8 characters per token, while Hangul is
 * token-dense at ~1.6 (a translated section costs far more than its English
 * source even though it looks shorter).
 *
 * Use it to compare sections and to see what trimming one buys — not as a bill.
 */
export function estimatePrimerTokens(text: string): number {
  let hangul = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if ((code >= 0xac00 && code <= 0xd7a3) || (code >= 0x1100 && code <= 0x11ff) || (code >= 0x3130 && code <= 0x318f)) {
      hangul += 1;
    }
  }
  const other = text.length - hangul;
  return Math.round(hangul / 1.6 + other / 3.8);
}

/**
 * WHEN each harness receives the primer. Stated per harness because they differ
 * in a way that matters for cost and for "why didn't my edit take effect":
 * nobody re-sends it per turn, but the moment it IS installed decides when a
 * change reaches a member.
 *
 * Kept next to the primer itself so the settings screen cannot drift from what
 * the adapters actually do (`claudeAdapter.partySystemPrompt`,
 * `codexAdapter.partyDeveloperInstructions`, `cursorAdapter.buildPrompt`).
 */
/**
 * WHICH channel the primer occupies. Not cosmetic: a system/developer prompt is
 * out-of-band instruction the model treats as its standing brief and the user
 * never sees, while a `user` primer is an ordinary first message that sits in
 * the visible chat history and can be summarised away by compaction.
 */
export type PartyPrimerChannel = "system" | "developer" | "user";

export const PARTY_PRIMER_CHANNEL_LABELS: Record<PartyPrimerChannel, string> = {
  system: "시스템 프롬프트",
  developer: "개발자 프롬프트",
  user: "첫 사용자 메시지",
};

export interface PartyPrimerDelivery {
  harness: "claude-code" | "codex" | "cursor" | "grok";
  label: string;
  /** Where it goes — see {@link PartyPrimerChannel}. */
  channel: PartyPrimerChannel;
  /** Short answer to "턴마다? 시작할 때?". */
  when: string;
  detail: string;
  /** False = this harness's members never receive the primer at all. */
  delivered: boolean;
}

export const PARTY_PRIMER_DELIVERY: readonly PartyPrimerDelivery[] = [
  {
    harness: "claude-code",
    label: "Claude Code",
    channel: "system",
    when: "세션 시작 시 1회",
    detail: "세션이 뜰 때 시스템 프롬프트에 덧붙습니다(preset append). 턴마다 앱이 다시 얹지 않으며, 대화 기록에도 남지 않습니다.",
    delivered: true,
  },
  {
    harness: "codex",
    label: "Codex",
    channel: "developer",
    when: "스레드 시작·재개 시 1회",
    detail: "thread/start 의 developer instructions 로 한 번, 스레드를 재개할 때 같은 값으로 한 번 더 설치됩니다. turn/start 입력에는 사용자 메시지만 담기므로 프라이머가 대화로 반복 쌓이지 않습니다.",
    delivered: true,
  },
  {
    harness: "cursor",
    label: "Cursor CLI",
    channel: "user",
    when: "첫 메시지에 1회",
    detail: "cursor-agent 에는 시스템·개발자 프롬프트 자리가 없어 첫 프롬프트 앞에 한 번 붙습니다. 이후 턴에는 붙지 않고 그 채팅 기록에 남습니다.",
    delivered: true,
  },
  {
    harness: "grok",
    label: "Grok Build",
    channel: "user",
    when: "첫 메시지에 1회",
    detail: "ACP 의 session/new 에는 시스템·개발자 프롬프트 자리가 없어(cwd·MCP 서버뿐) Cursor 와 같은 방식으로 첫 프롬프트 앞에 한 번 붙습니다. 스레드를 재개할 때는 이미 기록에 있으므로 다시 보내지 않습니다.",
    delivered: true,
  },
];

/** One section as the settings screen and the automation API see it. */
export interface PartyPrimerSectionView {
  id: PartyPrimerSectionId;
  title: string;
  summary: string;
  required: boolean;
  enabled: boolean;
  /** The built-in text (what "기본값으로 되돌리기" restores). */
  defaultText: string;
  /** The text actually used — the override when set, else `defaultText`. */
  text: string;
  customized: boolean;
  /** Estimated tokens this section adds to every member session (see `estimatePrimerTokens`). */
  tokens: number;
  /**
   * The saved Korean reading, when there is one. `stale` means the English text
   * changed after it was made, so it no longer describes what members are told.
   */
  translation?: PartyPrimerTranslation & { stale: boolean };
}

/** The whole primer as sections, for the settings UI and `GET /api/party/primer`. */
export function partyPrimerView(settings?: PartyPrimerSettings): PartyPrimerSectionView[] {
  return PARTY_PRIMER_SECTIONS.map((section) => {
    const text = partyPrimerSectionText(section, settings);
    const saved = settings?.translations?.[section.id];
    return {
      id: section.id,
      title: section.title,
      summary: section.summary,
      required: Boolean(section.required),
      enabled: isPartyPrimerSectionEnabled(section, settings),
      defaultText: section.body,
      text,
      customized: text !== section.body,
      tokens: estimatePrimerTokens(text),
      translation: saved ? { ...saved, stale: saved.sourceHash !== primerTextHash(text) } : undefined,
    };
  });
}

/** What the assembled primer costs a member session, and what is off. */
export interface PartyPrimerTotals {
  /** Estimated tokens of the primer as assembled (enabled sections only). */
  tokens: number;
  characters: number;
  enabledSections: number;
  totalSections: number;
  /** Estimated tokens of the sections currently switched OFF — what they would add back. */
  disabledTokens: number;
}

export function partyPrimerTotals(sections: PartyPrimerSectionView[]): PartyPrimerTotals {
  const enabled = sections.filter((section) => section.enabled);
  // Section joins add a blank line each; counted so the total matches the text a
  // session actually receives rather than the sum of the parts.
  const assembled = enabled.map((section) => section.text).join("\n\n");
  return {
    tokens: estimatePrimerTokens(assembled),
    characters: assembled.length,
    enabledSections: enabled.length,
    totalSections: sections.length,
    disabledTokens: sections.filter((section) => !section.enabled).reduce((sum, section) => sum + section.tokens, 0),
  };
}

/**
 * Validates stored/HTTP customization: unknown section ids and non-string text
 * are dropped, and a section that carries neither an override nor a disable is
 * not persisted, so the file never fills with no-op entries.
 */
export function normalizePartyPrimerSettings(value: unknown): PartyPrimerSettings | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const rawSections = ((value as PartyPrimerSettings).sections || {}) as Record<string, unknown>;
  const rawTranslations = ((value as PartyPrimerSettings).translations || {}) as Record<string, unknown>;
  const sections: Partial<Record<PartyPrimerSectionId, PartyPrimerSectionOverride>> = {};
  const translations: Partial<Record<PartyPrimerSectionId, PartyPrimerTranslation>> = {};
  for (const section of PARTY_PRIMER_SECTIONS) {
    const translation = normalizePartyPrimerTranslation(rawTranslations[section.id]);
    if (translation) {
      translations[section.id] = translation;
    }
    const raw = (rawSections as Record<string, unknown>)[section.id];
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const next: PartyPrimerSectionOverride = {};
    const text = (raw as PartyPrimerSectionOverride).text;
    if (typeof text === "string" && text.trim() && text !== section.body) {
      next.text = text;
    }
    // A required section cannot be disabled, so a stored `false` for one is
    // dropped rather than kept as a setting that quietly does nothing.
    if ((raw as PartyPrimerSectionOverride).enabled === false && !section.required) {
      next.enabled = false;
    }
    if (next.text !== undefined || next.enabled !== undefined) {
      sections[section.id] = next;
    }
  }
  const next: PartyPrimerSettings = {};
  if (Object.keys(sections).length) {
    next.sections = sections;
  }
  if (Object.keys(translations).length) {
    next.translations = translations;
  }
  return next.sections || next.translations ? next : undefined;
}

/** Validates one stored translation; anything half-written is dropped whole. */
function normalizePartyPrimerTranslation(value: unknown): PartyPrimerTranslation | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const raw = value as Partial<PartyPrimerTranslation>;
  if (typeof raw.text !== "string" || !raw.text.trim()) {
    return undefined;
  }
  // A translation without its source hash could never be judged stale, and a
  // translation that silently claims to be current is worse than none.
  if (typeof raw.sourceHash !== "string" || !raw.sourceHash) {
    return undefined;
  }
  return {
    text: raw.text,
    sourceHash: raw.sourceHash,
    model: typeof raw.model === "string" ? raw.model : "",
    at: typeof raw.at === "string" ? raw.at : "",
  };
}

/**
 * Stores (or clears, with `translation: null`) one section's Korean reading.
 * The caller supplies the English text it was made from, so the stale check
 * compares against exactly what the translator saw — not against whatever the
 * section says by the time the answer came back.
 */
export function applyPartyPrimerTranslation(
  current: PartyPrimerSettings | undefined,
  input: { section: string; translation: (Omit<PartyPrimerTranslation, "sourceHash"> & { source: string }) | null },
): { settings: PartyPrimerSettings | undefined; applied: PartyPrimerSectionView } {
  const section = partyPrimerSection(input.section);
  if (!section) {
    throw new Error(`알 수 없는 프롬프트 섹션입니다: ${input.section} (사용 가능: ${PARTY_PRIMER_SECTION_IDS.join(", ")})`);
  }
  const translations = { ...(current?.translations || {}) };
  if (input.translation === null) {
    delete translations[section.id];
  } else {
    translations[section.id] = {
      text: input.translation.text,
      sourceHash: primerTextHash(input.translation.source),
      model: input.translation.model,
      at: input.translation.at,
    };
  }
  const settings = normalizePartyPrimerSettings({ sections: current?.sections || {}, translations });
  const applied = partyPrimerView(settings).find((view) => view.id === section.id)!;
  return { settings, applied };
}

/**
 * Applies a per-section patch onto the current customization.
 * - `text: string` sets an override; `text: null` (or the built-in text) clears it.
 * - `enabled: boolean` toggles the section; ignored for required sections.
 * Returns the next settings value (`undefined` when nothing is customized).
 */
export function applyPartyPrimerPatch(
  current: PartyPrimerSettings | undefined,
  patch: { section: string; text?: string | null; enabled?: boolean },
): { settings: PartyPrimerSettings | undefined; applied: PartyPrimerSectionView } {
  const section = partyPrimerSection(patch.section);
  if (!section) {
    throw new Error(`알 수 없는 프롬프트 섹션입니다: ${patch.section} (사용 가능: ${PARTY_PRIMER_SECTION_IDS.join(", ")})`);
  }
  if (patch.enabled === false && section.required) {
    throw new Error(`'${section.title}' 섹션은 필수라 끌 수 없습니다.`);
  }
  const sections = { ...(current?.sections || {}) };
  const entry: PartyPrimerSectionOverride = { ...(sections[section.id] || {}) };
  if (patch.text !== undefined) {
    if (patch.text === null || !patch.text.trim() || patch.text === section.body) {
      delete entry.text;
    } else {
      entry.text = patch.text;
    }
  }
  if (typeof patch.enabled === "boolean") {
    if (patch.enabled) {
      delete entry.enabled;
    } else {
      entry.enabled = false;
    }
  }
  sections[section.id] = entry;
  // Translations ride along untouched: an edited section keeps its Korean
  // reading and simply reports itself stale (the hash no longer matches).
  const settings = normalizePartyPrimerSettings({ sections, translations: current?.translations || {} });
  const applied = partyPrimerView(settings).find((view) => view.id === section.id)!;
  return { settings, applied };
}
