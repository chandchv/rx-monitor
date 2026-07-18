import { describe, it, expect } from 'vitest';
import {
  classifyCertificateSeverity,
  calculateDaysRemaining,
  validateThresholds,
  DEFAULT_THRESHOLDS
} from '../../certificate-monitor.js';

describe('certificate-monitor', () => {
  describe('classifyCertificateSeverity', () => {
    it('returns warning when days remaining is 14 (at boundary)', () => {
      const result = classifyCertificateSeverity(14, DEFAULT_THRESHOLDS);
      expect(result).toBe('warning');
    });

    it('returns warning when days remaining is between 8 and 14', () => {
      const result = classifyCertificateSeverity(10, DEFAULT_THRESHOLDS);
      expect(result).toBe('warning');
    });

    it('returns critical when days remaining is 7 (at boundary)', () => {
      const result = classifyCertificateSeverity(7, DEFAULT_THRESHOLDS);
      expect(result).toBe('critical');
    });

    it('returns critical when days remaining is between 4 and 7', () => {
      const result = classifyCertificateSeverity(5, DEFAULT_THRESHOLDS);
      expect(result).toBe('critical');
    });

    it('returns emergency when days remaining is 3 (at boundary)', () => {
      const result = classifyCertificateSeverity(3, DEFAULT_THRESHOLDS);
      expect(result).toBe('emergency');
    });

    it('returns emergency when days remaining is 0 (expired)', () => {
      const result = classifyCertificateSeverity(0, DEFAULT_THRESHOLDS);
      expect(result).toBe('emergency');
    });

    it('returns emergency when days remaining is negative (already expired)', () => {
      const result = classifyCertificateSeverity(-5, DEFAULT_THRESHOLDS);
      expect(result).toBe('emergency');
    });

    it('returns null when days remaining is above all thresholds', () => {
      const result = classifyCertificateSeverity(15, DEFAULT_THRESHOLDS);
      expect(result).toBe(null);
    });

    it('returns null when days remaining is well above thresholds', () => {
      const result = classifyCertificateSeverity(100, DEFAULT_THRESHOLDS);
      expect(result).toBe(null);
    });

    it('handles custom thresholds correctly', () => {
      const customThresholds = [
        { days: 30, severity: 'warning' },
        { days: 15, severity: 'critical' },
        { days: 5, severity: 'emergency' }
      ];
      expect(classifyCertificateSeverity(25, customThresholds)).toBe('warning');
      expect(classifyCertificateSeverity(10, customThresholds)).toBe('critical');
      expect(classifyCertificateSeverity(3, customThresholds)).toBe('emergency');
      expect(classifyCertificateSeverity(31, customThresholds)).toBe(null);
    });

    it('returns null for empty thresholds array', () => {
      const result = classifyCertificateSeverity(5, []);
      expect(result).toBe(null);
    });

    it('returns null for non-array thresholds', () => {
      const result = classifyCertificateSeverity(5, null);
      expect(result).toBe(null);
    });

    it('sorts thresholds internally regardless of input order', () => {
      const unsorted = [
        { days: 3, severity: 'emergency' },
        { days: 14, severity: 'warning' },
        { days: 7, severity: 'critical' }
      ];
      // 20 days is above all thresholds
      expect(classifyCertificateSeverity(20, unsorted)).toBe(null);
      // 10 days is <= 14 but > 7, matches warning
      expect(classifyCertificateSeverity(10, unsorted)).toBe('warning');
      // 5 days is <= 7 but > 3, matches critical
      expect(classifyCertificateSeverity(5, unsorted)).toBe('critical');
      // 2 days is <= 3, matches emergency
      expect(classifyCertificateSeverity(2, unsorted)).toBe('emergency');
    });

    it('handles single threshold', () => {
      const single = [{ days: 10, severity: 'critical' }];
      expect(classifyCertificateSeverity(10, single)).toBe('critical');
      expect(classifyCertificateSeverity(11, single)).toBe(null);
      expect(classifyCertificateSeverity(5, single)).toBe('critical');
    });
  });

  describe('calculateDaysRemaining', () => {
    it('returns positive days for future expiry', () => {
      const expiry = '2025-01-15T00:00:00Z';
      const current = '2025-01-10T00:00:00Z';
      expect(calculateDaysRemaining(expiry, current)).toBe(5);
    });

    it('returns 0 when dates are the same', () => {
      const date = '2025-01-10T00:00:00Z';
      expect(calculateDaysRemaining(date, date)).toBe(0);
    });

    it('returns negative days for expired certificate', () => {
      const expiry = '2025-01-05T00:00:00Z';
      const current = '2025-01-10T00:00:00Z';
      expect(calculateDaysRemaining(expiry, current)).toBe(-5);
    });

    it('floors partial days (uses whole calendar days)', () => {
      const expiry = '2025-01-10T12:00:00Z';
      const current = '2025-01-08T18:00:00Z';
      // Difference is 1.75 days, should floor to 1
      expect(calculateDaysRemaining(expiry, current)).toBe(1);
    });

    it('handles exactly 14 days', () => {
      const expiry = '2025-02-01T00:00:00Z';
      const current = '2025-01-18T00:00:00Z';
      expect(calculateDaysRemaining(expiry, current)).toBe(14);
    });

    it('handles Date objects', () => {
      const expiry = new Date('2025-03-10T00:00:00Z');
      const current = new Date('2025-03-03T00:00:00Z');
      expect(calculateDaysRemaining(expiry, current)).toBe(7);
    });

    it('handles large differences', () => {
      const expiry = '2026-01-01T00:00:00Z';
      const current = '2025-01-01T00:00:00Z';
      expect(calculateDaysRemaining(expiry, current)).toBe(365);
    });

    it('floors correctly for times just under a full day', () => {
      const expiry = '2025-01-11T00:00:00Z';
      const current = '2025-01-10T00:01:00Z';
      // 23 hours 59 minutes = 0.999... days, floors to 0
      expect(calculateDaysRemaining(expiry, current)).toBe(0);
    });
  });

  describe('validateThresholds', () => {
    it('accepts valid thresholds within range', () => {
      const thresholds = [
        { days: 14, severity: 'warning' },
        { days: 7, severity: 'critical' },
        { days: 3, severity: 'emergency' }
      ];
      const result = validateThresholds(thresholds);
      expect(result).toEqual({ valid: true, errors: [] });
    });

    it('accepts a single threshold', () => {
      const result = validateThresholds([{ days: 30, severity: 'warning' }]);
      expect(result).toEqual({ valid: true, errors: [] });
    });

    it('accepts 10 thresholds (maximum)', () => {
      const thresholds = Array.from({ length: 10 }, (_, i) => ({
        days: (i + 1) * 30,
        severity: 'warning'
      }));
      const result = validateThresholds(thresholds);
      expect(result).toEqual({ valid: true, errors: [] });
    });

    it('rejects empty array', () => {
      const result = validateThresholds([]);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('At least 1 threshold is required');
    });

    it('rejects more than 10 thresholds', () => {
      const thresholds = Array.from({ length: 11 }, (_, i) => ({
        days: (i + 1) * 10,
        severity: 'warning'
      }));
      const result = validateThresholds(thresholds);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('Maximum of 10');
    });

    it('rejects non-array input', () => {
      const result = validateThresholds('not an array');
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Thresholds must be an array');
    });

    it('rejects days below 1', () => {
      const result = validateThresholds([{ days: 0, severity: 'warning' }]);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('days must be an integer between 1 and 365');
    });

    it('rejects days above 365', () => {
      const result = validateThresholds([{ days: 366, severity: 'warning' }]);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('days must be an integer between 1 and 365');
    });

    it('rejects non-integer days', () => {
      const result = validateThresholds([{ days: 7.5, severity: 'warning' }]);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('days must be an integer between 1 and 365');
    });

    it('rejects invalid severity', () => {
      const result = validateThresholds([{ days: 7, severity: 'high' }]);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('severity must be one of');
    });

    it('rejects non-object threshold entries', () => {
      const result = validateThresholds([null, 42]);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBe(2);
    });

    it('collects multiple errors from multiple thresholds', () => {
      const thresholds = [
        { days: 0, severity: 'warning' },
        { days: 10, severity: 'invalid' },
        { days: 400, severity: 'critical' }
      ];
      const result = validateThresholds(thresholds);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBe(3);
    });

    it('accepts boundary values: days=1 and days=365', () => {
      const thresholds = [
        { days: 1, severity: 'emergency' },
        { days: 365, severity: 'warning' }
      ];
      const result = validateThresholds(thresholds);
      expect(result).toEqual({ valid: true, errors: [] });
    });

    it('accepts all valid severity levels', () => {
      const thresholds = [
        { days: 30, severity: 'warning' },
        { days: 14, severity: 'critical' },
        { days: 7, severity: 'emergency' }
      ];
      const result = validateThresholds(thresholds);
      expect(result).toEqual({ valid: true, errors: [] });
    });
  });

  describe('DEFAULT_THRESHOLDS', () => {
    it('has exactly 3 default thresholds', () => {
      expect(DEFAULT_THRESHOLDS.length).toBe(3);
    });

    it('has 14-day warning threshold', () => {
      expect(DEFAULT_THRESHOLDS).toContainEqual({ days: 14, severity: 'warning' });
    });

    it('has 7-day critical threshold', () => {
      expect(DEFAULT_THRESHOLDS).toContainEqual({ days: 7, severity: 'critical' });
    });

    it('has 3-day emergency threshold', () => {
      expect(DEFAULT_THRESHOLDS).toContainEqual({ days: 3, severity: 'emergency' });
    });
  });
});
