/**
 * Unit tests for traceroute-runner.js module.
 * Tests canRunTraceroute rate limiting, output parsing, and graceful degradation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { canRunTraceroute, runTraceroute } from '../../traceroute-runner.js';

describe('traceroute-runner', () => {
  describe('canRunTraceroute', () => {
    it('should allow traceroute when lastRunTime is null (never run)', () => {
      expect(canRunTraceroute('monitor-1', null, 5)).toBe(true);
    });

    it('should allow traceroute when lastRunTime is undefined', () => {
      expect(canRunTraceroute('monitor-1', undefined, 5)).toBe(true);
    });

    it('should allow traceroute when cooldown period has elapsed', () => {
      const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
      expect(canRunTraceroute('monitor-1', fiveMinutesAgo, 5)).toBe(true);
    });

    it('should deny traceroute when within cooldown period', () => {
      const twoMinutesAgo = Date.now() - (2 * 60 * 1000);
      expect(canRunTraceroute('monitor-1', twoMinutesAgo, 5)).toBe(false);
    });

    it('should allow traceroute when exactly at cooldown boundary', () => {
      const exactlyFiveMinutesAgo = Date.now() - (5 * 60 * 1000);
      expect(canRunTraceroute('monitor-1', exactlyFiveMinutesAgo, 5)).toBe(true);
    });

    it('should respect custom cooldown minutes', () => {
      const threeMinutesAgo = Date.now() - (3 * 60 * 1000);
      expect(canRunTraceroute('monitor-1', threeMinutesAgo, 10)).toBe(false);
      expect(canRunTraceroute('monitor-1', threeMinutesAgo, 2)).toBe(true);
    });

    it('should default to 5 minutes cooldown when not specified', () => {
      const fourMinutesAgo = Date.now() - (4 * 60 * 1000);
      expect(canRunTraceroute('monitor-1', fourMinutesAgo)).toBe(false);
    });
  });

  describe('runTraceroute', () => {
    it('should return a result with hops array, complete, and target_reached fields', async () => {
      const result = await runTraceroute('127.0.0.1', 5, 10);
      expect(result).toHaveProperty('hops');
      expect(result).toHaveProperty('complete');
      expect(result).toHaveProperty('target_reached');
      expect(Array.isArray(result.hops)).toBe(true);
      expect(typeof result.complete).toBe('boolean');
      expect(typeof result.target_reached).toBe('boolean');
    });

    it('should gracefully degrade for unreachable/invalid hostnames', async () => {
      // This will either execute and return partial results or fail gracefully
      const result = await runTraceroute('thishostdoesnotexist.invalid', 5, 5);
      expect(result).toHaveProperty('hops');
      expect(result).toHaveProperty('complete');
      expect(result).toHaveProperty('target_reached');
    });

    it('should respect maxHops parameter', async () => {
      const result = await runTraceroute('127.0.0.1', 3, 10);
      // The number of hops should not exceed maxHops
      expect(result.hops.length).toBeLessThanOrEqual(3);
    });

    it('should return valid hop structure when hops are present', async () => {
      const result = await runTraceroute('127.0.0.1', 5, 10);
      for (const hop of result.hops) {
        expect(hop).toHaveProperty('seq');
        expect(hop).toHaveProperty('ip');
        expect(hop).toHaveProperty('hostname');
        expect(hop).toHaveProperty('rtt_ms');
        expect(typeof hop.seq).toBe('number');
        expect(typeof hop.ip).toBe('string');
        expect(typeof hop.hostname).toBe('string');
        expect(hop.rtt_ms === null || typeof hop.rtt_ms === 'number').toBe(true);
      }
    });
  });

  describe('runTraceroute - graceful degradation', () => {
    it('should handle the case where traceroute command produces output', async () => {
      // Running against localhost should complete quickly
      const result = await runTraceroute('localhost', 5, 10);
      expect(result).toHaveProperty('hops');
      expect(result).toHaveProperty('complete');
    });
  });
});
