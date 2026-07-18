import { describe, it, expect } from 'vitest';

// The module uses IIFE with CJS fallback for testability
const ComparisonChart = await import('../../public/js/comparison.js').then(m => m.default || m);

describe('comparison.js', () => {
  describe('constants', () => {
    it('MIN_MONITORS is 2', () => {
      expect(ComparisonChart.MIN_MONITORS).toBe(2);
    });

    it('MAX_MONITORS is 10', () => {
      expect(ComparisonChart.MAX_MONITORS).toBe(10);
    });

    it('DEFAULT_WINDOW is 24h', () => {
      expect(ComparisonChart.DEFAULT_WINDOW).toBe('24h');
    });

    it('supports time windows: 1h, 6h, 24h, 7d', () => {
      const keys = Object.keys(ComparisonChart.TIME_WINDOWS);
      expect(keys).toEqual(['1h', '6h', '24h', '7d']);
    });

    it('has 10 distinct line colors', () => {
      expect(ComparisonChart.LINE_COLORS).toHaveLength(10);
      const unique = new Set(ComparisonChart.LINE_COLORS);
      expect(unique.size).toBe(10);
    });
  });

  describe('_computeYRange', () => {
    it('returns {min:0, max:100} for empty series', () => {
      const result = ComparisonChart._computeYRange([]);
      expect(result.min).toBe(0);
      expect(result.max).toBe(100);
    });

    it('returns {min:0, max:100} for series with no data', () => {
      const result = ComparisonChart._computeYRange([{ data: [] }, { data: [] }]);
      expect(result.min).toBe(0);
      expect(result.max).toBe(100);
    });

    it('computes range across all monitors with 10% padding', () => {
      const series = [
        { data: [{ value: 100 }, { value: 200 }] },
        { data: [{ value: 50 }, { value: 300 }] }
      ];
      const result = ComparisonChart._computeYRange(series);
      // min=50, max=300, range=250
      // padded min = max(0, 50 - 25) = 25
      // padded max = 300 + 25 = 325
      expect(result.min).toBe(25);
      expect(result.max).toBe(325);
    });

    it('handles single data point', () => {
      const series = [{ data: [{ value: 150 }] }];
      const result = ComparisonChart._computeYRange(series);
      // min=150, max=150, range=1 (floor)
      // padded min = max(0, 150 - 0.1) = 149.9
      // padded max = 150 + 0.1 = 150.1
      expect(result.min).toBeCloseTo(149.9, 1);
      expect(result.max).toBeCloseTo(150.1, 1);
    });

    it('does not go below 0 for min', () => {
      const series = [{ data: [{ value: 5 }, { value: 10 }] }];
      const result = ComparisonChart._computeYRange(series);
      // min=5, max=10, range=5, padded min = max(0, 5-0.5) = 4.5
      expect(result.min).toBeGreaterThanOrEqual(0);
    });

    it('skips series with null/undefined data', () => {
      const series = [
        { data: null },
        { data: [{ value: 100 }, { value: 200 }] }
      ];
      const result = ComparisonChart._computeYRange(series);
      expect(result.min).toBeLessThan(100);
      expect(result.max).toBeGreaterThan(200);
    });
  });

  describe('_computeXRange', () => {
    it('returns a range ending at current time', () => {
      const before = Date.now();
      const result = ComparisonChart._computeXRange('24h');
      const after = Date.now();
      expect(result.max).toBeGreaterThanOrEqual(before);
      expect(result.max).toBeLessThanOrEqual(after);
    });

    it('1h window spans 3600000ms', () => {
      const result = ComparisonChart._computeXRange('1h');
      expect(result.max - result.min).toBe(60 * 60 * 1000);
    });

    it('6h window spans 21600000ms', () => {
      const result = ComparisonChart._computeXRange('6h');
      expect(result.max - result.min).toBe(6 * 60 * 60 * 1000);
    });

    it('24h window spans 86400000ms', () => {
      const result = ComparisonChart._computeXRange('24h');
      expect(result.max - result.min).toBe(24 * 60 * 60 * 1000);
    });

    it('7d window spans 604800000ms', () => {
      const result = ComparisonChart._computeXRange('7d');
      expect(result.max - result.min).toBe(7 * 24 * 60 * 60 * 1000);
    });
  });

  describe('init validation', () => {
    it('requires minimum 2 monitors (validates MIN_MONITORS constraint)', () => {
      // We can't test DOM rendering in node, but we verify the constants
      expect(ComparisonChart.MIN_MONITORS).toBe(2);
    });

    it('caps at maximum 10 monitors (validates MAX_MONITORS constraint)', () => {
      expect(ComparisonChart.MAX_MONITORS).toBe(10);
    });
  });
});
