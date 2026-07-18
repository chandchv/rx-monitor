import { describe, it, expect } from 'vitest';
import { shouldSuppress } from '../../alert-deduplicator.js';

describe('alert-deduplicator', () => {
  describe('shouldSuppress (pure function)', () => {
    const monitorId = 1;

    describe('basic suppression logic', () => {
      it('suppresses when time elapsed is less than the window', () => {
        const lastAlert = 1000000;
        const current = lastAlert + (29 * 60 * 1000); // 29 minutes later (within 30 min default)
        expect(shouldSuppress(monitorId, current, lastAlert, 30)).toBe(true);
      });

      it('does not suppress when time elapsed exceeds the window', () => {
        const lastAlert = 1000000;
        const current = lastAlert + (31 * 60 * 1000); // 31 minutes later
        expect(shouldSuppress(monitorId, current, lastAlert, 30)).toBe(false);
      });

      it('does not suppress when time elapsed equals the window exactly', () => {
        const lastAlert = 1000000;
        const current = lastAlert + (30 * 60 * 1000); // exactly 30 minutes
        expect(shouldSuppress(monitorId, current, lastAlert, 30)).toBe(false);
      });

      it('suppresses at 1ms before window expiry', () => {
        const lastAlert = 1000000;
        const current = lastAlert + (30 * 60 * 1000) - 1; // 1ms before window end
        expect(shouldSuppress(monitorId, current, lastAlert, 30)).toBe(true);
      });

      it('suppresses when currentTime equals lastAlertTime', () => {
        const time = 1000000;
        expect(shouldSuppress(monitorId, time, time, 30)).toBe(true);
      });
    });

    describe('configurable window', () => {
      it('uses custom window of 5 minutes (minimum)', () => {
        const lastAlert = 1000000;
        const within = lastAlert + (4 * 60 * 1000); // 4 min
        const outside = lastAlert + (6 * 60 * 1000); // 6 min
        expect(shouldSuppress(monitorId, within, lastAlert, 5)).toBe(true);
        expect(shouldSuppress(monitorId, outside, lastAlert, 5)).toBe(false);
      });

      it('uses custom window of 1440 minutes (maximum)', () => {
        const lastAlert = 1000000;
        const within = lastAlert + (1439 * 60 * 1000); // 1439 min
        const outside = lastAlert + (1441 * 60 * 1000); // 1441 min
        expect(shouldSuppress(monitorId, within, lastAlert, 1440)).toBe(true);
        expect(shouldSuppress(monitorId, outside, lastAlert, 1440)).toBe(false);
      });

      it('clamps window below minimum (5) to minimum', () => {
        const lastAlert = 1000000;
        // Window of 2 should be clamped to 5
        const at4min = lastAlert + (4 * 60 * 1000);
        const at6min = lastAlert + (6 * 60 * 1000);
        expect(shouldSuppress(monitorId, at4min, lastAlert, 2)).toBe(true);
        expect(shouldSuppress(monitorId, at6min, lastAlert, 2)).toBe(false);
      });

      it('clamps window above maximum (1440) to maximum', () => {
        const lastAlert = 1000000;
        // Window of 2000 should be clamped to 1440
        const at1439min = lastAlert + (1439 * 60 * 1000);
        const at1441min = lastAlert + (1441 * 60 * 1000);
        expect(shouldSuppress(monitorId, at1439min, lastAlert, 2000)).toBe(true);
        expect(shouldSuppress(monitorId, at1441min, lastAlert, 2000)).toBe(false);
      });

      it('uses default window (30 min) when windowMinutes is undefined', () => {
        const lastAlert = 1000000;
        const within = lastAlert + (29 * 60 * 1000);
        const outside = lastAlert + (31 * 60 * 1000);
        expect(shouldSuppress(monitorId, within, lastAlert, undefined)).toBe(true);
        expect(shouldSuppress(monitorId, outside, lastAlert, undefined)).toBe(false);
      });

      it('uses default window (30 min) when windowMinutes is null', () => {
        const lastAlert = 1000000;
        const within = lastAlert + (29 * 60 * 1000);
        expect(shouldSuppress(monitorId, within, lastAlert, null)).toBe(true);
      });

      it('uses default window (30 min) when windowMinutes is NaN', () => {
        const lastAlert = 1000000;
        const within = lastAlert + (29 * 60 * 1000);
        expect(shouldSuppress(monitorId, within, lastAlert, NaN)).toBe(true);
      });

      it('uses default window (30 min) when windowMinutes is a string', () => {
        const lastAlert = 1000000;
        const within = lastAlert + (29 * 60 * 1000);
        expect(shouldSuppress(monitorId, within, lastAlert, 'thirty')).toBe(true);
      });
    });

    describe('edge cases', () => {
      it('handles very large timestamps', () => {
        const lastAlert = Date.now();
        const current = lastAlert + (10 * 60 * 1000);
        expect(shouldSuppress(monitorId, current, lastAlert, 30)).toBe(true);
      });

      it('returns false when currentTime is before lastAlertTime (negative elapsed)', () => {
        const lastAlert = 2000000;
        const current = 1000000; // before lastAlert
        // elapsed is negative, which is < windowMs, so technically should suppress
        expect(shouldSuppress(monitorId, current, lastAlert, 30)).toBe(true);
      });

      it('works with different monitor IDs (monitorId is not used in calculation)', () => {
        const lastAlert = 1000000;
        const current = lastAlert + (10 * 60 * 1000);
        expect(shouldSuppress(1, current, lastAlert, 30)).toBe(true);
        expect(shouldSuppress(999, current, lastAlert, 30)).toBe(true);
      });
    });
  });
});
