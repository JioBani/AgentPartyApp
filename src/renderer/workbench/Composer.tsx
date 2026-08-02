import { DragEvent, FormEvent, KeyboardEvent, ClipboardEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDownToLine, AtSign, CircleStop, FileText, ImageOff, Maximize2, Send, X } from "lucide-react";
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
import { fileReference, type FileReference, type ReferenceKind } from "../../shared/fileReferences";
import {
  clampOutOfChip,
  createMentionChip,
  draftReferences,
  endOfDraft,
  insertChipAt,
  rehydrateDraft,
  serializeDraft,
  setCaret,
} from "./composerDraft";
import { sendsOnEnter } from "../../shared/composerSettings";
import { useComposerPrefs } from "../app/composerPrefs";
import { usePartyMembers } from "../app/partyMemberPrefs";
import { MentionPalette } from "./MentionPalette";
import { applyMention, detectMention, mentionCandidates, type MentionCandidate } from "./mentionModel";

interface ComposerProps {
  view: MemberView;
  density: PanelDensity;
  actions: WorkbenchActions;
}

/**
 * Per-member message composer. Wide/mid render a two-row textarea with a tool
 * row; narrow collapses to a single-line input so the send control stays
 * reachable. While the member is working that control ADDS TO ITS QUEUE — Stop
 * lives in the panel toolbar, because the send slot is the only way to queue a
 * message and cannot be the thing that disappears exactly when the queue is in
 * use. The member's message queue renders directly above, inside this same
 * bordered block.
 *
 * Which keystroke sends is a global preference (Settings → 입력창), applied
 * identically in both layouts — the narrow input must never send on a key the
 * wide textarea treats as a newline. Ctrl/Cmd+Enter sends under both settings
 * and additionally SKIPS THE WAIT: the message is queued and handed over at
 * once. ArrowUp in an empty composer takes the last queued message back.
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
  const prefs = useComposerPrefs();
  /** The rich editing surface. Its serialization IS `draft`. */
  const editorRef = useRef<HTMLDivElement>(null);
  /**
   * Every reference the editor has held this draft. Kept so a draft restored
   * from outside (queue edit) can turn its paths back into chips; the editor's
   * own chips remain the source of truth for what gets sent.
   */
  const knownRefs = useRef<FileReference[]>([]);
  /** Last text pushed INTO the editor, so we only rebuild on external changes. */
  const renderedRef = useRef("");
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

  // --- `@` member mention -------------------------------------------------
  // Deliberately not part of the `/` palette: that one fires only when the whole
  // draft is the command, while a mention happens mid-sentence and replaces just
  // the token under the caret. Keeping them apart leaves `/` untouched.
  const partyMembers = usePartyMembers();
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const [mentionIndex, setMentionIndex] = useState(0);
  /** The caret's own text node and offset — a mention never spans nodes. */
  const [caretText, setCaretText] = useState("");
  /** Viewport position of the caret, so the popover can sit against it. */
  const [caretAnchor, setCaretAnchor] = useState<{ left: number; top: number } | null>(null);
  const mention = useMemo(() => detectMention(caretText, caretText.length), [caretText]);
  const mentionMatches = useMemo(
    () => (mention ? mentionCandidates(partyMembers, view.name, mention.query) : []),
    [mention, partyMembers, view.name],
  );
  const mentionOpen = Boolean(mention) && !mentionDismissed && mentionMatches.length > 0;

  useEffect(() => { setMentionIndex(0); }, [mention?.query]);
  useEffect(() => { if (!mention) { setMentionDismissed(false); } }, [mention]);

  /** The caret's text node and offset, when the caret is inside the editor. */
  function caretPoint(): { node: Text; offset: number } | null {
    const root = editorRef.current;
    const selection = root?.ownerDocument.defaultView?.getSelection();
    if (!root || !selection || selection.rangeCount === 0) {
      return null;
    }
    const range = selection.getRangeAt(0);
    if (!root.contains(range.startContainer) || range.startContainer.nodeType !== Node.TEXT_NODE) {
      return null;
    }
    return { node: range.startContainer as Text, offset: range.startOffset };
  }

  /** Re-reads the text before the caret, which is what arms `@`. */
  function syncCaret() {
    const point = caretPoint();
    setCaretText(point ? (point.node.nodeValue || "").slice(0, point.offset) : "");
    setCaretAnchor(caretRect());
  }

  /**
   * Where the caret is on screen, so the popover can sit against it the way an
   * editor's completion does. Anchored to the corner of the box instead, it
   * points at nothing once the sentence is more than a few words long.
   */
  function caretRect(): { left: number; top: number } | null {
    const root = editorRef.current;
    const selection = root?.ownerDocument.defaultView?.getSelection();
    if (!root || !selection || selection.rangeCount === 0 || !root.contains(selection.getRangeAt(0).startContainer)) {
      return null;
    }
    const range = selection.getRangeAt(0).cloneRange();
    range.collapse(true);
    // A collapsed range has no rect of its own in some positions; a zero-width
    // probe character gives one, and is removed immediately.
    let rect = range.getClientRects()[0];
    if (!rect) {
      const probe = root.ownerDocument.createElement("span");
      probe.textContent = "​";
      range.insertNode(probe);
      rect = probe.getBoundingClientRect();
      const parent = probe.parentNode;
      probe.remove();
      parent?.normalize();
    }
    return rect ? { left: rect.left, top: rect.top } : null;
  }

  /** The editor changed: its serialization becomes the draft. */
  function syncDraft() {
    const root = editorRef.current;
    if (!root) {
      return;
    }
    const text = serializeDraft(root);
    renderedRef.current = text;
    setDraft(text);
    syncCaret();
  }

  function applyMentionChoice(member: MentionCandidate) {
    const point = caretPoint();
    const root = editorRef.current;
    if (!mention || !point || !root) {
      return;
    }
    // Replace only the `@query` under the caret — the rest of the sentence, and
    // every chip in it, is left alone. The `@name` becomes a chip so a mention
    // reads the same here as it will in the sent message.
    const doc = root.ownerDocument;
    const start = point.offset - mention.query.length - 1;
    const range = doc.createRange();
    range.setStart(point.node, Math.max(0, start));
    range.setEnd(point.node, point.offset);
    range.deleteContents();

    const chip = createMentionChip(doc, member.name, member.color);
    const trailing = doc.createTextNode(" ");
    const fragment = doc.createDocumentFragment();
    fragment.appendChild(chip);
    fragment.appendChild(trailing);
    range.insertNode(fragment);

    const after = doc.createRange();
    after.setStart(trailing, trailing.length);
    after.collapse(true);
    setCaret(root, after);
    setMentionDismissed(true);
    syncDraft();
  }

  /**
   * Types `@` at the caret for the toolbar button, adding a leading space when
   * needed so the trigger starts a word (mid-word it is an email address, and
   * the popover correctly refuses to open).
   */
  function insertMentionTrigger() {
    const root = editorRef.current;
    if (!root) {
      return;
    }
    root.focus();
    const point = caretPoint();
    const doc = root.ownerDocument;
    const range = doc.createRange();
    if (point) {
      const before = (point.node.nodeValue || "").slice(0, point.offset);
      const inserted = before.length > 0 && !/[\s(\[{"']$/.test(before) ? " @" : "@";
      point.node.nodeValue = before + inserted + (point.node.nodeValue || "").slice(point.offset);
      range.setStart(point.node, before.length + inserted.length);
    } else {
      const node = doc.createTextNode(root.textContent ? " @" : "@");
      root.appendChild(node);
      range.setStart(node, node.nodeValue!.length);
    }
    range.collapse(true);
    setCaret(root, range);
    setMentionDismissed(false);
    syncDraft();
  }

  /** Returns true when the mention popover consumed the key. */
  function handleMentionKey(event: KeyboardEvent): boolean {
    if (!mentionOpen) {
      return false;
    }
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setMentionIndex((i) => (i + 1) % mentionMatches.length);
        return true;
      case "ArrowUp":
        event.preventDefault();
        setMentionIndex((i) => (i - 1 + mentionMatches.length) % mentionMatches.length);
        return true;
      case "Enter":
      case "Tab":
        event.preventDefault();
        applyMentionChoice(mentionMatches[Math.min(mentionIndex, mentionMatches.length - 1)]);
        return true;
      case "Escape":
        event.preventDefault();
        setMentionDismissed(true);
        return true;
      default:
        return false;
    }
  }

  /*
   * A contenteditable must not be re-rendered by the framework on every
   * keystroke — that destroys the caret. The draft is held as a value and the
   * DOM is written directly, so this only rebuilds when the draft changed from
   * OUTSIDE the editor (cleared after send, restored from the queue), detected
   * by comparing against what was last put in.
   */
  useLayoutEffect(() => {
    const root = editorRef.current;
    if (!root || renderedRef.current === draft) {
      return;
    }
    renderedRef.current = draft;
    rehydrateDraft(root, draft, knownRefs.current, partyMembers);
    if (document.activeElement === root) {
      setCaret(root, endOfDraft(root));
    }
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
    if (files.length) {
      event.preventDefault();
      void addFiles(files);
      return;
    }
    // Paste as PLAIN text. A contenteditable would otherwise take the clipboard's
    // HTML — fonts, colours, even elements that look like chips but carry no
    // path — and the editor would stop being a faithful view of what is sent.
    const text = event.clipboardData?.getData("text/plain");
    if (text) {
      event.preventDefault();
      event.currentTarget.ownerDocument.execCommand("insertText", false, text);
      syncDraft();
    }
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
    const transfer = event.dataTransfer;
    const files = Array.from(transfer?.files || []);
    if (files.length === 0) {
      return;
    }
    event.preventDefault();

    // `webkitGetAsEntry` is the only thing that tells a folder from a file here,
    // and the items are neutered once this handler returns — so read the kinds
    // NOW, before any await.
    const kinds = Array.from(transfer?.items || []).map((item) => {
      const entry = item.webkitGetAsEntry?.();
      return entry?.isDirectory ? "folder" : "file";
    }) as ReferenceKind[];

    const images = files.filter((file) => file.type.startsWith("image/"));
    // A folder has no MIME type, so it can never be mistaken for an image.
    const others = files
      .map((file, index) => ({ file, kind: kinds[index] || "file" }))
      .filter(({ file, kind }) => kind === "folder" || !file.type.startsWith("image/"));

    if (images.length) {
      void addFiles(images);
    }
    if (others.length) {
      // Where the pointer let go — that is where the chip belongs, because the
      // words around it are what say which file is meant.
      insertReferences(others, dropRange(event));
    }
  }

  /** The caret position under the drop point, falling back to the draft's end. */
  function dropRange(event: DragEvent): Range | null {
    const root = editorRef.current;
    if (!root) {
      return null;
    }
    const doc = root.ownerDocument as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null };
    const at = doc.caretRangeFromPoint?.(event.clientX, event.clientY) || null;
    if (at && root.contains(at.startContainer)) {
      return clampOutOfChip(at);
    }
    return endOfDraft(root);
  }

  /**
   * Inserts a chip per dropped item at the drop point, reporting any whose path
   * could not be resolved.
   *
   * The chip displays the name; the element carries the full path, and that is
   * what serialization sends. An item whose path cannot be read is surfaced
   * rather than skipped — silently dropping it would leave the user believing
   * they attached something the member cannot open.
   */
  function insertReferences(items: { file: File; kind: ReferenceKind }[], range: Range | null) {
    const root = editorRef.current;
    if (!root) {
      return;
    }
    root.focus();
    let at = range || endOfDraft(root);
    const unresolved: string[] = [];
    for (const { file, kind } of items) {
      let filePath = "";
      try {
        filePath = window.agentParty.pathForFile?.(file) || "";
      } catch {
        filePath = ""; // reported below — never a silent drop
      }
      if (!filePath) {
        unresolved.push(file.name || "이름 없는 항목");
        continue;
      }
      const reference = fileReference(filePath, kind);
      knownRefs.current = [...knownRefs.current.filter((r) => r.path !== reference.path), reference];
      at = insertChipAt(root, at, reference);
    }
    setCaret(root, at);
    syncDraft();
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
   * `bypassQueue` is Ctrl/Cmd+Enter — already this app's universal "send now".
   * With a busy member that now also means "do not wait your turn": the message
   * is parked like any other (so it is never lost if the delivery fails) and
   * then immediately handed over, which is exactly what the row's 지금 보내기
   * does. An idle member is unaffected; nothing was queued to skip.
   */
  function submit(event?: FormEvent, bypassQueue = false) {
    event?.preventDefault();
    // What the model receives is the editor read back as plain text: every chip
    // writes out its FULL path. The chip only ever shortened the display.
    const root = editorRef.current;
    const text = (root ? serializeDraft(root) : draft).trim();
    if (!text && attachments.length === 0) {
      return;
    }
    const images = attachments.length ? attachments : undefined;
    setDraft("");
    knownRefs.current = [];
    setAttachments([]);
    setAttachError("");
    void (async () => {
      const result = await actions.sendMessage(view.name, text, images);
      if (!bypassQueue || !result?.queued) {
        return;
      }
      const parked = result.queue?.items?.at(-1);
      if (parked) {
        await actions.runQueueCommand(view.name, { action: "sendItem", itemId: parked.id });
      }
    })().catch((error) => {
      // The message is still in the queue if this failed — say so rather than
      // leaving the user thinking Ctrl+Enter did nothing.
      setAttachError(`지금 보내기에 실패했습니다 (메시지는 대기열에 있습니다): ${error instanceof Error ? error.message : String(error)}`);
    });
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
    // …and so does the mention popover, so Enter picks a member instead of
    // sending a half-typed `@nam`.
    if (handleMentionKey(event)) {
      return;
    }
    // ArrowUp in an EMPTY composer takes the last queued message back for
    // editing — the fastest correction path when you have just realised the
    // message waiting at the bottom of the queue is wrong. Only when empty, so
    // it never fights with cursor movement in real text.
    if (event.key === "ArrowUp" && !draft) {
      const last = view.member.queue?.items.at(-1);
      if (last) {
        event.preventDefault();
        void actions.runQueueCommand(view.name, { action: "edit", itemId: last.id })
          .then((result) => result?.text && takeBackForEdit(result.text))
          .catch((error) => setAttachError(`대기열에서 되돌리지 못했습니다: ${error instanceof Error ? error.message : String(error)}`));
      }
      return;
    }
    if (event.key !== "Enter") {
      return;
    }
    if (sendsOnEnter(prefs.sendKey, { ctrlOrMeta: event.ctrlKey || event.metaKey, shift: event.shiftKey })) {
      event.preventDefault();
      submit(undefined, event.ctrlKey || event.metaKey);
      return;
    }
    if (!multiline) {
      event.preventDefault(); // no newline to insert here — just don't submit the form
    }
  }

  // A dropped file is a complete request on its own: the draft is non-empty the
  // moment a chip is in it, because a chip serializes to its path.
  const canSend = Boolean(draft.trim()) || attachments.length > 0;
  /**
   * The editing surface, shared by both densities.
   *
   * `contenteditable` rather than a textarea because a chip has to sit INSIDE
   * the sentence. React must never re-render it from `draft` (that would kill
   * the caret), so it is uncontrolled here and rebuilt only by the effect above.
   * The placeholder is CSS on an empty editor, since there is no native one.
   */
  function editor(className: string, multiline: boolean, placeholder: string) {
    return (
      <div
        ref={editorRef}
        className={className + " wb-composer-editor"}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline={multiline}
        aria-label={`${view.name}에게 보낼 메시지`}
        data-placeholder={placeholder}
        // What this editor would actually SEND, with every chip expanded to the
        // full path it stands for. The screen deliberately shows a short name
        // instead, so the two differ — and anything reading the editor from
        // outside (QA driving the real UI) would otherwise have to reconstruct
        // the difference and could get it wrong without anyone noticing. This
        // is the draft the composer already computes, not a second opinion.
        data-draft={draft}
        onInput={syncDraft}
        onKeyDown={(event) => onKeyDown(event, multiline)}
        onKeyUp={syncCaret}
        onClick={syncCaret}
        onFocus={syncCaret}
        onPaste={onPaste}
      />
    );
  }

  const palettePopover = palette.open ? (
    <CommandPalette commands={palette.matches} activeIndex={palette.activeIndex} onHover={palette.setActiveIndex} onSelect={palette.apply} />
  ) : null;
  const mentionPopover = mentionOpen ? (
    <MentionPalette
      members={mentionMatches}
      activeIndex={mentionIndex}
      onHover={setMentionIndex}
      onSelect={applyMentionChoice}
      compact={density === "narrow"}
      anchor={caretAnchor}
    />
  ) : null;

  // R-18 moved image copy to the transcript (where the image stays after send).
  // The composer strip only removes — copying a not-yet-sent paste is rarely
  // useful, and the control made the mis-wired feature look "done".
  //
  // Only IMAGES live here. A file or folder goes inline in the sentence, where
  // the words next to it say which one is meant.
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

  const stopLabel = forceStop ? "강제 종료" : "Stop";
  const onStop = () => (forceStop ? actions.forceStop(view.name) : actions.interrupt(view.name));
  const queueing = view.busy;
  /**
   * Stop sits BESIDE the send control, not in it.
   *
   * It used to take the slot over while a member worked, which removed the only
   * way to queue a message from the UI — exactly when the queue is what you
   * want. So it moved to the panel toolbar, far from the hand. It belongs here,
   * where the typing happens; it just must not be the same button. Two
   * controls, side by side: one adds to the queue, one stops the turn.
   */
  const stopBeside = (view.busy || interrupting) && !forceStop ? (
    <button type="button" className="wb-composer-stop" title={interrupting ? "중단하는 중…" : "진행 중인 턴 중단"} onClick={onStop}>
      <CircleStop size={14} /> {interrupting ? "중단 중" : "Stop"}
    </button>
  ) : null;
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
    // Goes through `draft`, so the rehydrate effect rebuilds the editor and any
    // path in the recalled text becomes a chip again where it is still known.
    setDraft((current) => (current.trim() ? `${current.replace(/\s+$/, "")}\n${text}` : text));
    editorRef.current?.focus();
  }

  // Sits between the transcript and the composer, inside the same border-top
  // block, and never scrolls — the transcript gives up the space instead.
  const queuePanel = <MessageQueue view={view} density={density} actions={actions} onEditBack={takeBackForEdit} />;

  if (density === "narrow" && !expanded) {
    return (
      <form className={"wb-composer is-narrow" + (dragging ? " is-drag" : "")} onSubmit={submit} {...dragProps}>
        {palettePopover}
        {mentionPopover}
        {queuePanel}
        {attachmentStrip}
        {attachHint}
        <div className="wb-composer-bar">
          {editor("wb-composer-input", false, queueing ? `${view.name} 작업 중 — 대기열에 쌓입니다` : `${view.name}에게…`)}
          <button type="button" className="wb-icon-btn" title="Expand" onClick={() => setExpanded(true)}><Maximize2 size={13} /></button>
          {stopBeside && (
            <button type="button" className="wb-composer-stop is-icon" title={interrupting ? "중단하는 중…" : "진행 중인 턴 중단"} onClick={onStop}>
              <CircleStop size={14} />
            </button>
          )}
          {iconOnly}
          {permission}
        </div>
      </form>
    );
  }

  return (
    <form className={"wb-composer" + (dragging ? " is-drag" : "")} onSubmit={submit} {...dragProps}>
      {palettePopover}
      {mentionPopover}
      {queuePanel}
      <div className="wb-composer-box">
        {attachmentStrip}
        {attachHint}
        {/* While the member works, say where the text will actually GO — the box
            must not read "send a message" at the moment it no longer sends one. */}
        {editor(
          "wb-composer-textarea",
          true,
          queueing
            ? `${view.name}가 작업 중 — 보내면 대기열에 쌓입니다`
            : imageBlocked
              ? `${view.name}에게 메시지 보내기… (파일·폴더 끌어놓기 가능)`
              : `${view.name}에게 메시지 보내기… (이미지·파일·폴더 끌어놓기 가능)`,
        )}
        <div className="wb-composer-row">
          <div className="wb-composer-tools">
            {/* This button existed but did nothing. It is the entry point for
                anyone who does not know the `@` shortcut, so it types the `@`
                at the caret and lets the popover open exactly as typing would. */}
            <button type="button" className="wb-icon-btn" title="멤버 멘션" aria-label="멤버 멘션" onClick={insertMentionTrigger}><AtSign size={14} /></button>
          </div>
          <div className="wb-composer-actions">
            {stopBeside}
            {labeled}
            {permission}
          </div>
        </div>
      </div>
      {/* Shown for ANY drag: a text-only model still accepts a dropped path. */}
      {dragging && (
        <div className="wb-composer-dropzone">
          {imageBlocked ? "놓은 자리에 파일·폴더가 붙습니다" : "이미지는 첨부되고, 파일·폴더는 놓은 자리에 붙습니다"}
        </div>
      )}
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
