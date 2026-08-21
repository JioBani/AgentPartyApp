import { ChevronDown, Folder, FolderOpen } from "lucide-react";
import type { MemberView } from "./types";
import { memberColorVars } from "../theme/memberColors";
import { statusLabel } from "./memberStatus";
import { WorkingDots } from "./StatusIndicator";
import { ProviderIcon } from "./ProviderIcon";
import { providerLabel } from "./modelProvider";
import { EnvIcon, ENV_LABEL } from "./CwdPicker";
import { groupMembersByLocation, splitPathTail, type MemberCwdGroup, type MemberHostGroup } from "./memberGroups";
import { LocalizedText, localized } from "../i18n/I18nProvider";

/**
 * The member list as a two-level tree: execution host, then working directory.
 *
 * A party routinely spans Windows and a WSL distro, and several checkouts inside
 * each. That is the fact which decides whether two members can even see the same
 * file, and a flat list either hid it or repeated the whole path on every row.
 * Here it is stated once, at the group it belongs to, and each member row goes
 * back to being just the member.
 *
 * Presentational: grouping, open/closed state and every action arrive as props,
 * so the design preview and the tests can draw a collapsed WSL section, a
 * hundred-character path and a busy member with no store behind them.
 *
 * Open/closed is tracked as the set of CLOSED ids rather than open ones, which
 * is what makes "everything starts expanded" survive the things that keep
 * happening to this list: a member created in a brand-new directory appears
 * inside an already-open group instead of a silently collapsed one.
 */

export interface MemberCwdTreeProps {
  views: MemberView[];
  /** Members with a tab open somewhere in the workbench. */
  openMembers: ReadonlySet<string>;
  /** Ids of host / directory groups the user has collapsed. */
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
  const hosts = groupMembersByLocation(views);
  return (
    <div className="wb-member-list">
      {views.length === 0 && <div className="wb-empty"><LocalizedText id="STR-2065" /></div>}
      {hosts.map((host) => (
        <HostSection
          key={host.id}
          host={host}
          openMembers={openMembers}
          closedGroupIds={closedGroupIds}
          menuMemberName={menuMemberName}
          onToggleGroup={onToggleGroup}
          onOpenMember={onOpenMember}
          onMemberContextMenu={onMemberContextMenu}
        />
      ))}
    </div>
  );
}

function HostSection({
  host, openMembers, closedGroupIds, menuMemberName, onToggleGroup, onOpenMember, onMemberContextMenu,
}: { host: MemberHostGroup<MemberView> } & Omit<MemberCwdTreeProps, "views">) {
  const open = !closedGroupIds.has(host.id);
  // A collapsed section still has to report what is happening inside it —
  // otherwise folding a host is how you stop noticing that one of its members
  // is waiting on an approval.
  const busy = host.groups.some((group) => group.members.some((view) => view.busy));
  const attention = host.groups.some((group) => group.members.some((view) => view.pendingApproval));
  return (
    <div className={"wb-host-group" + (open ? " is-open" : "")} data-host={host.host}>
      <button
        type="button"
        className="wb-host-row"
        title={localized("STR-3783")}
        aria-expanded={open}
        onClick={() => onToggleGroup(host.id)}
      >
        <ChevronDown size={13} className="wb-group-caret" />
        {host.host === "unknown"
          ? <Folder size={13} className="wb-host-icon" />
          : <EnvIcon env={host.host} size={13} />}
        <span className="wb-host-name">
          {host.host === "unknown" ? <LocalizedText id="STR-3784" /> : ENV_LABEL[host.host]}
        </span>
        {!open && attention && <span className="wb-group-alert" />}
        {!open && !attention && busy && <span className="wb-dot is-working wb-group-live" />}
        <span className="wb-mono wb-group-count">{host.count}</span>
      </button>
      <div className="wb-host-groups">
        {host.groups.map((group) => (
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
  // the folder name is clipped.
  const full = group.distro ? `${group.distro}: ${group.cwd}` : group.cwd;
  const busy = group.members.some((view) => view.busy);
  const attention = group.members.some((view) => view.pendingApproval);
  return (
    <div className={"wb-cwd-group" + (open ? " is-open" : "")}>
      <button
        type="button"
        className="wb-cwd-row"
        title={full || localized("STR-3784")}
        aria-expanded={open}
        onClick={() => onToggleGroup(group.id)}
      >
        <ChevronDown size={12} className="wb-group-caret" />
        {open ? <FolderOpen size={13} className="wb-group-icon" /> : <Folder size={13} className="wb-group-icon" />}
        {group.distro && <span className="wb-cwd-distro">{group.distro}</span>}
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
      <div className="wb-cwd-members">
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
      <span className="wb-member-mark" title={provider} aria-label={provider}>
        <ProviderIcon provider={view.provider} size={16} />
      </span>
      <span className="wb-member-name">{view.name}</span>
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
