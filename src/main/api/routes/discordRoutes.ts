import type { MethodRoute } from "../methodRegistry";
import { optText, text } from "../methodRegistry";

/** The Discord bridge (docs/기획 노트.md §11): app-level settings + per-member channels. */
export const discordRoutes: MethodRoute[] = [
  {
    name: "discord.status",
    http: "GET /api/discord",
    handler: (_p, ctx) => ctx.controller.discordStatus(),
  },
  {
    name: "discord.settings",
    http: "POST /api/discord/settings",
    handler: (p, ctx) => ctx.controller.updateDiscordSettings(p),
  },
  {
    name: "discord.command",
    http: "POST /api/discord/command",
    handler: (p, ctx) => ctx.controller.discordRunCommand({
      content: text(p.content),
      channelId: optText(p.channelId),
      authorId: optText(p.authorId),
      post: p.post !== false,
    }),
  },
  {
    name: "discord.register",
    http: "POST /api/discord/register",
    handler: (p, ctx) => ctx.controller.discordRegisterParty(ctx.workspace, optText(p.partyId) ?? ctx.partyId, ctx.windowId),
  },
  {
    name: "discord.connect",
    http: "POST /api/party/members/:name/discord/connect",
    handler: (p, ctx) => ctx.controller.discordConnectMember(ctx.workspace, text(p.name), optText(p.channelName), ctx.windowId, ctx.partyId),
  },
  {
    name: "discord.send",
    http: "POST /api/party/members/:name/discord/send",
    handler: (p, ctx) => ctx.controller.discordSendAsMember(ctx.workspace, text(p.name), text(p.content), ctx.windowId, ctx.partyId),
  },
  {
    name: "discord.sendImage",
    http: "POST /api/party/members/:name/discord/send-image",
    handler: (p, ctx) => ctx.controller.discordSendImageAsMember(
      ctx.workspace,
      text(p.name),
      {
        dataBase64: text(p.dataBase64),
        filename: text(p.filename, "image.png"),
        mediaType: text(p.mediaType, "image/png"),
      },
      optText(p.caption),
      ctx.windowId,
      ctx.partyId,
    ),
  },
  {
    name: "discord.disconnect",
    http: "POST /api/party/members/:name/discord/disconnect",
    handler: (p, ctx) => ctx.controller.discordDisconnectMember(ctx.workspace, text(p.name), ctx.windowId, ctx.partyId),
  },
];
