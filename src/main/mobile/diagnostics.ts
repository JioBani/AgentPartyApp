import * as os from "node:os";
import {
  MOBILE_STUN_SERVERS,
  type DiagnosticReason,
  type NatDiagnosticProbe,
  type NatDiagnostics,
  type NatMappingKind,
  type NatPortMapping,
} from "../../shared/mobileProtocol";
import type { MobileGatewayDeps } from "./index";
import { createProbeSocket, stunProbe, type StunResult } from "./stun";

/**
 * Why a direct connection is (or is not) expected to work (04 §NAT 매핑·진단).
 *
 * The verdict is derived from observations, never guessed: two STUN probes from
 * the SAME local port (a second socket would make every NAT look symmetric),
 * the local interface list, and — when one was attempted — the result of a port
 * mapping. Every probe is recorded with its outcome, so a user reporting "it
 * says symmetric NAT" can be told which measurement said so.
 *
 * `[검토]` The observation → reason-code mapping below is this module's
 * proposal; 04 fixes the code list but not the rules. Sent to develop for
 * confirmation.
 */

export interface DiagnosticsDeps {
  log: MobileGatewayDeps["log"];
  stunServers?: readonly string[];
  /** Result of the most recent mapping attempt, if the mapper ran. */
  portMapping?: () => NatPortMapping | undefined;
  timeoutMs?: number;
  now?: () => number;
}

export class NatDiagnosticsProbe {
  private inFlight: Promise<NatDiagnostics> | undefined;

  constructor(private readonly deps: DiagnosticsDeps) {}

  /**
   * Runs the diagnosis. Concurrent calls share one run: the probes take seconds
   * and a diagnostics screen that is opened twice should not double the load on
   * public STUN servers.
   */
  run(): Promise<NatDiagnostics> {
    this.inFlight ??= this.execute().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async execute(): Promise<NatDiagnostics> {
    const now = this.deps.now ?? Date.now;
    const servers = this.deps.stunServers ?? MOBILE_STUN_SERVERS;
    const probes: NatDiagnosticProbe[] = [];
    const errors: string[] = [];

    // One socket for both probes: mapping behaviour is only meaningful when the
    // requests share a local port.
    const socket = createProbeSocket();
    const results: StunResult[] = [];
    try {
      for (const server of servers) {
        const startedAt = now();
        try {
          const result = await stunProbe({ server, socket, timeoutMs: this.deps.timeoutMs });
          results.push(result);
          probes.push({
            name: `stun:${server}`,
            ok: true,
            detail: `${result.address}:${result.port}`,
            elapsedMs: result.elapsedMs,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          probes.push({ name: `stun:${server}`, ok: false, detail: message, elapsedMs: now() - startedAt });
          errors.push(message);
        }
      }
    } finally {
      socket.close();
    }

    const local = localAddresses();
    probes.push({
      name: "interfaces",
      ok: local.ipv4.length > 0 || local.ipv6.length > 0,
      detail: `ipv4=${local.ipv4.join(",") || "none"} ipv6=${local.ipv6.length}`,
      elapsedMs: 0,
    });

    const portMapping = this.deps.portMapping?.();
    const mappingKind = classifyMapping(results);
    const wan = results[0];
    const wanAddress = wan?.address;
    const wanIsPrivate = wanAddress !== undefined && isPrivateV4(wanAddress);
    const behindNat = wanAddress !== undefined && !local.ipv4.includes(wanAddress);

    const reason = decideReason({
      results,
      mappingKind,
      wanAddress,
      wanIsPrivate,
      behindNat,
      portMapping,
      ipv6Available: local.ipv6.length > 0,
    });

    const diagnostics: NatDiagnostics = {
      reason,
      ranAt: now(),
      wanAddress,
      wanIsPrivate,
      behindNat,
      mappingKind,
      ipv6Available: local.ipv6.length > 0,
      portMapping,
      probes,
      errors,
    };
    this.deps.log("info", "mobile diagnostics completed", { reason, mappingKind, behindNat });
    return diagnostics;
  }
}

/**
 * RFC 5780's mapping test, reduced to what matters here: if the same local port
 * appears as the same reflexive port to two different servers, the NAT reuses
 * one mapping and hole punching works. A different port per destination is the
 * symmetric case, where it does not.
 */
function classifyMapping(results: StunResult[]): NatMappingKind {
  if (results.length === 0) {
    return "blocked";
  }
  if (results.length === 1) {
    // One answer cannot distinguish the cases; saying "endpointIndependent"
    // here would be a guess dressed as a measurement.
    return "unknown";
  }
  const [first, second] = results;
  if (first.address === second.address && first.port === second.port) {
    return "endpointIndependent";
  }
  if (first.address === second.address) {
    return "portDependent";
  }
  return "addressDependent";
}

interface ReasonInput {
  results: StunResult[];
  mappingKind: NatMappingKind;
  wanAddress: string | undefined;
  wanIsPrivate: boolean;
  behindNat: boolean;
  portMapping: NatPortMapping | undefined;
  ipv6Available: boolean;
}

/** Most specific finding wins; each branch names the observation behind it. */
function decideReason(input: ReasonInput): DiagnosticReason {
  if (input.results.length === 0) {
    // UDP to the STUN servers never came back: a firewall, no network, or
    // IPv6-only egress. IPv6 presence separates the last case.
    return input.ipv6Available ? "ipv6_only" : "unknown";
  }
  if (input.wanAddress && isCgnat(input.wanAddress)) {
    return "cgnat_100_64";
  }
  if (input.wanIsPrivate) {
    // The reflexive address is itself private: another NAT sits upstream.
    return "private_wan";
  }
  if (
    input.portMapping?.externalAddress &&
    input.wanAddress &&
    input.portMapping.externalAddress !== input.wanAddress
  ) {
    // The router mapped a port on an address the outside world does not see —
    // the classic double-NAT signature.
    return "double_nat";
  }
  if (input.mappingKind === "portDependent" || input.mappingKind === "addressDependent") {
    return "symmetric_nat";
  }
  if (input.mappingKind === "endpointIndependent") {
    // Hole punching works here whether or not a mapping was obtained.
    return "ok_direct";
  }
  if (input.behindNat && !input.portMapping) {
    return "no_upnp";
  }
  return "unknown";
}

function localAddresses(): { ipv4: string[]; ipv6: string[] } {
  const ipv4: string[] = [];
  const ipv6: string[] = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal) {
        continue;
      }
      // Node reports "IPv4" on current releases and 4 on older ones; the
      // declared type only covers the string form.
      if (String(entry.family) === "IPv4" || String(entry.family) === "4") {
        ipv4.push(entry.address);
      } else if (!entry.address.startsWith("fe80")) {
        // Link-local v6 is present on almost every machine and says nothing
        // about whether IPv6 egress works.
        ipv6.push(entry.address);
      }
    }
  }
  return { ipv4, ipv6 };
}

/** RFC 6598 carrier-grade NAT: 100.64.0.0/10. */
export function isCgnat(address: string): boolean {
  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

/** RFC 1918 plus link-local and loopback. */
export function isPrivateV4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return false;
  }
  const [a, b] = parts;
  if (a === 10 || a === 127) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  return a === 169 && b === 254;
}
