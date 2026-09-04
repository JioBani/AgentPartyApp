/**
 * Triggerless member completion plus `!` model completion — a chain of pickers
 * that writes TEXT.
 *
 * ## It changes nothing
 *
 * Picking here does not switch the session's model and sends no command to the
 * harness. It writes the exact string the user would otherwise have typed by
 * hand. Changing the model is the header pill's job and stays there; if this
 * did both, "I inserted a chip, why did the model change?" and "I wanted the
 * text, why did it change?" would both become possible in the same control.
 *
 * ## Why a chain
 *
 * Model, effort, thinking and service tier are not independent lists — which of
 * them even exist is decided by the model just chosen. `grok` supports neither
 * effort nor thinking; a Cursor model adds a service tier. So the stages are
 * derived from the chosen route's capabilities and a stage with nothing to
 * offer never appears. Nothing is shown that cannot be picked, which is why
 * there is no "why is this greyed out?" state to explain.
 *
 * ## Display and payload are different strings
 *
 * A row shows `Haiku 4.5` and writes `claude-haiku-4-5-20251001`. Sending the
 * label instead would hand the model a name it has to guess an id from, and
 * short aliases move between releases (`opus` is not a fixed model). The chip
 * already separates the two — see `composerDraft.ts`.
 */
import { harnessLabel, HARNESS_IDS, type HarnessId } from "../../shared/types";
import { rankByFuzzyAny, rowHaystack } from "./fuzzyMatch";
import { EVERYONE } from "./mentionModel";
import { hasHangul, qwertyFromHangul } from "./hangulKeys";
import { PROVIDER_DOTS, PROVIDER_LABELS, routeProvider, type ProviderId } from "./modelCatalog";
import type { RouteLike } from "./routes";

/**
 * The steps a model completion can walk, in order.
 *
 * Provider comes FIRST because it is the cut that makes the rest small: 66
 * routes is a scan, one provider's handful is a choice. It also matches how the
 * user thinks about the question — you know whose model you want before you know
 * which one.
 */
export type ChainStage = "provider" | "model" | "effort" | "thinking" | "serviceTier";

/**
 * What a chosen row becomes in the message.
 *
 * `member` is here even though members are not part of the model chain, because
 * both lists render and select through the same code — one row type keeps the
 * popover and the key handling from needing to know which list they are in.
 */
export type TokenKind = "provider" | "model" | "harness" | "effort" | "thinking" | "serviceTier" | "member";

export interface CompletionRow {
  /** Stable key within its section. */
  key: string;
  /** Primary text. Rendered, and therefore searched. */
  label: string;
  /** Right-hand text. Rendered, and therefore searched. */
  secondary?: string;
  /** The exact string written into the message. */
  value: string;
  kind: TokenKind;
  /** Set on a model row: drives which stages follow. */
  route?: RouteLike;
  /** Set on a provider row: which provider's models the next stage offers. */
  provider?: string;
  /**
   * Brand mark to draw, as a {@link HarnessIcon} key. Kept as a plain string so
   * this module stays free of JSX — the popover turns it into an element.
   */
  iconKey?: string;
  /** Identity/brand colour: a member's colour, or a provider's catalog dot. */
  accent?: string;
  /** Row-specific styling hook (the `everyone` row). */
  className?: string;
}

export interface CompletionSection {
  key: string;
  label: string;
  rows: CompletionRow[];
}

/** A normal word searches members; an explicit `!` searches the model catalog. */
export type CompletionKind = "model" | "member";

export interface CompletionTrigger {
  kind: CompletionKind;
  /**
   * Spellings of the text typed after the trigger word, best first.
   *
   * More than one when the IME was on: `!햐` carries both `햐` (as typed) and
   * `gi` (the keys behind it). Matching tries them in order.
   */
  queries: string[];
  /** Index of the trigger's first character in the draft. */
  start: number;
  /** Index just past the query (the caret). */
  end: number;
}

/** Most rows offered at once; past this the list is a scan, not a pick. */
export const COMPLETION_LIMIT = 8;

/**
 * Finds the active word immediately before the caret.
 *
 * ## Two deliberately separate surfaces
 *
 * A normal identifier searches MEMBERS only, so typing `i` can offer `impl`
 * without also filling ordinary conversation with model names. A leading `!`
 * searches the MODEL catalog only: `!c` can offer Claude, Codex and Cursor.
 * An empty `!` opens the unfiltered model first stage.
 *
 * ## Why this does not fire by accident
 *
 * Either token must START a word — preceded by the beginning of the draft,
 * whitespace, or an opening bracket. The query is an identifier: a
 * letter/digit/Hangul character followed by letters, digits, `_`, `-` or `.`.
 * `/`, `@`, paths, URLs and punctuation therefore keep their existing meaning.
 * The query stops at whitespace, so completion never swallows a sentence.
 */
export function detectCompletion(draft: string, caret: number): CompletionTrigger | null {
  const upToCaret = draft.slice(0, Math.max(0, caret));
  // The token must not swallow the opening bracket that precedes it, or `(!c`
  // reads as one word starting with `(` and never matches.
  const match = /(^|[\s(\[{"'])([^\s(\[{"']*)$/.exec(upToCaret);
  if (!match) {
    return null;
  }
  const token = match[2];
  if (!token) {
    return null;
  }
  const explicit = token.startsWith("!");
  const query = explicit ? token.slice(1) : token;
  // Matched against the KEYS pressed, not only the glyphs shown: with the IME
  // on, a Latin member/model query may arrive as Hangul from the same keys.
  const typed = (hasHangul(query) ? qwertyFromHangul(query) : query).toLowerCase();

  // A dot and hyphen are allowed after the first character because model ids
  // commonly contain both (`!gpt-5.6`), while the first character must be a
  // real word. Empty is allowed only for explicit `!`, which opens stage one.
  if ((!query && !explicit) || (query && !/^[\p{L}\p{N}_][\p{L}\p{N}_.-]*$/u.test(query))) {
    return null;
  }
  return {
    kind: explicit ? "model" : "member",
    queries: dedupe([query, typed]),
    start: upToCaret.length - token.length,
    end: upToCaret.length,
  };
}

function dedupe(values: string[]): string[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}

/** Provider text shown on a model row — the only place its provenance appears. */
function providerOf(route: RouteLike): string {
  return [route.harnessId ? harnessLabel(route.harnessId as HarnessId) : "", route.modelProvider || route.providerId || ""]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Brand mark for a provider, as a {@link HarnessIcon} key.
 *
 * The marks the app already ships are keyed by HARNESS; providers are the same
 * companies under their catalog ids, so this is a translation and not a second
 * icon set. A provider with no mark (OpenRouter, DeepSeek) falls back to its
 * catalog dot colour, which is what the model catalog already uses for it.
 */
const PROVIDER_ICONS: Record<string, string> = {
  anthropic: "claude-code",
  openai: "codex",
  cursor: "cursor",
  xai: "grok",
};

/** Rows for stage 1: every provider that has at least one runnable route. */
export function providerRows(routes: readonly RouteLike[]): CompletionRow[] {
  const counts = new Map<string, number>();
  for (const route of routes) {
    if (route.enabled === false) {
      continue;
    }
    const provider = routeProvider(route);
    counts.set(provider, (counts.get(provider) || 0) + 1);
  }
  return [...counts.entries()].map(([provider, count]) => ({
    key: provider,
    label: PROVIDER_LABELS[provider as ProviderId] || provider,
    secondary: `${count}`,
    value: provider,
    kind: "provider" as const,
    provider,
    iconKey: PROVIDER_ICONS[provider],
    accent: PROVIDER_DOTS[provider as ProviderId],
  }));
}

/** Harness rows — a harness has no effort, so choosing one ends the chain. */
export function harnessRows(routes: readonly RouteLike[]): CompletionRow[] {
  const present = new Set(routes.filter((route) => route.enabled !== false).map((route) => route.harnessId).filter(Boolean));
  return HARNESS_IDS.filter((id) => present.has(id)).map((id) => ({
    key: id,
    label: harnessLabel(id),
    secondary: "하네스",
    value: id,
    kind: "harness" as const,
    iconKey: id,
  }));
}

/**
 * Stage 1: providers, plus the harnesses.
 *
 * Both are "the thing you name before the model", so they belong on the same
 * screen — and a harness id is exactly the sort of string this feature exists to
 * stop people misspelling. Choosing a harness ends there: a harness has no
 * effort or thinking to set.
 */
export function providerStageSections(routes: readonly RouteLike[], queries: readonly string[]): CompletionSection[] {
  const haystack = (row: CompletionRow) => rowHaystack([row.label]);
  const providers = rankByFuzzyAny(providerRows(routes), queries, haystack).slice(0, COMPLETION_LIMIT);
  const harnesses = rankByFuzzyAny(harnessRows(routes), queries, haystack).slice(0, COMPLETION_LIMIT);
  // Models appear here ONLY once something has been typed.
  //
  // Someone who knows the model's name should not have to walk through its
  // provider to reach it — typing `haiku` goes straight there, and choosing it skips
  // to that model's own options. But listing all 66 with an empty query would
  // undo the reason provider comes first, so the short list stays the default
  // and the long one is what a query buys.
  const searching = queries.some((query) => query.trim());
  const models = searching
    ? rankByFuzzyAny(modelRows(routes), queries, (row) => rowHaystack([row.label, row.secondary])).slice(0, COMPLETION_LIMIT)
    : [];
  return [
    { key: "provider", label: "프로바이더", rows: providers },
    { key: "harness", label: "하네스", rows: harnesses },
    { key: "model", label: "모델", rows: models },
  ].filter((section) => section.rows.length > 0);
}

/**
 * Stage 2: the models of ONE provider.
 *
 * Only routes the user can actually run are offered. A disabled route is left
 * out rather than shown greyed: this control writes text, so an unavailable
 * model would produce an instruction naming something that cannot run, and the
 * failure would surface far away from here.
 */
export function modelRows(routes: readonly RouteLike[], provider?: string): CompletionRow[] {
  const seen = new Set<string>();
  const rows: CompletionRow[] = [];
  for (const route of routes) {
    if (route.enabled === false || (provider && routeProvider(route) !== provider)) {
      continue;
    }
    const value = route.runtimeModel || route.model;
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    rows.push({
      key: value,
      label: route.label || route.model,
      secondary: providerOf(route),
      value,
      kind: "model",
      provider: routeProvider(route),
      route,
    });
  }
  return rows;
}

/** The model stage's rows for one provider, filtered and ranked by the query. */
export function modelStageSections(routes: readonly RouteLike[], provider: string | undefined, queries: readonly string[]): CompletionSection[] {
  const rows = rankByFuzzyAny(modelRows(routes, provider), queries, (row) => rowHaystack([row.label, row.secondary]));
  return rows.length ? [{ key: "model", label: "모델", rows }] : [];
}

/**
 * The stages that follow a chosen model, in order, skipping every capability the
 * model does not have.
 *
 * A capability with a single option is skipped too: the provider serves exactly
 * one configuration, so the "choice" would be a list of one that the user has to
 * dismiss. `budget` is deliberately absent — a number is not something to pick
 * from a list, and the runtime modal already has a slider for it.
 */
export function stagesAfterModel(route: RouteLike | undefined): ChainStage[] {
  const capabilities = route?.capabilities;
  if (!capabilities) {
    return [];
  }
  const stages: ChainStage[] = [];
  if (capabilities.effort?.supported && (capabilities.effort.options?.length || 0) > 1) {
    stages.push("effort");
  }
  if (capabilities.thinking?.supported && (capabilities.thinking.modes?.length || 0) > 1) {
    stages.push("thinking");
  }
  if (capabilities.serviceTier?.supported && (capabilities.serviceTier.options?.length || 0) > 1) {
    stages.push("serviceTier");
  }
  return stages;
}

/** Human label for a stage, shown as the popover's heading. */
export const STAGE_LABELS: Record<ChainStage, string> = {
  provider: "프로바이더",
  model: "모델",
  effort: "Effort",
  thinking: "Thinking",
  serviceTier: "속도",
};

/** `effort=high`, `thinking=on`, `tier=fast` — the key each stage writes. */
const STAGE_KEYS: Record<Exclude<ChainStage, "provider" | "model">, string> = {
  effort: "effort",
  thinking: "thinking",
  serviceTier: "tier",
};

/** Rows for a stage after the model, from the chosen route's capabilities. */
export function stageRows(route: RouteLike | undefined, stage: ChainStage): CompletionRow[] {
  if (stage === "provider" || stage === "model" || !route?.capabilities) {
    return [];
  }
  const capabilities = route.capabilities;
  const options =
    stage === "effort" ? capabilities.effort?.options
      : stage === "thinking" ? capabilities.thinking?.modes
      : capabilities.serviceTier?.options;
  const key = STAGE_KEYS[stage];
  return (options || []).map((option) => ({
    key: option.id,
    label: option.label,
    value: `${key}=${option.id}`,
    kind: stage as TokenKind,
  }));
}

/** The stage's rows, filtered and ranked — the same rule as every other stage. */
export function stageSections(route: RouteLike | undefined, stage: ChainStage, queries: readonly string[]): CompletionSection[] {
  if (stage === "provider" || stage === "model") {
    return [];
  }
  const rows = rankByFuzzyAny(stageRows(route, stage), queries, (row) => rowHaystack([row.label, row.secondary]));
  return rows.length ? [{ key: stage, label: STAGE_LABELS[stage], rows }] : [];
}

/**
 * Every stage's rows behind one call, so the composer does not have to know
 * which function belongs to which stage.
 *
 * `provider` and `model` come from the route list; the rest come from the chosen
 * model's capabilities. Keeping the branch here means the caller holds only
 * "which stage am I on", and a new stage is added in one place.
 */
export function sectionsForStage(
  stage: ChainStage,
  routes: readonly RouteLike[],
  chosen: { provider?: string; model?: RouteLike },
  queries: readonly string[],
): CompletionSection[] {
  if (stage === "provider") {
    return providerStageSections(routes, queries);
  }
  if (stage === "model") {
    return modelStageSections(routes, chosen.provider, queries);
  }
  return stageSections(chosen.model, stage, queries);
}

/** Flattens sections to the row order the arrow keys walk. */
export function flattenRows(sections: readonly CompletionSection[]): CompletionRow[] {
  return sections.flatMap((section) => section.rows);
}

/**
 * Member rows for the first completion stage.
 *
 * The label keeps the `@`, because a mention IS `@name` — the row should read as
 * the thing about to be inserted, not as the trigger that found it. Candidate
 * selection (who is offered, and `everyone` leading) stays in `mentionModel.ts`;
 * this only dresses the result for the shared popover.
 */
export function memberSections(members: readonly { name: string; color: string; status: string }[]): CompletionSection[] {
  if (!members.length) {
    return [];
  }
  return [{
    key: "member",
    label: "멤버",
    rows: members.map((member) => ({
      key: member.name,
      label: `@${member.name}`,
      secondary: member.status,
      value: member.name,
      kind: "member" as const,
      accent: member.color,
      className: member.name === EVERYONE ? "is-everyone" : undefined,
    })),
  }];
}
