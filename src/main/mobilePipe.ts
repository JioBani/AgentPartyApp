import { log } from "./logger";
import type { CreateMobileGatewayOptions, MobileGateway } from "./mobile/mobileGateway";

/**
 * Dormant Mobile Link adapter retained for a future reactivation.
 *
 * This file and `src/main/mobile/` are excluded by `tsconfig.main.json` while
 * the feature is detached. Reactivation must restore the dependency, build,
 * runtime, API, and UI boundaries together; see
 * `docs/MOBILE_LINK_REACTIVATION.md`.
 *
 * Deliberately a runtime `require` rather than an `import`. An import would put
 * the pipe — and through it the protocol package — back into the type graph,
 * which is exactly what a build without the package cannot have.
 *
 * There is no fallback to the mock. A desktop that quietly ran the phone
 * simulator would show a pairing QR that no phone can ever complete.
 */

export interface MobilePipe {
  createMobileGateway(options: CreateMobileGatewayOptions): MobileGateway;
}

export interface MobilePipeUnavailable {
  /** Human-readable reason, surfaced in the log and in the 모바일 연결 tab. */
  reason: string;
}

let cached: MobilePipe | MobilePipeUnavailable | undefined;

/** The pipe, or why it is missing. Resolved once per process. */
export function loadMobilePipe(): MobilePipe | MobilePipeUnavailable {
  if (!cached) cached = resolve();
  return cached;
}

export function isMobilePipe(pipe: MobilePipe | MobilePipeUnavailable): pipe is MobilePipe {
  return typeof (pipe as MobilePipe).createMobileGateway === "function";
}

function resolve(): MobilePipe | MobilePipeUnavailable {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const module = require("./mobile") as Partial<MobilePipe>;
    if (typeof module.createMobileGateway !== "function") {
      return { reason: "모바일 파이프 모듈에 createMobileGateway가 없습니다 (빌드가 손상되었습니다)." };
    }
    return { createMobileGateway: module.createMobileGateway };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log("error", "mobile", "mobile pipe is not available; the mobile link is disabled in this build", { detail });
    return {
      reason: `이 빌드에는 모바일 파이프가 포함되어 있지 않습니다 (@agentparty/protocol 미설치). 원인: ${detail}`,
    };
  }
}
