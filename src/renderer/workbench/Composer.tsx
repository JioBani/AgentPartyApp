import { FormEvent, KeyboardEvent, useLayoutEffect, useRef, useState } from "react";
import { AtSign, CircleStop, Maximize2, Paperclip, Send } from "lucide-react";
import type { MemberView, PanelDensity } from "./types";
import type { WorkbenchActions } from "./actions";
import { Dropdown } from "./Dropdown";
import { PERMISSION_OPTIONS } from "./controls";
import { CommandPalette } from "./CommandPalette";
import { useCommandPalette } from "./useCommandPalette";
import { CodexPermissionControl } from "./CodexPermissionControl";
import { harnessCapabilities } from "../../shared/harnessCapabilities";
import { DEFAULT_CODEX_POLICY } from "../../shared/codexPolicy";

interface ComposerProps {
  view: MemberView;
  density: PanelDensity;
  actions: WorkbenchActions;
}

/**
 * Per-member message composer. Wide/mid render a two-row textarea with a tool
 * row; narrow collapses to a single-line input so the Send/Stop control stays
 * reachable. Stop replaces Send while the member is working.
 */
/** Max auto-grow height (px) before the textarea scrolls internally. */
const TEXTAREA_MAX_HEIGHT = 220;

export function Composer({ view, density, actions }: ComposerProps) {
  const [draft, setDraft] = useState("");
  const [expanded, setExpanded] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Command/skill palette — harness-aware (`/` for claude-code/codex, etc.).
  const palette = useCommandPalette({
    runtime: view.member.runtime,
    discovered: view.session?.snapshot.slashCommands,
    draft,
    setDraft,
    onAction: (action) => {
      if (action === "compact") actions.compact(view.name);
      else if (action === "restart") actions.restart(view.name);
      else if (action === "interrupt") actions.interrupt(view.name);
    },
  });

  // Grow the textarea with its content (up to a cap, then it scrolls), and
  // shrink back when the draft is cleared/shortened.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) {
      return;
    }
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, TEXTAREA_MAX_HEIGHT) + "px";
  }, [draft]);

  function submit(event?: FormEvent) {
    event?.preventDefault();
    const text = draft.trim();
    if (!text) {
      return;
    }
    setDraft("");
    void actions.sendMessage(view.name, text);
  }

  function onKeyDown(event: KeyboardEvent) {
    // The palette claims navigation/selection keys while it is open.
    if (palette.handleKeyDown(event)) {
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      submit();
    }
  }

  const palettePopover = palette.open ? (
    <CommandPalette commands={palette.matches} activeIndex={palette.activeIndex} onHover={palette.setActiveIndex} onSelect={palette.apply} />
  ) : null;

  const stop = view.busy;
  const iconOnly = stop ? (
    <button type="button" className="wb-send is-stop" title="Stop" onClick={() => actions.interrupt(view.name)}><CircleStop size={15} /></button>
  ) : (
    <button type="submit" className="wb-send" title="Send" disabled={!draft.trim()}><Send size={15} /></button>
  );
  const labeled = stop ? (
    <button type="button" className="wb-send-labeled is-stop" title="Stop" onClick={() => actions.interrupt(view.name)}>Stop <CircleStop size={14} /></button>
  ) : (
    <button type="submit" className="wb-send-labeled" title="Send" disabled={!draft.trim()}>Send <Send size={14} /></button>
  );
  // Permission control next to Send: Codex members get the two-axis
  // (sandbox × approval + guardian) control; Claude members get the single mode.
  const permission = harnessCapabilities(view.member.runtime).twoAxisPermission ? (
    <CodexPermissionControl
      policy={view.session?.snapshot.codexPolicy || view.member.codexPolicy || DEFAULT_CODEX_POLICY}
      onChange={(policy) => actions.setCodexPolicy(view.name, policy)}
    />
  ) : (
    <Dropdown
      value={view.permissionMode || "default"}
      options={PERMISSION_OPTIONS}
      onChange={(mode) => actions.setPermissionMode(view.name, mode)}
      title="권한"
      compact
      drop="up"
      align="right"
    />
  );

  if (density === "narrow" && !expanded) {
    return (
      <form className="wb-composer is-narrow" onSubmit={submit}>
        {palettePopover}
        <div className="wb-composer-bar">
          <input
            className="wb-composer-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={`${view.name}에게…`}
          />
          <button type="button" className="wb-icon-btn" title="Expand" onClick={() => setExpanded(true)}><Maximize2 size={13} /></button>
          {iconOnly}
          {permission}
        </div>
      </form>
    );
  }

  return (
    <form className="wb-composer" onSubmit={submit}>
      {palettePopover}
      <div className="wb-composer-box">
        <textarea
          ref={textareaRef}
          className="wb-composer-textarea"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          placeholder={`${view.name}에게 메시지 보내기…`}
        />
        <div className="wb-composer-row">
          <div className="wb-composer-tools">
            <button type="button" className="wb-icon-btn" title="Attach"><Paperclip size={14} /></button>
            <button type="button" className="wb-icon-btn" title="Mention"><AtSign size={14} /></button>
          </div>
          <div className="wb-composer-actions">
            {labeled}
            {permission}
          </div>
        </div>
      </div>
    </form>
  );
}
