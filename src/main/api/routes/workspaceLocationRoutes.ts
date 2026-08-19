import { ApiError, optText, required, text, type MethodRoute } from "../methodRegistry";
import type { ExecutionEnv, MemberExecutionLocation } from "../../../shared/memberLocation";

/**
 * Party groups and member execution locations.
 *
 * Its own file rather than more rows in `partyRoutes`, because none of these are
 * workspace-scoped: the group registry and the cwd preferences are app-global,
 * and mixing them into the party table would invite the next reader to add
 * `ctx.workspace` to one of them.
 *
 * Registering here publishes the HTTP endpoint, the `GET /api/spec` entry and
 * the mobile-link method together, so an agent drives exactly what a user does.
 * See `docs/API.md`.
 */

/** Reads `{env, cwd, distro}` off a request body, refusing anything unusable. */
function location(p: Record<string, any>): MemberExecutionLocation {
  const env = env0(p.env);
  const cwd = text(p.cwd, "cwd");
  const distro = optText(p.distro);
  if (env === "wsl" && !distro) {
    throw new ApiError(400, "WSL 위치에는 distro 가 필요합니다.");
  }
  return env === "wsl" ? { env, cwd, distro } : { env, cwd };
}

function env0(value: unknown): ExecutionEnv {
  const env = String(value || "").trim();
  if (env !== "windows" && env !== "wsl") {
    throw new ApiError(400, `env 는 'windows' 또는 'wsl' 이어야 합니다 (받은 값: '${env}').`);
  }
  return env;
}

export const workspaceLocationRoutes: MethodRoute[] = [
  {
    name: "partyGroups.list",
    http: "GET /api/party-groups",
    handler: (_p, ctx) => ctx.controller.listPartyGroups(),
  },
  {
    name: "partyGroups.create",
    http: "POST /api/party-groups",
    handler: (p, ctx) => ctx.controller.createPartyGroup(required(p.name, "name")),
  },
  {
    name: "partyGroups.move",
    http: "POST /api/parties/:id/group",
    handler: (p, ctx) => ctx.controller.movePartyToGroup(text(p.id), required(p.groupId, "groupId")),
  },
  {
    // Idempotent by design, so a QA run (or a user who wants it now) can ask
    // for it again and read what it found.
    name: "partyGroups.migrate",
    http: "POST /api/party-groups/migrate",
    handler: (p, ctx) => ctx.controller.migratePartyGroups(Array.isArray(p.workspaces) ? p.workspaces.map(String) : [ctx.workspace]),
  },
  {
    // `?check=1` re-probes every remembered path in its own environment, which
    // can spawn `wsl.exe` — off by default so drawing the list stays cheap.
    name: "cwd.preferences",
    http: "GET /api/cwd/preferences",
    handler: (p, ctx) => ctx.controller.getCwdPreferences({ check: p.check === "1" || p.check === true }),
  },
  {
    name: "cwd.setDefault",
    http: "POST /api/cwd/default",
    handler: (p, ctx) => ctx.controller.setDefaultCwd(location(p)),
  },
  {
    name: "cwd.clearDefault",
    http: "POST /api/cwd/default/clear",
    handler: (p, ctx) => ctx.controller.clearDefaultCwd(env0(p.env)),
  },
  {
    name: "cwd.removeRecent",
    http: "POST /api/cwd/recent/remove",
    handler: (p, ctx) => ctx.controller.removeRecentCwd(location(p)),
  },
  {
    name: "cwd.check",
    http: "POST /api/cwd/check",
    handler: (p, ctx) => ctx.controller.checkCwd(location(p)),
  },
  {
    name: "cwd.distros",
    http: "GET /api/cwd/distros",
    handler: (_p, ctx) => ctx.controller.listWslDistros(),
  },
  {
    // The WSL folder browser's one call: a directory level as the distro sees
    // it. `cwd` omitted = the distro's `$HOME`, which is where browsing starts.
    name: "cwd.listWslDirectories",
    http: "POST /api/cwd/wsl/list",
    handler: (p, ctx) => ctx.controller.listWslDirectories(text(p.distro, "distro"), optText(p.cwd)),
  },
  {
    // Opens the real folder picker, so an agent driving QA walks the same path a
    // user does. `remote: false` — a headless engine has no dialog.
    name: "cwd.browse",
    http: "POST /api/cwd/browse",
    remote: false,
    handler: (p, ctx) => ctx.controller.browseCwd(env0(p.env ?? "windows"), ctx.windowId),
  },
  {
    name: "cwd.memberLocations",
    http: "GET /api/cwd/members",
    handler: (_p, ctx) => ctx.controller.memberLocations(ctx.workspace),
  },
];
