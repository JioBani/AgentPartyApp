import { useEffect, useMemo, useState } from "react";
import { ChevronDown, Info as InfoIcon, RotateCcw } from "lucide-react";
import {
  partyPrimerView,
  PARTY_PRIMER_VARIABLES,
  type PartyPrimerSectionId,
  type PartyPrimerSettings as PartyPrimerSettingsValue,
} from "../../shared/partyPrimer";

export interface PartyPrimerSectionPatch {
  section: PartyPrimerSectionId;
  /** New text, or `null` to go back to the built-in one. */
  text?: string | null;
  enabled?: boolean;
}

/**
 * Settings → 런타임 → 파티 프롬프트.
 *
 * Shows the member primer the way it is actually assembled — one card per
 * section — so the user can read what every member is told at session start and
 * edit just the part they disagree with. The text comes from
 * `shared/partyPrimer`, the same module the session is built from, so this
 * screen can never show a prompt the app does not use.
 *
 * Edits are STAGED per section: a textarea is only committed by 저장, because
 * saving on every keystroke would rewrite the prompt of every session started
 * mid-sentence.
 */
export function PartyPrimerSettings({ settings, onSave, onDirtyChange }: {
  settings?: PartyPrimerSettingsValue;
  onSave: (patch: PartyPrimerSectionPatch) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const sections = useMemo(() => partyPrimerView(settings), [settings]);
  const [openId, setOpenId] = useState<PartyPrimerSectionId | null>(null);
  // Staged text per section. A section absent here has no pending edit — which
  // is also how a saved section resets itself: the entry is dropped on save.
  const [drafts, setDrafts] = useState<Partial<Record<PartyPrimerSectionId, string>>>({});

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
      <div className="set-inline-note">
        <InfoIcon size={14} />
        <span>
          모든 멤버 세션이 시작할 때 시스템 프롬프트로 받는 내용입니다. 섹션별로 켜고 끄거나 문구를 바꿀 수 있고,
          바꾸지 않은 섹션은 앱이 갱신될 때 함께 최신 내용을 따라갑니다. <b>이미 실행 중인 멤버는 시작할 때 받은 프롬프트를 유지</b>하므로,
          변경 내용은 다음에 시작·재개하는 세션부터 적용됩니다.
        </span>
      </div>
      <div className="set-inline-note is-soft">
        <InfoIcon size={14} />
        <span>
          문구 안에서 <code className="wb-mono">{PARTY_PRIMER_VARIABLES.join(" ")}</code> 는 세션이 시작될 때 그 멤버의 파티·이름·역할로 치환됩니다.
        </span>
      </div>

      {sections.map((section) => {
        const open = openId === section.id;
        const draft = drafts[section.id];
        const value = typeof draft === "string" ? draft : section.text;
        const changed = value !== section.text;
        return (
          <section className={"set-primer-card" + (section.enabled ? "" : " is-off")} key={section.id}>
            <div className="set-primer-head">
              <button
                type="button"
                className="set-primer-title"
                aria-expanded={open}
                onClick={() => setOpenId(open ? null : section.id)}
              >
                <ChevronDown size={14} className={"set-primer-caret" + (open ? " is-open" : "")} />
                <span className="set-primer-name">{section.title}</span>
                {section.customized && <span className="set-primer-badge is-edited">수정됨</span>}
                {changed && <span className="set-primer-badge is-dirty">저장 안 됨</span>}
                {section.required && <span className="set-primer-badge">필수</span>}
                {!section.enabled && <span className="set-primer-badge is-off">꺼짐</span>}
              </button>
              <button
                type="button"
                className="set-toggle"
                disabled={section.required}
                title={section.required ? "이 섹션은 멤버가 자기 정체성과 툴을 아는 근거라 끌 수 없습니다." : undefined}
                onClick={() => onSave({ section: section.id, enabled: !section.enabled })}
              >
                <span className={"set-switch" + (section.enabled ? " is-on" : "")}><span className="set-switch-knob" /></span>
              </button>
            </div>
            <div className="set-primer-summary">{section.summary}</div>
            {open && (
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
                    <RotateCcw size={13} />기본값으로
                  </button>
                  <span className="set-primer-gap" />
                  {changed && (
                    <button type="button" className="set-btn-soft" onClick={() => clearDraft(section.id)}>편집 취소</button>
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
                    저장
                  </button>
                </div>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
