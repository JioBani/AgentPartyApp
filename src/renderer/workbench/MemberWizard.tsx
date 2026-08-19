import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, RefreshCw, UserPlus, X, Zap } from "lucide-react";
import type { RouteLike } from "./routes";
import { routeKey } from "./routes";
import { modelView } from "./modelCatalog";
import type { RouteEntry } from "./modelMeters";
import type { CreateMemberInput } from "./PartySidebar";
import { ModelCatalogModal, type ModelCatalogValue } from "./ModelCatalogModal";
import type { CodexModelDiscoveryState } from "../../shared/codexModels";
import type { DefaultMemberProfile, HarnessDefaults } from "../../shared/types";
import type { HarnessId, PermissionModeSetting } from "../../shared/types";
import { harnessLabel } from "../../shared/types";
import { DEFAULT_CODEX_POLICY, type CodexPolicy } from "../../shared/codexPolicy";
import { HarnessPermissionControl } from "./HarnessPermissionControl";
import { CwdPicker, type WslBrowsing } from "./CwdPicker";
import type { CwdPreferences, ExecutionEnv, MemberExecutionLocation } from "../../shared/memberLocation";
import { checkLocationShape, preferencesFor } from "../../shared/memberLocation";

/** Why this harness's permission axes matter, in the wizard's own voice. */
const PERMISSION_HINTS: Record<HarnessId, string> = {
  "claude-code": "새 멤버가 첫 작업부터 사용할 Claude Code 권한 모드입니다.",
  codex: "Codex 하니스에서 사용할 Sandbox와 승인 정책, Guardian을 지정합니다. 선택한 모델 공급자와 관계없이 이 권한 정책이 유지됩니다.",
  cursor: "Cursor CLI의 작업 모드와 승인 모드를 그대로 설정합니다.",
  grok: "Grok Build는 도구 실행을 클라이언트에 묻지 않습니다. 플랜 모드만 적용되고, 나머지 권한 설정은 이 하니스에 영향을 주지 않습니다.",
};
import { cursorPolicyOf, type CursorPolicy } from "../../shared/cursorPolicy";
import { HarnessIcon } from "./HarnessIcon";
import { LocalizedText, localized } from "../i18n/I18nProvider";

interface MemberWizardProps {
  routes: RouteLike[];
  /** Live Codex catalog discovery state — the model step must say when the
   *  codex list is still loading or failed (fallback-only), never silently. */
  codexModels?: CodexModelDiscoveryState;
  onRefreshCodexModels?: () => void;
  /** Seed values so "next, next, next" creates a member with the saved defaults. */
  defaultProfile: DefaultMemberProfile;
  /** Per-harness defaults — switching harness seeds THAT harness's default. */
  harnessDefaults: Record<string, HarnessDefaults>;
  /** Default + recent cwds per environment, used to seed and offer the location. */
  cwdPrefs: CwdPreferences;
  /** Frozen "now" for the recency column, so previews render deterministically. */
  now: number;
  /**
   * Opens the platform folder picker for one environment.
   *
   * Resolves to the chosen location, or `null` when the user cancelled — a
   * distinction the wizard needs, because "cancelled" must leave the previous
   * selection alone rather than clear it.
   */
  onBrowseCwd: (env: ExecutionEnv) => Promise<MemberExecutionLocation | null>;
  /** The WSL side of the picker (distro list + directory reader). */
  wsl?: WslBrowsing;
  /**
   * Which step to open on. Defaults to the first; the design preview uses it to
   * show step 2 without clicking through, and a "이 설정으로 새 멤버" duplicate
   * can land the user on the step it prefilled.
   */
  startStep?: number;
  onCancel: () => void;
  onCreate: (input: CreateMemberInput) => void;
}

interface HarnessChoice {
  id: string;
  label: string;
  status: "available" | "planned";
  icon: JSX.Element;
  hint: string;
}

const HARNESSES: HarnessChoice[] = [
  { id: "claude-code", label: "Claude Code", status: "available", icon: <HarnessIcon harness="claude-code" size={16} />, hint: "Claude Code SDK 기반 로컬 하네스" },
  { id: "codex", label: "Codex", status: "available", icon: <HarnessIcon harness="codex" size={16} />, hint: "Codex CLI exec 기반 로컬 하네스" },
];

const NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const CURSOR_HARNESS: HarnessChoice = {
  id: "cursor",
  label: "Cursor CLI",
  status: "available",
  icon: <HarnessIcon harness="cursor" size={16} />,
  hint: "Cursor Agent CLI · Auto / Grok 4.5",
};
const GROK_HARNESS: HarnessChoice = {
  id: "grok",
  label: "Grok Build",
  status: "available",
  icon: <HarnessIcon harness="grok" size={16} />,
  hint: "xAI Grok Build CLI · 구독 · 도구를 스스로 승인",
};
const ALL_HARNESSES = [...HARNESSES, CURSOR_HARNESS, GROK_HARNESS];

/**
 * Creating a party member, in three steps: identity → runtime → permission.
 *
 * It used to be six (name → harness → model → reasoning → permission → role).
 * The reduction is not "fewer clicks" but "one question per step": name and
 * description are the same question asked twice, and harness, model and
 * reasoning are a single decision that was being split across three screens —
 * they are now made together in the model catalog, the same screen used to
 * retune a member later, so there is no second arrangement of the same controls
 * to keep in agreement.
 *
 * Every field lives in this component, and the steps only choose what is shown.
 * That is deliberate: going back and forward must not cost the user anything
 * they already typed, and a step that unmounted its own fields would lose them
 * while still looking correct — an empty box is exactly what a fresh step is
 * supposed to look like.
 */
type StepId = "identity" | "runtime" | "permission";

const STEPS: Array<{ id: StepId; label: string }> = [
  { id: "identity", label: "이름 · 설명" },
  { id: "runtime", label: "실행 구성" },
  { id: "permission", label: "권한" },
];
export function MemberWizard({ routes, codexModels, onRefreshCodexModels, defaultProfile, harnessDefaults, cwdPrefs, now, onBrowseCwd, wsl, startStep = 0, onCancel, onCreate }: MemberWizardProps) {
  const [name, setName] = useState("");
  const [stepIndex, setStepIndex] = useState(startStep);
  /** The catalog, opened to choose harness + model + reasoning together. */
  const [pickerOpen, setPickerOpen] = useState(false);
  const [harness, setHarness] = useState<string>(defaultProfile.harness || "claude-code");
  const [role, setRole] = useState("");
  /**
   * Where this member will run, forever. Seeded from the Windows default because
   * this is a Windows app; an environment with no default starts EMPTY rather
   * than borrowing the other environment's path, which would create the member
   * somewhere the user never chose.
   */
  const [location, setLocation] = useState<MemberExecutionLocation | undefined>(cwdPrefs.windowsDefault);
  const [saveAsDefault, setSaveAsDefault] = useState(false);
  /** Steps already reached, so the rail can jump back to one without re-walking. */
  const [maxStep, setMaxStep] = useState(startStep);

  const entries = useMemo<RouteEntry[]>(() => routes.map((route) => ({ route, meta: modelView(route) })), [routes]);
  const harnessEntries = useMemo(
    () => entries.filter((entry) => (entry.route.harnessId || "claude-code") === harness),
    [entries, harness],
  );

  // Seed the model from the default profile so "next, next, next" works.
  const [selectedKey, setSelectedKey] = useState(() => {
    const match = routes.find((route) => route.model === defaultProfile.model && (route.harnessId || "claude-code") === (defaultProfile.harness || "claude-code"));
    return match ? routeKey(match) : "";
  });
  const selected = harnessEntries.find((entry) => routeKey(entry.route) === selectedKey) || harnessEntries[0];
  const capabilities = selected?.route.capabilities || {};
  const effortCap = capabilities.effort;
  const serviceTierCap = capabilities.serviceTier;
  const thinkingCap = capabilities.thinking;

  const [effort, setEffort] = useState("");
  const [serviceTier, setServiceTier] = useState("");
  const [thinkingMode, setThinkingMode] = useState("");
  const [budget, setBudget] = useState(0);
  const [permissionMode, setPermissionMode] = useState<PermissionModeSetting>(
    harnessDefaults["claude-code"]?.permissionMode || "default",
  );
  const [codexPolicy, setCodexPolicy] = useState<CodexPolicy>(
    harnessDefaults.codex?.codexPolicy || DEFAULT_CODEX_POLICY,
  );
  const [cursorPolicy, setCursorPolicy] = useState<CursorPolicy>(
    cursorPolicyOf(harnessDefaults.cursor?.cursorPolicy, harnessDefaults.cursor?.permissionMode),
  );

  // When the chosen harness changes, seed the model to THAT harness's default
  // (so switching to Codex prefills the Codex default model, not just the first
  // one). Falls back to the harness's first model.
  useEffect(() => {
    if (!harnessEntries.some((entry) => routeKey(entry.route) === selectedKey)) {
      const defModel = harnessDefaults[harness]?.model;
      const defEntry = defModel ? harnessEntries.find((entry) => entry.route.model === defModel) : undefined;
      const seed = defEntry || harnessEntries[0];
      setSelectedKey(seed ? routeKey(seed.route) : "");
    }
  }, [harnessEntries, selectedKey, harness, harnessDefaults]);

  // Reset staged reasoning whenever the selected model changes. Prefer the
  // member's harness default effort/reasoning where set (so "next, next, next"
  // honors that harness's saved default), else the model's own default.
  useEffect(() => {
    const hDefaults = harnessDefaults[harness];
    const effDefault = effortCap?.supported ? effortCap.defaultValue || "medium" : "";
    const thinkDefault = thinkingCap?.supported ? thinkingCap.defaultValue || "" : "";
    const budgetDefault = thinkingCap?.budget?.default ?? 0;
    setEffort(effortCap?.supported && hDefaults?.effort ? hDefaults.effort : effDefault);
    setServiceTier(serviceTierCap?.supported ? hDefaults?.serviceTier || serviceTierCap.defaultValue || "standard" : "");
    setThinkingMode(thinkingCap?.supported && hDefaults?.reasoning ? hDefaults.reasoning : thinkDefault);
    setBudget(hDefaults?.reasoningBudget ? hDefaults.reasoningBudget : budgetDefault);
  }, [selectedKey]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const thinkingOn = Boolean(thinkingMode) && thinkingMode !== "disabled";
  const showBudget = Boolean(thinkingCap?.budget) && thinkingOn;
  const selectedHarness = ALL_HARNESSES.find((item) => item.id === harness);
  const executionHarness = harness === "codex" ? "codex" : harness === "cursor" ? "cursor" : harness === "grok" ? "grok" : "claude-code";

  useEffect(() => {
    if (executionHarness === "codex") {
      setCodexPolicy({ ...(harnessDefaults.codex?.codexPolicy || DEFAULT_CODEX_POLICY) });
    } else if (executionHarness === "cursor") {
      setCursorPolicy(cursorPolicyOf(harnessDefaults.cursor?.cursorPolicy, harnessDefaults.cursor?.permissionMode));
    } else {
      setPermissionMode(harnessDefaults["claude-code"]?.permissionMode || "default");
    }
  }, [executionHarness, harnessDefaults]);

  // The NAME is the only requirement. Everything else is either seeded from the
  // saved defaults or genuinely optional, so a member can be created the moment
  // it has something to be called.
  const canCreate = NAME_PATTERN.test(name.trim());
  const step = STEPS[stepIndex].id;
  const isLastStep = stepIndex === STEPS.length - 1;
  /**
   * A member cannot exist without a reachable cwd (README §5.1), so the runtime
   * step gates on one being chosen and well-formed. This is shape only — whether
   * the folder is actually there is decided in the environment it will run in,
   * and a green button here never means the path was verified.
   */
  const locationProblem = location ? checkLocationShape(location) : undefined;
  const hasLocation = Boolean(location?.cwd) && !locationProblem;
  // Name gates the first step, location the second; the permission step is
  // pre-seeded from the saved defaults and cannot be left unusable.
  const canAdvance = step === "identity" ? canCreate : step === "runtime" ? hasLocation : true;

  function goNext() {
    if (!canAdvance) {
      return;
    }
    if (isLastStep) {
      create();
      return;
    }
    setStepIndex((current) => {
      const next = Math.min(current + 1, STEPS.length - 1);
      setMaxStep((seen) => Math.max(seen, next));
      return next;
    });
  }

  /**
   * Switches environment, re-seeding the path from THAT environment's default.
   *
   * Carrying the Windows path across to WSL would produce `C:\Project` as a
   * POSIX cwd — a value no distro can use, offered as if it were ready.
   */
  function changeEnv(env: ExecutionEnv) {
    const { fallback } = preferencesFor(cwdPrefs, env);
    setLocation(fallback ?? { env, cwd: "" });
  }

  async function browse() {
    const picked = await onBrowseCwd(location?.env ?? "windows");
    if (picked) {
      setLocation(picked);
    }
  }

  function create() {
    if (!canCreate) {
      return;
    }
    onCreate({
      name: name.trim(),
      requirement: role.trim(),
      runtime: harness,
      model: selected?.route.model,
      effort: effortCap?.supported ? effort : undefined,
      serviceTier: serviceTierCap?.supported ? serviceTier : undefined,
      reasoning: thinkingCap?.supported ? thinkingMode : undefined,
      reasoningBudget: showBudget ? budget : undefined,
      permissionMode: executionHarness === "claude-code" ? permissionMode : undefined,
      codexPolicy: executionHarness === "codex" ? codexPolicy : undefined,
      cursorPolicy: executionHarness === "cursor" ? cursorPolicy : undefined,
      location,
      saveAsDefault,
    });
  }

  /**
   * Creates the member from the SAVED defaults, skipping the remaining steps.
   *
   * It deliberately sends nothing but the identity: omitted fields are filled by
   * `buildPartyMember` from `settings.harnessDefaults`, which is the same place
   * this wizard seeds its own fields from. Sending the staged values instead
   * would put a second copy of "what the defaults are" in the renderer, and the
   * two would disagree the moment either side changed — a member created by this
   * button would then differ from one created by pressing 다음 twice.
   *
   * Offered on the identity step only. Past that point the user has been shown
   * the runtime and permission controls, and a button that silently discarded a
   * choice they just made would be worse than no button at all.
   */
  function createWithDefaults() {
    if (!canCreate || !cwdPrefs.windowsDefault) {
      return;
    }
    // The cwd is the one field the defaults CANNOT fill in silently: a member
    // without one has nowhere to run. It is sent explicitly (and the button is
    // hidden when no default exists) rather than left for the backend to guess.
    onCreate({
      name: name.trim(),
      requirement: role.trim(),
      runtime: defaultProfile.harness,
      location: cwdPrefs.windowsDefault,
    });
  }

  /** Takes the whole runtime choice back from the catalog in one go. */
  function applyRuntime(next: ModelCatalogValue) {
    if (next.harness) {
      setHarness(next.harness);
    }
    if (next.route) {
      setSelectedKey(routeKey(next.route));
    }
    // `undefined` means the model does not support that axis — store the empty
    // string so the summary line says so rather than showing a stale value from
    // the previous model.
    setEffort(next.effort || "");
    setServiceTier(next.serviceTier || "");
    setThinkingMode(next.thinkingMode || "");
    setBudget(next.thinkingBudget ?? 0);
    setPickerOpen(false);
  }

  const selectedMeta = selected?.meta;

  // What "기본 설정" actually is, spelled out. A shortcut that creates something
  // the user cannot see beforehand is a guess, so the button says what it makes.
  const defaultSummary = useMemo(() => {
    const route = routes.find(
      (item) => item.model === defaultProfile.model && (item.harnessId || "claude-code") === defaultProfile.harness,
    );
    const model = route?.label || defaultProfile.model || "모델 미지정";
    const reasoning = reasoningSummary(defaultProfile.effort || "", defaultProfile.reasoning || "", defaultProfile.reasoningBudget);
    return `${harnessLabel(defaultProfile.harness)} · ${model} · ${reasoning}`;
  }, [routes, defaultProfile]);

  // The scrim does not dismiss: a stray click outside would throw away a
  // half-filled form. Closing is explicit (취소 / ✕) — the same contract as
  // every other modal in the app.
  return (
    <div className="wb-modal-scrim">
      <div className="wb-modal wb-wizard" role="dialog" aria-modal="true">
        <header className="wb-modal-head">
          <div className="wb-modal-title">
            <UserPlus size={16} />
            <strong><LocalizedText id="STR-1744" /></strong>
          </div>
          <button type="button" className="wb-icon-btn" title={localized("STR-1745")} onClick={onCancel}><X size={16} /></button>
        </header>

        {/* Named, numbered, and showing which are done: a step rail that only
            marks the current one leaves "how much is left" unanswered, which is
            the single thing a multi-step form owes the user. */}
        <ol className="wb-wizard-steps">
          {STEPS.map((entry, index) => {
            // Only a step already reached is a destination. Jumping FORWARD past
            // an unmet requirement (no name, no cwd) would land on 만들기 with a
            // form that cannot be submitted and no sign of why.
            const reachable = index <= maxStep && index !== stepIndex;
            return (
              <li
                key={entry.id}
                className={
                  "wb-wizard-step" +
                  (index === stepIndex ? " is-current" : "") +
                  (index < stepIndex ? " is-done" : "") +
                  (reachable ? " is-nav" : "")
                }
                aria-current={index === stepIndex ? "step" : undefined}
                onClick={reachable ? () => setStepIndex(index) : undefined}
              >
                <span className="wb-wizard-step-n">{index + 1}</span>
                <span className="wb-wizard-step-label">{entry.label}</span>
              </li>
            );
          })}
        </ol>

        <div className="wb-modal-body wb-wizard-body">
          <div className="wb-wizard-pane">
            {step === "identity" && (
            <>
            <section className="wb-wizard-section">
              <div className="wb-modal-label"><LocalizedText id="STR-1746" /></div>
              <input
                className="wb-wizard-input"
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") goNext(); }}
                placeholder={localized("STR-1747")}
              />
              <p className="wb-wizard-hint"><LocalizedText id="STR-1748" /></p>
              {name.trim() && !NAME_PATTERN.test(name.trim()) && <p className="wb-wizard-error"><LocalizedText id="STR-1749" /></p>}
            </section>

            <section className="wb-wizard-section">
              <div className="wb-modal-label"><LocalizedText id="STR-1751" /> <span className="wb-wizard-optional"><LocalizedText id="STR-1750" /></span></div>
              <textarea
                className="wb-wizard-input wb-wizard-textarea"
                value={role}
                onChange={(event) => setRole(event.target.value)}
                placeholder={localized("STR-1752")}
                rows={2}
              />
              <p className="wb-wizard-hint"><LocalizedText id="STR-1753" /></p>
            </section>

            {/* Names the defaults rather than just promising them: "기본 설정으로
                만들기" is only a shortcut if the user can tell what it will make
                without walking the steps to find out. */}
            {cwdPrefs.windowsDefault && (
              <p className="wb-wizard-default-note">
                <Zap size={12} />
                <span>
                  <LocalizedText id="STR-1755" /> <span className="wb-mono">{defaultSummary}</span>
                  {" · "}<span className="wb-mono">{cwdPrefs.windowsDefault.cwd}</span>  <LocalizedText id="STR-1754" />
                </span>
              </p>
            )}
            </>
            )}

            {step === "runtime" && (
            <section className="wb-wizard-section">
              <div className="wb-modal-label"><LocalizedText id="STR-1757" /></div>
              {/* Harness, model and reasoning are one decision, so they are made
                  in the catalog — the same screen used to retune a member later,
                  rather than a second arrangement of the same controls. */}
              <button type="button" className="wb-wizard-runtime" onClick={() => setPickerOpen(true)}>
                <span className="wb-wizard-runtime-main">
                  <span className="wb-wizard-runtime-harness">{selectedHarness?.icon}{selectedHarness?.label || harness}</span>
                  <span className="wb-mono wb-wizard-runtime-model">{selected?.route.label || selectedMeta?.name || "모델 선택"}</span>
                </span>
                <span className="wb-mono wb-wizard-runtime-sub">
                  {reasoningSummary(effortCap?.supported ? effort : "", thinkingCap?.supported ? thinkingMode : "", showBudget ? budget : undefined)}
                </span>
                <span className="wb-wizard-runtime-change"><LocalizedText id="STR-1759" /></span>
              </button>
              {/* Kept out of the catalog: discovery state belongs to the list the
                  wizard is seeding from, and staying silent about a half-loaded
                  Codex list would let someone pick from a fallback believing it
                  to be their account's models. */}
              {harness === "codex" && codexModels?.status === "pending" && (
                <p className="wb-wizard-hint"><LocalizedText id="STR-1760" /></p>
              )}
              {harness === "codex" && codexModels?.status === "error" && (
                <p className="wb-wizard-error">

                  <LocalizedText id="STR-1761" /> {codexModels.error}
                  {onRefreshCodexModels && (
                    <button type="button" className="wb-btn wb-btn-ghost" onClick={onRefreshCodexModels}>
                      <RefreshCw size={13} />  <LocalizedText id="STR-1762" />
                    </button>
                  )}
                </p>
              )}
            </section>
            )}

            {/* The cwd sits with the runtime because they are one answer to
                "what does this member run as": a harness and the directory it
                runs in. Unlike everything else on this step it cannot be changed
                afterwards, which is why it is marked 필수 and says so. */}
            {step === "runtime" && (
            <section className="wb-wizard-section">
              <div className="wb-modal-label"><LocalizedText id="STR-3268" /> <span className="wb-wizard-optional"><LocalizedText id="STR-3269" /></span></div>
              <CwdPicker
                value={location}
                prefs={cwdPrefs}
                now={now}
                onChange={setLocation}
                onChangeEnv={changeEnv}
                onBrowse={() => { void browse(); }}
                wsl={wsl}
                saveAsDefault={{ checked: saveAsDefault, onToggle: setSaveAsDefault }}
                hint={localized("STR-3270")}
              />
              {locationProblem && <p className="wb-wizard-error">{locationProblem.message}</p>}
            </section>
            )}

            {step === "permission" && (
            <section className="wb-wizard-section">
              <div className="wb-modal-label"><LocalizedText id="STR-1763" /> <span className="wb-mono">{harnessLabel(executionHarness)}</span></div>
              <HarnessPermissionControl
                harnessId={executionHarness}
                variant="inline"
                value={{ permissionMode, codexPolicy, cursorPolicy }}
                onChange={(patch) => {
                  if (patch.permissionMode) setPermissionMode(patch.permissionMode);
                  if (patch.codexPolicy) setCodexPolicy(patch.codexPolicy);
                  if (patch.cursorPolicy) setCursorPolicy(patch.cursorPolicy);
                }}
              />
              <p className="wb-wizard-hint">{PERMISSION_HINTS[executionHarness]}</p>
            </section>
            )}
          </div>
        </div>

        <footer className="wb-modal-foot wb-wizard-foot">
          <button type="button" className="wb-btn wb-btn-ghost" onClick={onCancel}><LocalizedText id="STR-1764" /></button>
          <div className="wb-modal-actions">
            {stepIndex > 0 && (
              <button type="button" className="wb-btn wb-btn-ghost wb-wizard-back" onClick={() => setStepIndex((current) => current - 1)}>
                <ChevronLeft size={14} />  <LocalizedText id="STR-1765" />
              </button>
            )}
            {step === "identity" && cwdPrefs.windowsDefault && (
              <button
                type="button"
                className="wb-btn wb-btn-ghost"
                disabled={!canCreate}
                title={localized("STR-1766", [defaultSummary])}
                onClick={createWithDefaults}
              >
                <Zap size={14} />  <LocalizedText id="STR-1767" />
              </button>
            )}
            {isLastStep ? (
              <button type="button" className="wb-btn wb-btn-accent" disabled={!canCreate} onClick={create}>
                <UserPlus size={14} />  <LocalizedText id="STR-1768" />
              </button>
            ) : (
              <button type="button" className="wb-btn wb-btn-accent" disabled={!canAdvance} onClick={goNext}>

                <LocalizedText id="STR-1769" /> <ChevronRight size={14} />
              </button>
            )}
          </div>
        </footer>

        {pickerOpen && (
          <ModelCatalogModal
            title={localized("STR-1770")}
            routes={routes}
            value={{
              model: selected?.route.model || "",
              harness,
              effort,
              serviceTier,
              thinkingMode,
              thinkingBudget: budget,
            }}
            config={{ harness: true, effort: true, serviceTier: true, thinking: true }}
            currentHarness={harness}
            applyLabel="선택"
            dim
            onApply={applyRuntime}
            onClose={() => setPickerOpen(false)}
          />
        )}
      </div>
    </div>
  );
}

function reasoningSummary(effort: string, thinking: string, budget?: number): string {
  const parts: string[] = [];
  if (effort) parts.push(`effort ${effort}`);
  if (thinking) parts.push(`thinking ${thinking}`);
  if (budget) parts.push(`${budget.toLocaleString()} tok`);
  return parts.length ? parts.join(" · ") : "기본값";
}
