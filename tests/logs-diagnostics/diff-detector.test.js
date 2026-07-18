/**
 * Unit tests for diff-detector.js module
 * Tests: computeDiffPercentage, computeContentHash, shouldAlert, applyExclusions, getChangedLineSummary
 *
 * Requirements: 22.1, 22.2, 22.3, 22.4, 22.5, 22.6, 22.7
 */

import { describe, it, expect } from 'vitest';
import {
  computeDiffPercentage,
  computeContentHash,
  shouldAlert,
  applyExclusions,
  getChangedLineSummary,
} from '../../diff-detector.js';

describe('diff-detector', () => {
  describe('computeDiffPercentage', () => {
    it('returns 0 for identical strings', () => {
      expect(computeDiffPercentage('hello world', 'hello world')).toBe(0);
    });

    it('returns 0 for two empty strings', () => {
      expect(computeDiffPercentage('', '')).toBe(0);
    });

    it('returns 100 when baseline is empty but current has content', () => {
      expect(computeDiffPercentage('', 'some content')).toBe(100);
    });

    it('computes correct percentage for single character change', () => {
      // Baseline: "abcde" (5 chars), current: "abcdf" -> 1 char changed
      // 1/5 * 100 = 20%
      expect(computeDiffPercentage('abcde', 'abcdf')).toBe(20);
    });

    it('computes correct percentage for completely different strings', () => {
      // "aaaa" vs "bbbb" -> 4 chars different / 4 chars baseline = 100%
      expect(computeDiffPercentage('aaaa', 'bbbb')).toBe(100);
    });

    it('accounts for length differences as changes', () => {
      // Baseline: "abc" (3 chars), current: "abcde" -> 0 char mismatches + 2 extra = 2 changes
      // 2/3 * 100 = 66.66...%
      const result = computeDiffPercentage('abc', 'abcde');
      expect(result).toBeCloseTo(66.667, 1);
    });

    it('accounts for shorter current string', () => {
      // Baseline: "abcde" (5 chars), current: "abc" -> 0 char mismatches + 2 shorter = 2 changes
      // 2/5 * 100 = 40%
      expect(computeDiffPercentage('abcde', 'abc')).toBe(40);
    });

    it('handles multiline content', () => {
      const baseline = 'line1\nline2\nline3';
      const current = 'line1\nline2\nline3';
      expect(computeDiffPercentage(baseline, current)).toBe(0);
    });

    it('detects changes in multiline content', () => {
      const baseline = 'line1\nline2\nline3';
      const current = 'line1\nLINE2\nline3';
      // 4 characters changed (l->L, i->I, n->N, e->E) out of 17 baseline chars
      const result = computeDiffPercentage(baseline, current);
      expect(result).toBeGreaterThan(0);
    });

    it('handles null/undefined baseline as empty', () => {
      expect(computeDiffPercentage(null, 'content')).toBe(100);
      expect(computeDiffPercentage(undefined, 'content')).toBe(100);
    });

    it('handles null/undefined current', () => {
      // Both falsy => 0
      expect(computeDiffPercentage(null, null)).toBe(0);
      expect(computeDiffPercentage(null, '')).toBe(0);
    });
  });

  describe('computeContentHash', () => {
    it('returns a 64-character hex string (SHA-256)', () => {
      const hash = computeContentHash('hello');
      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('returns consistent hash for same content', () => {
      const hash1 = computeContentHash('test content');
      const hash2 = computeContentHash('test content');
      expect(hash1).toBe(hash2);
    });

    it('returns different hash for different content', () => {
      const hash1 = computeContentHash('hello');
      const hash2 = computeContentHash('world');
      expect(hash1).not.toBe(hash2);
    });

    it('handles empty string', () => {
      const hash = computeContentHash('');
      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('handles null input', () => {
      const hash = computeContentHash(null);
      expect(hash).toHaveLength(64);
      // Should hash the empty string
      expect(hash).toBe(computeContentHash(''));
    });

    it('handles undefined input', () => {
      const hash = computeContentHash(undefined);
      expect(hash).toHaveLength(64);
      expect(hash).toBe(computeContentHash(''));
    });

    it('produces known SHA-256 hash for known input', () => {
      // SHA-256 of empty string
      const emptyHash = computeContentHash('');
      expect(emptyHash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    });
  });

  describe('shouldAlert', () => {
    it('returns true when diff exceeds default threshold (5%)', () => {
      expect(shouldAlert(6)).toBe(true);
      expect(shouldAlert(10)).toBe(true);
      expect(shouldAlert(100)).toBe(true);
    });

    it('returns false when diff is at or below default threshold', () => {
      expect(shouldAlert(5)).toBe(false);
      expect(shouldAlert(4)).toBe(false);
      expect(shouldAlert(0)).toBe(false);
    });

    it('uses custom threshold when provided', () => {
      expect(shouldAlert(8, 10)).toBe(false);
      expect(shouldAlert(11, 10)).toBe(true);
      expect(shouldAlert(10, 10)).toBe(false);
    });

    it('falls back to default threshold for invalid threshold values', () => {
      expect(shouldAlert(6, NaN)).toBe(true);
      expect(shouldAlert(6, null)).toBe(true);
      expect(shouldAlert(6, undefined)).toBe(true);
      expect(shouldAlert(6, 'invalid')).toBe(true);
    });

    it('works with threshold of 0', () => {
      expect(shouldAlert(0, 0)).toBe(false);
      expect(shouldAlert(0.001, 0)).toBe(true);
    });

    it('returns false for 0% diff regardless of threshold', () => {
      expect(shouldAlert(0, 0)).toBe(false);
      expect(shouldAlert(0, 5)).toBe(false);
      expect(shouldAlert(0, 100)).toBe(false);
    });
  });

  describe('applyExclusions', () => {
    it('returns content unchanged when no exclusions provided', () => {
      expect(applyExclusions('hello world', [])).toBe('hello world');
    });

    it('returns content unchanged when exclusions is null', () => {
      expect(applyExclusions('hello world', null)).toBe('hello world');
    });

    it('returns content unchanged when exclusions is undefined', () => {
      expect(applyExclusions('hello world', undefined)).toBe('hello world');
    });

    it('removes content matching a regex pattern', () => {
      const content = 'Generated at 2024-01-15T10:30:00Z by server';
      const exclusions = ['\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z'];
      expect(applyExclusions(content, exclusions)).toBe('Generated at  by server');
    });

    it('removes all occurrences of a pattern (global flag)', () => {
      const content = 'token=abc123 other token=xyz789 end';
      const exclusions = ['token=[a-z0-9]+'];
      expect(applyExclusions(content, exclusions)).toBe(' other  end');
    });

    it('applies multiple exclusion patterns', () => {
      const content = 'time: 12:00 session: sess_abc nonce: n123';
      const exclusions = ['\\d{2}:\\d{2}', 'sess_[a-z]+', 'n\\d+'];
      expect(applyExclusions(content, exclusions)).toBe('time:  session:  nonce: ');
    });

    it('skips invalid regex patterns silently', () => {
      const content = 'hello world';
      const exclusions = ['[invalid regex', 'world'];
      expect(applyExclusions(content, exclusions)).toBe('hello ');
    });

    it('returns empty string for empty content', () => {
      expect(applyExclusions('', ['pattern'])).toBe('');
    });

    it('returns empty string for null content', () => {
      expect(applyExclusions(null, ['pattern'])).toBe('');
    });

    it('skips non-string exclusion entries', () => {
      const content = 'hello world';
      const exclusions = [null, undefined, 123, 'world'];
      expect(applyExclusions(content, exclusions)).toBe('hello ');
    });

    it('handles exclusion that removes everything', () => {
      const content = 'abcdef';
      const exclusions = ['[a-f]+'];
      expect(applyExclusions(content, exclusions)).toBe('');
    });
  });

  describe('getChangedLineSummary', () => {
    it('returns empty array for identical content', () => {
      expect(getChangedLineSummary('hello', 'hello')).toEqual([]);
    });

    it('returns empty array for both empty', () => {
      expect(getChangedLineSummary('', '')).toEqual([]);
    });

    it('identifies changed lines with character counts', () => {
      const baseline = 'line1\nline2\nline3';
      const current = 'line1\nLINE2\nline3';
      const result = getChangedLineSummary(baseline, current);
      expect(result).toHaveLength(1);
      expect(result[0].line).toBe(2);
      expect(result[0].chars).toBeGreaterThan(0);
    });

    it('handles added lines', () => {
      const baseline = 'line1\nline2';
      const current = 'line1\nline2\nline3';
      const result = getChangedLineSummary(baseline, current);
      expect(result).toHaveLength(1);
      expect(result[0].line).toBe(3);
    });

    it('handles removed lines', () => {
      const baseline = 'line1\nline2\nline3';
      const current = 'line1\nline2';
      const result = getChangedLineSummary(baseline, current);
      expect(result).toHaveLength(1);
      expect(result[0].line).toBe(3);
    });

    it('handles completely different multiline content', () => {
      const baseline = 'aaa\nbbb\nccc';
      const current = 'xxx\nyyy\nzzz';
      const result = getChangedLineSummary(baseline, current);
      expect(result).toHaveLength(3);
      expect(result[0].line).toBe(1);
      expect(result[1].line).toBe(2);
      expect(result[2].line).toBe(3);
    });

    it('handles null baseline', () => {
      const result = getChangedLineSummary(null, 'hello');
      expect(result).toHaveLength(1);
      expect(result[0].line).toBe(1);
    });

    it('handles null current', () => {
      const result = getChangedLineSummary('hello', null);
      expect(result).toHaveLength(1);
      expect(result[0].line).toBe(1);
    });

    it('handles both null', () => {
      expect(getChangedLineSummary(null, null)).toEqual([]);
    });
  });

  describe('integration: end-to-end diff detection flow', () => {
    it('correctly detects no change with exclusions applied', () => {
      const baseline = 'Page loaded at 2024-01-01T00:00:00Z with content here';
      const current = 'Page loaded at 2024-06-15T12:30:45Z with content here';
      const exclusions = ['\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z'];

      const cleanBaseline = applyExclusions(baseline, exclusions);
      const cleanCurrent = applyExclusions(current, exclusions);
      const diff = computeDiffPercentage(cleanBaseline, cleanCurrent);

      expect(diff).toBe(0);
      expect(shouldAlert(diff)).toBe(false);
    });

    it('correctly detects significant change after exclusions', () => {
      const baseline = 'Welcome to Our Site - timestamp: 123456';
      const current = 'HACKED BY ATTACKER - timestamp: 789012';
      const exclusions = ['timestamp: \\d+'];

      const cleanBaseline = applyExclusions(baseline, exclusions);
      const cleanCurrent = applyExclusions(current, exclusions);
      const diff = computeDiffPercentage(cleanBaseline, cleanCurrent);

      expect(diff).toBeGreaterThan(5);
      expect(shouldAlert(diff)).toBe(true);
    });

    it('hashes content correctly for storage', () => {
      const content = '<html><body>Hello World</body></html>';
      const hash = computeContentHash(content);
      expect(hash).toHaveLength(64);
      // Same content always produces same hash
      expect(computeContentHash(content)).toBe(hash);
    });

    it('first-enable scenario: captures baseline without alerting (req 22.6)', () => {
      // On first enable, there is no baseline (null/empty)
      // The module should be able to compute hash for storage
      const firstResponse = '<html><body>My Page</body></html>';
      const hash = computeContentHash(firstResponse);
      expect(hash).toHaveLength(64);

      // No diff to compute since there's no previous baseline
      // The integration layer would store this as the initial baseline
    });

    it('skip comparison on check failure scenario (req 22.7)', () => {
      // On check failure, the existing baseline is retained
      // The module itself doesn't enforce this - it's an integration concern
      // But we can verify the hash stays consistent
      const baseline = 'existing content';
      const baselineHash = computeContentHash(baseline);
      // After failure, baseline hash should remain unchanged
      expect(computeContentHash(baseline)).toBe(baselineHash);
    });
  });
});
