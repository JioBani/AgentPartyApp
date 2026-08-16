import type { NatPortMapping } from "../../shared/mobileProtocol";
import type { MobileGatewayDeps } from "./index";
import {
  discoverRouter,
  natPmpProtocol,
  pcpProtocol,
  upnpProtocol,
  type MappingProtocol,
  type RouterEndpoint,
} from "./portMapping";

/**
 * Keeps one UDP port mapped on the router while a phone is paired
 * (04 §NAT 매핑·진단).
 *
 * A mapping is never required: with endpoint-independent NAT, hole punching
 * already connects. It widens the set of networks that work, so every failure
 * is recorded and surfaced, and none of them stops the gateway.
 *
 * 02 §T6 — the mapping is only opened when at least one phone is paired, and it
 * is released when the last one is revoked. An always-open port on a machine
 * with nothing to connect to it is attack surface for no benefit.
 */

/** 04 — lease renewal happens at half the granted lifetime. */
const DEFAULT_LIFETIME_SECONDS = 3_600;
const RENEW_FRACTION = 0.5;

export interface NatMapperDeps {
  log: MobileGatewayDeps["log"];
  /** Stable across restarts so the router is not littered with mappings. */
  port: number;
  description?: string;
  /** Ordered by preference; the first that answers wins. */
  protocols?: MappingProtocol[];
  discover?: (options: { timeoutMs?: number }) => Promise<RouterEndpoint | undefined>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
  /** Reports every attempt so diagnostics can explain a missing mapping. */
  onAttempt?: (attempt: { via: string; ok: boolean; detail: string }) => void;
}

export class NatMapper {
  private mapping: NatPortMapping | undefined;
  private router: RouterEndpoint | undefined;
  private protocol: MappingProtocol | undefined;
  private renewTimer: NodeJS.Timeout | undefined;
  private running = false;
  private readonly attempts: { via: string; ok: boolean; detail: string }[] = [];

  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => NodeJS.Timeout;
  private readonly clearTimer: (timer: NodeJS.Timeout) => void;

  constructor(private readonly deps: NatMapperDeps) {
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer));
  }

  /** Current mapping, or `undefined` when none is held. Feeds diagnostics. */
  current(): NatPortMapping | undefined {
    return this.mapping;
  }

  /** What was tried and what happened — the answer to "why no mapping?". */
  history(): readonly { via: string; ok: boolean; detail: string }[] {
    return this.attempts;
  }

  /**
   * Discovers a router and asks for a mapping, then renews it.
   *
   * Never throws: a router that refuses, or is not there at all, is a normal
   * outcome recorded in {@link history}. Concurrent starts are collapsed.
   */
  async start(): Promise<NatPortMapping | undefined> {
    if (this.running) {
      return this.mapping;
    }
    this.running = true;
    this.attempts.length = 0;

    const discover = this.deps.discover ?? discoverRouter;
    try {
      this.router = await discover({ timeoutMs: 2_500 });
    } catch (error) {
      this.record("discovery", false, String(error));
      return undefined;
    }
    if (!this.router) {
      this.record("discovery", false, "SSDP로 응답한 라우터가 없습니다 (UPnP가 꺼져 있을 수 있습니다).");
      return undefined;
    }
    this.record("discovery", true, `router=${this.router.address} local=${this.router.localAddress}`);
    return this.acquire();
  }

  /** Releases the mapping and stops renewing. Safe to call when not mapped. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.renewTimer) {
      this.clearTimer(this.renewTimer);
      this.renewTimer = undefined;
    }
    const mapping = this.mapping;
    const router = this.router;
    const protocol = this.protocol;
    this.mapping = undefined;
    if (!mapping || !router || !protocol) {
      return;
    }
    try {
      await protocol.unmap(mapping.externalPort, mapping.internalPort, router);
      this.deps.log("info", "mobile nat mapping released", { via: protocol.via, port: mapping.externalPort });
    } catch (error) {
      // The lease expires on its own; a router that will not delete on request
      // is worth knowing about but not worth failing shutdown over.
      this.deps.log("warn", "mobile nat mapping could not be released", { error: String(error) });
    }
  }

  // -- internals ------------------------------------------------------------

  private async acquire(): Promise<NatPortMapping | undefined> {
    const router = this.router;
    if (!router) {
      return undefined;
    }
    const protocols = this.deps.protocols ?? [pcpProtocol, natPmpProtocol, upnpProtocol];
    const request = {
      internalPort: this.deps.port,
      lifetimeSeconds: DEFAULT_LIFETIME_SECONDS,
      description: this.deps.description ?? "AgentParty mobile link",
    };

    for (const protocol of protocols) {
      try {
        const result = await protocol.map(request, router);
        if (!this.running) {
          // stop() ran while this request was in flight. Committing now would
          // leave a port open on the router that nothing is tracking or
          // renewing — the exact hazard 02 §T6 exists to avoid.
          await protocol.unmap(result.externalPort, request.internalPort, router).catch(() => undefined);
          this.deps.log("info", "mobile nat mapping discarded: mapper stopped mid-request", { via: result.via });
          return undefined;
        }
        this.protocol = protocol;
        this.mapping = {
          protocol: "udp",
          internalPort: request.internalPort,
          externalPort: result.externalPort,
          externalAddress: result.externalAddress,
          via: result.via,
          expiresAt: this.now() + result.lifetimeSeconds * 1_000,
        };
        this.record(protocol.via, true, `external=${result.externalPort} lifetime=${result.lifetimeSeconds}s`);
        this.scheduleRenewal(result.lifetimeSeconds);
        this.deps.log("info", "mobile nat mapping acquired", {
          via: result.via,
          externalPort: result.externalPort,
          externalAddress: result.externalAddress,
        });
        return this.mapping;
      } catch (error) {
        // Each protocol is tried in turn; a refusal from one says nothing about
        // the next, so the loop continues and every reason is kept.
        this.record(protocol.via, false, error instanceof Error ? error.message : String(error));
      }
    }
    this.deps.log("warn", "mobile nat mapping unavailable", { attempts: this.attempts.length });
    return undefined;
  }

  /**
   * 04 — renew at half the granted lifetime, so one missed renewal still leaves
   * time before the mapping lapses.
   */
  private scheduleRenewal(lifetimeSeconds: number): void {
    if (this.renewTimer) {
      this.clearTimer(this.renewTimer);
    }
    const delay = Math.max(30_000, lifetimeSeconds * RENEW_FRACTION * 1_000);
    this.renewTimer = this.setTimer(() => {
      if (!this.running) {
        return;
      }
      void this.acquire();
    }, delay);
  }

  private record(via: string, ok: boolean, detail: string): void {
    this.attempts.push({ via, ok, detail });
    this.deps.onAttempt?.({ via, ok, detail });
  }
}
