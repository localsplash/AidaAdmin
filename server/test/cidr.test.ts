import { describe, expect, it } from 'vitest';
import {
  ipInCidrs,
  normalizeIpv4,
  parseCidr,
  parseCidrs,
  resolveClientIp,
} from '../src/net/cidr.js';

describe('normalizeIpv4', () => {
  it('strips the IPv4-mapped IPv6 prefix', () => {
    expect(normalizeIpv4('::ffff:192.0.2.7')).toBe('192.0.2.7');
  });

  it('rejects non-IPv4 addresses', () => {
    expect(normalizeIpv4('::1')).toBeNull();
    expect(normalizeIpv4('192.0.2.999')).toBeNull();
  });
});

describe('parseCidr / ipInCidrs', () => {
  it('matches members and rejects outsiders', () => {
    const cidrs = parseCidrs(['10.0.0.0/8', '192.0.2.10/32']);
    expect(ipInCidrs('10.200.3.4', cidrs)).toBe(true);
    expect(ipInCidrs('192.0.2.10', cidrs)).toBe(true);
    expect(ipInCidrs('192.0.2.11', cidrs)).toBe(false);
    expect(ipInCidrs('11.0.0.1', cidrs)).toBe(false);
  });

  it('rejects malformed CIDRs', () => {
    expect(parseCidr('not-a-cidr')).toBeNull();
    expect(parseCidr('10.0.0.0/33')).toBeNull();
    expect(parseCidr('10.0.0.0')).toBeNull();
  });
});

describe('resolveClientIp', () => {
  const trusted = parseCidrs(['127.0.0.1/32']);

  it('uses the socket peer when no forwarding applies', () => {
    expect(resolveClientIp('::ffff:203.0.113.5', undefined, trusted)).toBe('203.0.113.5');
  });

  it('honors the proxy-appended forwarded address for a trusted peer', () => {
    expect(resolveClientIp('127.0.0.1', '198.51.100.9, 203.0.113.5', trusted)).toBe('203.0.113.5');
  });

  it('ignores X-Forwarded-For from an untrusted peer', () => {
    expect(resolveClientIp('203.0.113.99', '10.0.0.1', trusted)).toBe('203.0.113.99');
  });
});
