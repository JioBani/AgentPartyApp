import { DragEvent, FormEvent, KeyboardEvent, ClipboardEvent, useLayoutEffect, useRef, useState } from "react";
import { AtSign, CircleStop, ImageOff, Maximize2, Send, X } from "lucide-react";
import type { MemberView, PanelDensity } from "./types";
import type { WorkbenchActions } from "./actions";
import { Dropdown } from "./Dropdown";
import { PERMISSION_OPTIONS } from "./controls";
import { CommandPalette } from "./CommandPalette";
import { useCommandPalette } from "./useCommandPalette";
import { CodexPermissionControl } from "./CodexPermissionControl";
import { harnessCapabilities } from "../../shared/harnessCapabilities";
import { DEFAULT_CODEX_POLICY } from "../../shared/codexPolicy";
import {
  DEFAULT_MAX_IMAGES_PER_TURN,
  DEFAULT_MAX_IMAGE_BYTES,
  base64ByteLength,
  imageDataUrl,
  type ImageAttachment,
} from "../../shared/attachments";

interface ComposerProps {
  view: MemberView;
  density: PanelDensity;
  actions: WorkbenchActions;
}

/**
 * Per-member message composer. Wide/mid render a two-row textarea with a tool
 * row; narrow collapses to a single-line input so the Send/Stop control stays
 * reachable. Stop replaces Send while the member is working.
 *
 * Images attach by clipboard paste (Ctrl+V) or drag-and-drop. Attaching is gated
 * on the effective model's vision support: a text-only model refuses images with
 * a visible reason (never a silent drop); unknown support is allowed optimistically
 * and any real failure surfaces as an error card from the harness.
 */
/** Max auto-grow height (px) before the textarea scrolls internally. */
const TEXTAREA_MAX_HEIGHT = 220;

export function Composer({ view, density, actions }: ComposerProps) {
  const [draft, setDraft] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const [attachError, setAttachError] = useState("");
  const [dragging, setDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const harness = view.member.runtime === "codex" ? "codex" : "claude-code";

  // Effective-model vision gating. image: true = allowed, false = text-only
  // (block with a reason), undefined = unknown (allow, model surfaces errors).
  const imageSupported = view.vision?.image; // boolean | undefined
  const imageBlocked = imageSupported === false;
  const maxImages = view.vision?.maxImages ?? DEFAULT_MAX_IMAGES_PER_TURN;
  const maxBytes = view.vision?.maxBytesPerImage ?? DEFAULT_MAX_IMAGE_BYTES;

  // Command/skill palette — harness-aware (`/` for claude-code/codex, etc.).
  const palette = useCommandPalette({
    runtime: harness,
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

  async function addFiles(files: File[]) {
    const images = files.filter((file) => file.type.startsWith("image/"));
    if (images.length === 0) {
      return;
    }
    if (imageBlocked) {
      // No silent drop: tell the user why the image was refused.
      setAttachError(`${view.model || "이 모델"}은(는) 이미지를 지원하지 않습니다. 비전 지원 모델로 전환하세요.`);
      return;
    }
    const added: ImageAttachment[] = [];
    let error = "";
    for (const file of images) {
      if (attachments.length + added.length >= maxImages) {
        error = `이미지는 최대 ${maxImages}개까지 첨부할 수 있습니다.`;
        break;
      }
      const dataBase64 = await fileToBase64(file).catch(() => "");
      if (!dataBase64) {
        error = "이미지를 읽지 못했습니다.";
        continue;
      }
      if (base64ByteLength(dataBase64) > maxBytes) {
        error = `이미지 한 개는 최대 ${Math.round(maxBytes / (1024 * 1024))}MB까지 첨부할 수 있습니다.`;
        continue;
      }
      added.push({ kind: "image", mediaType: file.type, dataBase64, name: file.name || undefined });
    }
    if (added.length) {
      setAttachments((current) => [...current, ...added]);
    }
    setAttachError(error);
  }

  function onPaste(event: ClipboardEvent) {
    const files = Array.from(event.clipboardData?.items || [])
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (files.length === 0) {
      return; // let text paste through normally
    }
    event.preventDefault();
    void addFiles(files);
  }

  function onDrop(event: DragEvent) {
    const files = Array.from(event.dataTransfer?.files || []);
    if (files.some((file) => file.type.startsWith("image/"))) {
      event.preventDefault();
      void addFiles(files);
    }
    setDragging(false);
  }

  function onDragOver(event: DragEvent) {
    if (Array.from(event.dataTransfer?.items || []).some((item) => item.kind === "file")) {
      event.preventDefault();
      setDragging(true);
    }
  }

  function removeAttachment(index: number) {
    setAttachments((current) => current.filter((_, i) => i !== index));
  }

  function submit(event?: FormEvent) {
    event?.preventDefault();
    const text = draft.trim();
    if (!text && attachments.length === 0) {
      return;
    }
    const images = attachments.length ? attachments : undefined;
    setDraft("");
    setAttachments([]);
    setAttachError("");
    void actions.sendMessage(view.name, text, images);
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

  const canSend = Boolean(draft.trim()) || attachments.length > 0;
  const palettePopover = palette.open ? (
    <CommandPalette commands={palette.matches} activeIndex={palette.activeIndex} onHover={palette.setActiveIndex} onSelect={palette.apply} />
  ) : null;

  const attachmentStrip = attachments.length > 0 ? (
    <div className="wb-attachments">
      {attachments.map((image, index) => (
        <div className="wb-attachment" key={`${image.name || "img"}-${index}`} title={image.name}>
          <img src={imageDataUrl(image)} alt={image.name || "attached image"} />
          <button type="button" className="wb-attachment-x" title="제거" onClick={() => removeAttachment(index)}><X size={11} /></button>
        </div>
      ))}
    </div>
  ) : null;

  const attachHint = attachError ? (
    <div className="wb-attach-hint is-error">{attachError}</div>
  ) : imageBlocked ? (
    <div className="wb-attach-hint"><ImageOff size={12} /> 이 모델은 이미지를 지원하지 않습니다</div>
  ) : null;

  const stop = view.busy;
  const iconOnly = stop ? (
    <button type="button" className="wb-send is-stop" title="Stop" onClick={() => actions.interrupt(view.name)}><CircleStop size={15} /></button>
  ) : (
    <button type="submit" className="wb-send" title="Send" disabled={!canSend}><Send size={15} /></button>
  );
  const labeled = stop ? (
    <button type="button" className="wb-send-labeled is-stop" title="Stop" onClick={() => actions.interrupt(view.name)}>Stop <CircleStop size={14} /></button>
  ) : (
    <button type="submit" className="wb-send-labeled" title="Send" disabled={!canSend}>Send <Send size={14} /></button>
  );
  // Permission control next to Send: Codex members get the two-axis
  // (sandbox × approval + guardian) control; Claude members get the single mode.
  const permission = harnessCapabilities(harness).twoAxisPermission ? (
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

  const dragProps = {
    onDragOver,
    onDragLeave: () => setDragging(false),
    onDrop,
  };

  if (density === "narrow" && !expanded) {
    return (
      <form className={"wb-composer is-narrow" + (dragging ? " is-drag" : "")} onSubmit={submit} {...dragProps}>
        {palettePopover}
        {attachmentStrip}
        {attachHint}
        <div className="wb-composer-bar">
          <input
            className="wb-composer-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
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
    <form className={"wb-composer" + (dragging ? " is-drag" : "")} onSubmit={submit} {...dragProps}>
      {palettePopover}
      <div className="wb-composer-box">
        {attachmentStrip}
        {attachHint}
        <textarea
          ref={textareaRef}
          className="wb-composer-textarea"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          rows={2}
          placeholder={imageBlocked ? `${view.name}에게 메시지 보내기…` : `${view.name}에게 메시지 보내기… (이미지 붙여넣기/끌어놓기 가능)`}
        />
        <div className="wb-composer-row">
          <div className="wb-composer-tools">
            <button type="button" className="wb-icon-btn" title="Mention"><AtSign size={14} /></button>
          </div>
          <div className="wb-composer-actions">
            {labeled}
            {permission}
          </div>
        </div>
      </div>
      {dragging && !imageBlocked && <div className="wb-composer-dropzone">여기에 이미지를 놓으세요</div>}
    </form>
  );
}

/** Reads a File to its base64 body (strips the `data:...;base64,` prefix). */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : "");
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
