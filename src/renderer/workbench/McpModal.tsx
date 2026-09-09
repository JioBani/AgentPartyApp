import { useCallback, useEffect, useMemo, useState } from "react";
import { useModalEscape } from "./useModalEscape";
import { AlertTriangle, ChevronRight, ExternalLink, KeyRound, Lock, Plug, Power, RotateCcw, Search, Wrench, X } from "lucide-react";
import type { MemberView } from "./types";
import type { WorkbenchActions } from "./actions";
import type { McpServerInfo, McpServerSnapshot, McpServerState } from "../../shared/mcp";
import { harnessForRuntime, harnessLabel } from "../../shared/types";
import { LocalizedText, localized } from "../i18n/I18nProvider";

interface McpModalProps {
  view: MemberView;
  actions: WorkbenchActions;
  onClose: () => void;
}

type FilterId = "all" | "connected" | "failed" | "needs-auth";

const STATE_LABEL: Record<McpServerState, string> = {
  connected: "연결됨",
  connecting: "연결 중",
  failed: "실패",
  "needs-auth": "인증 필요",
  disabled: "비활성화됨",
  unknown: "알 수 없음",
};

const MAX_TOOL_CHIPS = 16;

/**
 * Per-member MCP (external server) status + actions. Mirrors the real Claude
 * Code / Codex clients: a searchable, filterable server list with live state +
 * tools, per-server actions gated by the harness's real capabilities
 * (canReconnect / canToggle / canAuthenticate) — never a button that no-ops.
 */
export function McpModal({ view, actions, onClose }: McpModalProps) {
  const fallbackHarness = harnessForRuntime(view.member.runtime);
  const [snapshot, setSnapshot] = useState<McpServerSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [authInfo, setAuthInfo] = useState<{ server: string; url?: string; note?: string } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterId>("all");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setSnapshot(await actions.listMcp(view.name));
    } catch (error) {
      setSnapshot({ supported: true, harness: fallbackHarness, servers: [], error: error instanceof Error ? error.message : String(error) });
    } finally {
      setLoading(false);
    }
  }, [actions, view.name, fallbackHarness]);

  useEffect(() => { void load(); }, [load]);

  useModalEscape(onClose);

  const servers = useMemo(() => snapshot?.servers || [], [snapshot]);
  const counts = useMemo(() => ({
    total: servers.length,
    connected: servers.filter((s) => s.state === "connected").length,
    failed: servers.filter((s) => s.state === "failed").length,
    "needs-auth": servers.filter((s) => s.state === "needs-auth").length,
    tools: servers.reduce((sum, s) => sum + (s.state === "disabled" ? 0 : s.tools.length), 0),
  }), [servers]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return servers.filter((s) => {
      if (filter !== "all" && s.state !== filter) return false;
      if (q && !s.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [servers, filter, query]);

  const withBusy = useCallback((name: string, on: boolean) => {
    setBusy((current) => {
      const next = new Set(current);
      on ? next.add(name) : next.delete(name);
      return next;
    });
  }, []);

  const runAction = useCallback(async (name: string, fn: () => Promise<void>) => {
    withBusy(name, true);
    setActionError(null);
    try {
      await fn();
      await load();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      withBusy(name, false);
    }
  }, [withBusy, load]);

  async function onAuthenticate(name: string) {
    withBusy(name, true);
    setActionError(null);
    try {
      const result = await actions.authenticateMcp(view.name, name);
      setAuthInfo({ server: name, url: result.authorizationUrl, note: result.note });
      await load();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      withBusy(name, false);
    }
  }

  async function reconnectAll() {
    const targets = servers.filter((s) => s.canReconnect && s.state !== "needs-auth" && s.state !== "disabled");
    if (!targets.length) return;
    setActionError(null);
    setBusy((current) => new Set([...current, ...targets.map((s) => s.name)]));
    try {
      await Promise.all(targets.map((s) => actions.reconnectMcp(view.name, s.name).catch(() => {})));
      await load();
    } finally {
      setBusy(new Set());
    }
  }

  function toggleExpanded(name: string) {
    setExpanded((current) => {
      const next = new Set(current);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  }

  const FILTERS: Array<{ id: FilterId; label: string; count: number; dot?: string }> = [
    { id: "all", label: "전체", count: counts.total },
    { id: "connected", label: "연결됨", count: counts.connected, dot: "success" },
    { id: "failed", label: "실패", count: counts.failed, dot: "danger" },
    { id: "needs-auth", label: "인증 필요", count: counts["needs-auth"], dot: "live" },
  ];

  const anyReconnectable = servers.some((s) => s.canReconnect && s.state !== "needs-auth" && s.state !== "disabled");

  // The scrim does not dismiss — closing is explicit (닫기 / ✕), as in every
  // other modal in the app.
  return (
    <div className="wb-modal-scrim">
      <div className="mcp-modal" role="dialog" aria-modal="true">
        {/* header */}
        <header className="mcp-head">
          <span className="mcp-head-icon"><Plug size={16} /></span>
          <div className="mcp-head-title">
            <span className="mcp-head-name"><LocalizedText id="STR-1696" /></span>
            <span className="mcp-head-sub">
              <span className="mcp-mem-dot" style={{ background: view.color }} />
              <span className="mcp-mem-name">{view.name}</span>
              <span className="mcp-sep" />
              <span className="wb-mono mcp-harness">{harnessLabel(snapshot?.harness || fallbackHarness)}</span>
            </span>
          </div>
          <div className="mcp-head-actions">
            <button type="button" className="mcp-btn-soft" title={localized("STR-1697")} onClick={() => void reconnectAll()} disabled={loading || !anyReconnectable}>
              <RotateCcw size={13} className={busy.size > 1 ? "wb-spin" : undefined} />  <LocalizedText id="STR-1698" />
            </button>
            <button type="button" className="mcp-icon-btn" title={localized("STR-1699")} onClick={onClose}><X size={15} /></button>
          </div>
        </header>

        {/* harness note */}
        {snapshot?.note && (
          <div className="mcp-note">
            <AlertTriangle size={14} />
            <span>{snapshot.note}</span>
          </div>
        )}
        {snapshot?.error && <div className="mcp-banner is-error"><AlertTriangle size={13} /> {snapshot.error}</div>}
        {actionError && <div className="mcp-banner is-error"><AlertTriangle size={13} /> {actionError}</div>}
        {authInfo && (
          <div className="mcp-banner is-auth">
            <KeyRound size={13} />
            <strong>{authInfo.server}</strong>
            {authInfo.url ? (
              <>
                <span className="wb-mono mcp-auth-url">{authInfo.url}</span>
                <button type="button" className="mcp-btn-accent" onClick={() => void window.agentParty.openExternal(authInfo.url!)}><ExternalLink size={12} />  <LocalizedText id="STR-1700" /></button>
              </>
            ) : (
              <span>{authInfo.note || "인증 URL을 받지 못했습니다."}</span>
            )}
            <button type="button" className="mcp-icon-btn mcp-inline-close" title={localized("STR-1702")} onClick={() => setAuthInfo(null)}><X size={13} /></button>
          </div>
        )}

        {/* controls */}
        <div className="mcp-controls">
          <div className="mcp-search">
            <Search size={14} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={localized("STR-1703")} />
            {query && <button type="button" className="mcp-search-clear" title={localized("STR-1704")} onClick={() => setQuery("")}><X size={10} /></button>}
          </div>
          <button type="button" className="mcp-icon-btn mcp-refresh" title={localized("STR-1705")} onClick={() => void load()} disabled={loading || busy.size > 0}>
            <RotateCcw size={15} className={loading ? "wb-spin" : undefined} />
          </button>
        </div>

        {/* filter chips */}
        <div className="mcp-filters">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" className={"mcp-chip" + (filter === f.id ? " is-active" : "")} onClick={() => setFilter(f.id)}>
              {f.dot && <span className={"mcp-dot is-" + f.dot} />}
              <span>{f.label}</span>
              <span className="wb-mono mcp-chip-count">{f.count}</span>
            </button>
          ))}
        </div>

        {/* list */}
        <div className="mcp-list">
          {loading && !snapshot ? (
            <div className="mcp-empty"><LocalizedText id="STR-1706" /></div>
          ) : filtered.length === 0 ? (
            <div className="mcp-empty">
              <Search size={24} />
              {servers.length === 0 ? (
                <>
                  <span><LocalizedText id="STR-1707" /></span>
                  <small>{(snapshot?.harness || fallbackHarness) === "codex" ? "~/.codex/config.toml 의 [mcp_servers.*] 에 서버를 추가하면 표시됩니다." : ".mcp.json 또는 사용자 설정에 MCP 서버를 추가하면 표시됩니다."}</small>
                </>
              ) : (
                <span><LocalizedText id="STR-1709" /></span>
              )}
            </div>
          ) : (
            filtered.map((server) => (
              <McpServerCard
                key={server.name}
                server={server}
                busy={busy.has(server.name)}
                expanded={expanded.has(server.name)}
                onToggleExpanded={() => toggleExpanded(server.name)}
                onReconnect={() => void runAction(server.name, () => actions.reconnectMcp(view.name, server.name))}
                onToggleEnabled={() => void runAction(server.name, () => actions.toggleMcp(view.name, server.name, server.state === "disabled"))}
                onAuthenticate={() => void onAuthenticate(server.name)}
              />
            ))
          )}
        </div>

        {/* footer */}
        <footer className="mcp-foot">
          <div className="mcp-foot-stats wb-mono">
            <span>{counts.total}<LocalizedText id="STR-1710" /></span>
            <span className="mcp-sep" />
            <span className="mcp-stat"><span className="mcp-dot is-success" /><LocalizedText id="STR-1711" /> {counts.connected}</span>
            <span className="mcp-stat"><span className="mcp-dot is-danger" /><LocalizedText id="STR-1712" /> {counts.failed}</span>
            <span className="mcp-stat"><span className="mcp-dot is-live" /><LocalizedText id="STR-1713" /> {counts["needs-auth"]}</span>
            <span className="mcp-sep" />
            <span><LocalizedText id="STR-1714" /> {counts.tools}개</span>
          </div>
          <button type="button" className="mcp-btn-soft" onClick={onClose}><LocalizedText id="STR-1715" /></button>
        </footer>
      </div>
    </div>
  );
}

interface McpServerCardProps {
  server: McpServerInfo;
  busy: boolean;
  expanded: boolean;
  onToggleExpanded: () => void;
  onReconnect: () => void;
  onToggleEnabled: () => void;
  onAuthenticate: () => void;
}

function McpServerCard({ server, busy, expanded, onToggleExpanded, onReconnect, onToggleEnabled, onAuthenticate }: McpServerCardProps) {
  const hasTools = server.tools.length > 0 && server.state !== "disabled";
  const chips = server.tools.slice(0, MAX_TOOL_CHIPS);
  const more = server.tools.length - chips.length;
  const disabled = server.state === "disabled";

  return (
    <div className={"mcp-card is-" + server.state}>
      <div className="mcp-card-top">
        <span className={"mcp-state is-" + server.state}>
          <span className="mcp-state-dot" />
          {STATE_LABEL[server.state]}
        </span>
        <span className="wb-mono mcp-card-name">{server.name}</span>
        <span className="mcp-tags">
          {server.transport && server.transport !== "unknown" && <span className="mcp-tag is-accent wb-mono">{server.transport}</span>}
          {server.scope && <span className="mcp-tag wb-mono">{server.scope}</span>}
          {server.version && <span className="mcp-tag wb-mono">v{server.version}</span>}
        </span>
      </div>

      {server.state === "failed" && server.error && (
        <div className="mcp-context is-error"><AlertTriangle size={13} /><span className="wb-mono">{server.error}</span></div>
      )}
      {server.state === "needs-auth" && (
        <div className="mcp-context is-auth"><Lock size={13} /><span><LocalizedText id="STR-1716" /></span></div>
      )}

      <div className="mcp-card-foot">
        <button type="button" className={"mcp-tools" + (hasTools ? "" : " is-empty")} onClick={hasTools ? onToggleExpanded : undefined} disabled={!hasTools}>
          <ChevronRight size={12} className={"mcp-caret" + (expanded ? " is-open" : "") + (hasTools ? "" : " is-hidden")} />
          <Wrench size={12} />
          <span><LocalizedText id="STR-1717" /></span>
          <span className={"wb-mono mcp-tool-count" + (server.tools.length ? "" : " is-zero")}>{server.tools.length}</span>
        </button>
        <div className="mcp-actions">
          {disabled ? (
            server.canToggle && (
              <button type="button" className="mcp-btn-accent" onClick={onToggleEnabled} disabled={busy}><Power size={13} />  <LocalizedText id="STR-1718" /></button>
            )
          ) : (
            <>
              {server.canAuthenticate && (
                <button type="button" className="mcp-btn-accent" onClick={onAuthenticate} disabled={busy}><KeyRound size={13} />  <LocalizedText id="STR-1719" /></button>
              )}
              {server.canReconnect && (
                <button type="button" className="mcp-btn-soft" onClick={onReconnect} disabled={busy}>
                  <RotateCcw size={13} className={busy ? "wb-spin" : undefined} /> {busy ? "재연결 중" : "재연결"}
                </button>
              )}
              {server.canToggle && (
                <button type="button" className="mcp-icon-btn mcp-disable" title={localized("STR-1722")} onClick={onToggleEnabled} disabled={busy}><Power size={14} /></button>
              )}
            </>
          )}
        </div>
      </div>

      {expanded && hasTools && (
        <div className="mcp-tools-panel">
          <div className="mcp-tool-chips">
            {chips.map((tool) => (
              <span key={tool.name} className="wb-mono mcp-tool-chip" title={tool.description}>{tool.name}</span>
            ))}
            {more > 0 && <span className="mcp-tool-chip is-more">+{more}<LocalizedText id="STR-1723" /></span>}
          </div>
        </div>
      )}
    </div>
  );
}
