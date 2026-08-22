import { ChevronDown, Folder, FolderOpen } from "lucide-react";
import type { MemberView } from "./types";
import { memberColorVars } from "../theme/memberColors";
import { statusLabel } from "./memberStatus";
import { WorkingDots } from "./StatusIndicator";
import { ProviderIcon } from "./ProviderIcon";
import { providerLabel } from "./modelProvider";
import { EnvIcon, ENV_LABEL } from "./CwdPicker";
import { groupMembersByLocation, splitPathTail, type MemberCwdGroup, type MemberEnvGroup } from "./memberGroups";
import { LocalizedText, localized, useI18n } from "../i18n/I18nProvider";

/**
 * The member list as a tree of execution environments and working directories.
 *
 * A party routinely spans Windows and one or more WSL distros, and several
 * checkouts inside each. That is the fact which decides whether two members can
 * even see the same file, and a flat list either hid it or repeated the whole
 * path on every row. Here it is stated once, at the group it belongs to, and
 * each member row goes back to being just the member.
 *
 * Each DISTRO is a top-level section, peer to Windows — there is no "WSL"
 * parent. Two distros share neither filesystem nor toolchain, so a common
 * parent grouped unrelated things together and spent a level of indentation
 * saying a word the distro name already implies. The section label is the
 * distro alone; the terminal mark beside it, the app's established WSL glyph,
 * carries the family, and the tooltip spells it out.
 *
 * With one native environment and nothing else, the environment headers say
 * nothing (`MemberTree.flat`) and the directory groups sit at the root — one
 * less row and one less indent in a drawer that is often 256px wide.
 *
 * Presentational: grouping, open/closed state and every action arrive as props,
 * so the design preview and the tests can draw a collapsed distro section, a
 * hundred-character path and a busy member with no store behind them.
 *
 * Open/closed is tracked as the set of CLOSED ids rather than open ones, which
 * is what makes "everything starts expanded" survive the things that keep
 * happening to this list: a member created in a brand-new directory — or the
 * first member in a distro nobody has used yet — appears inside an already-open
 * group instead of a silently collapsed one.
 */

export interface MemberCwdTreeProps {
  views: MemberView[];
  /** Members with a tab open somewhere in the workbench. */
  openMembers: ReadonlySet<string>;
  /** Ids of environment / directory groups the user has collapsed. */
  closedGroupIds: ReadonlySet<string>;
  /** Marks the row the context menu is currently open on. */
  menuMemberName?: string;
  onToggleGroup: (groupId: string) => void;
  onOpenMember: (name: string) => void;
  onMemberContextMenu: (name: string, event: React.MouseEvent) => void;
}

export function MemberCwdTree({
  views, openMembers, closedGroupIds, menuMemberName, onToggleGroup, onOpenMember, onMemberContextMenu,
}: MemberCwdTreeProps) {
  const tree = groupMembersByLocation(views);
  const shared = { openMembers, closedGroupIds, menuMemberName, onToggleGroup, onOpenMember, onMemberContextMenu };
  return (
    <div className={"wb-member-list" + (tree.flat ? " is-flat" : "")}>
      {views.length === 0 && <div className="wb-empty"><LocalizedText id="STR-2065" /></div>}
      {/* One native environment: every row runs there, so a header naming it
          would be a heading over the whole list saying what the whole list
          already is. The directory groups become the top level. */}
      {tree.flat
        ? tree.envs[0].groups.map((group) => <CwdSection key={group.id} group={group} {...shared} />)
        : tree.envs.map((env) => <EnvSection key={env.id} env={env} {...shared} />)}
    </div>
  );
}

/**
 * One execution environment: Windows, a single WSL distro, or the bucket for
 * members whose location could not be read.
 */
function EnvSection({
  env, openMembers, closedGroupIds, menuMemberName, onToggleGroup, onOpenMember, onMemberContextMenu,
}: { env: MemberEnvGroup<MemberView> } & Omit<MemberCwdTreeProps, "views">) {
  const { t } = useI18n();
  const open = !closedGroupIds.has(env.id);
  // A collapsed section still has to report what is happening inside it —
  // otherwise folding an environment is how you stop noticing that one of its
  // members is waiting on an approval.
  const busy = env.groups.some((group) => group.members.some((view) => view.busy));
  const attention = env.groups.some((group) => group.members.some((view) => view.pendingApproval));
  // The distro IS the label. Repeating "WSL" in front of it spends the drawer's
  // scarcest resource on a word the section's own mark and tooltip already
  // carry, and it is the distro name that tells Ubuntu from Debian.
  const label = env.kind === "wsl"
    ? (env.distro || t("member.env.unnamedDistro"))
    : env.kind === "unknown" ? localized("STR-3785") : ENV_LABEL[env.kind];
  const title = env.kind === "wsl"
    ? t("member.env.wslTitle", { distro: env.distro || t("member.env.unnamedDistro") })
    : localized("STR-3784");
  const bodyId = `wb-env-${env.id.replace(/[^a-zA-Z0-9]+/g, "-")}`;
  return (
    <div
      className={"wb-env-group" + (open ? " is-open" : "")}
      data-host={env.kind}
      data-distro={env.distro || undefined}
      role="group"
      aria-label={label}
    >
      <button
        type="button"
        className="wb-env-row"
        title={title}
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => onToggleGroup(env.id)}
      >
        <ChevronDown size={13} className="wb-group-caret" />
        {env.kind === "unknown"
          ? <Folder size={13} className="wb-env-icon" />
          : <EnvIcon env={env.kind} size={13} />}
        <span className={"wb-env-name" + (env.unnamed ? " is-unnamed" : "")}>{label}</span>
        {!open && attention && <span className="wb-group-alert" />}
        {!open && !attention && busy && <span className="wb-dot is-working wb-group-live" />}
        <span className="wb-mono wb-group-count">{env.count}</span>
      </button>
      <div className="wb-env-groups" id={bodyId}>
        {env.groups.map((group) => (
          <CwdSection
            key={group.id}
            group={group}
            openMembers={openMembers}
            closedGroupIds={closedGroupIds}
            menuMemberName={menuMemberName}
            onToggleGroup={onToggleGroup}
            onOpenMember={onOpenMember}
            onMemberContextMenu={onMemberContextMenu}
          />
        ))}
      </div>
    </div>
  );
}

function CwdSection({
  group, openMembers, closedGroupIds, menuMemberName, onToggleGroup, onOpenMember, onMemberContextMenu,
}: { group: MemberCwdGroup<MemberView> } & Omit<MemberCwdTreeProps, "views">) {
  const open = !closedGroupIds.has(group.id);
  const { head, tail } = splitPathTail(group.cwd);
  // The full path is the tooltip, always: the row shows as much of it as the
  // drawer's width allows, and a drawer can be dragged narrow enough that even
  // the folder name is clipped. The distro belongs here rather than as a second
  // badge on the row — the section above already names it.
  const full = group.distro ? `${group.distro}: ${group.cwd}` : group.cwd;
  const busy = group.members.some((view) => view.busy);
  const attention = group.members.some((view) => view.pendingApproval);
  const bodyId = `wb-cwd-${group.id.replace(/[^a-zA-Z0-9]+/g, "-")}`;
  return (
    <div className={"wb-cwd-group" + (open ? " is-open" : "")} role="group" aria-label={full || localized("STR-3785")}>
      <button
        type="button"
        className="wb-cwd-row"
        title={full || localized("STR-3785")}
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => onToggleGroup(group.id)}
      >
        <ChevronDown size={12} className="wb-group-caret" />
        {open ? <FolderOpen size={13} className="wb-group-icon" /> : <Folder size={13} className="wb-group-icon" />}
        <span className="wb-cwd-path">
          {/* Split so the ellipsis eats the ANCESTORS, never the directory name:
              several checkouts under one long parent are told apart by the tail,
              and end-truncation clipped exactly the part being read for. */}
          <span className="wb-cwd-head">{head}</span>
          <span className="wb-cwd-tail">{tail || full}</span>
        </span>
        {!open && attention && <span className="wb-group-alert" />}
        {!open && !attention && busy && <span className="wb-dot is-working wb-group-live" />}
        <span className="wb-mono wb-group-count">{group.members.length}</span>
      </button>
      <div className="wb-cwd-members" id={bodyId}>
        {group.members.map((view) => (
          <MemberRow
            key={view.name}
            view={view}
            open={openMembers.has(view.name)}
            menu={menuMemberName === view.name}
            onOpenMember={onOpenMember}
            onMemberContextMenu={onMemberContextMenu}
          />
        ))}
      </div>
    </div>
  );
}

function MemberRow({
  view, open, menu, onOpenMember, onMemberContextMenu,
}: {
  view: MemberView;
  open: boolean;
  menu: boolean;
  onOpenMember: (name: string) => void;
  onMemberContextMenu: (name: string, event: React.MouseEvent) => void;
}) {
  const provider = providerLabel(view.provider);
  return (
    <div
      role="button"
      tabIndex={0}
      className={"wb-member-row" + (open ? " is-open" : "") + (menu ? " is-menu" : "")}
      style={memberColorVars(view.name)}
      onClick={() => onOpenMember(view.name)}
      onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpenMember(view.name); } }}
      onContextMenu={(event) => {
        // Always worth showing: it applies to any member, session or not, so
        // there is no longer a case with nothing actionable in it.
        event.preventDefault();
        event.stopPropagation();
        onMemberContextMenu(view.name, event);
      }}
    >
      {/* Whose MODEL is answering, ahead of the name — the icon reads as part of
          the member's identity, and the harness that used to sit here named the
          wrong company for every cross-routed member. */}
      {/* A notch under the 18px slot it sits in, so the mark reads as a mark
          rather than as a second glyph competing with the member's name. The
          slot itself does not change — the names stay on one line down the
          whole list. */}
      <span className="wb-member-mark" title={provider} aria-label={provider}>
        <ProviderIcon provider={view.provider} size={14.5} />
      </span>
      {/* The name is the one thing a narrow drawer must not silently clip past
          recognition, so the full name is always on the tooltip. */}
      <span className="wb-member-name" title={view.name}>{view.name}</span>
      {view.pendingApproval && <span className="wb-member-badge"><LocalizedText id="STR-2066" /></span>}
      {view.unread > 0 && <span className="wb-mono wb-member-unread">{view.unread}</span>}
      {/* A running turn is motion, not the grey word "working" that read as a
          label and was easy to miss down the list. */}
      {!view.pendingApproval && (view.status === "working"
        ? <WorkingDots label={localized("STR-2067")} />
        : <span className="wb-mono wb-member-status">{statusLabel(view.status)}</span>)}
    </div>
  );
}
