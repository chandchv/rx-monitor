import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateMaintenanceWindow } from '../../maintenance-window.js';

describe('maintenance-window', () => {
  describe('validateMaintenanceWindow', () => {
    it('returns valid for a correct one-time window', () => {
      const window = {
        monitor_id: 1,
        start_time: '2024-06-01T02:00:00Z',
        end_time: '2024-06-01T04:00:00Z',
        timezone: 'UTC',
        recurrence: 'once',
      };
      const result = validateMaintenanceWindow(window);
      expect(result).toEqual({ valid: true, errors: [] });
    });

    it('returns valid for a recurring daily window', () => {
      const window = {
        monitor_id: 5,
        start_time: '2024-06-01T22:00:00Z',
        end_time: '2024-06-01T23:30:00Z',
        timezone: 'America/New_York',
        recurrence: 'daily',
      };
      const result = validateMaintenanceWindow(window);
      expect(result).toEqual({ valid: true, errors: [] });
    });

    it('returns valid for a recurring weekly window', () => {
      const window = {
        monitor_id: 2,
        start_time: '2024-06-03T01:00:00Z',
        end_time: '2024-06-03T05:00:00Z',
        timezone: 'Europe/London',
        recurrence: 'weekly',
      };
      const result = validateMaintenanceWindow(window);
      expect(result).toEqual({ valid: true, errors: [] });
    });

    it('returns valid for a recurring monthly window', () => {
      const window = {
        monitor_id: 3,
        start_time: '2024-06-15T03:00:00Z',
        end_time: '2024-06-15T06:00:00Z',
        timezone: 'Asia/Tokyo',
        recurrence: 'monthly',
      };
      const result = validateMaintenanceWindow(window);
      expect(result).toEqual({ valid: true, errors: [] });
    });

    it('returns valid when recurrence is null', () => {
      const window = {
        monitor_id: 1,
        start_time: '2024-06-01T02:00:00Z',
        end_time: '2024-06-01T04:00:00Z',
        timezone: 'UTC',
        recurrence: null,
      };
      const result = validateMaintenanceWindow(window);
      expect(result).toEqual({ valid: true, errors: [] });
    });

    it('returns valid when timezone is omitted (defaults handled elsewhere)', () => {
      const window = {
        monitor_id: 1,
        start_time: '2024-06-01T02:00:00Z',
        end_time: '2024-06-01T04:00:00Z',
        recurrence: 'once',
      };
      const result = validateMaintenanceWindow(window);
      expect(result).toEqual({ valid: true, errors: [] });
    });

    // Error cases

    it('rejects null input', () => {
      const result = validateMaintenanceWindow(null);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Window must be a non-null object');
    });

    it('rejects non-object input', () => {
      const result = validateMaintenanceWindow('string');
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Window must be a non-null object');
    });

    it('rejects missing start_time', () => {
      const window = {
        monitor_id: 1,
        end_time: '2024-06-01T04:00:00Z',
        recurrence: 'once',
      };
      const result = validateMaintenanceWindow(window);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('start_time is required');
    });

    it('rejects missing end_time', () => {
      const window = {
        monitor_id: 1,
        start_time: '2024-06-01T02:00:00Z',
        recurrence: 'once',
      };
      const result = validateMaintenanceWindow(window);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('end_time is required');
    });

    it('rejects invalid start_time format', () => {
      const window = {
        monitor_id: 1,
        start_time: 'not-a-date',
        end_time: '2024-06-01T04:00:00Z',
        recurrence: 'once',
      };
      const result = validateMaintenanceWindow(window);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('start_time must be a valid date/time string');
    });

    it('rejects invalid end_time format', () => {
      const window = {
        monitor_id: 1,
        start_time: '2024-06-01T02:00:00Z',
        end_time: 'bad-date',
        recurrence: 'once',
      };
      const result = validateMaintenanceWindow(window);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('end_time must be a valid date/time string');
    });

    it('rejects end_time before start_time', () => {
      const window = {
        monitor_id: 1,
        start_time: '2024-06-01T04:00:00Z',
        end_time: '2024-06-01T02:00:00Z',
        recurrence: 'once',
      };
      const result = validateMaintenanceWindow(window);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('end_time must be after start_time');
    });

    it('rejects end_time equal to start_time', () => {
      const window = {
        monitor_id: 1,
        start_time: '2024-06-01T04:00:00Z',
        end_time: '2024-06-01T04:00:00Z',
        recurrence: 'once',
      };
      const result = validateMaintenanceWindow(window);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('end_time must be after start_time');
    });

    it('rejects duration exceeding 24 hours', () => {
      const window = {
        monitor_id: 1,
        start_time: '2024-06-01T00:00:00Z',
        end_time: '2024-06-02T00:01:00Z', // 24h + 1min
        recurrence: 'once',
      };
      const result = validateMaintenanceWindow(window);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Duration must not exceed 24 hours');
    });

    it('accepts exactly 24 hours duration', () => {
      const window = {
        monitor_id: 1,
        start_time: '2024-06-01T00:00:00Z',
        end_time: '2024-06-02T00:00:00Z', // exactly 24h
        recurrence: 'once',
      };
      const result = validateMaintenanceWindow(window);
      expect(result).toEqual({ valid: true, errors: [] });
    });

    it('rejects invalid recurrence value', () => {
      const window = {
        monitor_id: 1,
        start_time: '2024-06-01T02:00:00Z',
        end_time: '2024-06-01T04:00:00Z',
        recurrence: 'biweekly',
      };
      const result = validateMaintenanceWindow(window);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('recurrence must be one of');
    });

    it('rejects invalid timezone', () => {
      const window = {
        monitor_id: 1,
        start_time: '2024-06-01T02:00:00Z',
        end_time: '2024-06-01T04:00:00Z',
        timezone: 'Invalid/Timezone',
        recurrence: 'once',
      };
      const result = validateMaintenanceWindow(window);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('timezone must be a valid IANA timezone identifier');
    });

    it('rejects missing monitor_id', () => {
      const window = {
        start_time: '2024-06-01T02:00:00Z',
        end_time: '2024-06-01T04:00:00Z',
        recurrence: 'once',
      };
      const result = validateMaintenanceWindow(window);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('monitor_id is required');
    });

    it('rejects non-integer monitor_id', () => {
      const window = {
        monitor_id: 1.5,
        start_time: '2024-06-01T02:00:00Z',
        end_time: '2024-06-01T04:00:00Z',
        recurrence: 'once',
      };
      const result = validateMaintenanceWindow(window);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('monitor_id must be a positive integer');
    });

    it('rejects negative monitor_id', () => {
      const window = {
        monitor_id: -1,
        start_time: '2024-06-01T02:00:00Z',
        end_time: '2024-06-01T04:00:00Z',
        recurrence: 'once',
      };
      const result = validateMaintenanceWindow(window);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('monitor_id must be a positive integer');
    });

    it('collects multiple errors at once', () => {
      const window = {
        start_time: 'bad',
        end_time: 'bad',
        timezone: 'Invalid/TZ',
        recurrence: 'yearly',
      };
      const result = validateMaintenanceWindow(window);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe('isWithinMaintenanceWindow (with mocked DB)', () => {
    // We test the time-matching logic indirectly via getActiveWindows
    // by mocking the database module
    let mockDb;
    let isWithinMaintenanceWindow;
    let getActiveWindows;

    beforeEach(async () => {
      // Reset modules for each test
      vi.resetModules();

      mockDb = {
        all: vi.fn().mockResolvedValue([]),
      };

      vi.doMock('../../database.js', () => ({
        getDb: () => Promise.resolve(mockDb),
      }));

      const mod = await import('../../maintenance-window.js');
      isWithinMaintenanceWindow = mod.isWithinMaintenanceWindow;
      getActiveWindows = mod.getActiveWindows;
    });

    it('returns false when no windows exist for monitor', async () => {
      mockDb.all.mockResolvedValue([]);
      const result = await isWithinMaintenanceWindow(1, new Date('2024-06-01T03:00:00Z'));
      expect(result).toBe(false);
    });

    it('returns true when current time is within a one-time window', async () => {
      mockDb.all.mockResolvedValue([
        {
          id: 1,
          monitor_id: 1,
          start_time: '2024-06-01T02:00:00Z',
          end_time: '2024-06-01T04:00:00Z',
          timezone: 'UTC',
          recurrence: 'once',
          active: 1,
        },
      ]);
      const result = await isWithinMaintenanceWindow(1, new Date('2024-06-01T03:00:00Z'));
      expect(result).toBe(true);
    });

    it('returns false when current time is outside a one-time window', async () => {
      mockDb.all.mockResolvedValue([
        {
          id: 1,
          monitor_id: 1,
          start_time: '2024-06-01T02:00:00Z',
          end_time: '2024-06-01T04:00:00Z',
          timezone: 'UTC',
          recurrence: 'once',
          active: 1,
        },
      ]);
      const result = await isWithinMaintenanceWindow(1, new Date('2024-06-01T05:00:00Z'));
      expect(result).toBe(false);
    });

    it('returns true for daily recurring window at matching time', async () => {
      // Window defined as 02:00-04:00 UTC daily
      mockDb.all.mockResolvedValue([
        {
          id: 2,
          monitor_id: 1,
          start_time: '2024-06-01T02:00:00Z',
          end_time: '2024-06-01T04:00:00Z',
          timezone: 'UTC',
          recurrence: 'daily',
          active: 1,
        },
      ]);
      // Different day, same time range
      const result = await isWithinMaintenanceWindow(1, new Date('2024-06-15T03:00:00Z'));
      expect(result).toBe(true);
    });

    it('returns false for daily recurring window at non-matching time', async () => {
      mockDb.all.mockResolvedValue([
        {
          id: 2,
          monitor_id: 1,
          start_time: '2024-06-01T02:00:00Z',
          end_time: '2024-06-01T04:00:00Z',
          timezone: 'UTC',
          recurrence: 'daily',
          active: 1,
        },
      ]);
      const result = await isWithinMaintenanceWindow(1, new Date('2024-06-15T05:00:00Z'));
      expect(result).toBe(false);
    });

    it('returns true for weekly recurring window on matching day and time', async () => {
      // 2024-06-01 is a Saturday
      mockDb.all.mockResolvedValue([
        {
          id: 3,
          monitor_id: 1,
          start_time: '2024-06-01T02:00:00Z',
          end_time: '2024-06-01T04:00:00Z',
          timezone: 'UTC',
          recurrence: 'weekly',
          active: 1,
        },
      ]);
      // 2024-06-08 is also a Saturday
      const result = await isWithinMaintenanceWindow(1, new Date('2024-06-08T03:00:00Z'));
      expect(result).toBe(true);
    });

    it('returns false for weekly recurring window on wrong day', async () => {
      // 2024-06-01 is a Saturday
      mockDb.all.mockResolvedValue([
        {
          id: 3,
          monitor_id: 1,
          start_time: '2024-06-01T02:00:00Z',
          end_time: '2024-06-01T04:00:00Z',
          timezone: 'UTC',
          recurrence: 'weekly',
          active: 1,
        },
      ]);
      // 2024-06-09 is a Sunday
      const result = await isWithinMaintenanceWindow(1, new Date('2024-06-09T03:00:00Z'));
      expect(result).toBe(false);
    });

    it('returns true for monthly recurring window on matching day-of-month and time', async () => {
      // Window starts on the 15th
      mockDb.all.mockResolvedValue([
        {
          id: 4,
          monitor_id: 1,
          start_time: '2024-06-15T10:00:00Z',
          end_time: '2024-06-15T12:00:00Z',
          timezone: 'UTC',
          recurrence: 'monthly',
          active: 1,
        },
      ]);
      // July 15th at matching time
      const result = await isWithinMaintenanceWindow(1, new Date('2024-07-15T11:00:00Z'));
      expect(result).toBe(true);
    });

    it('returns false for monthly recurring window on wrong day-of-month', async () => {
      mockDb.all.mockResolvedValue([
        {
          id: 4,
          monitor_id: 1,
          start_time: '2024-06-15T10:00:00Z',
          end_time: '2024-06-15T12:00:00Z',
          timezone: 'UTC',
          recurrence: 'monthly',
          active: 1,
        },
      ]);
      // July 16th
      const result = await isWithinMaintenanceWindow(1, new Date('2024-07-16T11:00:00Z'));
      expect(result).toBe(false);
    });

    it('handles overlapping windows - returns true until all end', async () => {
      mockDb.all.mockResolvedValue([
        {
          id: 1,
          monitor_id: 1,
          start_time: '2024-06-01T02:00:00Z',
          end_time: '2024-06-01T04:00:00Z',
          timezone: 'UTC',
          recurrence: 'once',
          active: 1,
        },
        {
          id: 2,
          monitor_id: 1,
          start_time: '2024-06-01T03:00:00Z',
          end_time: '2024-06-01T05:00:00Z',
          timezone: 'UTC',
          recurrence: 'once',
          active: 1,
        },
      ]);
      // At 03:30, both windows active
      const result = await isWithinMaintenanceWindow(1, new Date('2024-06-01T03:30:00Z'));
      expect(result).toBe(true);
    });

    it('getActiveWindows returns all matching windows for overlaps', async () => {
      mockDb.all.mockResolvedValue([
        {
          id: 1,
          monitor_id: 1,
          start_time: '2024-06-01T02:00:00Z',
          end_time: '2024-06-01T04:00:00Z',
          timezone: 'UTC',
          recurrence: 'once',
          active: 1,
        },
        {
          id: 2,
          monitor_id: 1,
          start_time: '2024-06-01T03:00:00Z',
          end_time: '2024-06-01T05:00:00Z',
          timezone: 'UTC',
          recurrence: 'once',
          active: 1,
        },
      ]);
      const windows = await getActiveWindows(1, new Date('2024-06-01T03:30:00Z'));
      expect(windows.length).toBe(2);
      expect(windows[0].id).toBe(1);
      expect(windows[1].id).toBe(2);
    });

    it('handles timezone-aware window correctly', async () => {
      // Window is 02:00-04:00 America/New_York
      // During summer (EDT = UTC-4), 02:00 ET = 06:00 UTC
      mockDb.all.mockResolvedValue([
        {
          id: 5,
          monitor_id: 1,
          start_time: '2024-06-01T06:00:00Z', // 02:00 ET
          end_time: '2024-06-01T08:00:00Z',   // 04:00 ET
          timezone: 'America/New_York',
          recurrence: 'daily',
          active: 1,
        },
      ]);
      // 07:00 UTC = 03:00 ET, should be within window
      const result = await isWithinMaintenanceWindow(1, new Date('2024-06-15T07:00:00Z'));
      expect(result).toBe(true);
    });

    it('returns false for inactive windows', async () => {
      // The SQL query filters by active=1, so inactive windows won't appear
      mockDb.all.mockResolvedValue([]);
      const result = await isWithinMaintenanceWindow(1, new Date('2024-06-01T03:00:00Z'));
      expect(result).toBe(false);
    });

    it('accepts ISO string as currentTime parameter', async () => {
      mockDb.all.mockResolvedValue([
        {
          id: 1,
          monitor_id: 1,
          start_time: '2024-06-01T02:00:00Z',
          end_time: '2024-06-01T04:00:00Z',
          timezone: 'UTC',
          recurrence: 'once',
          active: 1,
        },
      ]);
      const result = await isWithinMaintenanceWindow(1, '2024-06-01T03:00:00Z');
      expect(result).toBe(true);
    });
  });
});
