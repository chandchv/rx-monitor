import { describe, it, expect } from 'vitest';
import { validateHeaderRules, evaluateHeaders, getSecurityPreset } from '../../header-validator.js';

describe('header-validator', () => {
  describe('validateHeaderRules', () => {
    it('returns valid for an empty rules array', () => {
      const result = validateHeaderRules([]);
      expect(result).toEqual({ valid: true, errors: [] });
    });

    it('rejects non-array input', () => {
      const result = validateHeaderRules('not an array');
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Rules must be an array');
    });

    it('validates a correct presence rule', () => {
      const rules = [{ header: 'X-Frame-Options', type: 'presence', expected: null }];
      expect(validateHeaderRules(rules)).toEqual({ valid: true, errors: [] });
    });

    it('validates a correct exact rule', () => {
      const rules = [{ header: 'X-Content-Type-Options', type: 'exact', expected: 'nosniff' }];
      expect(validateHeaderRules(rules)).toEqual({ valid: true, errors: [] });
    });

    it('validates a correct contains rule', () => {
      const rules = [{ header: 'Content-Security-Policy', type: 'contains', expected: 'default-src' }];
      expect(validateHeaderRules(rules)).toEqual({ valid: true, errors: [] });
    });

    it('rejects a rule with invalid type', () => {
      const rules = [{ header: 'X-Custom', type: 'invalid', expected: 'val' }];
      const result = validateHeaderRules(rules);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('invalid type');
    });

    it('rejects a rule with empty header name', () => {
      const rules = [{ header: '', type: 'presence', expected: null }];
      const result = validateHeaderRules(rules);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('header must be a non-empty string');
    });

    it('rejects exact rule with missing expected', () => {
      const rules = [{ header: 'X-Custom', type: 'exact', expected: '' }];
      const result = validateHeaderRules(rules);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('expected must be a non-empty string');
    });

    it('rejects contains rule with missing expected', () => {
      const rules = [{ header: 'X-Custom', type: 'contains', expected: null }];
      const result = validateHeaderRules(rules);
      expect(result.valid).toBe(false);
    });

    it('reports multiple errors for multiple invalid rules', () => {
      const rules = [
        { header: '', type: 'presence', expected: null },
        { header: 'X-Custom', type: 'bad-type', expected: 'val' }
      ];
      const result = validateHeaderRules(rules);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBe(2);
    });

    it('rejects non-object rule entries', () => {
      const rules = [null, undefined, 42];
      const result = validateHeaderRules(rules);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBe(3);
    });
  });

  describe('evaluateHeaders', () => {
    it('returns pass for empty rules', () => {
      const result = evaluateHeaders({ 'x-custom': 'value' }, []);
      expect(result).toEqual({ pass: true, failures: [] });
    });

    it('passes presence check when header exists', () => {
      const headers = { 'X-Frame-Options': 'DENY' };
      const rules = [{ header: 'X-Frame-Options', type: 'presence', expected: null }];
      const result = evaluateHeaders(headers, rules);
      expect(result.pass).toBe(true);
      expect(result.failures).toHaveLength(0);
    });

    it('fails presence check when header is missing', () => {
      const headers = { 'Content-Type': 'text/html' };
      const rules = [{ header: 'X-Frame-Options', type: 'presence', expected: null }];
      const result = evaluateHeaders(headers, rules);
      expect(result.pass).toBe(false);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toEqual({
        header: 'X-Frame-Options',
        type: 'presence',
        expected: 'present',
        actual: null
      });
    });

    it('passes exact match when values are identical', () => {
      const headers = { 'X-Content-Type-Options': 'nosniff' };
      const rules = [{ header: 'X-Content-Type-Options', type: 'exact', expected: 'nosniff' }];
      const result = evaluateHeaders(headers, rules);
      expect(result.pass).toBe(true);
    });

    it('fails exact match when values differ', () => {
      const headers = { 'X-Content-Type-Options': 'wrong' };
      const rules = [{ header: 'X-Content-Type-Options', type: 'exact', expected: 'nosniff' }];
      const result = evaluateHeaders(headers, rules);
      expect(result.pass).toBe(false);
      expect(result.failures[0]).toEqual({
        header: 'X-Content-Type-Options',
        type: 'exact',
        expected: 'nosniff',
        actual: 'wrong'
      });
    });

    it('exact match is case-sensitive for values', () => {
      const headers = { 'X-Content-Type-Options': 'Nosniff' };
      const rules = [{ header: 'X-Content-Type-Options', type: 'exact', expected: 'nosniff' }];
      const result = evaluateHeaders(headers, rules);
      expect(result.pass).toBe(false);
    });

    it('passes contains check when substring found', () => {
      const headers = { 'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'" };
      const rules = [{ header: 'Content-Security-Policy', type: 'contains', expected: "default-src" }];
      const result = evaluateHeaders(headers, rules);
      expect(result.pass).toBe(true);
    });

    it('fails contains check when substring not found', () => {
      const headers = { 'Content-Security-Policy': "script-src 'self'" };
      const rules = [{ header: 'Content-Security-Policy', type: 'contains', expected: 'default-src' }];
      const result = evaluateHeaders(headers, rules);
      expect(result.pass).toBe(false);
      expect(result.failures[0]).toEqual({
        header: 'Content-Security-Policy',
        type: 'contains',
        expected: 'default-src',
        actual: "script-src 'self'"
      });
    });

    it('contains check is case-sensitive for values', () => {
      const headers = { 'Content-Security-Policy': "Default-Src 'self'" };
      const rules = [{ header: 'Content-Security-Policy', type: 'contains', expected: 'default-src' }];
      const result = evaluateHeaders(headers, rules);
      expect(result.pass).toBe(false);
    });

    it('performs case-insensitive header name matching', () => {
      const headers = { 'x-frame-options': 'DENY' };
      const rules = [{ header: 'X-Frame-Options', type: 'presence', expected: null }];
      const result = evaluateHeaders(headers, rules);
      expect(result.pass).toBe(true);
    });

    it('case-insensitive matching works with mixed case headers', () => {
      const headers = { 'CONTENT-TYPE': 'text/html' };
      const rules = [{ header: 'content-type', type: 'exact', expected: 'text/html' }];
      const result = evaluateHeaders(headers, rules);
      expect(result.pass).toBe(true);
    });

    it('reports multiple failures independently', () => {
      const headers = { 'Content-Type': 'text/html' };
      const rules = [
        { header: 'X-Frame-Options', type: 'presence', expected: null },
        { header: 'Strict-Transport-Security', type: 'presence', expected: null },
        { header: 'Content-Type', type: 'exact', expected: 'application/json' }
      ];
      const result = evaluateHeaders(headers, rules);
      expect(result.pass).toBe(false);
      expect(result.failures).toHaveLength(3);
      expect(result.failures[0].header).toBe('X-Frame-Options');
      expect(result.failures[1].header).toBe('Strict-Transport-Security');
      expect(result.failures[2].header).toBe('Content-Type');
    });

    it('handles null/undefined headers gracefully', () => {
      const rules = [{ header: 'X-Custom', type: 'presence', expected: null }];
      const result = evaluateHeaders(null, rules);
      expect(result.pass).toBe(false);
      expect(result.failures).toHaveLength(1);
    });

    it('exact check fails when header is missing', () => {
      const headers = {};
      const rules = [{ header: 'X-Custom', type: 'exact', expected: 'value' }];
      const result = evaluateHeaders(headers, rules);
      expect(result.pass).toBe(false);
      expect(result.failures[0].actual).toBeNull();
    });

    it('contains check fails when header is missing', () => {
      const headers = {};
      const rules = [{ header: 'X-Custom', type: 'contains', expected: 'value' }];
      const result = evaluateHeaders(headers, rules);
      expect(result.pass).toBe(false);
      expect(result.failures[0].actual).toBeNull();
    });
  });

  describe('getSecurityPreset', () => {
    it('returns exactly 5 security header rules', () => {
      const preset = getSecurityPreset();
      expect(preset).toHaveLength(5);
    });

    it('all preset rules are presence type', () => {
      const preset = getSecurityPreset();
      for (const rule of preset) {
        expect(rule.type).toBe('presence');
        expect(rule.expected).toBeNull();
      }
    });

    it('includes all required security headers', () => {
      const preset = getSecurityPreset();
      const headers = preset.map(r => r.header);
      expect(headers).toContain('Strict-Transport-Security');
      expect(headers).toContain('Content-Security-Policy');
      expect(headers).toContain('X-Frame-Options');
      expect(headers).toContain('X-Content-Type-Options');
      expect(headers).toContain('Referrer-Policy');
    });

    it('preset rules validate correctly', () => {
      const preset = getSecurityPreset();
      const result = validateHeaderRules(preset);
      expect(result.valid).toBe(true);
    });

    it('preset works with evaluateHeaders to detect missing headers', () => {
      const preset = getSecurityPreset();
      const headers = { 'Strict-Transport-Security': 'max-age=31536000' };
      const result = evaluateHeaders(headers, preset);
      expect(result.pass).toBe(false);
      // 4 out of 5 headers are missing
      expect(result.failures).toHaveLength(4);
    });

    it('preset passes when all security headers are present', () => {
      const preset = getSecurityPreset();
      const headers = {
        'Strict-Transport-Security': 'max-age=31536000',
        'Content-Security-Policy': "default-src 'self'",
        'X-Frame-Options': 'DENY',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'strict-origin-when-cross-origin'
      };
      const result = evaluateHeaders(headers, preset);
      expect(result.pass).toBe(true);
      expect(result.failures).toHaveLength(0);
    });
  });
});
