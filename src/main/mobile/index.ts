import { createMockMobileGateway } from "./mockMobileGateway";
import type { MockMobileGateway } from "./mockMobileGateway";
import type { CreateMobileGatewayOptions, MobileGateway } from "./mobileGateway";
import { RealMobileGateway } from "./realMobileGateway";

/**
 * The pipe's construction point.
 *
 * Only this file and the implementations under it need `@agentparty/protocol`.
 * The contracts the host app types against live in `./mobileGateway`, and the
 * app reaches this module through `src/main/mobilePipe.ts` at RUNTIME — so a
 * build without the protocol package still compiles and runs, with the mobile
 * link reported as unavailable (`docs/mobile-gateway-wiring.md` §패키지가 없을 때).
 */

export type { MobileGateway } from "./mobileGateway";
export type {
  CreateMobileGatewayOptions,
  MobileConnectionLockApi,
  MobileEventScope,
  MobileGatewayDeps,
  MobileGatewayStartOptions,
  MobilePairingApi,
  MobilePushApi,
  MobileRequestHandler,
  MobileSnapshotProvider,
  MockControls,
  MockMobileGatewayOptions,
  PairingSession,
  PushPayload,
  RequestContext,
  SecretCipher,
  SnapshotContext,
} from "./mobileGateway";
export { createMockMobileGateway } from "./mockMobileGateway";
/**
 * Lets an app handler answer with its own protocol error code instead of the
 * generic `handler_failed`. A plain Error carries no code, so anything the
 * phone needs to branch on must be thrown as this.
 */
export { RpcError } from "./rpcServer";
export { RealMobileGateway } from "./realMobileGateway";
export type { MockMobileGateway, MockPhoneControls } from "./mockMobileGateway";

/**
 * Single construction point for the mobile pipe.
 *
 * @throws when `implementation: "real"` is requested without its dependencies.
 *   There is no fallback to the mock: a UI that looked connected while the pipe
 *   was absent would be worse than a startup failure.
 */
export function createMobileGateway(options: CreateMobileGatewayOptions): MobileGateway | MockMobileGateway {
  if (options.implementation === "mock") {
    return createMockMobileGateway(options.mock);
  }
  if (!options.deps) {
    throw new Error("createMobileGateway: the real gateway requires MobileGatewayDeps");
  }
  return new RealMobileGateway(options.deps);
}
