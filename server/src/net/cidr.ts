/**
 * IPv4 CIDR trust utilities for the POC network-trust model (see the
 * normative specification §2.1): TLS plus IPv4 allowlisting, no shared
 * secrets. Both `id` outbound calls and the /id/events receiver rely on
 * these checks.
 */

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Strips an IPv4-mapped IPv6 prefix (Node sockets report `::ffff:1.2.3.4`). */
export function normalizeIpv4(address: string): string | null {
  const bare = address.startsWith('::ffff:') ? address.slice(7) : address;
  const match = IPV4_RE.exec(bare);
  if (!match) return null;
  for (let i = 1; i <= 4; i += 1) {
    if (Number(match[i]) > 255) return null;
  }
  return bare;
}

function ipv4ToInt(address: string): number | null {
  const bare = normalizeIpv4(address);
  if (!bare) return null;
  const octets = bare.split('.').map(Number) as [number, number, number, number];
  return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
}

export interface Cidr {
  base: number;
  mask: number;
}

export function parseCidr(entry: string): Cidr | null {
  const [ip, prefixRaw] = entry.split('/');
  if (!ip || prefixRaw === undefined) return null;
  const base = ipv4ToInt(ip);
  const prefix = Number(prefixRaw);
  if (base === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return { base: (base & mask) >>> 0, mask };
}

export function parseCidrs(entries: string[]): Cidr[] {
  const parsed: Cidr[] = [];
  for (const entry of entries) {
    const cidr = parseCidr(entry);
    if (cidr) parsed.push(cidr);
  }
  return parsed;
}

export function ipInCidrs(address: string, cidrs: Cidr[]): boolean {
  const ip = ipv4ToInt(address);
  if (ip === null) return false;
  return cidrs.some((cidr) => (ip & cidr.mask) >>> 0 === cidr.base);
}

/**
 * Resolves the client IPv4 for trust decisions. The TCP socket peer is
 * authoritative; a forwarded address is honored only when the direct peer is
 * itself inside the trusted-proxy allowlist, and then only the last (i.e.
 * proxy-appended) X-Forwarded-For entry counts. Arbitrary browser-supplied
 * X-Forwarded-For is never trusted.
 */
export function resolveClientIp(
  socketAddress: string | undefined,
  forwardedFor: string | undefined,
  trustedProxies: Cidr[],
): string | null {
  if (!socketAddress) return null;
  const peer = normalizeIpv4(socketAddress);
  if (!peer) return null;
  if (!forwardedFor || trustedProxies.length === 0 || !ipInCidrs(peer, trustedProxies)) {
    return peer;
  }
  const hops = forwardedFor
    .split(',')
    .map((hop) => hop.trim())
    .filter((hop) => hop.length > 0);
  const lastHop = hops[hops.length - 1];
  if (!lastHop) return peer;
  return normalizeIpv4(lastHop);
}
