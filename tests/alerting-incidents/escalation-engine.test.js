import { describe, it, expect } from 'vitest';
import { validateEscalationPolicy } from '../../escalation-engine.js';

describe('escalation-engine', () => {
  describe('validateEscalationPolicy', () => {
    function makeTier(overrides = {}) {
      return {
        level: 1,
        channel: 'telegram',
        contact: '+123456789',
        delay_minutes: 5,
        ...overrides
      };
    }

    function makePolicy(tierCount = 3, tierOverrides = {}) {
      const tiers = Array.from({ length: tierCount }, (_, i) =>
        makeTier({ level: i + 1, ...tierOverrides })
      );
      return { id: 1, monitor_id: 1, tiers };
    }

    describe('valid policies', () => {
      it('accepts a policy with exactly 3 tiers', () => {
        const policy = makePolicy(3);
        const result = validateEscalationPolicy(policy);
        expect(result).toEqual({ valid: true, errors: [] });
      });

      it('accepts a policy with exactly 10 tiers', () => {
        const policy = makePolicy(10);
        const result = validateEscalationPolicy(policy);
        expect(result).toEqual({ valid: true, errors: [] });
      });

      it('accepts a policy with email channel', () => {
        const policy = makePolicy(3, { channel: 'email', contact: 'admin@example.com' });
        const result = validateEscalationPolicy(policy);
        expect(result).toEqual({ valid: true, errors: [] });
      });

      it('accepts minimum delay of 1 minute', () => {
        const policy = makePolicy(3, { delay_minutes: 1 });
        const result = validateEscalationPolicy(policy);
        expect(result).toEqual({ valid: true, errors: [] });
      });

      it('accepts maximum delay of 60 minutes', () => {
        const policy = makePolicy(3, { delay_minutes: 60 });
        const result = validateEscalationPolicy(policy);
        expect(result).toEqual({ valid: true, errors: [] });
      });

      it('accepts mixed channels across tiers', () => {
        const policy = {
          id: 1,
          monitor_id: 1,
          tiers: [
            makeTier({ level: 1, channel: 'telegram', contact: '123' }),
            makeTier({ level: 2, channel: 'email', contact: 'a@b.com' }),
            makeTier({ level: 3, channel: 'telegram', contact: '456' }),
          ]
        };
        const result = validateEscalationPolicy(policy);
        expect(result).toEqual({ valid: true, errors: [] });
      });
    });

    describe('invalid policy object', () => {
      it('rejects null', () => {
        const result = validateEscalationPolicy(null);
        expect(result.valid).toBe(false);
        expect(result.errors).toContain('Policy must be an object');
      });

      it('rejects undefined', () => {
        const result = validateEscalationPolicy(undefined);
        expect(result.valid).toBe(false);
        expect(result.errors).toContain('Policy must be an object');
      });

      it('rejects a string', () => {
        const result = validateEscalationPolicy('not a policy');
        expect(result.valid).toBe(false);
        expect(result.errors).toContain('Policy must be an object');
      });

      it('rejects a number', () => {
        const result = validateEscalationPolicy(42);
        expect(result.valid).toBe(false);
        expect(result.errors).toContain('Policy must be an object');
      });
    });

    describe('invalid tiers array', () => {
      it('rejects policy without tiers property', () => {
        const result = validateEscalationPolicy({ id: 1, monitor_id: 1 });
        expect(result.valid).toBe(false);
        expect(result.errors).toContain('Policy must have a tiers array');
      });

      it('rejects policy with non-array tiers', () => {
        const result = validateEscalationPolicy({ tiers: 'not an array' });
        expect(result.valid).toBe(false);
        expect(result.errors).toContain('Policy must have a tiers array');
      });
    });

    describe('tier count validation', () => {
      it('rejects fewer than 3 tiers', () => {
        const policy = makePolicy(2);
        const result = validateEscalationPolicy(policy);
        expect(result.valid).toBe(false);
        expect(result.errors[0]).toContain('between 3 and 10 tiers');
      });

      it('rejects empty tiers array', () => {
        const result = validateEscalationPolicy({ tiers: [] });
        expect(result.valid).toBe(false);
        expect(result.errors[0]).toContain('between 3 and 10 tiers');
      });

      it('rejects 1 tier', () => {
        const policy = makePolicy(1);
        const result = validateEscalationPolicy(policy);
        expect(result.valid).toBe(false);
        expect(result.errors[0]).toContain('between 3 and 10 tiers');
      });

      it('rejects more than 10 tiers', () => {
        const policy = makePolicy(11);
        const result = validateEscalationPolicy(policy);
        expect(result.valid).toBe(false);
        expect(result.errors[0]).toContain('between 3 and 10 tiers');
      });
    });

    describe('tier level validation', () => {
      it('rejects level 0', () => {
        const policy = makePolicy(3);
        policy.tiers[0].level = 0;
        const result = validateEscalationPolicy(policy);
        expect(result.valid).toBe(false);
        expect(result.errors[0]).toContain('level must be an integer between 1 and 10');
      });

      it('rejects level 11', () => {
        const policy = makePolicy(3);
        policy.tiers[0].level = 11;
        const result = validateEscalationPolicy(policy);
        expect(result.valid).toBe(false);
        expect(result.errors[0]).toContain('level must be an integer between 1 and 10');
      });

      it('rejects non-integer level', () => {
        const policy = makePolicy(3);
        policy.tiers[0].level = 1.5;
        const result = validateEscalationPolicy(policy);
        expect(result.valid).toBe(false);
        expect(result.errors[0]).toContain('level must be an integer between 1 and 10');
      });

      it('rejects non-number level', () => {
        const policy = makePolicy(3);
        policy.tiers[0].level = 'first';
        const result = validateEscalationPolicy(policy);
        expect(result.valid).toBe(false);
        expect(result.errors[0]).toContain('level must be an integer between 1 and 10');
      });
    });

    describe('tier channel validation', () => {
      it('rejects invalid channel', () => {
        const policy = makePolicy(3);
        policy.tiers[1].channel = 'sms';
        const result = validateEscalationPolicy(policy);
        expect(result.valid).toBe(false);
        expect(result.errors[0]).toContain("channel must be 'telegram' or 'email'");
      });

      it('rejects undefined channel', () => {
        const policy = makePolicy(3);
        policy.tiers[0].channel = undefined;
        const result = validateEscalationPolicy(policy);
        expect(result.valid).toBe(false);
        expect(result.errors[0]).toContain("channel must be 'telegram' or 'email'");
      });
    });

    describe('tier contact validation', () => {
      it('rejects empty string contact', () => {
        const policy = makePolicy(3);
        policy.tiers[0].contact = '';
        const result = validateEscalationPolicy(policy);
        expect(result.valid).toBe(false);
        expect(result.errors[0]).toContain('contact must be a non-empty string');
      });

      it('rejects whitespace-only contact', () => {
        const policy = makePolicy(3);
        policy.tiers[0].contact = '   ';
        const result = validateEscalationPolicy(policy);
        expect(result.valid).toBe(false);
        expect(result.errors[0]).toContain('contact must be a non-empty string');
      });

      it('rejects null contact', () => {
        const policy = makePolicy(3);
        policy.tiers[0].contact = null;
        const result = validateEscalationPolicy(policy);
        expect(result.valid).toBe(false);
        expect(result.errors[0]).toContain('contact must be a non-empty string');
      });

      it('rejects numeric contact', () => {
        const policy = makePolicy(3);
        policy.tiers[0].contact = 12345;
        const result = validateEscalationPolicy(policy);
        expect(result.valid).toBe(false);
        expect(result.errors[0]).toContain('contact must be a non-empty string');
      });
    });

    describe('tier delay_minutes validation', () => {
      it('rejects delay less than 1', () => {
        const policy = makePolicy(3);
        policy.tiers[0].delay_minutes = 0;
        const result = validateEscalationPolicy(policy);
        expect(result.valid).toBe(false);
        expect(result.errors[0]).toContain('delay_minutes must be an integer between 1 and 60');
      });

      it('rejects delay greater than 60', () => {
        const policy = makePolicy(3);
        policy.tiers[0].delay_minutes = 61;
        const result = validateEscalationPolicy(policy);
        expect(result.valid).toBe(false);
        expect(result.errors[0]).toContain('delay_minutes must be an integer between 1 and 60');
      });

      it('rejects non-integer delay', () => {
        const policy = makePolicy(3);
        policy.tiers[0].delay_minutes = 5.5;
        const result = validateEscalationPolicy(policy);
        expect(result.valid).toBe(false);
        expect(result.errors[0]).toContain('delay_minutes must be an integer between 1 and 60');
      });

      it('rejects non-number delay', () => {
        const policy = makePolicy(3);
        policy.tiers[0].delay_minutes = '5';
        const result = validateEscalationPolicy(policy);
        expect(result.valid).toBe(false);
        expect(result.errors[0]).toContain('delay_minutes must be an integer between 1 and 60');
      });

      it('rejects negative delay', () => {
        const policy = makePolicy(3);
        policy.tiers[0].delay_minutes = -1;
        const result = validateEscalationPolicy(policy);
        expect(result.valid).toBe(false);
        expect(result.errors[0]).toContain('delay_minutes must be an integer between 1 and 60');
      });
    });

    describe('multiple errors', () => {
      it('collects errors from multiple invalid tiers', () => {
        const policy = {
          tiers: [
            makeTier({ level: 1 }),
            makeTier({ level: 2, channel: 'sms' }),
            makeTier({ level: 3, contact: '' }),
          ]
        };
        const result = validateEscalationPolicy(policy);
        expect(result.valid).toBe(false);
        expect(result.errors.length).toBe(2);
      });

      it('reports non-object tiers', () => {
        const policy = {
          tiers: [null, makeTier({ level: 2 }), makeTier({ level: 3 })]
        };
        const result = validateEscalationPolicy(policy);
        expect(result.valid).toBe(false);
        expect(result.errors[0]).toContain('must be an object');
      });
    });
  });
});
