import { describe, it, expect } from 'vitest';
import {
  classifyResponse,
  computeApdex,
  getApdexLabel,
  computeApdexFromResults,
} from '../../apdex-calculator.js';

describe('apdex-calculator', () => {
  describe('classifyResponse', () => {
    it('classifies response at threshold as satisfied', () => {
      expect(classifyResponse(500, 500)).toBe('satisfied');
    });

    it('classifies response below threshold as satisfied', () => {
      expect(classifyResponse(200, 500)).toBe('satisfied');
    });

    it('classifies response just above threshold as tolerating', () => {
      expect(classifyResponse(501, 500)).toBe('tolerating');
    });

    it('classifies response at 4T as tolerating', () => {
      expect(classifyResponse(2000, 500)).toBe('tolerating');
    });

    it('classifies response above 4T as frustrated', () => {
      expect(classifyResponse(2001, 500)).toBe('frustrated');
    });

    it('uses default threshold of 500ms when not specified', () => {
      expect(classifyResponse(500)).toBe('satisfied');
      expect(classifyResponse(501)).toBe('tolerating');
      expect(classifyResponse(2000)).toBe('tolerating');
      expect(classifyResponse(2001)).toBe('frustrated');
    });

    it('handles custom threshold correctly', () => {
      expect(classifyResponse(100, 100)).toBe('satisfied');
      expect(classifyResponse(101, 100)).toBe('tolerating');
      expect(classifyResponse(400, 100)).toBe('tolerating');
      expect(classifyResponse(401, 100)).toBe('frustrated');
    });

    it('classifies 0ms response time as satisfied', () => {
      expect(classifyResponse(0, 500)).toBe('satisfied');
    });
  });

  describe('computeApdex', () => {
    it('returns null when total is less than 20', () => {
      expect(computeApdex(10, 5, 19)).toBeNull();
    });

    it('returns null when total is 0', () => {
      expect(computeApdex(0, 0, 0)).toBeNull();
    });

    it('computes perfect score of 1.0 when all satisfied', () => {
      expect(computeApdex(20, 0, 20)).toBe(1.0);
    });

    it('computes score of 0.0 when all frustrated', () => {
      expect(computeApdex(0, 0, 20)).toBe(0.0);
    });

    it('computes score with tolerating counted as half', () => {
      // (10 + 10/2) / 20 = 15/20 = 0.75
      expect(computeApdex(10, 10, 20)).toBe(0.75);
    });

    it('rounds to 2 decimal places', () => {
      // (7 + 5/2) / 20 = 9.5/20 = 0.475 → 0.48
      expect(computeApdex(7, 5, 20)).toBe(0.48);
    });

    it('handles exact threshold of 20 results', () => {
      expect(computeApdex(20, 0, 20)).toBe(1.0);
    });

    it('computes correctly with large numbers', () => {
      // (900 + 50/2) / 1000 = 925/1000 = 0.925 → 0.93
      expect(computeApdex(900, 50, 1000)).toBe(0.93);
    });
  });

  describe('getApdexLabel', () => {
    it('returns null for null score', () => {
      expect(getApdexLabel(null)).toBeNull();
    });

    it('returns null for undefined score', () => {
      expect(getApdexLabel(undefined)).toBeNull();
    });

    it('returns Excellent for score 1.0', () => {
      expect(getApdexLabel(1.0)).toBe('Excellent');
    });

    it('returns Excellent for score 0.94', () => {
      expect(getApdexLabel(0.94)).toBe('Excellent');
    });

    it('returns Good for score 0.93', () => {
      expect(getApdexLabel(0.93)).toBe('Good');
    });

    it('returns Good for score 0.85', () => {
      expect(getApdexLabel(0.85)).toBe('Good');
    });

    it('returns Fair for score 0.84', () => {
      expect(getApdexLabel(0.84)).toBe('Fair');
    });

    it('returns Fair for score 0.70', () => {
      expect(getApdexLabel(0.70)).toBe('Fair');
    });

    it('returns Poor for score 0.69', () => {
      expect(getApdexLabel(0.69)).toBe('Poor');
    });

    it('returns Poor for score 0.50', () => {
      expect(getApdexLabel(0.50)).toBe('Poor');
    });

    it('returns Unacceptable for score 0.49', () => {
      expect(getApdexLabel(0.49)).toBe('Unacceptable');
    });

    it('returns Unacceptable for score 0.0', () => {
      expect(getApdexLabel(0.0)).toBe('Unacceptable');
    });
  });

  describe('computeApdexFromResults', () => {
    it('returns null score and label when fewer than 20 results', () => {
      const results = Array.from({ length: 19 }, () => ({ responseTime: 100, success: true }));
      const apdex = computeApdexFromResults(results);
      expect(apdex.score).toBeNull();
      expect(apdex.label).toBeNull();
      expect(apdex.total).toBe(19);
    });

    it('returns correct counts even when score is null', () => {
      const results = [
        { responseTime: 100, success: true },
        { responseTime: 600, success: true },
        { responseTime: 3000, success: false },
      ];
      const apdex = computeApdexFromResults(results);
      expect(apdex.satisfied).toBe(1);
      expect(apdex.tolerating).toBe(1);
      expect(apdex.frustrated).toBe(1);
      expect(apdex.total).toBe(3);
      expect(apdex.score).toBeNull();
    });

    it('computes correct Apdex for all satisfied results', () => {
      const results = Array.from({ length: 20 }, () => ({ responseTime: 200, success: true }));
      const apdex = computeApdexFromResults(results);
      expect(apdex.score).toBe(1.0);
      expect(apdex.label).toBe('Excellent');
      expect(apdex.satisfied).toBe(20);
      expect(apdex.tolerating).toBe(0);
      expect(apdex.frustrated).toBe(0);
    });

    it('classifies failed checks as frustrated regardless of response time', () => {
      const results = Array.from({ length: 20 }, () => ({ responseTime: 100, success: false }));
      const apdex = computeApdexFromResults(results);
      expect(apdex.score).toBe(0.0);
      expect(apdex.label).toBe('Unacceptable');
      expect(apdex.frustrated).toBe(20);
      expect(apdex.satisfied).toBe(0);
    });

    it('uses default threshold of 500ms', () => {
      const results = Array.from({ length: 20 }, () => ({ responseTime: 500, success: true }));
      const apdex = computeApdexFromResults(results);
      expect(apdex.score).toBe(1.0);
      expect(apdex.threshold_ms).toBe(500);
    });

    it('uses custom threshold when provided', () => {
      const results = Array.from({ length: 20 }, () => ({ responseTime: 200, success: true }));
      const apdex = computeApdexFromResults(results, 100);
      // 200ms with 100ms threshold → all tolerating (100 < 200 ≤ 400)
      expect(apdex.tolerating).toBe(20);
      expect(apdex.score).toBe(0.5);
      expect(apdex.threshold_ms).toBe(100);
    });

    it('handles mixed results correctly', () => {
      const results = [
        ...Array.from({ length: 10 }, () => ({ responseTime: 200, success: true })),  // satisfied
        ...Array.from({ length: 5 }, () => ({ responseTime: 1000, success: true })),  // tolerating
        ...Array.from({ length: 3 }, () => ({ responseTime: 3000, success: true })),  // frustrated (>2000)
        ...Array.from({ length: 2 }, () => ({ responseTime: 100, success: false })),  // frustrated (failed)
      ];
      const apdex = computeApdexFromResults(results);
      expect(apdex.satisfied).toBe(10);
      expect(apdex.tolerating).toBe(5);
      expect(apdex.frustrated).toBe(5);
      expect(apdex.total).toBe(20);
      // (10 + 5/2) / 20 = 12.5/20 = 0.625 → 0.63
      expect(apdex.score).toBe(0.63);
      expect(apdex.label).toBe('Poor');
    });

    it('returns correct shape with all fields', () => {
      const results = Array.from({ length: 25 }, () => ({ responseTime: 300, success: true }));
      const apdex = computeApdexFromResults(results, 400);
      expect(apdex).toEqual({
        score: 1.0,
        label: 'Excellent',
        satisfied: 25,
        tolerating: 0,
        frustrated: 0,
        total: 25,
        threshold_ms: 400,
      });
    });

    it('handles empty results array', () => {
      const apdex = computeApdexFromResults([]);
      expect(apdex.score).toBeNull();
      expect(apdex.label).toBeNull();
      expect(apdex.total).toBe(0);
      expect(apdex.satisfied).toBe(0);
      expect(apdex.tolerating).toBe(0);
      expect(apdex.frustrated).toBe(0);
    });

    it('handles non-array input gracefully', () => {
      const apdex = computeApdexFromResults(null);
      expect(apdex.score).toBeNull();
      expect(apdex.total).toBe(0);
    });
  });
});
