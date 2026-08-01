import { DragEvent, FormEvent, KeyboardEvent, ClipboardEvent, useLayoutEffect, useRef, useState } from "react";
import { ArrowDownToLine, AtSign, Check, CircleStop, Copy, ImageOff, Maximize2, Send, X } from "lucide-react";
import { MessageQueue } from "./MessageQueue";
import type { MemberView, PanelDensity } from "./types";
import type { WorkbenchActions } from "./actions";
import { Dropdown } from "./Dropdown";
import { PERMISSION_OPTIONS } from "./controls";
import { CommandPalette } from "./CommandPalette";
import { useCommandPalette } from "./useCommandPalette";
import { CodexPermissionControl } from "./CodexPermissionControl";
import { CursorPermissionControl } from "./CursorPermissionControl";
import { harnessCapabilities } from "../../shared/harnessCapabilities";
import { DEFAULT_CODEX_POLICY } from "../../shared/codexPolicy";
import { cursorPolicyOf } from "../../shared/cursorPolicy";
import {
  DEFAULT_MAX_IMAGES_PER_TURN,
  DEFAULT_MAX_IMAGE_BYTES,
  base64ByteLength,
  imageDataUrl,
  type ImageAttachment,
} from "../../shared/attachments";
import { sendsOnEnter } from "../../shared/composerSettings";
import { useComposerPrefs } from "../app/composerPrefs";

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
 * Which keystroke sends is a global preference (Settings → 입력창), applied
 * identically in both layouts — the narrow input must never send on a key the
 * wide textarea treats as a newline.
 *
 * Images attach by clipboard paste (Ctrl+V) or drag-and-drop. Attaching is gated
 * on the effective model's vision support: a text-only model refuses images with
 * a visible reason (never a silent drop); unknown support is allowed optimistically
 * and any real failure surfaces as an error card from the harness.
 */
/** Max auto-grow height (px) before the textarea scrolls internally. */
const TEXTAREA_MAX_HEIGHT = 220;

/**
 * How long a Stop may sit unacknowledged before the control offers a force stop.
 * A healthy interrupt clears in well under a second, so this never appears in
 * normal use — it is the escape hatch for a turn the harness will never close.
 */
const FORCE_STOP_AFTER_MS = 5_000;

export function Composer({ view, density, actions }: ComposerProps) {
  const [draft, setDraft] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const [attachError, setAttachError] = useState("");
  const [dragging, setDragging] = useState(false);
  // Which thumbnail just went to the clipboard (a brief ✓ on its copy button).
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const prefs = useComposerPrefs();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const harness = view.member.runtime === "codex" ? "codex" : view.member.runtime === "cursor" ? "cursor" : "claude-code";

  // A Stop the harness has not acknowledged yet. It stays "interrupting" only
  // until the turn actually closes, so anything past the grace period is a turn
  // the harness is not going to close on its own.
  const interrupting = String(view.session?.snapshot.status || "") === "interrupting";
  const [forceStop, setForceStop] = useState(false);
  useLayoutEffect(() => {
    if (!interrupting) {
      setForceStop(false);
      return;
    }
    const timer = setTimeout(() => setForceStop(true), FORCE_STOP_AFTER_MS);
    return () => clearTimeout(timer);
  }, [interrupting]);

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

  /**
   * Drop splits by kind: an image is ATTACHED (the existing behaviour), and
   * anything else has its path inserted into the draft, which is what a member
   * can actually act on — it reads files itself, so handing it a path beats
   * uploading bytes it would then have nowhere to put. Non-image drops used to
   * be swallowed with no attachment and no message.
   */
  function onDrop(event: DragEvent) {
    setDragging(false);
    const files = Array.from(event.dataTransfer?.files || []);
    if (files.length === 0) {
      return;
    }
    event.preventDefault();
    const images = files.filter((file) => file.type.startsWith("image/"));
    const others = files.filter((file) => !file.type.startsWith("image/"));
    if (images.length) {
      void addFiles(images);
    }
    if (others.length) {
      insertPaths(others);
    }
  }

  /** Appends the dropped files' paths to the draft, reporting any it cannot resolve. */
  function insertPaths(files: File[]) {
    const paths: string[] = [];
    const unresolved: string[] = [];
    for (const file of files) {
      let filePath = "";
      try {
        filePath = window.agentParty.pathForFile?.(file) || "";
      } catch {
        filePath = ""; // reported below — never a silent drop
      }
      if (filePath) {
        paths.push(quotePath(filePath));
      } else {
        unresolved.push(file.name || "이름 없는 항목");
      }
    }
    if (paths.length) {
      setDraft((current) => (current.trim() ? `${current.replace(/\s+$/, "")} ${paths.join(" ")}` : paths.join(" ")));
    }
    setAttachError(unresolved.length ? `${unresolved.join(", ")}의 경로를 확인하지 못했습니다.` : "");
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

  /**
   * Puts an attached image on the OS clipboard so it can be pasted elsewhere —
   * an image dropped in here is often the one you also want in a ticket or a
   * chat, and until now the only thing you could do with it was remove it.
   * Writing goes through the main process (`clipboard.writeImage`), the same
   * route `POST /api/clipboard/image` takes.
   */
  async function copyAttachment(image: ImageAttachment, index: number) {
    try {
      await window.agentParty.copyImageToClipboard({ dataBase64: image.dataBase64, mediaType: image.mediaType });
      setAttachError("");
      setCopiedIndex(index);
      setTimeout(() => setCopiedIndex((current) => (current === index ? null : current)), 1400);
    } catch (error) {
      // Never a silent no-op: a copy that did not happen has to say so, or the
      // user pastes stale clipboard content and blames the other app.
      setAttachError(`이미지를 클립보드로 복사하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
    }
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

  /**
   * `multiline` is the ONLY thing the layout gets to decide, and it decides a
   * newline — never whether Enter sends. An Enter that must not send is still
   * consumed in the single-line input, because that input sits in a `<form>`
   * where the browser's default action for Enter is "submit": leaving the key
   * alone there made merely narrowing the panel start sending on Enter.
   */
  function onKeyDown(event: KeyboardEvent, multiline: boolean) {
    // The palette claims navigation/selection keys while it is open.
    if (palette.handleKeyDown(event)) {
      return;
    }
    if (event.key !== "Enter") {
      return;
    }
    if (sendsOnEnter(prefs.sendKey, { ctrlOrMeta: event.ctrlKey || event.metaKey, shift: event.shiftKey })) {
      event.preventDefault();
      submit();
      return;
    }
    if (!multiline) {
      event.preventDefault(); // no newline to insert here — just don't submit the form
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
          <button
            type="button"
            className="wb-attachment-copy"
            title={copiedIndex === index ? "복사됨" : "클립보드로 복사"}
            onClick={() => copyAttachment(image, index)}
          >
            {copiedIndex === index ? <Check size={11} /> : <Copy size={11} />}
          </button>
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

  const stopLabel = forceStop ? "강제 종료" : "Stop";
  const onStop = () => (forceStop ? actions.forceStop(view.name) : actions.interrupt(view.name));
  // While the member works this button ADDS TO ITS QUEUE — it no longer turns
  // into Stop. Stop moved to the panel toolbar, because the one control that
  // puts a message in the queue has to stay available exactly when the queue is
  // in use; taking the slot over left no way to queue from the UI at all.
  // A turn that will never complete is the exception: once Stop has gone
  // unanswered that long, the force stop surfaces here rather than staying
  // buried, since at that point queueing behind it is pointless.
  const queueing = view.busy;
  const sendTitle = queueing ? "대기열에 추가" : "Send";
  const iconOnly = forceStop ? (
    <button type="button" className="wb-send is-stop" title={stopLabel} onClick={onStop}><CircleStop size={15} /></button>
  ) : (
    <button type="submit" className={"wb-send" + (queueing ? " is-queueing" : "")} title={sendTitle} disabled={!canSend}>
      {queueing ? <ArrowDownToLine size={15} /> : <Send size={15} />}
    </button>
  );
  const labeled = forceStop ? (
    <button type="button" className="wb-send-labeled is-stop" title={stopLabel} onClick={onStop}>{stopLabel} <CircleStop size={14} /></button>
  ) : (
    <button type="submit" className={"wb-send-labeled" + (queueing ? " is-queueing" : "")} title={sendTitle} disabled={!canSend}>
      {queueing ? <>대기열에 추가 <ArrowDownToLine size={14} /></> : <>Send <Send size={14} /></>}
    </button>
  );
  // Permission control next to Send: Codex members get the two-axis
  // (sandbox × approval + guardian) control; Claude members get the single mode.
  const permission = harnessCapabilities(harness).twoAxisPermission ? (
    <CodexPermissionControl
      policy={view.session?.snapshot.codexPolicy || view.member.codexPolicy || DEFAULT_CODEX_POLICY}
      onChange={(policy) => actions.setCodexPolicy(view.name, policy)}
    />
  ) : harness === "cursor" ? (
    <CursorPermissionControl
      policy={cursorPolicyOf(view.session?.snapshot.cursorPolicy || view.member.cursorPolicy, view.permissionMode)}
      onChange={(policy) => actions.setCursorPolicy(view.name, policy)}
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

  /**
   * "편집" on a queued row hands the text back here. Appended rather than
   * substituted, so recalling a message never destroys something already typed.
   */
  function takeBackForEdit(text: string) {
    setDraft((current) => (current.trim() ? `${current.replace(/\s+$/, "")}\n${text}` : text));
    textareaRef.current?.focus();
  }

  // Sits between the transcript and the composer, inside the same border-top
  // block, and never scrolls — the transcript gives up the space instead.
  const queuePanel = <MessageQueue view={view} density={density} actions={actions} onEditBack={takeBackForEdit} />;

  if (density === "narrow" && !expanded) {
    return (
      <form className={"wb-composer is-narrow" + (dragging ? " is-drag" : "")} onSubmit={submit} {...dragProps}>
        {palettePopover}
        {queuePanel}
        {attachmentStrip}
        {attachHint}
        <div className="wb-composer-bar">
          <input
            className="wb-composer-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => onKeyDown(event, false)}
            onPaste={onPaste}
            placeholder={queueing ? `${view.name} 작업 중 — 대기열에 쌓입니다` : `${view.name}에게…`}
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
      {queuePanel}
      <div className="wb-composer-box">
        {attachmentStrip}
        {attachHint}
        <textarea
          ref={textareaRef}
          className="wb-composer-textarea"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => onKeyDown(event, true)}
          onPaste={onPaste}
          rows={2}
          // While the member works, say where the text will actually GO. Without
          // this the box still reads "send a message" at the exact moment it no
          // longer sends one.
          placeholder={
            queueing
              ? `${view.name}가 작업 중 — 보내면 대기열에 쌓입니다`
              : imageBlocked
                ? `${view.name}에게 메시지 보내기…`
                : `${view.name}에게 메시지 보내기… (이미지 붙여넣기/끌어놓기 가능)`
          }
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
      {/* Shown for ANY drag: a text-only model still accepts a dropped path. */}
      {dragging && (
        <div className="wb-composer-dropzone">
          {imageBlocked ? "여기에 파일을 놓으면 경로가 입력됩니다" : "이미지는 첨부되고, 그 외 파일은 경로가 입력됩니다"}
        </div>
      )}
    </form>
  );
}

/**
 * Quotes a path that contains whitespace, so a member reading the message can
 * tell one dropped path from the next.
 */
function quotePath(filePath: string): string {
  return /\s/.test(filePath) ? `"${filePath}"` : filePath;
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
