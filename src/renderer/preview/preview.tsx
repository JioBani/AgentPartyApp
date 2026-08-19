import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider, useTheme } from "../theme/ThemeProvider";
import { I18nProvider } from "../i18n/I18nProvider";
import { PartyGroupList } from "../workbench/PartyGroupList";
import { MoveGroupModal, NewGroupModal } from "../workbench/PartyGroupModals";
import { NewPartyModal } from "../workbench/PartySidebar";
import { MemberWizard } from "../workbench/MemberWizard";
import { CwdPicker, ENV_LABEL, EnvIcon } from "../workbench/CwdPicker";
import { WorkspaceCwdSettings } from "../app/WorkspaceCwdSettings";
import { groupParties } from "../../shared/partyGroups";
import type { ExecutionEnv, MemberExecutionLocation } from "../../shared/memberLocation";
import { preferencesFor } from "../../shared/memberLocation";
import {
  GALLERY_CWD_PREFERENCES,
  GALLERY_CWD_PREFERENCES_EMPTY,
  GALLERY_DEFAULT_USAGE,
  GALLERY_GROUPS,
  GALLERY_MEMBER_LOCATIONS,
  GALLERY_NOW,
  GALLERY_PARTIES,
  GALLERY_WSL_DEFAULT,
  GALLERY_MEMBER_PROFILE,
  GALLERY_ROUTE,
} from "../../shared/partyGroupsGallery";
import "../design-system.css";
import "../styles.css";
import "./preview.css";

/**
 * 디자인 목업 — the party-group and member-cwd surfaces, rendered from fixtures.
 *
 * Every screen here is the SHIPPING component with fixture props, not a copy.
 * That is the point: a mockup that redraws the UI proves nothing about the UI,
 * and the first refactor makes it a lie. Because these components take their
 * data and their callbacks as props, the whole feature can be looked at — the
 * broken WSL distro, the deleted folder, the empty first-run state — with no
 * harness running, no party created, and no WSL distro installed.
 *
 * Opened from `dist-renderer/preview/index.html`; not linked from the app.
 */

const stages: Array<{ id: string; title: string; note: string; width?: number; render: () => JSX.Element }> = [
  {
    id: "sidebar-groups",
    title: "사이드바 · 파티 그룹",
    note: "그룹 3개 · 파티 9개. 세 번째 그룹은 접힌 상태.",
    width: 236,
    render: () => <SidebarStage />,
  },
  {
    id: "cwd-picker-wsl",
    title: "실행 위치 (WSL)",
    note: "최근 목록의 마지막 항목은 시작할 수 없는 배포판 — 지우지 않고 이유와 함께 남는다.",
    width: 562,
    render: () => <CwdPickerStage initial={GALLERY_WSL_DEFAULT} />,
  },
  {
    id: "cwd-picker-windows",
    title: "실행 위치 (Windows)",
    note: "환경을 바꾸면 그 환경의 기본 cwd와 최근 목록만 보인다.",
    width: 562,
    render: () => <CwdPickerStage initial={GALLERY_CWD_PREFERENCES.windowsDefault} />,
  },
  {
    id: "cwd-picker-empty",
    title: "실행 위치 · 첫 실행",
    note: "기본 cwd도 최근 목록도 없을 때. 경로를 고르기 전에는 다음으로 갈 수 없다.",
    width: 562,
    render: () => <CwdPickerStage initial={undefined} empty />,
  },
  {
    id: "wizard-runtime",
    title: "멤버 만들기 · 2 실행 구성",
    note: "하네스·모델과 실행 위치가 한 단계에 있다. 정본 대화상자 그대로.",
    render: () => (
      <ModalStage tall>
        <MemberWizard
          routes={[GALLERY_ROUTE as never]}
          defaultProfile={GALLERY_MEMBER_PROFILE as never}
          harnessDefaults={{} as never}
          cwdPrefs={GALLERY_CWD_PREFERENCES}
          now={GALLERY_NOW}
          onBrowseCwd={async () => null}
          onCancel={noop}
          onCreate={noop}
          startStep={1}
        />
      </ModalStage>
    ),
  },
  {
    id: "new-party",
    title: "새 파티 · 그룹 + main cwd",
    note: "파티는 cwd를 갖지 않는다 — 이 경로는 함께 만들어지는 main 멤버의 것.",
    render: () => (
      <ModalStage tall>
        <NewPartyModal
          initialName=""
          groups={GALLERY_GROUPS}
          initialGroupId="g-payments"
          cwdPrefs={GALLERY_CWD_PREFERENCES}
          now={GALLERY_NOW}
          onBrowseCwd={async () => null}
          onCreateGroup={noop}
          onCancel={noop}
          onCreate={noop}
        />
      </ModalStage>
    ),
  },
  {
    id: "new-group",
    title: "파티 그룹 만들기",
    note: "",
    render: () => <ModalStage><NewGroupModal onCancel={noop} onCreate={noop} /></ModalStage>,
  },
  {
    id: "move-group",
    title: "그룹으로 이동",
    note: "",
    render: () => (
      <ModalStage>
        <MoveGroupModal
          party={GALLERY_PARTIES[0]}
          groups={GALLERY_GROUPS}
          partyCountByGroup={Object.fromEntries(
            groupParties(GALLERY_GROUPS, GALLERY_PARTIES).map((entry) => [entry.group.id, entry.parties.length]),
          )}
          onCancel={noop}
          onMove={noop}
        />
      </ModalStage>
    ),
  },
  {
    id: "ctx-member",
    title: "멤버 우클릭 메뉴 · 실행 위치",
    note: "생성 후 바꿀 수 없다는 사실을 메뉴가 먼저 말한다.",
    width: 260,
    render: () => (
      <div className="wb-ctx-menu pv-static-menu">
        <div className="wb-ctx-head">
          <strong>impl</strong>
          <span className="wb-ctx-head-loc">
            <EnvIcon env="wsl" />
            <span className="wb-cwd-distro">Ubuntu-24.04</span>
            <span className="wb-mono">/home/dev/service</span>
          </span>
          <span>실행 위치는 생성 후 바꿀 수 없습니다</span>
        </div>
      </div>
    ),
  },
  {
    id: "settings-workspace",
    title: "설정 · 작업 위치",
    note: "기본 cwd 2개 · 최근 cwd 환경별 목록 · 읽기 전용 멤버 목록.",
    // The measure the settings screen gives this tab in the app (840px + the
    // stage's own border), so the cards wrap exactly as they ship.
    width: 842,
    render: () => (
      <div className="set-page set-page-tabbed">
        <div className="set-tab-panel">
          <WorkspaceCwdSettings
            prefs={GALLERY_CWD_PREFERENCES}
            defaultUsage={GALLERY_DEFAULT_USAGE}
            members={GALLERY_MEMBER_LOCATIONS}
            now={GALLERY_NOW}
            onPickDefault={noop}
            onClearDefault={noop}
            onPromoteRecent={noop}
            onRemoveRecent={noop}
            onRecheckRecent={noop}
            onCloneMember={noop}
          />
        </div>
      </div>
    ),
  },
];

function noop(): void {
  /* The preview shows states, it does not perform them. */
}

function SidebarStage() {
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set(["g-lab"]));
  const grouped = groupParties(GALLERY_GROUPS, GALLERY_PARTIES);
  const open = new Set(GALLERY_GROUPS.map((group) => group.id).filter((id) => !closed.has(id)));
  return (
    <aside className="wb-sidebar" style={{ width: 236 }}>
      <section className="wb-sidebar-section">
        <div className="wb-section-label">
          <span>Parties <span className="wb-mono">{GALLERY_PARTIES.length}</span></span>
          <span className="wb-hint">앱 전역 · cwd와 무관</span>
        </div>
        <form className="wb-new-party" onSubmit={(event) => event.preventDefault()}>
          <input placeholder="새 파티 이름…" readOnly />
          <button type="button" className="wb-icon-btn is-accent" title="새 파티 만들기">＋</button>
        </form>
        <PartyGroupList
          groups={grouped}
          activePartyId="p-agentparty"
          openGroupIds={open}
          now={GALLERY_NOW}
          onToggleGroup={(id) => setClosed((current) => {
            const next = new Set(current);
            if (next.has(id)) { next.delete(id); } else { next.add(id); }
            return next;
          })}
          onSelectParty={noop}
          onCreateGroup={noop}
        />
      </section>
    </aside>
  );
}

/**
 * The picker inside the wizard's own section, so the spacing under 실행 위치 is
 * the spacing the wizard actually produces rather than the preview's.
 */
function CwdPickerStage({ initial, empty }: { initial?: MemberExecutionLocation; empty?: boolean }) {
  const prefs = empty ? GALLERY_CWD_PREFERENCES_EMPTY : GALLERY_CWD_PREFERENCES;
  const [value, setValue] = useState<MemberExecutionLocation | undefined>(initial);
  const [save, setSave] = useState(false);
  return (
    <div className="wb-modal wb-wizard pv-modal">
      <div className="wb-modal-body wb-wizard-body">
        <div className="wb-wizard-pane">
          <section className="wb-wizard-section">
            <div className="wb-modal-label">실행 위치 <span className="wb-wizard-optional">필수</span></div>
            <CwdPicker
              value={value}
              prefs={prefs}
              now={GALLERY_NOW}
              onChange={setValue}
              onChangeEnv={(env: ExecutionEnv) => setValue(preferencesFor(prefs, env).fallback ?? { env, cwd: "" })}
              onBrowse={noop}
              saveAsDefault={{ checked: save, onToggle: setSave }}
              hint={`실행 환경과 cwd는 생성 후 바꿀 수 없습니다. 세션 재개와 대화 기록이 이 cwd에 묶이기 때문입니다 — 다른 위치가 필요하면 새 멤버를 만드세요.${empty ? ` (${ENV_LABEL.windows} 기본 cwd 없음)` : ""}`}
            />
          </section>
        </div>
      </div>
    </div>
  );
}

/** Modals position themselves against the viewport; the stage gives them one. */
function ModalStage({ children, tall }: { children: JSX.Element; tall?: boolean }) {
  return <div className={"pv-modal-stage" + (tall ? " is-tall" : "")}>{children}</div>;
}

function Preview() {
  const { themeId, cycleTheme } = useTheme();
  return (
    <div className="pv-root">
      <header className="pv-bar">
        <strong>AgentParty · 디자인 목업</strong>
        <span>파티 그룹 · 멤버 실행 위치(cwd) — 기능을 실행하지 않고 보는 화면</span>
        <button type="button" onClick={cycleTheme}>테마: {themeId}</button>
      </header>
      <div className="pv-stages">
        {stages.map((stage) => (
          <section key={stage.id} className="pv-stage" data-preview={stage.id}>
            <div className="pv-stage-head">
              <h2>{stage.title}</h2>
              {stage.note && <p>{stage.note}</p>}
            </div>
            <div className="pv-stage-body" style={stage.width ? { width: stage.width } : undefined}>
              {stage.render()}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

createRoot(document.getElementById("preview")!).render(
  <ThemeProvider>
    <I18nProvider locale="ko">
      <Preview />
    </I18nProvider>
  </ThemeProvider>,
);
