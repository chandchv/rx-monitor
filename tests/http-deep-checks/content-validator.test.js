import { describe, it, expect } from 'vitest';
import { validateContentRules, evaluateContent } from '../../content-validator.js';

describe('content-validator', () => {
  describe('validateContentRules', () => {
    it('returns valid for an empty rules array', () => {
      const result = validateContentRules([]);
      expect(result).toEqual({ valid: true, errors: [] });
    });

    it('returns error when rules is not an array', () => {
      const result = validateContentRules('not an array');
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Rules must be an array');
    });

    it('accepts valid substring rule', () => {
      const rules = [{ type: 'substring', value: 'hello', description: 'check hello' }];
      expect(validateContentRules(rules)).toEqual({ valid: true, errors: [] });
    });

    it('accepts valid json_key rule', () => {
      const rules = [{ type: 'json_key', value: 'data.user.name', description: 'check nested key' }];
      expect(validateContentRules(rules)).toEqual({ valid: true, errors: [] });
    });

    it('accepts valid regex rule', () => {
      const rules = [{ type: 'regex', value: '^\\d{3}$', description: 'three digits' }];
      expect(validateContentRules(rules)).toEqual({ valid: true, errors: [] });
    });

    it('rejects invalid rule type', () => {
      const rules = [{ type: 'invalid', value: 'test', description: 'bad type' }];
      const result = validateContentRules(rules);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('invalid type');
    });

    it('rejects empty value', () => {
      const rules = [{ type: 'substring', value: '', description: 'empty' }];
      const result = validateContentRules(rules);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('value must be a non-empty string');
    });

    it('rejects invalid regex pattern', () => {
      const rules = [{ type: 'regex', value: '[invalid(', description: 'bad regex' }];
      const result = validateContentRules(rules);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('invalid regex pattern');
    });

    it('rejects non-object rules', () => {
      const rules = [null, 42, 'string'];
      const result = validateContentRules(rules);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBe(3);
    });

    it('validates multiple rules and collects all errors', () => {
      const rules = [
        { type: 'substring', value: 'ok', description: 'valid' },
        { type: 'bad_type', value: 'test', description: 'invalid' },
        { type: 'regex', value: '[bad(', description: 'bad regex' },
      ];
      const result = validateContentRules(rules);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBe(2);
    });
  });

  describe('evaluateContent', () => {
    describe('empty body handling', () => {
      it('fails all rules when body is empty string', () => {
        const rules = [
          { type: 'substring', value: 'hello', description: 'test' },
          { type: 'json_key', value: 'key', description: 'test2' },
        ];
        const result = evaluateContent('', rules);
        expect(result.pass).toBe(false);
        expect(result.failures.length).toBe(2);
        expect(result.failures[0].reason).toContain('empty');
      });

      it('fails all rules when body is null', () => {
        const rules = [{ type: 'substring', value: 'hello', description: 'test' }];
        const result = evaluateContent(null, rules);
        expect(result.pass).toBe(false);
        expect(result.failures[0].reason).toContain('empty');
      });

      it('fails all rules when body is undefined', () => {
        const rules = [{ type: 'substring', value: 'hello', description: 'test' }];
        const result = evaluateContent(undefined, rules);
        expect(result.pass).toBe(false);
        expect(result.failures[0].reason).toContain('empty');
      });
    });

    describe('no rules', () => {
      it('passes when rules array is empty', () => {
        const result = evaluateContent('any body', []);
        expect(result.pass).toBe(true);
        expect(result.failures).toEqual([]);
      });

      it('passes when rules is not an array', () => {
        const result = evaluateContent('any body', null);
        expect(result.pass).toBe(true);
      });
    });

    describe('substring validation', () => {
      it('passes when substring is found (case-sensitive)', () => {
        const rules = [{ type: 'substring', value: 'Hello', description: 'test' }];
        const result = evaluateContent('Hello World', rules);
        expect(result.pass).toBe(true);
        expect(result.failures).toEqual([]);
      });

      it('fails when substring is not found', () => {
        const rules = [{ type: 'substring', value: 'goodbye', description: 'test' }];
        const result = evaluateContent('Hello World', rules);
        expect(result.pass).toBe(false);
        expect(result.failures[0].reason).toContain('not found');
      });

      it('is case-sensitive', () => {
        const rules = [{ type: 'substring', value: 'hello', description: 'test' }];
        const result = evaluateContent('Hello World', rules);
        expect(result.pass).toBe(false);
      });
    });

    describe('json_key validation', () => {
      it('passes for top-level key', () => {
        const body = JSON.stringify({ name: 'test', value: 123 });
        const rules = [{ type: 'json_key', value: 'name', description: 'test' }];
        const result = evaluateContent(body, rules);
        expect(result.pass).toBe(true);
      });

      it('passes for nested key with dot-notation', () => {
        const body = JSON.stringify({ data: { user: { name: 'Alice' } } });
        const rules = [{ type: 'json_key', value: 'data.user.name', description: 'test' }];
        const result = evaluateContent(body, rules);
        expect(result.pass).toBe(true);
      });

      it('fails when nested key does not exist', () => {
        const body = JSON.stringify({ data: { user: {} } });
        const rules = [{ type: 'json_key', value: 'data.user.email', description: 'test' }];
        const result = evaluateContent(body, rules);
        expect(result.pass).toBe(false);
        expect(result.failures[0].reason).toContain('does not exist');
      });

      it('fails when body is not valid JSON', () => {
        const rules = [{ type: 'json_key', value: 'key', description: 'test' }];
        const result = evaluateContent('not json at all', rules);
        expect(result.pass).toBe(false);
        expect(result.failures[0].reason).toContain('not valid JSON');
      });

      it('passes when key exists with null value', () => {
        const body = JSON.stringify({ key: null });
        const rules = [{ type: 'json_key', value: 'key', description: 'test' }];
        const result = evaluateContent(body, rules);
        expect(result.pass).toBe(true);
      });

      it('fails when intermediate key is not an object', () => {
        const body = JSON.stringify({ data: 'string_value' });
        const rules = [{ type: 'json_key', value: 'data.nested', description: 'test' }];
        const result = evaluateContent(body, rules);
        expect(result.pass).toBe(false);
        expect(result.failures[0].reason).toContain('does not exist');
      });
    });

    describe('regex validation', () => {
      it('passes when regex matches', () => {
        const rules = [{ type: 'regex', value: '\\d{3}-\\d{4}', description: 'test' }];
        const result = evaluateContent('Phone: 123-4567', rules);
        expect(result.pass).toBe(true);
      });

      it('fails when regex does not match', () => {
        const rules = [{ type: 'regex', value: '^\\d+$', description: 'test' }];
        const result = evaluateContent('abc123', rules);
        expect(result.pass).toBe(false);
        expect(result.failures[0].reason).toContain('did not match');
      });

      it('handles invalid regex gracefully at evaluation time', () => {
        const rules = [{ type: 'regex', value: '[invalid(', description: 'test' }];
        const result = evaluateContent('test body', rules);
        expect(result.pass).toBe(false);
        expect(result.failures[0].reason).toContain('Invalid regex');
      });
    });

    describe('multiple rules', () => {
      it('passes when all rules match', () => {
        const body = JSON.stringify({ status: 'ok', data: { id: 1 } });
        const rules = [
          { type: 'substring', value: 'ok', description: 'status check' },
          { type: 'json_key', value: 'data.id', description: 'id exists' },
          { type: 'regex', value: '"status"', description: 'has status field' },
        ];
        const result = evaluateContent(body, rules);
        expect(result.pass).toBe(true);
        expect(result.failures).toEqual([]);
      });

      it('fails when any rule does not match', () => {
        const body = JSON.stringify({ status: 'ok' });
        const rules = [
          { type: 'substring', value: 'ok', description: 'status check' },
          { type: 'json_key', value: 'data.missing', description: 'missing key' },
        ];
        const result = evaluateContent(body, rules);
        expect(result.pass).toBe(false);
        expect(result.failures.length).toBe(1);
        expect(result.failures[0].rule.type).toBe('json_key');
      });

      it('reports all failures when multiple rules fail', () => {
        const body = 'plain text body';
        const rules = [
          { type: 'substring', value: 'missing', description: 'test1' },
          { type: 'json_key', value: 'key', description: 'test2' },
          { type: 'regex', value: '^\\d+$', description: 'test3' },
        ];
        const result = evaluateContent(body, rules);
        expect(result.pass).toBe(false);
        expect(result.failures.length).toBe(3);
      });
    });
  });
});
