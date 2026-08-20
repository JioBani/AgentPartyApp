import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Languages, RotateCcw } from "lucide-react";
import {
  partyPrimerTotals,
  partyPrimerView,
  PARTY_PRIMER_CHANNEL_LABELS,
  PARTY_PRIMER_DELIVERY,
  PARTY_PRIMER_VARIABLES,
  type PartyPrimerSectionId,
  type PartyPrimerSettings as PartyPrimerSettingsValue,
} from "../../shared/partyPrimer";
import { SubtreeVisibility } from "./SubtreeVisibility";
import { LocalizedText, localized } from "../i18n/I18nProvider";

export interface PartyPrimerSectionPatch {
  section: PartyPrimerSectionId;
  /** New text, or `null` to go back to the built-in one. */
  text?: string | null;
  enabled?: boolean;
}

/**
 * Agent → 파티 프롬프트.
 *
 * Shows the member primer the way it is actually assembled — one SUB-TAB per
 * section — so the user reads what every member is told at session start and
 * edits just the part they disagree with. The text comes from
 * `shared/partyPrimer`, the same module the session is built from, so this
 * screen can never show a prompt the app does not use.
 *
 * Sub-tabs rather than stacked cards: a section body is a full page of prose, so
 * an accordion buried the section you wanted under the one you had opened. The
 * strip doubles as the cost readout — each tab carries that section's estimated
 * token weight, which is the number you actually weigh when deciding to trim or
 * switch one off.
 *
 * Edits are STAGED per section: a textarea is only committed by 저장, because
 * saving on every keystroke would rewrite the prompt of every session started
 * mid-sentence. Panels stay MOUNTED (hidden) so switching tabs never throws a
 * staged edit away.
 */
export function PartyPrimerSettings({ settings, onSave, onTranslate, onDirtyChange }: {
  settings?: PartyPrimerSettingsValue;
  onSave: (patch: PartyPrimerSectionPatch) => void;
  /** Runs the Korean translation of one section (or clears it); resolves when stored. */
  onTranslate: (patch: { section: PartyPrimerSectionId; clear?: boolean }) => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const sections = useMemo(() => partyPrimerView(settings), [settings]);
  const totals = useMemo(() => partyPrimerTotals(sections), [sections]);
  const [active, setActive] = useState<PartyPrimerSectionId>(sections[0].id);
  // Staged text per section. A section absent here has no pending edit — which
  // is also how a saved section resets itself: the entry is dropped on save.
  const [drafts, setDrafts] = useState<Partial<Record<PartyPrimerSectionId, string>>>({});
  // Which section is mid-translation, and the last failure per section. A failed
  // translation has to say so on the card — a button that just stops spinning
  // reads as "nothing happened".
  const [translating, setTranslating] = useState<PartyPrimerSectionId | null>(null);
  const [translateError, setTranslateError] = useState<Partial<Record<PartyPrimerSectionId, string>>>({});

  async function runTranslate(id: PartyPrimerSectionId, clear?: boolean) {
    setTranslating(id);
    setTranslateError((current) => ({ ...current, [id]: "" }));
    try {
      await onTranslate({ section: id, clear });
    } catch (error) {
      setTranslateError((current) => ({ ...current, [id]: error instanceof Error ? error.message : String(error) }));
    } finally {
      setTranslating(null);
    }
  }

  const dirty = sections.some((section) => {
    const draft = drafts[section.id];
    return typeof draft === "string" && draft !== section.text;
  });
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  function stage(id: PartyPrimerSectionId, text: string) {
    setDrafts((current) => ({ ...current, [id]: text }));
  }

  function clearDraft(id: PartyPrimerSectionId) {
    setDrafts((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  }

  return (
    <div className="set-primer">
      {/* One summary block, not three islands: what it costs, when it is
          installed, and the two caveats that change how those numbers read. */}
      <section className="set-primer-brief">
        <div className="set-primer-brief-top">
          <div className="set-primer-total">
            <span className="set-primer-total-num wb-mono">{totals.tokens.toLocaleString()}</span>
            <span className="set-primer-total-unit"><LocalizedText id="STR-2009" /><small><LocalizedText id="STR-2008" /></small></span>
          </div>
          <dl className="set-primer-facts">
            <div className="set-primer-fact">
              <dt><LocalizedText id="STR-2010" /></dt>
              <dd className="wb-mono">{totals.enabledSections}/{totals.totalSections}</dd>
            </div>
            <div className="set-primer-fact">
              <dt><LocalizedText id="STR-2011" /></dt>
              <dd className="wb-mono">{totals.characters.toLocaleString()}자</dd>
            </div>
            <div className="set-primer-fact">
              <dt><LocalizedText id="STR-2012" /></dt>
              <dd className="wb-mono">{totals.disabledTokens > 0 ? `−${totals.disabledTokens.toLocaleString()} 토큰` : "없음"}</dd>
            </div>
          </dl>
        </div>

        <div className="set-primer-delivery">
          <div className="set-primer-delivery-label"><LocalizedText id="STR-2015" /></div>
          {PARTY_PRIMER_DELIVERY.map((entry) => (
            <div className="set-primer-delivery-row" key={entry.harness}>
              <span className="set-primer-delivery-harness">{entry.label}</span>
              <span className={"set-primer-channel is-" + entry.channel}>{PARTY_PRIMER_CHANNEL_LABELS[entry.channel]}</span>
              <span className={"set-primer-delivery-when" + (entry.delivered ? "" : " is-none")}>{entry.when}</span>
              <span className="set-primer-delivery-detail">{entry.detail}</span>
            </div>
          ))}
        </div>

        <ul className="set-primer-notes">
          <li>
            <b><LocalizedText id="STR-2016" /></b><LocalizedText id="STR-2017" />
          </li>
          <li>

            <LocalizedText id="STR-2020" /> <b><LocalizedText id="STR-2019" /></b><LocalizedText id="STR-2018" />
          </li>
          <li>

            <LocalizedText id="STR-2022" /> <code className="wb-mono">{PARTY_PRIMER_VARIABLES.join(" ")}</code>  <LocalizedText id="STR-2021" />
          </li>
        </ul>
      </section>

      {/* Section tabs attached to their panel — one tabbed surface, not a strip
          of pills floating above a separate card. */}
      <div className="set-primer-tabs" role="tablist" aria-label={localized("STR-2023")}>
        {sections.map((section) => {
          const draft = drafts[section.id];
          const changed = typeof draft === "string" && draft !== section.text;
          return (
            <button
              type="button"
              key={section.id}
              role="tab"
              aria-selected={section.id === active}
              className={"set-primer-tab" + (section.id === active ? " is-active" : "") + (section.enabled ? "" : " is-off")}
              onClick={() => setActive(section.id)}
            >
              <span className="set-primer-tab-name">{section.title}</span>
              <span className="set-primer-tab-tokens wb-mono">{section.tokens.toLocaleString()}</span>
              {changed && <span className="set-primer-tab-dot" title={localized("STR-2024")} />}
              {!changed && section.translation?.stale && <span className="set-primer-tab-dot is-stale" title={localized("STR-2025")} />}
            </button>
          );
        })}
      </div>

      {sections.map((section) => {
        const open = section.id === active;
        const draft = drafts[section.id];
        const value = typeof draft === "string" ? draft : section.text;
        const changed = value !== section.text;
        return (
          <div className="set-primer-panel" key={section.id} hidden={!open}>
            <SubtreeVisibility visible={open}>
              <section className={"set-primer-section" + (section.enabled ? "" : " is-off")}>
                <div className="set-primer-head">
                  <span className="set-primer-name">{section.title}</span>
                  {section.customized && <span className="set-primer-badge is-edited"><LocalizedText id="STR-2026" /></span>}
                  {changed && <span className="set-primer-badge is-dirty"><LocalizedText id="STR-2027" /></span>}
                  {section.required && <span className="set-primer-badge"><LocalizedText id="STR-2028" /></span>}
                  {!section.enabled && <span className="set-primer-badge is-off"><LocalizedText id="STR-2029" /></span>}
                  {section.translation?.stale && <span className="set-primer-badge is-stale"><LocalizedText id="STR-2030" /></span>}
                  <span className="set-primer-gap" />
                  <span className="set-primer-tokens wb-mono">{section.tokens.toLocaleString()}  <LocalizedText id="STR-2031" /></span>
                  <button
                    type="button"
                    className="set-toggle"
                    disabled={section.required}
                    title={section.required ? localized("STR-2032") : localized("STR-2033")}
                    onClick={() => onSave({ section: section.id, enabled: !section.enabled })}
                  >
                    <span className={"set-switch" + (section.enabled ? " is-on" : "")}><span className="set-switch-knob" /></span>
                  </button>
                </div>
                <div className="set-primer-summary">{section.summary}</div>

                <div className="set-primer-body">
                  <textarea
                    className="set-primer-textarea wb-mono"
                    value={value}
                    spellCheck={false}
                    onChange={(event) => stage(section.id, event.target.value)}
                  />
                  <div className="set-primer-actions">
                    <button
                      type="button"
                      className="set-btn-soft"
                      disabled={!section.customized && !changed}
                      onClick={() => {
                        clearDraft(section.id);
                        if (section.customized) {
                          onSave({ section: section.id, text: null });
                        }
                      }}
                    >
                      <RotateCcw size={13} /><LocalizedText id="STR-2034" />
                    </button>
                    {/* Translating the STAGED text would file a Korean reading of
                        something no member is being told, so it waits for 저장. */}
                    <button
                      type="button"
                      className="set-btn-soft"
                      disabled={translating !== null || changed}
                      title={changed ? localized("STR-2036") : localized("STR-2035")}
                      onClick={() => void runTranslate(section.id)}
                    >
                      <Languages size={13} />
                      {translating === section.id ? "번역 중…" : section.translation ? "다시 번역" : "번역하기"}
                    </button>
                    <span className="set-primer-gap" />
                    {changed && (
                      <button type="button" className="set-btn-soft" onClick={() => clearDraft(section.id)}><LocalizedText id="STR-2040" /></button>
                    )}
                    <button
                      type="button"
                      className="set-btn-accent"
                      disabled={!changed}
                      onClick={() => {
                        onSave({ section: section.id, text: value });
                        clearDraft(section.id);
                      }}
                    >

                      <LocalizedText id="STR-2041" />
                    </button>
                  </div>

                  {translateError[section.id] && (
                    <div className="set-inline-note is-error">
                      <AlertTriangle size={14} />
                      <span>{translateError[section.id]}</span>
                    </div>
                  )}

                  {section.translation && (
                    <div className={"set-primer-tr" + (section.translation.stale ? " is-stale" : "")}>
                      <div className="set-primer-tr-head">
                        <span className="set-primer-tr-label"><LocalizedText id="STR-2042" /></span>
                        <span className="set-primer-tr-meta wb-mono">
                          {section.translation.model}
                          {section.translation.at ? ` · ${new Date(section.translation.at).toLocaleString()}` : ""}
                        </span>
                        <span className="set-primer-gap" />
                        <button
                          type="button"
                          className="set-primer-tr-clear"
                          disabled={translating !== null}
                          onClick={() => void runTranslate(section.id, true)}
                        >

                          <LocalizedText id="STR-2043" />
                        </button>
                      </div>
                      {section.translation.stale && (
                        <div className="set-primer-tr-stale">
                          <AlertTriangle size={13} />
                          <span><LocalizedText id="STR-2045" /> <b><LocalizedText id="STR-2044" /></b><LocalizedText id="STR-2046" /></span>
                        </div>
                      )}
                      <pre className="set-primer-tr-text">{section.translation.text}</pre>
                    </div>
                  )}
                </div>
              </section>
            </SubtreeVisibility>
          </div>
        );
      })}
    </div>
  );
}
