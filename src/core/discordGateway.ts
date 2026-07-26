import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { DISCORD_GATEWAY_INTENTS, type DiscordConnectionState } from "../shared/discordBridge";

/**
 * Discord gateway client — the INBOUND half of the bridge (docs/기획 노트.md §11.8).
 *
 * Outbound (member → Discord) is plain REST, but a message the user types in
 * Discord has to reach an IDLE member, and an MCP tool only runs while the agent
 * has a turn. So the app holds this socket open and injects what arrives into the
 * member's session over the normal party-message path.
 *
 * `ws` is used because Electron 33 runs Node 20, which has no global WebSocket.
 *
 * Connection state is emitted rather than logged-and-forgotten: a bridge that
 * quietly stopped receiving would look exactly like "the user said nothing".
 */

const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";

/** Closes that a retry can never fix — only a settings change can. */
const FATAL_CLOSE_CODES = new Set([
  4004, // authentication failed (bad token)
  4013, // invalid intents
  4014, // disallowed intents (MESSAGE CONTENT not enabled)
]);

/** Opcodes used here; the rest are ignored. */
const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RECONNECT = 7;
const OP_INVALID_SESSION = 9;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

export interface DiscordInboundAttachment {
  id: string;
  filename: string;
  size: number;
  contentType?: string;
  url: string;
}

export interface DiscordInboundMessage {
  channelId: string;
  messageId: string;
  authorId: string;
  authorName: string;
  authorIsBot: boolean;
  content: string;
  /** Files the user attached — images become user-turn attachments. */
  attachments: DiscordInboundAttachment[];
}

export interface DiscordGatewayEvents {
  message: (message: DiscordInboundMessage) => void;
  state: (state: DiscordConnectionState, error?: string) => void;
}

export class DiscordGateway extends EventEmitter {
  private socket: WebSocket | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private sequence: number | null = null;
  private closed = false;
  private attempt = 0;

  constructor(private readonly token: string) {
    super();
  }

  start(): void {
    this.closed = false;
    this.open();
  }

  stop(): void {
    this.closed = true;
    this.clearTimers();
    const socket = this.socket;
    this.socket = undefined;
    try {
      socket?.close(1000, "bridge stopped");
    } catch {
      /* already closing */
    }
    this.emitState("off");
  }

  private open(): void {
    this.clearTimers();
    this.emitState("connecting");
    const socket = new WebSocket(GATEWAY_URL);
    this.socket = socket;

    socket.on("message", (raw) => this.onFrame(String(raw)));
    socket.on("error", (error) => {
      // Surfaced, not swallowed — the UI shows the bridge as errored.
      this.emitState("error", `Discord gateway error: ${String(error)}`);
    });
    socket.on("close", (code, reason) => {
      if (this.socket !== socket) {
        return; // superseded by a newer socket
      }
      this.socket = undefined;
      this.clearTimers();
      if (this.closed) {
        return;
      }
      this.emitState("error", closeReason(code, String(reason || "")));
      if (FATAL_CLOSE_CODES.has(code)) {
        // Retrying cannot succeed until the USER changes something (enable the
        // intent, fix the token). Looping anyway would burn Discord's daily
        // gateway session budget (~1000 identifies/day) — a 30s retry loop spends
        // ~2880 — and then the bridge stays broken even after the fix. Stop, stay
        // visibly errored, and reconnect when settings are saved or the app
        // restarts.
        this.closed = true;
        return;
      }
      this.scheduleReconnect();
    });
  }

  private onFrame(raw: string): void {
    let frame: any;
    try {
      frame = JSON.parse(raw);
    } catch {
      return; // non-JSON frames are not part of the protocol we speak
    }
    if (typeof frame.s === "number") {
      this.sequence = frame.s;
    }
    switch (frame.op) {
      case OP_HELLO:
        this.startHeartbeat(Number(frame.d?.heartbeat_interval) || 41250);
        this.identify();
        break;
      case OP_HEARTBEAT:
        this.send({ op: OP_HEARTBEAT, d: this.sequence });
        break;
      case OP_HEARTBEAT_ACK:
        break;
      case OP_INVALID_SESSION:
      case OP_RECONNECT:
        this.socket?.close(4000, "reconnect requested");
        break;
      case OP_DISPATCH:
        this.onDispatch(String(frame.t || ""), frame.d);
        break;
      default:
        break;
    }
  }

  private onDispatch(type: string, data: any): void {
    if (type === "READY") {
      this.attempt = 0;
      this.emitState("connected");
      return;
    }
    if (type !== "MESSAGE_CREATE" || !data) {
      return;
    }
    this.emit("message", {
      channelId: String(data.channel_id || ""),
      messageId: String(data.id || ""),
      authorId: String(data.author?.id || ""),
      authorName: String(data.author?.username || ""),
      authorIsBot: Boolean(data.author?.bot),
      content: typeof data.content === "string" ? data.content : "",
      attachments: (Array.isArray(data.attachments) ? data.attachments : []).map((attachment: any) => ({
        id: String(attachment?.id || ""),
        filename: String(attachment?.filename || ""),
        size: Number(attachment?.size) || 0,
        contentType: attachment?.content_type ? String(attachment.content_type) : undefined,
        url: String(attachment?.url || ""),
      })),
    } satisfies DiscordInboundMessage);
  }

  private identify(): void {
    this.send({
      op: OP_IDENTIFY,
      d: {
        token: this.token,
        intents: DISCORD_GATEWAY_INTENTS,
        properties: { os: process.platform, browser: "agentparty", device: "agentparty" },
      },
    });
  }

  private startHeartbeat(intervalMs: number): void {
    this.heartbeatTimer = setInterval(() => this.send({ op: OP_HEARTBEAT, d: this.sequence }), intervalMs);
  }

  private scheduleReconnect(): void {
    this.attempt += 1;
    // Capped backoff: a wrong token would otherwise reconnect in a hot loop.
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.attempt, 5));
    this.reconnectTimer = setTimeout(() => {
      if (!this.closed) {
        this.open();
      }
    }, delay);
  }

  private send(payload: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload));
    }
  }

  private clearTimers(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private emitState(state: DiscordConnectionState, error?: string): void {
    this.emit("state", state, error);
  }
}

/**
 * Turns Discord's close codes into something the user can act on. The two that
 * actually happen during setup are unauthenticated (bad token) and disallowed
 * intents (MESSAGE CONTENT not enabled) — both look identical as a raw number.
 */
function closeReason(code: number, reason: string): string {
  if (code === 4014) {
    return "Discord refused the connection: MESSAGE CONTENT INTENT is not enabled for this bot. Turn it on in the Discord Developer Portal → your app → Bot → Privileged Gateway Intents, then reconnect. Until then the member cannot receive what you type in Discord.";
  }
  if (code === 4004) {
    return "Discord rejected the bot token. Check the token in Settings → Discord (it may have been reset).";
  }
  if (code === 4013) {
    return "Discord rejected the requested gateway intents (4013). This is a bug in the bridge's intent set, not a setting.";
  }
  return `Discord gateway closed (${code}${reason ? `: ${reason}` : ""}).`;
}
