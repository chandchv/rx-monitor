import { describe, it, expect } from 'vitest';
import { resolveWithTiming, isIPAddress, computeDnsStats } from '../../dns-resolver.js';

describe('dns-resolver', () => {
  describe('isIPAddress', () => {
    it('should detect IPv4 addresses', () => {
      expect(isIPAddress('192.168.1.1')).toBe(true);
      expect(isIPAddress('10.0.0.1')).toBe(true);
      expect(isIPAddress('255.255.255.255')).toBe(true);
      expect(isIPAddress('127.0.0.1')).toBe(true);
    });

    it('should detect IPv6 addresses', () => {
      expect(isIPAddress('::1')).toBe(true);
      expect(isIPAddress('2001:db8::1')).toBe(true);
      expect(isIPAddress('fe80::1')).toBe(true);
    });

    it('should detect IP addresses in URLs', () => {
      expect(isIPAddress('http://192.168.1.1/path')).toBe(true);
      expect(isIPAddress('https://10.0.0.1:8080/api')).toBe(true);
      expect(isIPAddress('http://[::1]:3000/')).toBe(true);
      expect(isIPAddress('http://[2001:db8::1]/path')).toBe(true);
    });

    it('should return false for hostnames', () => {
      expect(isIPAddress('example.com')).toBe(false);
      expect(isIPAddress('sub.domain.org')).toBe(false);
      expect(isIPAddress('http://example.com')).toBe(false);
      expect(isIPAddress('https://www.google.com/path')).toBe(false);
    });

    it('should handle edge cases', () => {
      expect(isIPAddress('')).toBe(false);
      expect(isIPAddress(null)).toBe(false);
      expect(isIPAddress(undefined)).toBe(false);
    });
  });

  describe('computeDnsStats', () => {
    it('should compute avg, min, max from DNS times', () => {
      const result = computeDnsStats([10, 20, 30, 40, 50]);
      expect(result.avg).toBe(30);
      expect(result.min).toBe(10);
      expect(result.max).toBe(50);
    });

    it('should round the average', () => {
      const result = computeDnsStats([10, 20, 33]);
      expect(result.avg).toBe(21); // 63/3 = 21
    });

    it('should handle a single element', () => {
      const result = computeDnsStats([42]);
      expect(result.avg).toBe(42);
      expect(result.min).toBe(42);
      expect(result.max).toBe(42);
    });

    it('should return zeros for empty array', () => {
      const result = computeDnsStats([]);
      expect(result).toEqual({ avg: 0, min: 0, max: 0 });
    });

    it('should return zeros for non-array input', () => {
      expect(computeDnsStats(null)).toEqual({ avg: 0, min: 0, max: 0 });
      expect(computeDnsStats(undefined)).toEqual({ avg: 0, min: 0, max: 0 });
    });
  });

  describe('resolveWithTiming', () => {
    it('should resolve a valid hostname and return timing', async () => {
      const result = await resolveWithTiming('localhost');
      expect(result).toHaveProperty('ip');
      expect(result).toHaveProperty('timeMs');
      expect(typeof result.ip).toBe('string');
      expect(typeof result.timeMs).toBe('number');
      expect(result.timeMs).toBeGreaterThanOrEqual(0);
    });

    it('should throw with NXDOMAIN type for non-existent domain', async () => {
      try {
        await resolveWithTiming('this-domain-does-not-exist-xyz123.invalid');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.type).toBe('NXDOMAIN');
        expect(typeof err.timeMs).toBe('number');
      }
    });
  });
});
