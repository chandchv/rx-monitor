import { describe, it, expect } from 'vitest';
import { getCurrentOnCall, getNextOnCall, validateRotationConfig } from '../../on-call-scheduler.js';

const makeTeam = (count) => {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    name: `Member ${i + 1}`,
    telegram_chat_id: `chat_${i + 1}`,
    email: `member${i + 1}@example.com`
  }));
};

describe('on-call-scheduler', () => {
  describe('getCurrentOnCall', () => {
    const team = makeTeam(4);
    const startTime = new Date('2024-01-01T00:00:00Z').getTime();

    it('returns the first member at rotation start', () => {
      const result = getCurrentOnCall(team, startTime, 24, startTime);
      expect(result).toEqual(team[0]);
    });

    it('advances to next member after one interval', () => {
      const oneDay = 24 * 60 * 60 * 1000;
      const result = getCurrentOnCall(team, startTime, 24, startTime + oneDay);
      expect(result).toEqual(team[1]);
    });

    it('wraps around after all members have had a turn', () => {
      const fourDays = 4 * 24 * 60 * 60 * 1000;
      const result = getCurrentOnCall(team, startTime, 24, startTime + fourDays);
      expect(result).toEqual(team[0]);
    });

    it('handles weekly rotation (168h)', () => {
      const oneWeek = 168 * 60 * 60 * 1000;
      const result = getCurrentOnCall(team, startTime, 168, startTime + oneWeek);
      expect(result).toEqual(team[1]);
    });

    it('handles custom interval (8h)', () => {
      const eightHours = 8 * 60 * 60 * 1000;
      const result = getCurrentOnCall(team, startTime, 8, startTime + eightHours * 2);
      expect(result).toEqual(team[2]);
    });

    it('returns first member when currentTime is before rotation start', () => {
      const result = getCurrentOnCall(team, startTime, 24, startTime - 1000);
      expect(result).toEqual(team[0]);
    });

    it('returns null for empty team array', () => {
      const result = getCurrentOnCall([], startTime, 24, startTime);
      expect(result).toBeNull();
    });

    it('returns null for non-array team', () => {
      const result = getCurrentOnCall(null, startTime, 24, startTime);
      expect(result).toBeNull();
    });

    it('returns null for invalid intervalHours', () => {
      const result = getCurrentOnCall(team, startTime, 0, startTime);
      expect(result).toBeNull();
    });

    it('returns null for negative intervalHours', () => {
      const result = getCurrentOnCall(team, startTime, -5, startTime);
      expect(result).toBeNull();
    });

    it('returns null for non-number rotationStartTime', () => {
      const result = getCurrentOnCall(team, 'invalid', 24, startTime);
      expect(result).toBeNull();
    });

    it('correctly computes index with large elapsed time', () => {
      // 10 full rotations + 2 intervals
      const elapsed = (10 * 4 + 2) * 24 * 60 * 60 * 1000;
      const result = getCurrentOnCall(team, startTime, 24, startTime + elapsed);
      expect(result).toEqual(team[2]);
    });

    it('works with a team of 2 members', () => {
      const smallTeam = makeTeam(2);
      const oneDay = 24 * 60 * 60 * 1000;
      expect(getCurrentOnCall(smallTeam, startTime, 24, startTime)).toEqual(smallTeam[0]);
      expect(getCurrentOnCall(smallTeam, startTime, 24, startTime + oneDay)).toEqual(smallTeam[1]);
      expect(getCurrentOnCall(smallTeam, startTime, 24, startTime + 2 * oneDay)).toEqual(smallTeam[0]);
    });

    it('works with a team of 50 members', () => {
      const largeTeam = makeTeam(50);
      const oneHour = 60 * 60 * 1000;
      // At interval 49 (0-indexed), should be last member
      const result = getCurrentOnCall(largeTeam, startTime, 1, startTime + 49 * oneHour);
      expect(result).toEqual(largeTeam[49]);
      // At interval 50, wraps to first
      const wrapped = getCurrentOnCall(largeTeam, startTime, 1, startTime + 50 * oneHour);
      expect(wrapped).toEqual(largeTeam[0]);
    });
  });

  describe('getNextOnCall', () => {
    const team = makeTeam(4);

    it('returns the next member in the list', () => {
      const result = getNextOnCall(team, 0);
      expect(result).toEqual(team[1]);
    });

    it('wraps from last to first', () => {
      const result = getNextOnCall(team, 3);
      expect(result).toEqual(team[0]);
    });

    it('wraps from middle', () => {
      const result = getNextOnCall(team, 2);
      expect(result).toEqual(team[3]);
    });

    it('returns null for empty array', () => {
      const result = getNextOnCall([], 0);
      expect(result).toBeNull();
    });

    it('returns null for non-array', () => {
      const result = getNextOnCall(null, 0);
      expect(result).toBeNull();
    });

    it('returns null for negative index', () => {
      const result = getNextOnCall(team, -1);
      expect(result).toBeNull();
    });

    it('handles index beyond array length (wraps)', () => {
      const result = getNextOnCall(team, 5);
      expect(result).toEqual(team[2]); // (5+1) % 4 = 2
    });
  });

  describe('validateRotationConfig', () => {
    const validConfig = {
      teamMembers: makeTeam(3),
      intervalHours: 24,
      rotationStartTime: new Date('2024-01-01T00:00:00Z').getTime()
    };

    it('accepts a valid config', () => {
      const result = validateRotationConfig(validConfig);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('rejects null config', () => {
      const result = validateRotationConfig(null);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Config must be an object');
    });

    it('rejects non-object config', () => {
      const result = validateRotationConfig('invalid');
      expect(result.valid).toBe(false);
    });

    it('requires teamMembers to be an array', () => {
      const result = validateRotationConfig({ ...validConfig, teamMembers: 'not-array' });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('teamMembers must be an array');
    });

    it('rejects fewer than 2 team members', () => {
      const result = validateRotationConfig({ ...validConfig, teamMembers: makeTeam(1) });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('at least 2');
    });

    it('rejects more than 50 team members', () => {
      const result = validateRotationConfig({ ...validConfig, teamMembers: makeTeam(51) });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('at most 50');
    });

    it('validates team member has id as integer', () => {
      const members = [{ id: 'abc', name: 'A', email: 'a@b.com' }, ...makeTeam(2)];
      const result = validateRotationConfig({ ...validConfig, teamMembers: members });
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('id must be an integer'))).toBe(true);
    });

    it('validates team member has non-empty name', () => {
      const members = [{ id: 1, name: '', email: 'a@b.com' }, ...makeTeam(2)];
      const result = validateRotationConfig({ ...validConfig, teamMembers: members });
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('name must be a non-empty string'))).toBe(true);
    });

    it('validates team member has at least one contact method', () => {
      const members = [
        { id: 1, name: 'NoContact', telegram_chat_id: null, email: null },
        ...makeTeam(2)
      ];
      const result = validateRotationConfig({ ...validConfig, teamMembers: members });
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('at least one contact method'))).toBe(true);
    });

    it('accepts member with only telegram', () => {
      const members = [
        { id: 1, name: 'TelegramOnly', telegram_chat_id: '12345', email: null },
        ...makeTeam(2)
      ];
      const result = validateRotationConfig({ ...validConfig, teamMembers: members });
      expect(result.valid).toBe(true);
    });

    it('accepts member with only email', () => {
      const members = [
        { id: 1, name: 'EmailOnly', telegram_chat_id: null, email: 'test@example.com' },
        ...makeTeam(2)
      ];
      const result = validateRotationConfig({ ...validConfig, teamMembers: members });
      expect(result.valid).toBe(true);
    });

    it('rejects intervalHours below minimum (1)', () => {
      const result = validateRotationConfig({ ...validConfig, intervalHours: 0 });
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('between 1 and 720'))).toBe(true);
    });

    it('rejects intervalHours above maximum (720)', () => {
      const result = validateRotationConfig({ ...validConfig, intervalHours: 721 });
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('between 1 and 720'))).toBe(true);
    });

    it('accepts daily interval (24)', () => {
      const result = validateRotationConfig({ ...validConfig, intervalHours: 24 });
      expect(result.valid).toBe(true);
    });

    it('accepts weekly interval (168)', () => {
      const result = validateRotationConfig({ ...validConfig, intervalHours: 168 });
      expect(result.valid).toBe(true);
    });

    it('accepts custom interval (8)', () => {
      const result = validateRotationConfig({ ...validConfig, intervalHours: 8 });
      expect(result.valid).toBe(true);
    });

    it('rejects non-number intervalHours', () => {
      const result = validateRotationConfig({ ...validConfig, intervalHours: 'daily' });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('intervalHours must be a number');
    });

    it('requires rotationStartTime', () => {
      const result = validateRotationConfig({ ...validConfig, rotationStartTime: undefined });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('rotationStartTime is required');
    });

    it('accepts ISO date string for rotationStartTime', () => {
      const result = validateRotationConfig({ ...validConfig, rotationStartTime: '2024-01-01T00:00:00Z' });
      expect(result.valid).toBe(true);
    });

    it('rejects invalid rotationStartTime string', () => {
      const result = validateRotationConfig({ ...validConfig, rotationStartTime: 'not-a-date' });
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('valid timestamp or ISO date'))).toBe(true);
    });

    it('accepts config without override', () => {
      const result = validateRotationConfig(validConfig);
      expect(result.valid).toBe(true);
    });

    it('validates override memberId is integer', () => {
      const config = { ...validConfig, override: { memberId: 'abc', endTime: Date.now() + 3600000 } };
      const result = validateRotationConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('override.memberId must be an integer'))).toBe(true);
    });

    it('requires override endTime', () => {
      const config = { ...validConfig, override: { memberId: 1 } };
      const result = validateRotationConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('override.endTime is required'))).toBe(true);
    });

    it('accepts valid override', () => {
      const config = { ...validConfig, override: { memberId: 1, endTime: Date.now() + 3600000 } };
      const result = validateRotationConfig(config);
      expect(result.valid).toBe(true);
    });
  });
});
