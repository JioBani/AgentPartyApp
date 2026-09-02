import { DragEvent, FormEvent, KeyboardEvent, ClipboardEvent, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDownToLine, CircleStop, FileText, ImageOff, Maximize2, Send, Users, X } from "lucide-react";
import { MessageQueue } from "./MessageQueue";
import type { MemberView, PanelDensity } from "./types";
import type { WorkbenchActions } from "./actions";
import { Dropdown } from "./Dropdown";
import { HarnessPermissionControl } from "./HarnessPermissionControl";
import type { HarnessId, PermissionModeSetting } from "../../shared/types";
import { harnessForRuntime } from "../../shared/types";
import { CommandPalette } from "./CommandPalette";
import { useCommandPalette } from "./useCommandPalette";
import type { PaletteAction } from "./paletteModel";
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
  createTokenChip,
  draftReferences,
  endOfDraft,
  insertChipAt,
  rehydrateDraft,
  serializeDraft,
  setCaret,
} from "./composerDraft";
import { sendsImmediately, sendsOnEnter } from "../../shared/composerSettings";
import { useComposerPrefs } from "../app/composerPrefs";
import { usePartyMembers } from "../app/partyMemberPrefs";
import { useModelRoutes } from "../app/modelRoutePrefs";
import { CompletionPopover, type PopoverSection } from "./CompletionPopover";
import { mentionCandidates, EVERYONE } from "./mentionModel";
import {
  detectCompletion,
  flattenRows,
  memberSections,
  sectionsForStage,
  stagesAfterModel,
  STAGE_LABELS,
  type ChainStage,
  type CompletionRow,
  type CompletionSection,
} from "./completionModel";
import { HarnessIcon } from "./HarnessIcon";
import { queryVariants } from "./hangulKeys";
import { LocalizedText, localized } from "../i18n/I18nProvider";
import {
  clearComposerDraft,
  composerDraftKey,
  readComposerDraft,
  writeComposerDraft,
} from "./composerDraftStore";

interface ComposerProps {
  view: MemberView;
  density: PanelDensity;
  actions: WorkbenchActions;
  commandUi: {
    openRuntime: () => void;
    openPermissions: () => void;
    openMcp: () => void;
    openStatus: () => void;
    openUsage: () => void;
    openAutoCompact: () => void;
  };
  /** Show the permission control beside Send. The guide window turns this off:
   *  its session runs on a fixed permission set the user must not change
   *  (F-15 §6-2), and a control that cannot be honoured must not be shown. */
  permission?: boolean;
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

function ComposerView({ view, density, actions, commandUi, permission: showPermission = true }: ComposerProps) {
  const draftKey = composerDraftKey(view.member);
  const savedDraft = readComposerDraft(draftKey);
  const [draft, setDraft] = useState(() => savedDraft?.text || "");
  const [expanded, setExpanded] = useState(false);
  const [attachments, setAttachments] = useState<ImageAttachment[]>(() => savedDraft?.attachments || []);
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
  const knownRefs = useRef<FileReference[]>(savedDraft?.references || []);
  /** Last text pushed INTO the editor, so we only rebuild on external changes. */
  const renderedRef = useRef("");
  /** Prevents a second key gesture from submitting the same still-visible turn. */
  const sendingRef = useRef(false);
  /** A successful send clears only the exact revision it submitted. */
  const revisionRef = useRef(0);
  const harness = harnessForRuntime(view.member.runtime);

  useEffect(() => {
    if (!draft && attachments.length === 0) {
      clearComposerDraft(draftKey);
      return;
    }
    writeComposerDraft(draftKey, { text: draft, attachments, references: [...knownRefs.current] });
  }, [draftKey, draft, attachments]);

  // React may unmount the composer before a passive effect gets its turn (tab
  // close, party switch, navigation). A layout-effect cleanup closes that gap.
  useLayoutEffect(() => () => {
    writeComposerDraft(draftKey, { text: draft, attachments, references: [...knownRefs.current] });
  }, [draftKey, draft, attachments]);

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

  function runPaletteAction(action: PaletteAction) {
    if (action === "compact") actions.compact(view.name);
    else if (action === "restart") actions.restart(view.name);
    else if (action === "interrupt") actions.interrupt(view.name);
    else if (action === "runtime") commandUi.openRuntime();
    else if (action === "permissions") commandUi.openPermissions();
    else if (action === "mcp") commandUi.openMcp();
    else if (action === "status") commandUi.openStatus();
    else if (action === "usage") commandUi.openUsage();
    else if (action === "auto-compact") commandUi.openAutoCompact();
    else if (action === "environment") actions.openEnvironmentSettings();
  }

  // Command/skill palette — harness-aware (`/` for claude-code/codex, etc.).
  const palette = useCommandPalette({
    runtime: harness,
    discovered: view.session?.snapshot.slashCommands,
    draft,
    setDraft,
    onAction: runPaletteAction,
  });

  // --- Triggerless members / providers / models ----------------------------
  // Deliberately not part of the `/` palette: that one fires only when the whole
  // draft is the command, while these happen mid-sentence and replace just the
  // token under the caret. Keeping them apart leaves `/` untouched.
  //
  // A normal word opens one combined member/provider/model list. The model side
  // is a CHAIN — provider, model, then whatever that model supports (effort,
  // thinking, service tier). Stage 1 is driven by the word under the caret;
  // every stage after it is driven by `chain`, because the first choice is
  // already a chip and there is no source word left to detect.
  const partyMembers = usePartyMembers();
  const modelRoutes = useModelRoutes();
  const [completionDismissed, setCompletionDismissed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  /**
   * The model chain in progress.
   *
   * `stages`/`at` is the walk; `provider`/`model` are what has been chosen so far
   * and decide what the remaining stages offer; `chips` lets Backspace take a
   * step back out rather than leaving an orphan token in the sentence; `query`
   * is the filter typed INSIDE the popover (the model stage can hold twenty
   * rows, and by then there is no trigger text left in the draft to type into).
   */
  const [chain, setChain] = useState<
    { stages: ChainStage[]; at: number; chips: HTMLElement[]; provider?: string; model?: CompletionRow; query: string } | null
  >(null);
  /**
   * Every completion chip in dependency order, retained even when the visible
   * chain has reached its end. Native contenteditable deletion happens after
   * that point too: deleting a model must still know which provider to reopen.
   */
  const completionTrail = useRef<Array<{ chip: HTMLElement; row: CompletionRow }>>([]);
  /** The caret's own text node and offset — a trigger never spans nodes. */
  const [caretText, setCaretText] = useState("");
  /** Viewport position of the caret, so the popover can sit against it. */
  const [caretAnchor, setCaretAnchor] = useState<{ left: number; top: number } | null>(null);

  const trigger = useMemo(() => detectCompletion(caretText, caretText.length), [caretText]);
  /**
   * The stage being shown: a live chain wins, otherwise any detected word that
   * can name a model starts at the provider list.
   */
  const stage: ChainStage | null = chain ? chain.stages[chain.at] ?? null : trigger && trigger.kind !== "member" ? "provider" : null;

  /**
   * The one list. Everything else is derived from it, so what the popover shows
   * and what the keys select can never disagree.
   */
  const resolved: CompletionSection[] = useMemo(() => {
    if (chain) {
      // The in-popover filter gets the same IME treatment as the trigger text:
      // `햐` typed with the IME on is the keys `gi`, and both spellings are tried.
      const queries = queryVariants(chain.query);
      return stage ? sectionsForStage(stage, modelRoutes, { provider: chain.provider, model: chain.model?.route }, queries) : [];
    }
    if (!trigger) {
      return [];
    }
    const members = trigger.kind === "model"
      ? []
      : memberSections(mentionCandidates(partyMembers, view.name, trigger.queries));
    const models = trigger.kind === "member"
      ? []
      : sectionsForStage("provider", modelRoutes, {}, trigger.queries);
    return [...members, ...models];
  }, [chain, stage, trigger, partyMembers, view.name, modelRoutes]);

  const rows: CompletionRow[] = useMemo(() => flattenRows(resolved), [resolved]);
  const sections: PopoverSection[] = useMemo(
    () => resolved.map((section) => ({
      key: section.key,
      label: section.label,
      rows: section.rows.map((row) => ({
        key: row.key,
        label: row.label,
        secondary: row.secondary,
        accent: row.accent,
        className: row.className,
        // Icons are attached here because the row models are pure data modules
        // and must stay free of JSX: `everyone` is a group rather than a person
        // so it gets the group glyph, and a provider/harness gets the app's
        // existing brand mark — the same one the wizard and sidebar draw, not a
        // second icon set that could drift from them.
        icon: row.key === EVERYONE
          ? <Users size={11} className="wb-mention-everyone-icon" />
          : row.iconKey
            ? <HarnessIcon harness={row.iconKey} size={13} />
            : undefined,
      })),
    })),
    [resolved],
  );

  const completionOpen = (Boolean(chain) || Boolean(trigger)) && !completionDismissed && rows.length > 0;
  /**
   * The heading names what is actually on screen.
   *
   * Stage 1 can hold providers, harnesses and models at once, and a query often
   * filters it down to just one of them — a "프로바이더" heading over a list of
   * models would be a plain lie, so a surviving single section names itself.
   */
  const completionTitle = trigger?.kind === "member" && !chain
    ? "멤버"
    : resolved.length === 1 ? resolved[0].label
      : trigger?.kind === "all" && !chain ? "자동완성"
        : stage ? STAGE_LABELS[stage] : "모델";

  useEffect(() => { setActiveIndex(0); }, [trigger?.queries.join(" "), trigger?.kind, chain?.at]);
  useEffect(() => { if (!trigger && !chain) { setCompletionDismissed(false); } }, [trigger, chain]);

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

  /** Re-reads the text before the caret, which drives triggerless completion. */
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
  function syncDraft(options: FormEvent | { allowDetachedChainChip?: boolean } = {}) {
    const root = editorRef.current;
    if (!root) {
      return;
    }
    const allowDetachedChainChip = "allowDetachedChainChip" in options && options.allowDetachedChainChip === true;
    // Native contenteditable deletion owns the DOM before React sees the input
    // event. Reconcile the semantic completion path with those removed nodes.
    // A deleted MODEL returns to the models of its still-present provider; a
    // deleted provider closes the path. Controlled stage-back navigation opts
    // out because its key handler replaces the chain itself.
    if (!allowDetachedChainChip) {
      const detachedAt = completionTrail.current.findIndex(({ chip }) => !root.contains(chip));
      if (detachedAt >= 0) {
        const removed = completionTrail.current[detachedAt];
        // Options after the removed choice depend on it and cannot stay valid.
        // Remove them visibly instead of leaving e.g. an orphan effort token.
        for (const dependent of completionTrail.current.slice(detachedAt + 1)) {
          if (root.contains(dependent.chip)) {
            removeChip(dependent.chip);
          }
        }
        const remaining = completionTrail.current.slice(0, detachedAt).filter(({ chip }) => root.contains(chip));
        completionTrail.current = remaining;
        const provider = [...remaining].reverse().find(({ row }) => row.kind === "provider");
        const reopenProvider = provider?.row.provider || (removed.row.kind === "model" ? removed.row.provider : undefined);
        if (removed.row.kind === "model" && reopenProvider) {
          setChain({
            stages: ["model"],
            at: 0,
            chips: remaining.map(({ chip }) => chip),
            provider: reopenProvider,
            query: "",
          });
        } else {
          setChain(null);
        }
        setCompletionDismissed(false);
      }
    }
    const text = serializeDraft(root);
    revisionRef.current += 1;
    renderedRef.current = text;
    if (!text && attachments.length === 0) {
      clearComposerDraft(draftKey);
    } else {
      writeComposerDraft(draftKey, { text, attachments, references: [...knownRefs.current] });
    }
    setDraft(text);
    if (attachError) {
      setAttachError("");
    }
    syncCaret();
  }

  /**
   * Writes the chosen row into the editor as a chip and reports where it landed.
   *
   * Stage 1 replaces the matching word under the caret. Later stages have no
   * source word to replace — the previous choice is already a chip — so they
   * append at the caret instead. Either way only the token is touched: the rest
   * of the sentence, and every chip in it, is left alone.
   */
  function insertRowChip(row: CompletionRow, replaceTrigger: boolean): HTMLElement | null {
    const point = caretPoint();
    const root = editorRef.current;
    if (!point || !root) {
      return null;
    }
    const doc = root.ownerDocument;
    const range = doc.createRange();
    if (replaceTrigger && trigger) {
      const start = point.offset - (trigger.end - trigger.start);
      range.setStart(point.node, Math.max(0, start));
      range.setEnd(point.node, point.offset);
      range.deleteContents();
    } else {
      range.setStart(point.node, point.offset);
      range.collapse(true);
    }

    const chip = row.kind === "member"
      ? createMentionChip(doc, row.value, row.accent || "var(--text-2)")
      : createTokenChip(doc, row.kind, row.label, row.value);
    const trailing = doc.createTextNode(" ");
    const fragment = doc.createDocumentFragment();
    fragment.appendChild(chip);
    fragment.appendChild(trailing);
    range.insertNode(fragment);

    const after = doc.createRange();
    after.setStart(trailing, trailing.length);
    after.collapse(true);
    setCaret(root, after);
    return chip;
  }

  /** Removes a chip and the separator space that was inserted with it. */
  function removeChip(chip: HTMLElement) {
    const next = chip.nextSibling;
    if (next && next.nodeType === Node.TEXT_NODE && (next.nodeValue || "") === " ") {
      next.parentNode?.removeChild(next);
    }
    chip.parentNode?.removeChild(chip);
  }

  /**
   * Accepts a row. `advance` is the difference between Enter/Tab and `→`: both
   * commit, only the first walks on to the next stage of a model chain.
   */
  function applyCompletionChoice(row: CompletionRow, advance: boolean) {
    const first = !chain;
    const chip = insertRowChip(row, first);
    if (!chip) {
      return;
    }
    const chips = first ? [chip] : [...chain!.chips, chip];
    if (row.kind === "member") {
      completionTrail.current = [];
    } else {
      const connected = first
        ? []
        : completionTrail.current.filter((entry) => editorRef.current?.contains(entry.chip));
      completionTrail.current = [...connected, { chip, row }];
    }
    // What follows depends on WHAT was chosen, not on how far along we are:
    // a provider opens the model list, a model opens whatever that model
    // supports, and a harness or a member has nothing after it at all.
    const nextStages: ChainStage[] =
      row.kind === "provider" ? ["model"]
        : row.kind === "model" ? stagesAfterModel(row.route)
        : [];
    const continuing = row.kind === "provider" || row.kind === "model";
    if (advance && continuing && nextStages.length) {
      setChain({
        stages: nextStages,
        at: 0,
        chips,
        provider: row.kind === "provider" ? row.provider : chain?.provider || row.provider,
        model: row.kind === "model" ? row : chain?.model,
        query: "",
      });
      setCompletionDismissed(false);
    } else if (advance && !continuing && chain && chain.at + 1 < chain.stages.length) {
      // A capability stage: walk to the next one the model unlocked.
      setChain({ ...chain, at: chain.at + 1, chips, query: "" });
      setCompletionDismissed(false);
    } else {
      setChain(null);
      setCompletionDismissed(true);
    }
    syncDraft();
  }


  /**
   * Returns true when the completion popover consumed the key.
   *
   * `Space` deliberately does NOT commit. Everywhere else — VS Code, Slack,
   * GitHub — space closes a completion, because it is the key pressed to keep
   * writing the sentence. In this chain that convention and the user's intent
   * agree: reaching a later stage means the model is already a chip, so closing
   * on space leaves exactly "the model, and nothing after it".
   */
  function handleCompletionKey(event: KeyboardEvent): boolean {
    if (!completionOpen) {
      return false;
    }
    const enterIsSend = event.key === "Enter" && sendsOnEnter(prefs.sendKey, {
      ctrlOrMeta: event.ctrlKey || event.metaKey,
      shift: event.shiftKey,
    });
    if (enterIsSend) {
      return false;
    }
    const current = () => rows[Math.min(activeIndex, rows.length - 1)];
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActiveIndex((i) => (i + 1) % rows.length);
        return true;
      case "ArrowUp":
        event.preventDefault();
        setActiveIndex((i) => (i - 1 + rows.length) % rows.length);
        return true;
      case "Tab":
        event.preventDefault();
        applyCompletionChoice(current(), true);
        return true;
      case "Enter":
        // A triggerless list can be open during completely ordinary prose. It
        // must never steal the composer's configured send/newline key; Tab is
        // the explicit completion gesture the user asked for. Legacy explicit
        // triggers and an already-entered chain keep their old Enter support.
        if (trigger?.kind === "all" && !chain) {
          return false;
        }
        event.preventDefault();
        applyCompletionChoice(current(), true);
        return true;
      case "ArrowRight":
        // Commit, but stop here. The one key this feature adds to what the user
        // already knows.
        event.preventDefault();
        applyCompletionChoice(current(), false);
        return true;
      case "Escape":
        event.preventDefault();
        setChain(null);
        setCompletionDismissed(true);
        return true;
      case " ":
        // Not preventDefault: the space is still typed. The list just closes.
        setChain(null);
        setCompletionDismissed(true);
        return false;
      case "Backspace":
        // Inside the model stage, Backspace edits the filter first — the query
        // is the thing the user was last typing, so it is the thing to undo.
        if (chain && stage === "model" && chain.query) {
          event.preventDefault();
          setChain({ ...chain, query: chain.query.slice(0, -1) });
          return true;
        }
        // Otherwise step back a stage, taking the chip that stage wrote with it
        // — otherwise re-choosing would leave two `effort=` tokens in the
        // sentence. At the chain's first stage there is nothing earlier to
        // return to, so the chain ends and Backspace means Backspace again.
        if (chain && chain.at > 0) {
          event.preventDefault();
          const last = chain.chips[chain.at];
          if (last) {
            removeChip(last);
          }
          completionTrail.current = completionTrail.current.filter(({ chip }) => editorRef.current?.contains(chip));
          setChain({ ...chain, at: chain.at - 1, chips: chain.chips.slice(0, chain.at), query: "" });
          syncDraft({ allowDetachedChainChip: true });
          return true;
        }
        return false;
      default:
        if (!chain || event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) {
          return false;
        }
        // The model stage can hold twenty rows and there is no trigger text left
        // in the draft to narrow them with, so typing filters INSIDE the popover
        // instead of reaching the message. The query is drawn in the heading, so
        // the keystrokes are never invisible.
        if (stage === "model") {
          event.preventDefault();
          setChain({ ...chain, query: chain.query + event.key });
          setActiveIndex(0);
          return true;
        }
        // Every other stage is a short list. Typing there means the user has
        // moved on to writing the sentence, so the chain closes — otherwise the
        // next Enter would silently insert `effort=…` instead of sending.
        setChain(null);
        setCompletionDismissed(true);
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
    completionTrail.current = [];
    setChain(null);
    setCompletionDismissed(false);
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
      revisionRef.current += 1;
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
    revisionRef.current += 1;
    setAttachments((current) => current.filter((_, i) => i !== index));
  }

  /**
   * `bypassQueue` is Ctrl/Cmd+Enter — already this app's universal "send now".
   * With a busy member that also means "do not wait your turn". An idle member
   * is unaffected; nothing was queued to skip.
   *
   * ONE call, not park-then-deliver. This used to send normally and then chase
   * the parked row with a second `sendItem`, which is the same operation the
   * backend already performs for `interrupt` — and the two-step version got it
   * wrong three ways: it addressed the row BY POSITION (`items.at(-1)`), so an
   * interrupt-on-send park, which lands at the FRONT, made it grab a different
   * sender's waiting message and deliver that one while the message just typed
   * stayed in the queue; a member that went idle in the gap between the two
   * calls delivered the row on its own, and the follow-up then failed with "이미
   * 대기열에 없습니다", reporting a delivered message as still waiting; and it
   * stopped the turn even mid-COMPACTION, which the single path refuses to do.
   */
  async function submit(event?: FormEvent, bypassQueue = false) {
    event?.preventDefault();
    if (sendingRef.current) return;
    // What the model receives is the editor read back as plain text: every chip
    // writes out its FULL path. The chip only ever shortened the display.
    const root = editorRef.current;
    const text = (root ? serializeDraft(root) : draft).trim();
    if (!text && attachments.length === 0) {
      return;
    }
    if (palette.blocked) {
      setAttachError(`${palette.blocked.trigger}: ${palette.blocked.reason}`);
      return;
    }
    if (palette.typedAction) {
      runPaletteAction(palette.typedAction);
      clearComposerDraft(draftKey);
      setDraft("");
      knownRefs.current = [];
      setAttachments([]);
      setAttachError("");
      return;
    }
    const images = attachments.length ? attachments : undefined;
    const submittedRevision = revisionRef.current;
    sendingRef.current = true;
    // `interrupt: true` only when the gesture asked for it; otherwise the send
    // keeps whatever the composer setting says (App resolves that).
    try {
      await actions.sendMessage(view.name, text, images, bypassQueue ? { interrupt: true } : undefined);
      if (revisionRef.current === submittedRevision) {
        clearComposerDraft(draftKey);
        setDraft("");
        knownRefs.current = [];
        setAttachments([]);
        setAttachError("");
      }
    } catch (error) {
      // The untouched draft is still both on screen and in the window-scoped
      // store. A rejection or transport failure must not require reconstruction.
      setAttachError(`보내지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      sendingRef.current = false;
    }
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
    // …and so does the completion popover. A triggerless first stage claims
    // Tab, while an explicit/continued chain can also claim Enter.
    if (handleCompletionKey(event)) {
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
    const modifiers = { ctrlOrMeta: event.ctrlKey || event.metaKey, shift: event.shiftKey };
    if (sendsOnEnter(prefs.sendKey, modifiers)) {
      event.preventDefault();
      // NOT "was Ctrl held": under the default send key Ctrl+Enter IS the send
      // key, so reading the modifier alone made every ordinary send stop the
      // member's turn. See `sendsImmediately`.
      void submit(undefined, sendsImmediately(prefs.sendKey, modifiers));
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
        aria-label={localized("STR-1592", [view.name])}
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
  const mentionPopover = completionOpen ? (
    <CompletionPopover
      title={completionTitle}
      // What was typed inside the popover. Shown so the filter is never a
      // hidden state the user has to guess at from a shrinking list.
      query={chain?.query}
      // The heading and hint explain the keyboard flow while the list is open.
      hint={chain ? localized("STR-1593") : "↑↓ · Tab"}
      sections={sections}
      activeIndex={activeIndex}
      onHover={setActiveIndex}
      onSelect={(index) => applyCompletionChoice(rows[index], true)}
      compact={density === "narrow"}
      anchor={caretAnchor}
      ariaLabel={completionTitle}
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
          <img src={imageDataUrl(image)} alt={image.name || localized("STR-1594")} />
          <button type="button" className="wb-attachment-x" title={localized("STR-1595")} onClick={() => removeAttachment(index)}><X size={11} /></button>
        </div>
      ))}
    </div>
  ) : null;

  const attachHint = attachError ? (
    <div className="wb-attach-hint is-error">{attachError}</div>
  ) : imageBlocked ? (
    <div className="wb-attach-hint"><ImageOff size={12} />  <LocalizedText id="STR-1596" /></div>
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
  // A compaction is work in flight even though the member is not "working": it
  // can run for minutes with no way to call it off, because Stop keyed on
  // `busy` alone and a compacting member is not busy. The compact card
  // deliberately carries no cancel of its own — this is where stopping lives.
  // Icon only, and sitting immediately after the send/queue control rather than
  // before it. As a labelled button it was the widest thing in the row, and in a
  // narrow panel the row had to give that width up somewhere: the Korean label
  // on the primary button broke a character per line. What Stop does is not
  // ambiguous once it is red and shaped like a stop — the words were paying for
  // themselves in the one place where there is no room. Tooltip and aria-label
  // keep the full wording, including the "중단 중" in-flight state.
  const stopLabelBeside = interrupting ? localized("STR-1599") : localized("STR-1600");
  const stopBeside = (view.busy || view.compacting || interrupting) && !forceStop ? (
    <button
      type="button"
      className={"wb-composer-stop is-icon" + (interrupting ? " is-interrupting" : "")}
      title={stopLabelBeside}
      aria-label={stopLabelBeside}
      onClick={onStop}
    >
      <CircleStop size={15} />
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
      {queueing ? <><LocalizedText id="STR-1605" /> <ArrowDownToLine size={14} /></> : <>Send <Send size={14} /></>}
    </button>
  );
  // Permission control next to Send: Codex members get the two-axis
  // (sandbox × approval + guardian) control; Claude members get the single mode.
  const permission = (
    <HarnessPermissionControl
      harnessId={harness as HarnessId}
      value={{
        permissionMode: view.permissionMode as PermissionModeSetting | undefined,
        // The LIVE session's policy outranks the stored member: the harness knows
        // what it is currently running under.
        codexPolicy: view.session?.snapshot.codexPolicy || view.member.codexPolicy,
        cursorPolicy: view.session?.snapshot.cursorPolicy || view.member.cursorPolicy,
      }}
      onChange={(patch) => {
        if (patch.permissionMode) actions.setPermissionMode(view.name, patch.permissionMode);
        if (patch.codexPolicy) actions.setCodexPolicy(view.name, patch.codexPolicy);
        if (patch.cursorPolicy) actions.setCursorPolicy(view.name, patch.cursorPolicy);
      }}
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
    revisionRef.current += 1;
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
          {iconOnly}
          {stopBeside}
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
        {/* One well, right-aligned. The `@` button that used to hold the left
            end is gone: typing `@` opens the same popover, and an icon whose
            only job is to type one character was costing the row width it did
            not have at narrow panel sizes. Nothing else moved into the gap, so
            the tab order goes straight from the editor to the actions. */}
        <div className="wb-composer-row">
          <div className="wb-composer-actions">
            {labeled}
            {stopBeside}
            {showPermission ? permission : null}
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

/**
 * A transcript delta rebuilds the member view ~30×/sec while a member streams,
 * but almost none of that touches the composer. The comparator lists the FULL
 * set of view fields this component (and its MessageQueue/permission children)
 * reads — mirror any new view read here, exactly like Transcript's comparator.
 * `member` and `session` are compared by identity: the party store and the
 * session merge layer both preserve object identity when no fact changed.
 */
export const Composer = memo(ComposerView, (previous, next) => (
  previous.density === next.density
  && previous.actions === next.actions
  && previous.commandUi === next.commandUi
  && previous.permission === next.permission
  && previous.view.name === next.view.name
  && previous.view.member === next.view.member
  && previous.view.session === next.view.session
  && previous.view.busy === next.view.busy
  && previous.view.compacting === next.view.compacting
  && previous.view.model === next.view.model
  && previous.view.permissionMode === next.view.permissionMode
  && previous.view.vision?.image === next.view.vision?.image
  && previous.view.vision?.maxImages === next.view.vision?.maxImages
  && previous.view.vision?.maxBytesPerImage === next.view.vision?.maxBytesPerImage
));

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
