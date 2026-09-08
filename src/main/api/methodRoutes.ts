import { automationApiSpec } from "../../shared/apiSpec";
import { QA_ENDPOINTS } from "../automation/qaRoutes";
import { MethodRouteTable, type MethodRoute } from "./methodRegistry";
import { appRoutes } from "./routes/appRoutes";
import { approvalRoutes } from "./routes/approvalRoutes";
import { authRoutes } from "./routes/authRoutes";
import { discordRoutes } from "./routes/discordRoutes";
import { guideRoutes } from "./routes/guideRoutes";
import { mobileRoutes } from "./routes/mobileRoutes";
import { modelRoutes } from "./routes/modelRoutes";
import { partyRoutes } from "./routes/partyRoutes";
import { perfRoutes } from "./routes/perfRoutes";
import { workspaceLocationRoutes } from "./routes/workspaceLocationRoutes";
import { sessionRoutes } from "./routes/sessionRoutes";
import { windowRoutes } from "./routes/windowRoutes";

/**
 * The app's capability table — the single list HTTP and mobile RPC both
 * dispatch. Declaration order is HTTP matching order.
 *
 * Adding a capability means adding ONE entry here (or in a routes/ file): the
 * endpoint appears in `GET /api/spec`, and a paired phone can call it by name
 * unless the entry sets `remote: false`.
 */
const routes: MethodRoute[] = [
  {
    // Self-description, so an agent can discover the surface it is driving. The
    // table is read at call time, not at module load, because the spec route is
    // itself one of its entries.
    name: "app.spec",
    http: "GET /api/spec",
    handler: (_p, ctx) => automationApiSpec(ctx.apiBaseUrl, [...methodRoutes.endpoints(), ...QA_ENDPOINTS], methodRoutes.remoteRoutes().map((route) => route.name)),
  },
  ...appRoutes,
  ...approvalRoutes,
  ...authRoutes,
  ...discordRoutes,
  ...guideRoutes,
  ...mobileRoutes,
  ...modelRoutes,
  ...perfRoutes,
  ...sessionRoutes,
  ...partyRoutes,
  ...workspaceLocationRoutes,
  ...windowRoutes,
];

export const methodRoutes = new MethodRouteTable(routes);
