import { readJson, sendJson } from "./http";
import type { AutomationRouteContext } from "./routeContext";

/** Handles Discord-specific automation routes and reports whether one matched. */
export async function handleDiscordRoute(context: AutomationRouteContext): Promise<boolean> {
  const { method, url, req, res, controller: c, workspace, windowId, partyId } = context;
  if (method === "GET" && url.pathname === "/api/discord") {
    sendJson(res, 200, c.discordStatus());
    return true;
  }
  if (method === "POST" && url.pathname === "/api/discord/settings") {
    sendJson(res, 200, c.updateDiscordSettings(await readJson(req)));
    return true;
  }
  if (method === "POST" && url.pathname === "/api/discord/command") {
    const body = await readJson(req);
    sendJson(res, 200, await c.discordRunCommand({
      content: String(body.content || ""),
      channelId: body.channelId ? String(body.channelId) : undefined,
      authorId: body.authorId ? String(body.authorId) : undefined,
      post: body.post !== false,
    }));
    return true;
  }
  if (method === "POST" && url.pathname === "/api/discord/register") {
    const body = await readJson(req);
    sendJson(res, 200, await c.discordRegisterParty(workspace, body.partyId ? String(body.partyId) : partyId, windowId));
    return true;
  }
  const connectMatch = url.pathname.match(/^\/api\/party\/members\/([^/]+)\/discord\/connect$/);
  if (method === "POST" && connectMatch) {
    const body = await readJson(req);
    sendJson(res, 200, await c.discordConnectMember(
      workspace,
      decodeURIComponent(connectMatch[1]),
      body.channelName ? String(body.channelName) : undefined,
      windowId,
      partyId,
    ));
    return true;
  }
  const sendMatch = url.pathname.match(/^\/api\/party\/members\/([^/]+)\/discord\/send$/);
  if (method === "POST" && sendMatch) {
    const body = await readJson(req);
    sendJson(res, 200, await c.discordSendAsMember(
      workspace,
      decodeURIComponent(sendMatch[1]),
      String(body.content || ""),
      windowId,
      partyId,
    ));
    return true;
  }
  const imageMatch = url.pathname.match(/^\/api\/party\/members\/([^/]+)\/discord\/send-image$/);
  if (method === "POST" && imageMatch) {
    const body = await readJson(req);
    sendJson(res, 200, await c.discordSendImageAsMember(
      workspace,
      decodeURIComponent(imageMatch[1]),
      {
        dataBase64: String(body.dataBase64 || ""),
        filename: String(body.filename || "image.png"),
        mediaType: String(body.mediaType || "image/png"),
      },
      body.caption ? String(body.caption) : undefined,
      windowId,
      partyId,
    ));
    return true;
  }
  const disconnectMatch = url.pathname.match(/^\/api\/party\/members\/([^/]+)\/discord\/disconnect$/);
  if (method === "POST" && disconnectMatch) {
    sendJson(res, 200, await c.discordDisconnectMember(
      workspace,
      decodeURIComponent(disconnectMatch[1]),
      windowId,
      partyId,
    ));
    return true;
  }
  return false;
}

