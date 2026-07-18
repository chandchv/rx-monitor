import { describe, it, expect } from 'vitest';
import {
  computeSLA,
  computeErrorBudget,
  validateSLATarget,
  getPeriodSeconds,
  getSLAReferenceTable,
} from '../../sla-calculator.js';

describe('sla-calculator', () => {
  describe('validateSLATarget', () => {
    it('accepts 90.0 as valid lower bound', () => {
      expect(validateSLATarget(90.0)).toBe(true);
    });

    it('accepts 99.999 as valid upper bound', () => {
      expect(validateSLATarget(99.999)).toBe(true);
    });

    it('accepts values within range', () => {
      expect(validateSLATarget(95.0)).toBe(true);
      expect(validateSLATarget(99.9)).toBe(true);
      expect(validateSLATarget(99.5)).toBe(true);
    });

    it('rejects values below 90.0', () => {
      expect(validateSLATarget(89.999)).toBe(false);
      expect(validateSLATarget(50.0)).toBe(false);
      expect(validateSLATarget(0)).toBe(false);
    });

    it('rejects values above 99.999', () => {
      expect(validateSLATarget(100.0)).toBe(false);
      expect(validateSLATarget(99.9999)).toBe(false);
    });

    it('rejects null, undefined, and non-number types', () => {
      expect(validateSLATarget(null)).toBe(false);
      expect(validateSLATarget(undefined)).toBe(false);
      expect(validateSLATarget('99.9')).toBe(false);
      expect(validateSLATarget(NaN)).toBe(false);
    });

    it('rejects negative values', () => {
      expect(validateSLATarget(-1)).toBe(false);
    });
  });

  describe('computeSLA', () => {
    it('computes 100% uptime when no downtime', () => {
      expect(computeSLA(86400, 0)).toBe(100.0);
    });

    it('computes 0% uptime when all downtime', () => {
      expect(computeSLA(86400, 86400)).toBe(0.0);
    });

    it('computes correct SLA percentage rounded to 3 decimal places', () => {
      // (86400 - 60) / 86400 * 100 = 99.930556...
      expect(computeSLA(86400, 60)).toBe(99.931);
    });

    it('rounds correctly to 3 decimal places', () => {
      // (1000 - 1) / 1000 * 100 = 99.9
      expect(computeSLA(1000, 1)).toBe(99.9);
    });

    it('handles large period with small downtime', () => {
      // Monthly period (30 days = 2592000s), 5 minutes downtime (300s)
      // (2592000 - 300) / 2592000 * 100 = 99.988425...
      expect(computeSLA(2592000, 300)).toBe(99.988);
    });

    it('returns null for zero monitored time (no-data indicator)', () => {
      expect(computeSLA(0, 0)).toBeNull();
    });

    it('returns null for negative monitored time', () => {
      expect(computeSLA(-100, 0)).toBeNull();
    });

    it('returns null for null or undefined monitored time', () => {
      expect(computeSLA(null, 0)).toBeNull();
      expect(computeSLA(undefined, 0)).toBeNull();
    });

    it('treats null/undefined downtime as 0', () => {
      expect(computeSLA(86400, null)).toBe(100.0);
      expect(computeSLA(86400, undefined)).toBe(100.0);
    });

    it('treats negative downtime as 0', () => {
      expect(computeSLA(86400, -100)).toBe(100.0);
    });

    it('clamps downtime exceeding monitored time to monitored time', () => {
      expect(computeSLA(86400, 100000)).toBe(0.0);
    });

    it('produces 3 decimal place precision for typical SLA values', () => {
      // 99.9% SLA scenario: 2592000s period, 2592s downtime
      const result = computeSLA(2592000, 2592);
      expect(result).toBe(99.9);
    });
  });

  describe('computeErrorBudget', () => {
    it('computes correct error budget for 99.9% SLA monthly', () => {
      const periodSeconds = 30 * 24 * 60 * 60; // 2592000
      const budget = computeErrorBudget(99.9, periodSeconds, 0);

      expect(budget).not.toBeNull();
      // Allowed: 2592000 * 0.001 = 2592 seconds
      expect(budget.allowed_downtime_seconds).toBe(2592);
      expect(budget.used_seconds).toBe(0);
      expect(budget.remaining_seconds).toBe(2592);
      expect(budget.remaining_percentage).toBe(100);
      expect(budget.breached).toBe(false);
    });

    it('computes remaining budget after some downtime', () => {
      const periodSeconds = 2592000; // 30 days
      const budget = computeErrorBudget(99.9, periodSeconds, 1000);

      expect(budget.allowed_downtime_seconds).toBe(2592);
      expect(budget.used_seconds).toBe(1000);
      expect(budget.remaining_seconds).toBe(1592);
      expect(budget.breached).toBe(false);
    });

    it('detects breach when downtime exceeds allowed budget', () => {
      const periodSeconds = 2592000;
      const budget = computeErrorBudget(99.9, periodSeconds, 3000);

      expect(budget.breached).toBe(true);
      expect(budget.remaining_seconds).toBe(-408);
      expect(budget.remaining_percentage).toBe(0);
    });

    it('handles exact budget consumption (no breach)', () => {
      const periodSeconds = 2592000;
      const allowedDowntime = 2592000 * (1 - 99.9 / 100); // 2592
      const budget = computeErrorBudget(99.9, periodSeconds, allowedDowntime);

      expect(budget.breached).toBe(false);
      expect(budget.remaining_seconds).toBe(0);
      expect(budget.remaining_percentage).toBe(0);
    });

    it('computes budget for 99.99% SLA yearly', () => {
      const periodSeconds = 365 * 24 * 60 * 60; // 31536000
      const budget = computeErrorBudget(99.99, periodSeconds, 0);

      // Allowed: 31536000 * 0.0001 = 3153.6
      expect(budget.allowed_downtime_seconds).toBe(3153.6);
      expect(budget.remaining_seconds).toBe(3153.6);
      expect(budget.remaining_percentage).toBe(100);
      expect(budget.breached).toBe(false);
    });

    it('returns null for invalid SLA target', () => {
      expect(computeErrorBudget(89.0, 2592000, 0)).toBeNull();
      expect(computeErrorBudget(100.0, 2592000, 0)).toBeNull();
      expect(computeErrorBudget(null, 2592000, 0)).toBeNull();
    });

    it('returns null for invalid period', () => {
      expect(computeErrorBudget(99.9, 0, 0)).toBeNull();
      expect(computeErrorBudget(99.9, -1, 0)).toBeNull();
      expect(computeErrorBudget(99.9, null, 0)).toBeNull();
    });

    it('treats negative downtime as 0', () => {
      const budget = computeErrorBudget(99.9, 2592000, -100);
      expect(budget.used_seconds).toBe(0);
      expect(budget.breached).toBe(false);
    });

    it('computes remaining percentage correctly', () => {
      const periodSeconds = 2592000;
      // Allowed: 2592s, used: 1296s → 50% remaining
      const budget = computeErrorBudget(99.9, periodSeconds, 1296);

      expect(budget.remaining_percentage).toBe(50);
    });
  });

  describe('getPeriodSeconds', () => {
    it('returns correct seconds for monthly period', () => {
      expect(getPeriodSeconds('monthly')).toBe(30 * 24 * 60 * 60);
    });

    it('returns correct seconds for quarterly period', () => {
      expect(getPeriodSeconds('quarterly')).toBe(90 * 24 * 60 * 60);
    });

    it('returns correct seconds for yearly period', () => {
      expect(getPeriodSeconds('yearly')).toBe(365 * 24 * 60 * 60);
    });

    it('returns null for invalid period', () => {
      expect(getPeriodSeconds('weekly')).toBeNull();
      expect(getPeriodSeconds('')).toBeNull();
      expect(getPeriodSeconds(null)).toBeNull();
    });
  });

  describe('getSLAReferenceTable', () => {
    it('returns entries for all standard SLA levels', () => {
      const table = getSLAReferenceTable();
      expect(table).toHaveLength(5);
      expect(table.map((e) => e.sla_level)).toEqual([99, 99.5, 99.9, 99.95, 99.99]);
    });

    it('has correct shape for each entry', () => {
      const table = getSLAReferenceTable();
      for (const entry of table) {
        expect(entry).toHaveProperty('sla_level');
        expect(entry).toHaveProperty('allowed_downtime_yearly_seconds');
        expect(entry).toHaveProperty('allowed_downtime_monthly_seconds');
        expect(entry).toHaveProperty('allowed_downtime_weekly_seconds');
      }
    });

    it('computes correct yearly allowed downtime for 99% SLA', () => {
      const table = getSLAReferenceTable();
      const entry99 = table.find((e) => e.sla_level === 99);
      // 365 * 24 * 60 * 60 * 0.01 = 315360
      expect(entry99.allowed_downtime_yearly_seconds).toBe(315360);
    });

    it('computes correct monthly allowed downtime for 99.9% SLA', () => {
      const table = getSLAReferenceTable();
      const entry999 = table.find((e) => e.sla_level === 99.9);
      // 30 * 24 * 60 * 60 * 0.001 = 2592
      expect(entry999.allowed_downtime_monthly_seconds).toBe(2592);
    });
  });
});
