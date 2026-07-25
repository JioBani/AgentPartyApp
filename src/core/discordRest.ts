/**
 * Minimal Discord REST client — deliberately thin.
 *
 * A full SDK (discord.js) queues requests and swallows 429s internally, waiting
 * out the limit before resolving. That is exactly the behavior this feature must
 * NOT have: the design (docs/기획 노트.md §11.4) is that the app performs no
 * mechanical throttling and instead reports the throttle to the AGENT, which
 * decides when to retry. Hiding the 429 would make that impossible and would be
 * the silent-fallback the project forbids (AGENTS.md).
 *
 * So: one fetch per call, no queue, no retry, and 429 surfaces as a typed error
 * carrying Discord's own `retry_after`.
 */

const API_BASE = "https://discord.com/api/v10";

export class DiscordRestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Discord's advertised wait, in ms — present on 429 only. */
    readonly retryAfterMs?: number,
    /** Discord's JSON error code, when it sent one. */
    readonly code?: number,
  ) {
    super(message);
    this.name = "DiscordRestError";
  }

  get rateLimited(): boolean {
    return this.status === 429;
  }
}

export interface DiscordUser {
  id: string;
  username: string;
}

export interface DiscordGuild {
  id: string;
  name: string;
}

export interface DiscordChannel {
  id: string;
  name: string;
  type: number;
}

/** Text channel. */
const CHANNEL_TYPE_TEXT = 0;

export class DiscordRest {
  constructor(private readonly token: string) {}

  me(): Promise<DiscordUser> {
    return this.call("GET", "/users/@me");
  }

  guilds(): Promise<DiscordGuild[]> {
    return this.call("GET", "/users/@me/guilds");
  }

  guildChannels(guildId: string): Promise<DiscordChannel[]> {
    return this.call("GET", `/guilds/${guildId}/channels`);
  }

  createTextChannel(guildId: string, name: string, topic?: string): Promise<DiscordChannel> {
    return this.call("POST", `/guilds/${guildId}/channels`, { name, type: CHANNEL_TYPE_TEXT, topic });
  }

  createMessage(channelId: string, content: string): Promise<{ id: string }> {
    return this.call("POST", `/channels/${channelId}/messages`, { content });
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${API_BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bot ${this.token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      // Network failure: no status to report, but it must not look like success.
      throw new DiscordRestError(0, `Discord request failed (${method} ${path}): ${String(error)}`);
    }
    const text = await response.text();
    const payload = text ? safeJson(text) : undefined;
    if (response.ok) {
      return payload as T;
    }
    if (response.status === 429) {
      const retryAfterSeconds = Number((payload as any)?.retry_after);
      const headerSeconds = Number(response.headers.get("retry-after"));
      const seconds = Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : Number.isFinite(headerSeconds) ? headerSeconds : 1;
      throw new DiscordRestError(
        429,
        `Discord rate limited this request. Wait ${seconds}s and send again.`,
        Math.max(0, Math.round(seconds * 1000)),
        (payload as any)?.code,
      );
    }
    const detail = (payload as any)?.message || text || response.statusText;
    throw new DiscordRestError(response.status, `Discord ${method} ${path} failed (${response.status}): ${detail}`, undefined, (payload as any)?.code);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
