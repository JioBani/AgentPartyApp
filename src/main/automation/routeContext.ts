import type * as http from "node:http";
import type { AppController } from "../application/appController";

export interface AutomationRouteContext {
  method: string;
  url: URL;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  controller: AppController;
  workspace: string;
  windowId: string | undefined;
  partyId: string | undefined;
}

