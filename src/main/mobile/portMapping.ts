import * as dgram from "node:dgram";
import * as http from "node:http";
import { URL } from "node:url";

/**
 * Port-mapping protocols (04 §NAT 매핑·진단): UPnP IGD, NAT-PMP and PCP.
 *
 * Implemented directly rather than through a package for the same reason as the
 * STUN client: each is a small, stable wire format, and the alternative is
 * another dependency to keep working on three platforms. It also keeps the
 * pipe free of OS commands — Node exposes no default-gateway API, and 06 bans
 * shelling out to find one, so the router's address comes from SSDP discovery
 * and is then reused for the UDP protocols.
 *
 * None of these is required for a connection: with endpoint-independent NAT,
 * hole punching already works. A mapping only widens the set of networks that
 * connect, so every failure here is reported, never fatal.
 */

export interface MappingRequest {
  /** Local UDP port to expose. */
  internalPort: number;
  /** Requested lifetime; the router may grant less. */
  lifetimeSeconds: number;
  /** Shown in the router's UI where the protocol supports it. */
  description: string;
}

export interface MappingResult {
  externalPort: number;
  /** The router's WAN address, when the protocol reports one. */
  externalAddress: string | undefined;
  /** Lifetime the router actually granted. */
  lifetimeSeconds: number;
  via: "upnp" | "nat-pmp" | "pcp";
}

/** One way of asking a router for a mapping. */
export interface MappingProtocol {
  readonly via: MappingResult["via"];
  map(request: MappingRequest, router: RouterEndpoint): Promise<MappingResult>;
  unmap(externalPort: number, internalPort: number, router: RouterEndpoint): Promise<void>;
}

/** Where the router lives, as discovered by SSDP. */
export interface RouterEndpoint {
  /** Router's LAN address. */
  address: string;
  /** UPnP control URL; absent when only the address is known. */
  controlUrl?: string;
  /** UPnP service type that matched. */
  serviceType?: string;
  /** This machine's address on that network, needed by every protocol. */
  localAddress: string;
}

// ---------------------------------------------------------------------------
// SSDP discovery
// ---------------------------------------------------------------------------

const SSDP_ADDRESS = "239.255.255.250";
const SSDP_PORT = 1900;
/** Both IGD versions; v1 is still what most consumer routers announce. */
const IGD_TARGETS = [
  "urn:schemas-upnp-org:device:InternetGatewayDevice:1",
  "urn:schemas-upnp-org:device:InternetGatewayDevice:2",
];
const WAN_SERVICES = [
  "urn:schemas-upnp-org:service:WANIPConnection:1",
  "urn:schemas-upnp-org:service:WANIPConnection:2",
  "urn:schemas-upnp-org:service:WANPPPConnection:1",
];

/**
 * Finds an Internet Gateway Device by multicast.
 *
 * SSDP is used even when only NAT-PMP will be spoken, because it is the one
 * portable way to learn the router's address from pure Node.
 *
 * @returns the endpoint, or `undefined` when nothing answered in time. Silence
 *   is a normal outcome (many routers have UPnP disabled) and is reported by
 *   the caller as a diagnostic, not thrown.
 */
export async function discoverRouter(options: { timeoutMs?: number } = {}): Promise<RouterEndpoint | undefined> {
  const timeoutMs = options.timeoutMs ?? 2_500;
  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });

  const location = await new Promise<{ location: string; from: string; local: string } | undefined>((resolve) => {
    let settled = false;
    const finish = (value: { location: string; from: string; local: string } | undefined) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // Already closing.
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);

    socket.on("error", () => finish(undefined));
    socket.on("message", (message, remote) => {
      const text = message.toString("utf8");
      if (!/^HTTP\/1\.1 200/i.test(text)) {
        return;
      }
      const match = text.match(/^LOCATION:\s*(\S+)/im);
      if (match) {
        finish({ location: match[1], from: remote.address, local: socket.address().address });
      }
    });

    socket.bind(() => {
      for (const target of IGD_TARGETS) {
        const search = [
          "M-SEARCH * HTTP/1.1",
          `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
          'MAN: "ssdp:discover"',
          "MX: 2",
          `ST: ${target}`,
          "",
          "",
        ].join("\r\n");
        socket.send(Buffer.from(search), SSDP_PORT, SSDP_ADDRESS);
      }
    });
  });

  if (!location) {
    return undefined;
  }

  const described = await describeDevice(location.location, timeoutMs);
  return {
    address: location.from,
    controlUrl: described?.controlUrl,
    serviceType: described?.serviceType,
    localAddress: localAddressToward(location.from) ?? location.local,
  };
}

/** Fetches the device description and locates the WAN connection service. */
async function describeDevice(
  location: string,
  timeoutMs: number,
): Promise<{ controlUrl: string; serviceType: string } | undefined> {
  let xml: string;
  try {
    xml = await httpGet(location, timeoutMs);
  } catch {
    return undefined;
  }
  for (const serviceType of WAN_SERVICES) {
    // The description is small and its shape is fixed; a full XML parser would
    // be a dependency for one lookup.
    const index = xml.indexOf(serviceType);
    if (index < 0) {
      continue;
    }
    const tail = xml.slice(index);
    const match = tail.match(/<controlURL>\s*([^<]+?)\s*<\/controlURL>/i);
    if (match) {
      return { controlUrl: new URL(match[1], location).toString(), serviceType };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// UPnP IGD
// ---------------------------------------------------------------------------

export const upnpProtocol: MappingProtocol = {
  via: "upnp",

  async map(request, router) {
    if (!router.controlUrl || !router.serviceType) {
      throw new Error("UPnP: the router announced no WAN connection service");
    }
    await soap(router.controlUrl, router.serviceType, "AddPortMapping", {
      NewRemoteHost: "",
      NewExternalPort: String(request.internalPort),
      NewProtocol: "UDP",
      NewInternalPort: String(request.internalPort),
      NewInternalClient: router.localAddress,
      NewEnabled: "1",
      NewPortMappingDescription: request.description,
      NewLeaseDuration: String(request.lifetimeSeconds),
    });

    let externalAddress: string | undefined;
    try {
      const response = await soap(router.controlUrl, router.serviceType, "GetExternalIPAddress", {});
      externalAddress = response.match(/<NewExternalIPAddress>\s*([^<]*?)\s*<\/NewExternalIPAddress>/i)?.[1];
    } catch {
      // The mapping stands even if the address query fails; diagnostics simply
      // cannot compare it against the STUN reflexive address.
    }

    return {
      externalPort: request.internalPort,
      externalAddress: externalAddress || undefined,
      lifetimeSeconds: request.lifetimeSeconds,
      via: "upnp",
    };
  },

  async unmap(externalPort, _internalPort, router) {
    if (!router.controlUrl || !router.serviceType) {
      return;
    }
    await soap(router.controlUrl, router.serviceType, "DeletePortMapping", {
      NewRemoteHost: "",
      NewExternalPort: String(externalPort),
      NewProtocol: "UDP",
    });
  },
};

async function soap(
  controlUrl: string,
  serviceType: string,
  action: string,
  args: Record<string, string>,
): Promise<string> {
  const body =
    '<?xml version="1.0"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<s:Body><u:${action} xmlns:u="${serviceType}">` +
    Object.entries(args)
      .map(([key, value]) => `<${key}>${escapeXml(value)}</${key}>`)
      .join("") +
    `</u:${action}></s:Body></s:Envelope>`;

  const response = await httpRequest(controlUrl, {
    method: "POST",
    headers: {
      "Content-Type": 'text/xml; charset="utf-8"',
      SOAPAction: `"${serviceType}#${action}"`,
      "Content-Length": String(Buffer.byteLength(body)),
    },
    body,
    timeoutMs: 5_000,
  });

  if (response.status >= 400) {
    // The router's own error code is far more useful than "request failed".
    const code = response.text.match(/<errorCode>\s*(\d+)\s*<\/errorCode>/i)?.[1];
    const description = response.text.match(/<errorDescription>\s*([^<]*?)\s*<\/errorDescription>/i)?.[1];
    throw new Error(`UPnP ${action}: ${code ? `error ${code}` : `HTTP ${response.status}`}${description ? ` (${description})` : ""}`);
  }
  return response.text;
}

// ---------------------------------------------------------------------------
// NAT-PMP (RFC 6886) and PCP (RFC 6887), both on UDP 5351
// ---------------------------------------------------------------------------

const NAT_PMP_PORT = 5351;

export const natPmpProtocol: MappingProtocol = {
  via: "nat-pmp",

  async map(request, router) {
    // opcode 1 = map UDP. Request: version(0) op port(2) reserved(2)
    // internal(2) suggested-external(2) lifetime(4).
    const message = Buffer.alloc(12);
    message.writeUInt8(0, 0);
    message.writeUInt8(1, 1);
    message.writeUInt16BE(0, 2);
    message.writeUInt16BE(request.internalPort, 4);
    message.writeUInt16BE(request.internalPort, 6);
    message.writeUInt32BE(request.lifetimeSeconds, 8);

    const response = await udpExchange(router.address, NAT_PMP_PORT, message, 2_000);
    if (response.length < 16) {
      throw new Error("NAT-PMP: truncated answer");
    }
    const resultCode = response.readUInt16BE(2);
    if (resultCode !== 0) {
      throw new Error(`NAT-PMP: router refused with result code ${resultCode}`);
    }
    return {
      externalPort: response.readUInt16BE(10),
      // NAT-PMP's map response carries no address; a separate opcode-0 query
      // would be needed, and diagnostics treats "unknown" correctly already.
      externalAddress: undefined,
      lifetimeSeconds: response.readUInt32BE(12),
      via: "nat-pmp",
    };
  },

  async unmap(_externalPort, internalPort, router) {
    // A zero lifetime deletes the mapping.
    const message = Buffer.alloc(12);
    message.writeUInt8(0, 0);
    message.writeUInt8(1, 1);
    message.writeUInt16BE(internalPort, 4);
    await udpExchange(router.address, NAT_PMP_PORT, message, 2_000).catch(() => undefined);
  },
};

export const pcpProtocol: MappingProtocol = {
  via: "pcp",

  async map(request, router) {
    // PCP MAP: version(2) op(1|0x00) reserved lifetime client-address(16)
    // then nonce(12) protocol(1) reserved(3) internal(2) suggested(2)
    // suggested-address(16).
    const message = Buffer.alloc(60);
    message.writeUInt8(2, 0);
    message.writeUInt8(1, 1);
    message.writeUInt32BE(request.lifetimeSeconds, 4);
    writeV4MappedV6(message, 8, router.localAddress);
    // A fixed nonce is fine: it only has to be stable for renewals of this
    // mapping from this process.
    message.write("agentparty!!", 24, 12, "ascii");
    message.writeUInt8(17, 36); // UDP
    message.writeUInt16BE(request.internalPort, 40);
    message.writeUInt16BE(request.internalPort, 42);

    const response = await udpExchange(router.address, NAT_PMP_PORT, message, 2_000);
    if (response.length < 60) {
      throw new Error("PCP: truncated answer");
    }
    const resultCode = response.readUInt8(3);
    if (resultCode !== 0) {
      throw new Error(`PCP: router refused with result code ${resultCode}`);
    }
    return {
      externalPort: response.readUInt16BE(42),
      externalAddress: readV4MappedV6(response, 44),
      lifetimeSeconds: response.readUInt32BE(4),
      via: "pcp",
    };
  },

  async unmap(_externalPort, internalPort, router) {
    const message = Buffer.alloc(60);
    message.writeUInt8(2, 0);
    message.writeUInt8(1, 1);
    message.writeUInt32BE(0, 4);
    writeV4MappedV6(message, 8, router.localAddress);
    message.write("agentparty!!", 24, 12, "ascii");
    message.writeUInt8(17, 36);
    message.writeUInt16BE(internalPort, 40);
    await udpExchange(router.address, NAT_PMP_PORT, message, 2_000).catch(() => undefined);
  },
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function udpExchange(host: string, port: number, message: Buffer, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    let settled = false;
    const finish = (error: Error | undefined, value?: Buffer) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // Already closing.
      }
      if (error) {
        reject(error);
      } else if (value) {
        resolve(value);
      }
    };
    const timer = setTimeout(() => finish(new Error(`${host}:${port} did not answer within ${timeoutMs}ms`)), timeoutMs);
    socket.on("error", (error) => finish(error));
    socket.on("message", (data) => finish(undefined, data));
    socket.send(message, port, host, (error) => {
      if (error) {
        finish(error);
      }
    });
  });
}

function httpGet(url: string, timeoutMs: number): Promise<string> {
  return httpRequest(url, { method: "GET", timeoutMs }).then((response) => response.text);
}

function httpRequest(
  url: string,
  options: { method: string; headers?: Record<string, string>; body?: string; timeoutMs: number },
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = http.request(
      {
        hostname: target.hostname,
        port: target.port || 80,
        path: `${target.pathname}${target.search}`,
        method: options.method,
        headers: options.headers,
        timeout: options.timeoutMs,
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, text }));
      },
    );
    request.on("timeout", () => request.destroy(new Error(`${url} timed out`)));
    request.on("error", reject);
    if (options.body) {
      request.write(options.body);
    }
    request.end();
  });
}

/** Picks the local address on the same /24 as the router, when there is one. */
function localAddressToward(routerAddress: string): string | undefined {
  const prefix = routerAddress.split(".").slice(0, 3).join(".");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const interfaces = (require("node:os") as typeof import("node:os")).networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (!entry.internal && String(entry.family) === "IPv4" && entry.address.startsWith(`${prefix}.`)) {
        return entry.address;
      }
    }
  }
  return undefined;
}

function writeV4MappedV6(buffer: Buffer, offset: number, address: string): void {
  buffer.writeUInt16BE(0xffff, offset + 10);
  const octets = address.split(".").map(Number);
  for (let index = 0; index < 4; index += 1) {
    buffer.writeUInt8(Number.isInteger(octets[index]) ? octets[index] : 0, offset + 12 + index);
  }
}

function readV4MappedV6(buffer: Buffer, offset: number): string | undefined {
  if (buffer.readUInt16BE(offset + 10) !== 0xffff) {
    return undefined;
  }
  return [...buffer.subarray(offset + 12, offset + 16)].join(".");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
