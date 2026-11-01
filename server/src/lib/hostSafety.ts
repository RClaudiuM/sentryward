import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { env } from "../config/env.ts";
import { HttpError } from "./httpError.ts";

const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  // IETF protocol assignments, benchmarking, multicast and reserved ranges.
  // None of them are routable public addresses, but some deployments route
  // them internally, so a hostname resolving there must not pass either.
  ["192.0.0.0", 24],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  // NAT64 and 6to4 translation ranges embed an IPv4 address; on networks that
  // route them, a hostname resolving to one would pass the checks above while
  // still reaching an internal service, so they are refused outright.
  ["64:ff9b::", 96],
  ["2002::", 16],
] as const) {
  blocked.addSubnet(network, prefix, "ipv6");
}

// Every address the hostname resolves to must be public.
async function assertPublicHostname(hostname: string, what: string): Promise<void> {
  const bare = hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(bare)
    ? [{ address: bare, family: isIP(bare) }]
    : await lookup(bare, { all: true }).catch(() => {
        throw new HttpError(400, `Could not resolve ${bare}`);
      });
  for (const { address, family } of addresses) {
    if (blocked.check(address, family === 6 ? "ipv6" : "ipv4")) {
      throw new HttpError(400, `${what} resolves to a private address`);
    }
  }
}

// A self-hosted forge host is user input that the server then calls with
// credentials. In production it must be https and resolve only to public
// addresses, so a connection cannot be pointed at internal services. Local
// development is exempt so a forge on localhost or the LAN still works.
// DNS rebinding after this check is not covered; an egress proxy is the
// complete answer if that matters for a deployment.
export async function assertSafeForgeHost(host: string): Promise<void> {
  if (env.NODE_ENV !== "production") {
    return;
  }
  if (host.startsWith("http://")) {
    throw new HttpError(400, "Forge host must use https");
  }
  await assertPublicHostname(new URL(`https://${host}`).hostname, "Forge host");
}

// The same rules for a URL the server posts to on a workspace's behalf, such
// as a notification webhook.
export async function assertSafeUrl(url: string): Promise<void> {
  if (env.NODE_ENV !== "production") {
    return;
  }
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new HttpError(400, "URL must use https");
  }
  await assertPublicHostname(parsed.hostname, "URL");
}

// IPv4-mapped IPv6 (::ffff:10.0.0.1) is checked as the IPv4 address it wraps,
// so a private address cannot pass as an unlisted IPv6 one. NAT64 (64:ff9b::/96)
// and 6to4 (2002::/16) addresses embed an IPv4 address in the same way; it is
// checked against the IPv4 list too, and the ranges themselves are refused by
// the BlockList entries above.
export function isPrivateAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "");
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(bare);
  if (mapped) return blocked.check(mapped[1], "ipv4");
  const embedded = embeddedIpv4(bare);
  if (embedded && blocked.check(embedded, "ipv4")) return true;
  const family = isIP(bare);
  if (family === 0) return false;
  return blocked.check(bare, family === 6 ? "ipv6" : "ipv4");
}

// The IPv4 address carried in a NAT64 (64:ff9b::/96) or 6to4 (2002::/16)
// address, or null when the address is not in one of those forms.
function embeddedIpv4(address: string): string | null {
  // 6to4: 2002:VVWW:XXYY:: where the second and third 16-bit groups are the
  // first and second halves of the IPv4 address.
  const to4 = /^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4})(?::|$)/i.exec(address);
  if (to4) {
    const [hi, lo] = [parseInt(to4[1], 16), parseInt(to4[2], 16)];
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  // NAT64: the IPv4 fills the low 32 bits, written as two hex groups or a
  // dotted quad.
  const nat64Hex = /^64:ff9b::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (nat64Hex) {
    const [hi, lo] = [parseInt(nat64Hex[1], 16), parseInt(nat64Hex[2], 16)];
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  const nat64Dotted = /^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return nat64Dotted ? nat64Dotted[1] : null;
}

export type Resolve = (hostname: string) => Promise<{ address: string }[]>;

const resolveAll: Resolve = (hostname) => lookup(hostname, { all: true });

// Whether a host is reached on this machine or the private network: the test
// behind local-only mode, applied in every environment. Names are trusted only
// by what they resolve to (Docker service names and host.docker.internal pass
// that way); a lookup failure counts as external. Like the checks above, it
// does not cover DNS rebinding between this check and the request.
export async function isInternalHost(hostname: string, resolve: Resolve = resolveAll): Promise<boolean> {
  const bare = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (bare === "localhost" || bare.endsWith(".localhost")) return true;
  if (isIP(bare)) return isPrivateAddress(bare);
  const addresses = await resolve(bare).catch(() => []);
  return addresses.length > 0 && addresses.every(({ address }) => isPrivateAddress(address));
}
