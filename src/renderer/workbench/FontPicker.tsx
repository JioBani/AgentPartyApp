import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, ChevronDown, Search } from "lucide-react";
import { fontStackFor, matchesFontQuery, recommendedFor, type FontRole, type LocalFontFamily } from "../../shared/appFonts";

/**
 * One role's font picker: a trigger showing the current family, and a popover
 * with a search box over every installed family.
 *
 * A dropdown was enough for a fixed list of six; it is not for the ~300 a real
 * machine reports. Search is the primary control here — the list is far too
 * long to scan, and users arrive knowing the name they want.
 *
 * Every row is drawn IN ITS OWN FAMILY. That is the whole point of a font
 * picker and it costs nothing (the rows are already rendered), but it means the
 * list must stay short enough to lay out: see MAX_ROWS.
 */

/**
 * How many rows to render at once. Each row is laid out in a different font,
 * so an unbounded list would stall the popover on a machine with hundreds
 * installed. What is dropped is STATED under the list rather than silently
 * truncated — a search that quietly hides the match the user is looking for is
 * worse than no search.
 */
const MAX_ROWS = 120;

export interface FontPickerProps {
  role: FontRole;
  label: string;
  /** Selected family, "" for the platform default. */
  value: string;
  families: LocalFontFamily[];
  /** Availability for families NOT in `families` (the recommended list). */
  available: Record<string, boolean | null>;
  /** Set when enumeration failed — the list is the recommended fonts only. */
  enumerationError?: string;
  /** Enumeration has not finished yet. */
  loading?: boolean;
  onChange: (family: string) => void;
}

interface Row {
  family: string;
  label: string;
  note: string;
  /** `null` = could not determine. */
  installed: boolean | null;
  recommended: boolean;
}

export function FontPicker({ role, label, value, families, available, enumerationError, loading, onChange }: FontPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on an outside click or Escape — a popover that can only be dismissed
  // by picking something traps a user who opened it to look.
  useEffect(() => {
    if (!open) {
      return;
    }
    const onDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setOpen(false); }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const rows = useMemo(() => buildRows(role, families, available), [role, families, available]);
  const filtered = useMemo(() => filterRows(rows, query), [rows, query]);
  const shown = filtered.slice(0, MAX_ROWS);
  const hidden = filtered.length - shown.length;

  const selected = rows.find((row) => row.family === value);
  const selectedLabel = value ? (selected?.label || value) : "시스템 기본";
  const selectedMissing = value !== "" && selected?.installed === false;

  return (
    <div className="set-font-field" ref={containerRef}>
      <span className="set-field-label">{label}</span>
      <button type="button" className="set-font-trigger" data-font-role={role} onClick={() => { setOpen((v) => !v); setQuery(""); }}>
        <span className="set-font-trigger-name" style={{ fontFamily: fontStackFor(value, role) }}>{selectedLabel}</span>
        <ChevronDown size={14} />
      </button>

      {open && (
        <div className="set-font-pop">
          <div className="set-font-search">
            <Search size={14} />
            <input
              autoFocus
              value={query}
              data-font-search={role}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`글꼴 이름 검색 · 설치 ${rows.filter((r) => r.installed !== false).length}개`}
            />
          </div>
          {loading && <div className="set-font-status">설치된 글꼴을 읽는 중…</div>}
          {enumerationError && (
            <div className="set-font-status is-error">
              <AlertTriangle size={13} />
              <span>{enumerationError} 아래는 추천 글꼴만 표시한 것입니다.</span>
            </div>
          )}
          <div className="set-font-list" role="listbox" aria-label={label}>
            {shown.map((row) => (
              <button
                type="button"
                key={row.family || "__system__"}
                role="option"
                aria-selected={row.family === value}
                className={"set-font-row" + (row.family === value ? " is-active" : "")}
                data-font-family={row.family}
                onClick={() => { onChange(row.family); setOpen(false); }}
              >
                <span className="set-font-row-check">{row.family === value && <Check size={13} />}</span>
                <span className="set-font-row-body">
                  <span className="set-font-row-name" style={{ fontFamily: fontStackFor(row.family, role) }}>{row.label}</span>
                  <span className="set-font-row-sample" style={{ fontFamily: fontStackFor(row.family, role) }}>다람쥐 헌 쳇바퀴 Sphinx 0123</span>
                </span>
                <span className="set-font-row-tags">
                  {row.recommended && <span className="set-font-tag is-reco">추천</span>}
                  {row.installed === false && <span className="set-font-tag is-missing">미설치</span>}
                  {row.installed === null && <span className="set-font-tag">확인 불가</span>}
                  {row.note && <span className="set-font-row-note">{row.note}</span>}
                </span>
              </button>
            ))}
            {!shown.length && <div className="set-font-status">‘{query}’ 와(과) 일치하는 글꼴이 없습니다.</div>}
          </div>
          {hidden > 0 && <div className="set-font-status">{hidden}개 더 있습니다 — 검색어를 좁혀 주세요.</div>}
        </div>
      )}

      <div className="set-font-preview" style={{ fontFamily: fontStackFor(value, role) }}>다람쥐 헌 쳇바퀴에 타고파 Sphinx of black quartz 0123</div>
      <div className="set-font-note">
        <span>{value ? (selected?.note || "설치된 글꼴") : "OS 의 기본 글꼴을 그대로 사용"}</span>
        {selectedMissing && (
          <span className="set-font-warn">
            <AlertTriangle size={13} />
            이 컴퓨터에 설치되어 있지 않아 대체 글꼴로 표시됩니다.
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * The rows for one role: the platform default, then the recommended families,
 * then everything else installed.
 *
 * For the code role the enumerated list is restricted to families MEASURED as
 * fixed-width. A proportional font in a code pane misaligns every column it
 * touches, and ~90% of an unfiltered system list is proportional — offering
 * them all would bury the dozen fonts that belong there. Recommended entries
 * are exempt so a deliberate choice is never hidden by the classifier.
 */
function buildRows(role: FontRole, families: LocalFontFamily[], available: Record<string, boolean | null>): Row[] {
  const recommended = recommendedFor(role);
  const byFamily = new Map(families.map((entry) => [entry.family, entry]));
  const rows: Row[] = [
    { family: "", label: "시스템 기본", note: "OS 의 기본 글꼴", installed: true, recommended: false },
  ];
  const claimed = new Set<string>([""]);

  for (const font of recommended) {
    claimed.add(font.family);
    rows.push({
      family: font.family,
      label: font.label,
      note: font.note,
      // A bundled face is installed by definition. Otherwise prefer the
      // enumeration (authoritative) and fall back to the width probe, which is
      // all we have when enumeration was refused.
      installed: font.bundled || byFamily.has(font.family) ? true : available[font.family] ?? null,
      recommended: true,
    });
  }

  for (const entry of families) {
    if (claimed.has(entry.family) || (role === "mono" && !entry.monospace)) {
      continue;
    }
    rows.push({
      family: entry.family,
      label: entry.family,
      // Nothing useful to add: the row's sample line is drawn in this very
      // family, which tells the user more than any label could.
      note: "",
      installed: true,
      recommended: false,
    });
  }
  return rows;
}

/**
 * Filters by name, label or Hangul reading — the shared matcher, so the picker
 * and `GET /api/appearance/fonts?q=` can never disagree. The platform default is
 * always offered: it is the way back out of any choice.
 */
function filterRows(rows: Row[], query: string): Row[] {
  if (!query.trim()) {
    return rows;
  }
  return rows.filter((row) => row.family === "" || matchesFontQuery(row.family, query, row.label));
}
