import { describe, it, expect } from 'vitest';
import { computePercentile, computeAllPercentiles, isValidTimeWindow } from '../../percentile-calculator.js';

describe('percentile-calculator', () => {
  describe('isValidTimeWindow', () => {
    it('returns true for valid time windows', () => {
      expect(isValidTimeWindow('1h')).toBe(true);
      expect(isValidTimeWindow('6h')).toBe(true);
      expect(isValidTimeWindow('24h')).toBe(true);
      expect(isValidTimeWindow('7d')).toBe(true);
      expect(isValidTimeWindow('30d')).toBe(true);
    });

    it('returns false for invalid time windows', () => {
      expect(isValidTimeWindow('2h')).toBe(false);
      expect(isValidTimeWindow('12h')).toBe(false);
      expect(isValidTimeWindow('1d')).toBe(false);
      expect(isValidTimeWindow('60d')).toBe(false);
      expect(isValidTimeWindow('')).toBe(false);
      expect(isValidTimeWindow(null)).toBe(false);
      expect(isValidTimeWindow(undefined)).toBe(false);
      expect(isValidTimeWindow(24)).toBe(false);
    });
  });

  describe('computePercentile', () => {
    // Helper to create a sorted array of N elements
    function sortedRange(n) {
      return Array.from({ length: n }, (_, i) => i + 1);
    }

    it('returns null when array has fewer than 20 data points', () => {
      expect(computePercentile([1, 2, 3, 4, 5], 50)).toBe(null);
      expect(computePercentile(sortedRange(19), 50)).toBe(null);
      expect(computePercentile([], 50)).toBe(null);
    });

    it('returns null for non-array input', () => {
      expect(computePercentile(null, 50)).toBe(null);
      expect(computePercentile(undefined, 50)).toBe(null);
      expect(computePercentile('not array', 50)).toBe(null);
    });

    it('returns null for percentile out of range', () => {
      const sorted = sortedRange(20);
      expect(computePercentile(sorted, -1)).toBe(null);
      expect(computePercentile(sorted, 101)).toBe(null);
    });

    it('computes p50 correctly for 20 elements using nearest-rank', () => {
      // N=20, p=50: index = ceil(50/100 * 20) - 1 = ceil(10) - 1 = 9
      const sorted = sortedRange(20);
      expect(computePercentile(sorted, 50)).toBe(10);
    });

    it('computes p95 correctly for 20 elements using nearest-rank', () => {
      // N=20, p=95: index = ceil(95/100 * 20) - 1 = ceil(19) - 1 = 18
      const sorted = sortedRange(20);
      expect(computePercentile(sorted, 95)).toBe(19);
    });

    it('computes p99 correctly for 20 elements using nearest-rank', () => {
      // N=20, p=99: index = ceil(99/100 * 20) - 1 = ceil(19.8) - 1 = 20 - 1 = 19
      const sorted = sortedRange(20);
      expect(computePercentile(sorted, 99)).toBe(20);
    });

    it('computes p50 correctly for 100 elements', () => {
      // N=100, p=50: index = ceil(50/100 * 100) - 1 = 50 - 1 = 49
      const sorted = sortedRange(100);
      expect(computePercentile(sorted, 50)).toBe(50);
    });

    it('computes p95 correctly for 100 elements', () => {
      // N=100, p=95: index = ceil(95/100 * 100) - 1 = 95 - 1 = 94
      const sorted = sortedRange(100);
      expect(computePercentile(sorted, 95)).toBe(95);
    });

    it('computes p99 correctly for 100 elements', () => {
      // N=100, p=99: index = ceil(99/100 * 100) - 1 = 99 - 1 = 98
      const sorted = sortedRange(100);
      expect(computePercentile(sorted, 99)).toBe(99);
    });

    it('handles percentile 0 by returning first element', () => {
      // N=20, p=0: index = ceil(0/100 * 20) - 1 = ceil(0) - 1 = -1, clamped to 0
      const sorted = sortedRange(20);
      expect(computePercentile(sorted, 0)).toBe(1);
    });

    it('handles percentile 100 by returning last element', () => {
      // N=20, p=100: index = ceil(100/100 * 20) - 1 = 20 - 1 = 19
      const sorted = sortedRange(20);
      expect(computePercentile(sorted, 100)).toBe(20);
    });

    it('works with exactly 20 data points', () => {
      const sorted = sortedRange(20);
      expect(computePercentile(sorted, 50)).not.toBe(null);
    });

    it('computes correctly with duplicate values', () => {
      // 20 elements all value 5
      const sorted = Array(20).fill(5);
      expect(computePercentile(sorted, 50)).toBe(5);
      expect(computePercentile(sorted, 95)).toBe(5);
      expect(computePercentile(sorted, 99)).toBe(5);
    });

    it('computes correctly with response time-like values', () => {
      // Realistic response times sorted
      const sorted = [
        10, 12, 15, 18, 20, 22, 25, 28, 30, 35,
        40, 45, 50, 60, 70, 80, 100, 150, 200, 500
      ];
      // N=20, p50: index = ceil(10) - 1 = 9 → sorted[9] = 35
      expect(computePercentile(sorted, 50)).toBe(35);
      // N=20, p95: index = ceil(19) - 1 = 18 → sorted[18] = 200
      expect(computePercentile(sorted, 95)).toBe(200);
      // N=20, p99: index = ceil(19.8) - 1 = 19 → sorted[19] = 500
      expect(computePercentile(sorted, 99)).toBe(500);
    });
  });

  describe('computeAllPercentiles', () => {
    it('returns null for all percentiles when fewer than 20 data points', () => {
      expect(computeAllPercentiles([1, 2, 3])).toEqual({ p50: null, p95: null, p99: null });
      expect(computeAllPercentiles(Array(19).fill(100))).toEqual({ p50: null, p95: null, p99: null });
    });

    it('returns null for all percentiles when input is not an array', () => {
      expect(computeAllPercentiles(null)).toEqual({ p50: null, p95: null, p99: null });
      expect(computeAllPercentiles(undefined)).toEqual({ p50: null, p95: null, p99: null });
      expect(computeAllPercentiles('not array')).toEqual({ p50: null, p95: null, p99: null });
    });

    it('returns null when empty array', () => {
      expect(computeAllPercentiles([])).toEqual({ p50: null, p95: null, p99: null });
    });

    it('sorts values before computing percentiles', () => {
      // Unsorted array of 20 elements
      const unsorted = [20, 1, 19, 2, 18, 3, 17, 4, 16, 5, 15, 6, 14, 7, 13, 8, 12, 9, 11, 10];
      const result = computeAllPercentiles(unsorted);
      // After sorting: [1,2,3,...,20]
      // p50: index = ceil(10) - 1 = 9 → 10
      expect(result.p50).toBe(10);
      // p95: index = ceil(19) - 1 = 18 → 19
      expect(result.p95).toBe(19);
      // p99: index = ceil(19.8) - 1 = 19 → 20
      expect(result.p99).toBe(20);
    });

    it('filters out non-numeric values', () => {
      // 20 numbers mixed with non-numbers
      const values = [
        1, 2, 3, 'a', 4, null, 5, 6, undefined, 7,
        8, 9, NaN, 10, 11, 12, 13, Infinity, 14, 15,
        16, 17, 18, 19, 20
      ];
      // Valid numbers: 1-20 (20 items after filtering out 'a', null, undefined, NaN, Infinity)
      const result = computeAllPercentiles(values);
      expect(result.p50).toBe(10);
    });

    it('returns null when valid numbers after filtering are fewer than 20', () => {
      const values = [1, 2, 3, 'a', null, NaN, Infinity, undefined];
      expect(computeAllPercentiles(values)).toEqual({ p50: null, p95: null, p99: null });
    });

    it('computes all three percentiles correctly for large dataset', () => {
      // 100 elements: 1 to 100
      const values = Array.from({ length: 100 }, (_, i) => i + 1);
      const result = computeAllPercentiles(values);
      // p50: index = ceil(50) - 1 = 49 → 50
      expect(result.p50).toBe(50);
      // p95: index = ceil(95) - 1 = 94 → 95
      expect(result.p95).toBe(95);
      // p99: index = ceil(99) - 1 = 98 → 99
      expect(result.p99).toBe(99);
    });

    it('does not mutate the original array', () => {
      const original = [20, 1, 19, 2, 18, 3, 17, 4, 16, 5, 15, 6, 14, 7, 13, 8, 12, 9, 11, 10];
      const copy = [...original];
      computeAllPercentiles(original);
      expect(original).toEqual(copy);
    });

    it('handles all identical values', () => {
      const values = Array(25).fill(42);
      const result = computeAllPercentiles(values);
      expect(result.p50).toBe(42);
      expect(result.p95).toBe(42);
      expect(result.p99).toBe(42);
    });

    it('handles negative values correctly', () => {
      const values = Array.from({ length: 20 }, (_, i) => i - 10); // -10 to 9
      const result = computeAllPercentiles(values);
      // Sorted: [-10, -9, ..., 9]
      // p50: index = ceil(10) - 1 = 9 → -1
      expect(result.p50).toBe(-1);
    });
  });
});
