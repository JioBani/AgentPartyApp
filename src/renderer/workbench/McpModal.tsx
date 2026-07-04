import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, ChevronRight, ExternalLink, KeyRound, Plug, Power, RefreshCw, X } from "lucide-react";
import type { MemberView } from "./types";
import type { WorkbenchActions } from "./actions";
import type { McpServerInfo, McpServerSnapshot, McpServerState } from "../../shared/mcp";

interface McpModalProps {
  view: MemberView;
  actions: WorkbenchActions;
  onClose: () => void;
}

const STATE_LABEL: Record<McpServerState, string> = {
  connected: "연결됨",
  connecting: "연결 중",
  failed: "실패",
  "needs-auth": "인증 필요",
  disabled: "비활성",
  unknown: "알 수 없음",
};

/**
 * Per-member MCP (external server) status + actions. Mirrors the real Claude
 * Code / Codex clients: a server list with live state + tools, and per-server
 * actions gated by the harness's real capabilities (canReconnect / canToggle /
 * canAuthenticate) — never a button that would silently no-op.
 */
export function McpModal({ view, actions, onClose }: McpModalProps) {
  const [snapshot, setSnapshot] = useState<McpServerSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [authUrl, setAuthUrl] = useState<{ server: string; url?: string; note?: string } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setSnapshot(await actions.listMcp(view.name));
    } catch (error) {
      setSnapshot({ supported: true, harness: view.member.runtime === "codex" ? "codex" : "claude-code", servers: [], error: error instanceof Error ? error.message : String(error) });
    } finally {
      setLoading(false);
    }
  }, [actions, view.name, view.member.runtime]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function runAction(server: string, fn: () => Promise<void>) {
    setBusy(server);
    setActionError(null);
    try {
      await fn();
      await load();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  async function onAuthenticate(server: string) {
    setBusy(server);
    setActionError(null);
    try {
      const result = await actions.authenticateMcp(view.name, server);
      setAuthUrl({ server, url: result.authorizationUrl, note: result.note });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  function toggleExpanded(name: string) {
    setExpanded((current) => {
      const next = new Set(current);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  }

  const servers = snapshot?.servers || [];

  return (
    <div className="wb-modal-scrim" onMouseDown={onClose}>
      <div className="wb-modal wb-mcp-modal" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <header className="wb-modal-head">
          <div className="wb-modal-title">
            <Plug size={16} />
            <strong>MCP Servers</strong>
            <span className="wb-modal-target" style={{ ["--member" as string]: view.color }}>
              <span className="wb-dot" /> {view.name}
            </span>
            <span className="wb-mono wb-modal-sub">{view.member.runtime === "codex" ? "Codex" : "Claude Code"}</span>
          </div>
          <div className="wb-mcp-head-actions">
            <button type="button" className="wb-icon-btn" title="새로고침" onClick={() => void load()} disabled={loading || Boolean(busy)}>
              <RefreshCw size={15} className={loading ? "wb-spin" : undefined} />
            </button>
            <button type="button" className="wb-icon-btn" title="Close" onClick={onClose}><X size={16} /></button>
          </div>
        </header>

        <div className="wb-modal-body wb-mcp-body">
          {snapshot?.note && <div className="wb-mcp-note">{snapshot.note}</div>}
          {snapshot?.error && <div className="wb-mcp-error"><AlertTriangle size={13} /> {snapshot.error}</div>}
          {actionError && <div className="wb-mcp-error"><AlertTriangle size={13} /> {actionError}</div>}
          {authUrl && (
            <div className="wb-mcp-auth">
              <strong>{authUrl.server} 인증</strong>
              {authUrl.url ? (
                <>
                  <span className="wb-mono wb-mcp-auth-url">{authUrl.url}</span>
                  <button type="button" className="wb-btn wb-btn-accent" onClick={() => void window.agentParty.openExternal(authUrl.url!)}>
                    <ExternalLink size={13} /> 브라우저에서 열기
                  </button>
                </>
              ) : (
                <span>{authUrl.note || "인증 URL을 받지 못했습니다."}</span>
              )}
              <button type="button" className="wb-icon-btn" title="닫기" onClick={() => setAuthUrl(null)}><X size={14} /></button>
            </div>
          )}

          {loading && !snapshot ? (
            <div className="wb-mcp-empty">불러오는 중…</div>
          ) : servers.length === 0 ? (
            <div className="wb-mcp-empty">
              연결된 MCP 서버가 없습니다.
              <small>{view.member.runtime === "codex" ? "~/.codex/config.toml 의 [mcp_servers.*] 에 서버를 추가하면 표시됩니다." : ".mcp.json 또는 사용자 설정에 MCP 서버를 추가하면 표시됩니다."}</small>
            </div>
          ) : (
            <ul className="wb-mcp-list">
              {servers.map((server) => (
                <McpServerCard
                  key={server.name}
                  server={server}
                  busy={busy === server.name}
                  expanded={expanded.has(server.name)}
                  onToggleExpanded={() => toggleExpanded(server.name)}
                  onReconnect={() => void runAction(server.name, () => actions.reconnectMcp(view.name, server.name))}
                  onToggleEnabled={() => void runAction(server.name, () => actions.toggleMcp(view.name, server.name, server.state === "disabled"))}
                  onAuthenticate={() => void onAuthenticate(server.name)}
                />
              ))}
            </ul>
          )}
        </div>

        <footer className="wb-modal-foot">
          <span className="wb-mono wb-modal-sub">{servers.length}개 서버</span>
          <div className="wb-modal-actions">
            <button type="button" className="wb-btn wb-btn-ghost" onClick={onClose}>Close</button>
          </div>
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
  const hasTools = server.tools.length > 0;
  return (
    <li className={"wb-mcp-card is-" + server.state}>
      <div className="wb-mcp-card-head">
        <span className={"wb-mcp-state is-" + server.state} title={STATE_LABEL[server.state]}><span className="wb-mcp-dot" /> {STATE_LABEL[server.state]}</span>
        <strong className="wb-mcp-name">{server.name}</strong>
        <span className="wb-mcp-chips">
          {server.transport && server.transport !== "unknown" && <span className="wb-chip wb-mono">{server.transport}</span>}
          {server.scope && <span className="wb-chip wb-mono">{server.scope}</span>}
          {server.version && <span className="wb-chip wb-mono">v{server.version}</span>}
        </span>
      </div>

      {server.error && <div className="wb-mcp-card-error">{server.error}</div>}

      <div className="wb-mcp-card-foot">
        <button type="button" className={"wb-mcp-tools" + (hasTools ? "" : " is-empty")} onClick={hasTools ? onToggleExpanded : undefined} disabled={!hasTools}>
          <ChevronRight size={12} className={"wb-mcp-caret" + (expanded ? " is-open" : "")} />
          도구 {server.tools.length}개
        </button>
        <div className="wb-mcp-actions">
          {server.canReconnect && (
            <button type="button" className="wb-tool-btn" title="재연결" onClick={onReconnect} disabled={busy}><RefreshCw size={13} /> 재연결</button>
          )}
          {server.canToggle && (
            <button type="button" className="wb-tool-btn" title={server.state === "disabled" ? "활성화" : "비활성화"} onClick={onToggleEnabled} disabled={busy}>
              <Power size={13} /> {server.state === "disabled" ? "활성화" : "비활성화"}
            </button>
          )}
          {server.canAuthenticate && (
            <button type="button" className="wb-tool-btn wb-mcp-auth-btn" title="OAuth 인증" onClick={onAuthenticate} disabled={busy}><KeyRound size={13} /> 인증</button>
          )}
        </div>
      </div>

      {expanded && hasTools && (
        <ul className="wb-mcp-tool-list">
          {server.tools.map((tool) => (
            <li key={tool.name}>
              <span className="wb-mono">{tool.name}</span>
              {tool.description && <small>{tool.description}</small>}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
