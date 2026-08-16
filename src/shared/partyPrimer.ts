/**
 * The party-member primer — the system/developer prompt every member session
 * starts with.
 *
 * It is stored as a LIST OF SECTIONS rather than one blob for two reasons:
 *   1. a human has to be able to read it. "파티 통신 규약", "Message Gate 규약"
 *      and "Discord" are separate concerns and are edited separately in
 *      Settings → 런타임 → 파티 프롬프트;
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
  `- \`${tool("member-create")}\` — create a new member and start its session (call \`${tool("list-models")}\` first for valid harness/model/reasoning options).`,
  `- \`${tool("member-remove")}\` — remove a member from your party (cannot remove 'main').`,
  `- \`${tool("member-permission")}\` — change another member's permission; use \`permissionMode\` (Claude Code), \`codexPolicy\` (Codex), or \`cursorPolicy\` (Cursor).`,
  `- \`${tool("gate-set")}\` — set another member's Message Gate (the reviewer of that member's OUTGOING messages): \`mode\` (inherit|on|off), \`rule\` (text to enforce, null to inherit the party rule), \`reviewer\` ({model, effort}, null for the default).`,
  `- \`${tool("party-gate-set")}\` — set the PARTY-WIDE gate every inheriting member follows: \`enabled\`, \`rule\`, \`reviewer\`. It moves every inheriting member at once, so reach for \`${tool("gate-set")}\` when only one member should change.`,
  `- \`${tool("list")}\` — list your party's members and their status.`,
  `- \`${tool("list-models")}\` — discover available harnesses, models, and reasoning options.`,
  `- \`${tool("discord-connect")}\` / \`${tool("discord-send")}\` / \`${tool("discord-disconnect")}\` — bridge YOURSELF to Discord so the user can follow you from a phone or another PC. See the section below.`,
  "",
  "⚠️ Other similarly-named tools — e.g. `mcp__agentparty__*` or `mcp__plugin_*_agentparty__*` — are LEGACY and must not be used. Drive every party action through the `agentparty-app__*` tools above.",
].join("\n");

const PROTOCOL_BODY = [
  "## Communication protocol",
  '- Messages from other members arrive as a user turn wrapped in `<channel source="agentparty" from="…" to="…">…</channel>`.',
  `- To reply or initiate, call \`${tool("send")}\` with the recipient's member name. Replies are asynchronous: the other member's response arrives later as its own incoming message.`,
  '- **Turn timing (read this to avoid "tangled" turns).** Each member handles ONE turn at a time. A message you send lands in the recipient\'s queue and is only read when their CURRENT turn ends — for a Codex member, at its next tool call. So right after you send: they have NOT seen it yet if they were busy, and a slow reply means they are still finishing earlier work, not that your message was dropped. It will be handled in order once their turn completes.',
  `- Before assuming a message was missed, check \`${tool("member-status")}\` (or \`${tool("list")}\`) to see if the member is busy. When a message genuinely cannot wait for their current turn, use \`interrupt: true\` on \`${tool("send")}\`/\`${tool("broadcast")}\`, or call \`${tool("interrupt")}\` — this stops their turn so your message is seen immediately.`,
].join("\n");

const DISCIPLINE_BODY = [
  "## Talking to other members — keep it tight",
  "- **Be short without losing information.** Compress the wording, never the facts the recipient needs to act: the decision, the concrete target (file, member, branch), and what you want back.",
  "- **Send only what that member needs.** Do not push context, logs, transcripts or side-findings to someone just because you have them. Broadcasting something one member cares about costs every other member a turn.",
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
  { id: "discipline", title: "소통 원칙", summary: "짧게·필요한 만큼만·삼천포 방지 — 멤버 간 대화 태도입니다.", body: DISCIPLINE_BODY },
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

/** User customization of the primer, persisted in `AppSettings.partyPrimer`. */
export interface PartyPrimerSettings {
  sections?: Partial<Record<PartyPrimerSectionId, PartyPrimerSectionOverride>>;
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
}

/** The whole primer as sections, for the settings UI and `GET /api/party/primer`. */
export function partyPrimerView(settings?: PartyPrimerSettings): PartyPrimerSectionView[] {
  return PARTY_PRIMER_SECTIONS.map((section) => {
    const text = partyPrimerSectionText(section, settings);
    return {
      id: section.id,
      title: section.title,
      summary: section.summary,
      required: Boolean(section.required),
      enabled: isPartyPrimerSectionEnabled(section, settings),
      defaultText: section.body,
      text,
      customized: text !== section.body,
    };
  });
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
  const rawSections = (value as PartyPrimerSettings).sections;
  if (!rawSections || typeof rawSections !== "object") {
    return undefined;
  }
  const sections: Partial<Record<PartyPrimerSectionId, PartyPrimerSectionOverride>> = {};
  for (const section of PARTY_PRIMER_SECTIONS) {
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
  return Object.keys(sections).length ? { sections } : undefined;
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
  const settings = normalizePartyPrimerSettings({ sections });
  const applied = partyPrimerView(settings).find((view) => view.id === section.id)!;
  return { settings, applied };
}
