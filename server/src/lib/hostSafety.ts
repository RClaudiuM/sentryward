import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { env } from "../config/env.ts";
import { HttpError } from "./httpError.ts";

type Range = readonly [network: string, prefix: number];

// What local-only mode trusts as this machine or the private network.
const INTERNAL_V4: Range[] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
];
const INTERNAL_V6: Range[] = [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
];

// Not the private network either, but no forge or webhook is reachable there,
// and some deployments route them internally. Fake-IP DNS proxies, for
// example, answer every outbound name from 198.18.0.0/15.
const RESERVED_V4: Range[] = [
  ["192.0.0.0", 24], // IETF protocol assignments
  ["198.18.0.0", 15], // benchmarking
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, including 255.255.255.255
];
const RESERVED_V6: Range[] = [
  ["::", 96], // IPv4-compatible (deprecated), e.g. ::7f00:1
  ["64:ff9b:1::", 48], // local-use NAT64 in a layout embeddedIpv4 cannot decode
  ["2001::", 32], // Teredo, whose embedded IPv4 is obfuscated
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
];

function blockList(v4: Range[], v6: Range[]): BlockList {
  const list = new BlockList();
  for (const [network, prefix] of v4) list.addSubnet(network, prefix, "ipv4");
  for (const [network, prefix] of v6) list.addSubnet(network, prefix, "ipv6");
  return list;
}

// Two lists because they are read in opposite directions: the SSRF guard
// refuses anything non-public, while local-only mode *allows* anything
// internal. Widening one list for SSRF hardening must not widen what local-only
// mode trusts, so the reserved ranges are only in the SSRF list.
const internal = blockList(INTERNAL_V4, INTERNAL_V6);
const nonPublic = blockList([...INTERNAL_V4, ...RESERVED_V4], [...INTERNAL_V6, ...RESERVED_V6]);

// The eight 16-bit groups of an IPv6 address, or null when it is not one.
function ipv6Groups(address: string): number[] | null {
  if (isIP(address) !== 6) return null;
  let text = address.replace(/%.*$/, "");
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const parse = (part: string | undefined) => (part ? part.split(":").map((group) => parseInt(group, 16)) : []);
  const [head, tail] = text.split("::");
  if (tail === undefined) return parse(head);
  const left = parse(head);
  const right = parse(tail);
  return [...left, ...new Array<number>(8 - left.length - right.length).fill(0), ...right];
}

// The IPv4 address carried by an IPv4-mapped (::ffff:0:0/96), NAT64
// (64:ff9b::/96, or 64:ff9b:1::/48 in its /96 layout) or 6to4 (2002::/16)
// address, or null. Such an address is classified by the IPv4 address it
// carries: refusing the prefixes outright would refuse every IPv4-only host on
// a DNS64 network, and trusting them would make public hosts look internal.
function embeddedIpv4(address: string): string | null {
  const groups = ipv6Groups(address);
  if (!groups) return null;
  const zero = (from: number, to: number) => groups.slice(from, to).every((group) => group === 0);
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  if (zero(0, 5) && groups[5] === 0xffff) return v4(groups[6], groups[7]);
  if (groups[0] === 0x64 && groups[1] === 0xff9b && zero(2, 6)) return v4(groups[6], groups[7]);
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups[2] === 1 && zero(3, 6)) return v4(groups[6], groups[7]);
  if (groups[0] === 0x2002) return v4(groups[1], groups[2]);
  return null;
}

function classify(address: string, list: BlockList): boolean {
  const bare = address.replace(/^\[|\]$/g, "");
  const embedded = embeddedIpv4(bare);
  if (embedded) return list.check(embedded, "ipv4");
  const family = isIP(bare);
  if (family === 0) return false;
  return list.check(bare, family === 6 ? "ipv6" : "ipv4");
}

// Whether the server must refuse to call this address on a user's behalf.
export function isNonPublicAddress(address: string): boolean {
  return classify(address, nonPublic);
}

// Whether the address is this machine or the private network (local-only mode).
export function isPrivateAddress(address: string): boolean {
  return classify(address, internal);
}

export type Resolve = (hostname: string) => Promise<{ address: string }[]>;

const resolveAll: Resolve = (hostname) => lookup(hostname, { all: true });

// Every address the hostname resolves to must be public.
export async function assertPublicHostname(hostname: string, what: string, resolve: Resolve = resolveAll): Promise<void> {
  const bare = hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(bare)
    ? [{ address: bare }]
    : await resolve(bare).catch(() => {
        throw new HttpError(400, `Could not resolve ${bare}`);
      });
  for (const { address } of addresses) {
    if (isNonPublicAddress(address)) {
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
