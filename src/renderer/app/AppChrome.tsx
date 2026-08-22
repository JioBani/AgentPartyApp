/**
 * The app shell's own chrome: title bar, navigation rail, screen header.
 *
 * Extracted from `App.tsx` so it has ONE implementation. The design studio
 * shows whole screens, and a screen without its title bar and rail is not the
 * screen a person sees — but a studio that redraws the chrome would be a copy,
 * and the first refactor would make it a lie. So the chrome moved here and both
 * the app and the studio mount the same components.
 *
 * Markup and class names are unchanged from App.tsx on purpose: the QA scripts
 * and the locale sweep address this chrome by class.
 *
 * Everything that touches the outside world arrives as a prop — the window
 * buttons call `window.agentParty` in the app and do nothing in the studio,
 * which is why they cannot reach for it themselves.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { BarChart3, BookOpen, KeyRound, Maximize2, Minus, Palette, Settings, SlidersHorizontal, Sparkles, X, Flag } from "lucide-react";

export interface ChromeTheme {
  id: string;
  label: string;
  color: { accent: string };
}

interface TitleBarProps {
  /** Shown beside the brand when the view is not the workbench. */
  subtitle?: string;
  themes: readonly ChromeTheme[];
  preference: string;
  onPickTheme: (id: string) => void;
  /** Update pill, mobile pill — each renders only when it has something to say. */
  pills?: ReactNode;
  onMinimize: () => void;
  onMaximize: () => void;
  onClose: () => void;
  labels: {
    appearanceTitle: string;
    themeLabel: string;
    minimize: string;
    maximize: string;
    close: string;
  };
}

export function TitleBar({ subtitle, themes, preference, onPickTheme, pills, onMinimize, onMaximize, onClose, labels }: TitleBarProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnOutside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    requestAnimationFrame(() => menuRef.current?.querySelector<HTMLElement>("[role=menuitemradio][aria-checked=true]")?.focus());
    return () => {
      document.removeEventListener("pointerdown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  function moveFocus(event: React.KeyboardEvent<HTMLDivElement>) {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role=menuitemradio]") || []);
    if (!items.length) return;
    const current = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement));
    let next = current;
    if (event.key === "ArrowDown") next = (current + 1) % items.length;
    else if (event.key === "ArrowUp") next = (current - 1 + items.length) % items.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else return;
    event.preventDefault();
    items[next].focus();
  }

  const activeLabel = themes.find((item) => item.id === preference)?.label || preference;

  return (
    <div className="app-titlebar">
      <div className="titlebar-drag">
        <div className="titlebar-brand">
          <span className="brand-mark"><span className="brand-mark-dot" /></span>
          <span className="brand-name">AgentParty</span>
          {subtitle && <small className="brand-sub">{subtitle}</small>}
        </div>
        <div className="titlebar-theme-wrap no-drag" ref={menuRef}>
          <button
            ref={triggerRef}
            type="button"
            className="titlebar-action"
            data-theme-menu-trigger
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={`${labels.appearanceTitle}: ${activeLabel}`}
            onClick={() => setOpen((value) => !value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setOpen(true);
              }
            }}
          >
            <Palette size={14} />
          </button>
          {open && (
            <div className="titlebar-theme-menu" data-theme-menu role="menu" aria-label={labels.themeLabel} onKeyDown={moveFocus}>
              {themes.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={preference === item.id}
                  data-theme-menu-option={item.id}
                  className={preference === item.id ? "is-active" : ""}
                  onClick={() => {
                    onPickTheme(item.id);
                    setOpen(false);
                    triggerRef.current?.focus();
                  }}
                >
                  <span className="titlebar-theme-swatch" style={{ background: item.color.accent }} />
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {pills}
      </div>
      <div className="window-controls">
        <button type="button" className="window-button" title={labels.minimize} onClick={onMinimize}><Minus size={15} /></button>
        <button type="button" className="window-button" title={labels.maximize} onClick={onMaximize}><Maximize2 size={14} /></button>
        <button type="button" className="window-button close" title={labels.close} onClick={onClose}><X size={16} /></button>
      </div>
    </div>
  );
}

/** The rail's icons, in order. Ids match the app's view ids. */
export const NAV_ICONS: Record<string, JSX.Element> = {
  workbench: <Sparkles size={18} />,
  guide: <BookOpen size={18} />,
  usage: <BarChart3 size={18} />,
  auth: <KeyRound size={18} />,
  agent: <SlidersHorizontal size={18} />,
  settings: <Settings size={18} />,
};

interface NavRailProps {
  items: Array<{ id: string; label: string; icon: JSX.Element }>;
  current: string;
  onSelect: (id: string) => void;
  /** Account initials. */
  avatar: string;
  labels: { navigation: string; account: string };
}

export function NavRail({ items, current, onSelect, avatar, labels }: NavRailProps) {
  return (
    <nav className="nav-rail" aria-label={labels.navigation}>
      <div className="nav-items">
        {items.map((item) => (
          <button
            key={item.id}
            data-view={item.id}
            className={"nav-item " + (current === item.id ? "active" : "")}
            onClick={() => onSelect(item.id)}
            title={item.label}
          >
            {item.icon}
          </button>
        ))}
      </div>
      <div className="nav-spacer" />
      <div className="nav-avatar" title={labels.account}>{avatar}</div>
    </nav>
  );
}

interface ScreenHeaderProps {
  /** The PARTY, not the workspace path — every member runs in its own cwd. */
  party: string;
  actions?: ReactNode;
  labels: { partyLabel: string; none: string };
}

export function WorkbenchScreenHeader({ party, actions, labels }: ScreenHeaderProps) {
  return (
    <header className="screen-header screen-header-party">
      <div className="screen-title screen-title-party">
        <span className="screen-party" title={`현재 파티: ${party || labels.none}`}>
          <span className="screen-party-label">{labels.partyLabel}</span>
          <Flag size={12} strokeWidth={2.5} />
          <strong>{party || labels.none}</strong>
        </span>
      </div>
      <div className="screen-actions">{actions}</div>
    </header>
  );
}
