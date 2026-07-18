import { describe, it, expect, vi, beforeEach } from 'vitest';
import { detectLimit } from '../../connection-detector.js';

describe('connection-detector', () => {
  describe('detectLimit', () => {
    it('returns limitFound=false for empty array', () => {
      const result = detectLimit([]);
      expect(result).toEqual({ limitFound: false, limitLevel: 0 });
    });

    it('returns limitFound=false for null input', () => {
      const result = detectLimit(null);
      expect(result).toEqual({ limitFound: false, limitLevel: 0 });
    });

    it('returns limitFound=false for undefined input', () => {
      const result = detectLimit(undefined);
      expect(result).toEqual({ limitFound: false, limitLevel: 0 });
    });

    it('returns limitFound=false for non-array input', () => {
      const result = detectLimit('not an array');
      expect(result).toEqual({ limitFound: false, limitLevel: 0 });
    });

    it('returns limitFound=false when no level exceeds 10% error rate', () => {
      const levels = [
        { concurrency: 10, avg_response_ms: 50, error_rate_pct: 0, errors: 0, total: 20 },
        { concurrency: 20, avg_response_ms: 60, error_rate_pct: 5, errors: 1, total: 20 },
        { concurrency: 30, avg_response_ms: 70, error_rate_pct: 10, errors: 2, total: 20 },
      ];
      const result = detectLimit(levels);
      expect(result).toEqual({ limitFound: false, limitLevel: 0 });
    });

    it('returns limitFound=true with correct limitLevel when error rate exceeds 10%', () => {
      const levels = [
        { concurrency: 10, avg_response_ms: 50, error_rate_pct: 0, errors: 0, total: 20 },
        { concurrency: 20, avg_response_ms: 60, error_rate_pct: 5, errors: 1, total: 20 },
        { concurrency: 30, avg_response_ms: 100, error_rate_pct: 15, errors: 3, total: 20 },
      ];
      const result = detectLimit(levels);
      expect(result).toEqual({ limitFound: true, limitLevel: 30 });
    });

    it('returns the first level that exceeds 10% error rate', () => {
      const levels = [
        { concurrency: 10, avg_response_ms: 50, error_rate_pct: 0, errors: 0, total: 20 },
        { concurrency: 20, avg_response_ms: 60, error_rate_pct: 20, errors: 4, total: 20 },
        { concurrency: 30, avg_response_ms: 100, error_rate_pct: 50, errors: 10, total: 20 },
      ];
      const result = detectLimit(levels);
      expect(result).toEqual({ limitFound: true, limitLevel: 20 });
    });

    it('detects limit at the very first level', () => {
      const levels = [
        { concurrency: 10, avg_response_ms: 500, error_rate_pct: 100, errors: 20, total: 20 },
      ];
      const result = detectLimit(levels);
      expect(result).toEqual({ limitFound: true, limitLevel: 10 });
    });

    it('does not trigger on exactly 10% error rate (threshold is >10%)', () => {
      const levels = [
        { concurrency: 10, avg_response_ms: 50, error_rate_pct: 10, errors: 2, total: 20 },
        { concurrency: 20, avg_response_ms: 60, error_rate_pct: 10, errors: 2, total: 20 },
      ];
      const result = detectLimit(levels);
      expect(result).toEqual({ limitFound: false, limitLevel: 0 });
    });

    it('triggers on 10.01% error rate', () => {
      const levels = [
        { concurrency: 10, avg_response_ms: 50, error_rate_pct: 10.01, errors: 2, total: 20 },
      ];
      const result = detectLimit(levels);
      expect(result).toEqual({ limitFound: true, limitLevel: 10 });
    });

    it('handles a full test from concurrency 10 to 500 with no limit', () => {
      const levels = [];
      for (let c = 10; c <= 500; c += 10) {
        levels.push({
          concurrency: c,
          avg_response_ms: 50 + c * 0.1,
          error_rate_pct: Math.min(c * 0.02, 10), // Stays at or below 10
          errors: 0,
          total: 20
        });
      }
      const result = detectLimit(levels);
      expect(result).toEqual({ limitFound: false, limitLevel: 0 });
    });

    it('handles limit found at high concurrency level', () => {
      const levels = [];
      for (let c = 10; c <= 500; c += 10) {
        const errorRate = c >= 490 ? 15 : 5;
        levels.push({
          concurrency: c,
          avg_response_ms: 50 + c,
          error_rate_pct: errorRate,
          errors: errorRate === 15 ? 3 : 1,
          total: 20
        });
      }
      const result = detectLimit(levels);
      expect(result).toEqual({ limitFound: true, limitLevel: 490 });
    });

    it('handles levels with fractional error rates', () => {
      const levels = [
        { concurrency: 10, avg_response_ms: 50, error_rate_pct: 5.5, errors: 1, total: 20 },
        { concurrency: 20, avg_response_ms: 60, error_rate_pct: 10.5, errors: 2, total: 20 },
      ];
      const result = detectLimit(levels);
      expect(result).toEqual({ limitFound: true, limitLevel: 20 });
    });

    it('handles single level with no errors', () => {
      const levels = [
        { concurrency: 10, avg_response_ms: 50, error_rate_pct: 0, errors: 0, total: 20 },
      ];
      const result = detectLimit(levels);
      expect(result).toEqual({ limitFound: false, limitLevel: 0 });
    });
  });
});
