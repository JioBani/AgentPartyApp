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
  topic?: string;
  parent_id?: string | null;
  thread_metadata?: { archived?: boolean; locked?: boolean };
}

/** Text channel. */
export const CHANNEL_TYPE_TEXT = 0;
/** Category ("channel group") — the per-desktop container. */
export const CHANNEL_TYPE_CATEGORY = 4;
/** Public thread. */
export const CHANNEL_TYPE_PUBLIC_THREAD = 11;
/** Discord's maximum thread auto-archive window (7 days), in minutes. */
const THREAD_ARCHIVE_MINUTES = 10080;

export class DiscordRest {
  constructor(private readonly token: string) {}

  me(): Promise<DiscordUser> {
    return this.call("GET", "/users/@me");
  }

  guilds(): Promise<DiscordGuild[]> {
    return this.call("GET", "/users/@me/guilds");
  }

  /** One channel or thread — used to read a channel's identity topic. */
  channel(channelId: string): Promise<DiscordChannel> {
    return this.call("GET", `/channels/${channelId}`);
  }

  guildChannels(guildId: string): Promise<DiscordChannel[]> {
    return this.call("GET", `/guilds/${guildId}/channels`);
  }

  createCategory(guildId: string, name: string): Promise<DiscordChannel> {
    return this.call("POST", `/guilds/${guildId}/channels`, { name, type: CHANNEL_TYPE_CATEGORY });
  }

  createTextChannel(guildId: string, name: string, options?: { topic?: string; parentId?: string }): Promise<DiscordChannel> {
    return this.call("POST", `/guilds/${guildId}/channels`, {
      name,
      type: CHANNEL_TYPE_TEXT,
      topic: options?.topic,
      parent_id: options?.parentId,
    });
  }

  /** Threads that are currently active (not archived) in a guild. */
  async activeThreads(guildId: string): Promise<DiscordChannel[]> {
    const result = await this.call<{ threads?: DiscordChannel[] }>("GET", `/guilds/${guildId}/threads/active`);
    return result?.threads || [];
  }

  async archivedThreads(channelId: string): Promise<DiscordChannel[]> {
    const result = await this.call<{ threads?: DiscordChannel[] }>("GET", `/channels/${channelId}/threads/archived/public?limit=100`);
    return result?.threads || [];
  }

  createThread(channelId: string, name: string): Promise<DiscordChannel> {
    return this.call("POST", `/channels/${channelId}/threads`, {
      name,
      type: CHANNEL_TYPE_PUBLIC_THREAD,
      auto_archive_duration: THREAD_ARCHIVE_MINUTES,
    });
  }

  /** Brings an auto-archived thread back so a report is not swallowed. */
  unarchiveThread(threadId: string): Promise<DiscordChannel> {
    return this.call("PATCH", `/channels/${threadId}`, { archived: false, auto_archive_duration: THREAD_ARCHIVE_MINUTES });
  }

  pinMessage(channelId: string, messageId: string): Promise<void> {
    return this.call("PUT", `/channels/${channelId}/pins/${messageId}`);
  }

  pinnedMessages(channelId: string): Promise<Array<{ id: string; content: string }>> {
    return this.call("GET", `/channels/${channelId}/pins`);
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
