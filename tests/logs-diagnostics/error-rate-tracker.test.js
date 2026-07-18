import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordErrorStatus,
  getErrorCountInWindow,
  isSpike,
  getErrorRateHistory,
  getActiveSpikeAlert,
  purgeOldEvents
} from '../../error-rate-tracker.js';
import { getDb } from '../../database.js';

describe('error-rate-tracker', () => {
  let db;

  beforeEach(async () => {
    db = await getDb();
    // Clean up test data
    await db.run('DELETE FROM error_rate_events');
    await db.run('DELETE FROM error_rate_alerts');
    // Ensure test monitor exists
    await db.run(
      `INSERT OR IGNORE INTO monitors (id, name, url, error_rate_threshold) VALUES (999, 'Test Monitor', 'https://example.com', 5)`
    );
  });

  describe('recordErrorStatus', () => {
    it('should record a 5xx status code', async () => {
      const timestamp = new Date().toISOString();
      await recordErrorStatus(999, 500, timestamp);

      const row = await db.get(
        'SELECT * FROM error_rate_events WHERE monitor_id = 999'
      );
      expect(row).toBeDefined();
      expect(row.status_code).toBe(500);
      expect(row.recorded_at).toBe(timestamp);
    });

    it('should ignore non-5xx status codes', async () => {
      await recordErrorStatus(999, 200, new Date().toISOString());
      await recordErrorStatus(999, 404, new Date().toISOString());
      await recordErrorStatus(999, 301, new Date().toISOString());

      const count = await db.get(
        'SELECT COUNT(*) as count FROM error_rate_events WHERE monitor_id = 999'
      );
      expect(count.count).toBe(0);
    });

    it('should record specific 5xx codes (500, 502, 503, 504)', async () => {
      const timestamp = new Date().toISOString();
      await recordErrorStatus(999, 500, timestamp);
      await recordErrorStatus(999, 502, timestamp);
      await recordErrorStatus(999, 503, timestamp);
      await recordErrorStatus(999, 504, timestamp);

      const rows = await db.all(
        'SELECT status_code FROM error_rate_events WHERE monitor_id = 999 ORDER BY status_code'
      );
      expect(rows.map(r => r.status_code)).toEqual([500, 502, 503, 504]);
    });

    it('should accept Date objects as timestamps', async () => {
      const date = new Date('2024-01-15T10:30:00.000Z');
      await recordErrorStatus(999, 500, date);

      const row = await db.get(
        'SELECT recorded_at FROM error_rate_events WHERE monitor_id = 999'
      );
      expect(row.recorded_at).toBe('2024-01-15T10:30:00.000Z');
    });
  });

  describe('getErrorCountInWindow', () => {
    it('should count errors within the specified window', async () => {
      const base = new Date('2024-01-15T10:00:00.000Z');
      await recordErrorStatus(999, 500, new Date(base.getTime() + 10000).toISOString());
      await recordErrorStatus(999, 502, new Date(base.getTime() + 20000).toISOString());
      await recordErrorStatus(999, 503, new Date(base.getTime() + 30000).toISOString());

      const count = await getErrorCountInWindow(
        999,
        base.toISOString(),
        new Date(base.getTime() + 60000).toISOString()
      );
      expect(count).toBe(3);
    });

    it('should not count errors outside the window', async () => {
      const base = new Date('2024-01-15T10:00:00.000Z');
      // Before window
      await recordErrorStatus(999, 500, new Date(base.getTime() - 10000).toISOString());
      // Inside window
      await recordErrorStatus(999, 502, new Date(base.getTime() + 10000).toISOString());
      // After window
      await recordErrorStatus(999, 503, new Date(base.getTime() + 70000).toISOString());

      const count = await getErrorCountInWindow(
        999,
        base.toISOString(),
        new Date(base.getTime() + 60000).toISOString()
      );
      expect(count).toBe(1);
    });

    it('should return 0 for empty windows', async () => {
      const count = await getErrorCountInWindow(
        999,
        '2024-01-15T10:00:00.000Z',
        '2024-01-15T10:01:00.000Z'
      );
      expect(count).toBe(0);
    });
  });

  describe('isSpike', () => {
    it('should return true when count exceeds threshold', () => {
      expect(isSpike(6, 5)).toBe(true);
      expect(isSpike(10, 5)).toBe(true);
    });

    it('should return false when count equals threshold', () => {
      expect(isSpike(5, 5)).toBe(false);
    });

    it('should return false when count is below threshold', () => {
      expect(isSpike(3, 5)).toBe(false);
      expect(isSpike(0, 5)).toBe(false);
    });

    it('should use default threshold (5) when not provided', () => {
      expect(isSpike(6)).toBe(true);
      expect(isSpike(5)).toBe(false);
      expect(isSpike(4)).toBe(false);
    });

    it('should clamp threshold to valid range (1-100)', () => {
      // Threshold clamped to 1
      expect(isSpike(2, 0)).toBe(true);
      expect(isSpike(1, 0)).toBe(false);
      // Threshold clamped to 100
      expect(isSpike(101, 200)).toBe(true);
      expect(isSpike(100, 200)).toBe(false);
    });
  });

  describe('spike alert lifecycle', () => {
    it('should trigger spike alert when count exceeds threshold', async () => {
      const base = new Date('2024-01-15T10:00:00.000Z');
      // Record 6 errors within 1 minute (threshold is 5)
      for (let i = 0; i < 6; i++) {
        await recordErrorStatus(999, 500, new Date(base.getTime() + i * 5000).toISOString());
      }

      const alert = await getActiveSpikeAlert(999);
      expect(alert).toBeDefined();
      expect(alert.spike_active).toBe(1);
      expect(alert.monitor_id).toBe(999);
    });

    it('should suppress additional alerts while spike is active (Req 19.6)', async () => {
      const base = new Date('2024-01-15T10:00:00.000Z');
      // Record enough errors to trigger spike
      for (let i = 0; i < 8; i++) {
        await recordErrorStatus(999, 500, new Date(base.getTime() + i * 5000).toISOString());
      }

      // Should only have one active alert, not multiple
      const alerts = await db.all(
        'SELECT * FROM error_rate_alerts WHERE monitor_id = 999 AND spike_active = 1'
      );
      expect(alerts.length).toBe(1);
    });

    it('should resolve spike and send recovery when rate drops (Req 19.3)', async () => {
      const base = new Date('2024-01-15T10:00:00.000Z');
      // Trigger a spike first
      for (let i = 0; i < 6; i++) {
        await recordErrorStatus(999, 500, new Date(base.getTime() + i * 5000).toISOString());
      }

      // Verify spike is active
      let alert = await getActiveSpikeAlert(999);
      expect(alert).toBeDefined();
      expect(alert.spike_active).toBe(1);

      // Now record an error well after the 1-min window so the count in the current window is below threshold
      const laterTime = new Date(base.getTime() + 120000).toISOString();
      await recordErrorStatus(999, 500, laterTime);

      // The spike should now be resolved since there's only 1 error in the new window
      alert = await getActiveSpikeAlert(999);
      expect(alert).toBeNull();

      // Check that the alert was marked as resolved
      const resolvedAlert = await db.get(
        'SELECT * FROM error_rate_alerts WHERE monitor_id = 999 AND spike_active = 0'
      );
      expect(resolvedAlert).toBeDefined();
      expect(resolvedAlert.resolved_at).toBe(laterTime);
    });
  });

  describe('getErrorRateHistory', () => {
    it('should return per-minute history with zero-fill', async () => {
      const history = await getErrorRateHistory(999, 1);
      // 1 hour = 60 data points
      expect(history.length).toBe(60);
      // All should have count 0 since no errors recorded
      expect(history.every(p => p.count === 0)).toBe(true);
      expect(history.every(p => Object.keys(p.codes).length === 0)).toBe(true);
    });

    it('should include status code breakdown in each data point', async () => {
      const now = new Date();
      const minuteStart = new Date(
        now.getFullYear(), now.getMonth(), now.getDate(),
        now.getHours(), now.getMinutes(), 10, 0
      );

      await recordErrorStatus(999, 500, minuteStart.toISOString());
      await recordErrorStatus(999, 502, new Date(minuteStart.getTime() + 5000).toISOString());
      await recordErrorStatus(999, 500, new Date(minuteStart.getTime() + 10000).toISOString());

      const history = await getErrorRateHistory(999, 1);
      // Find the data point with errors
      const withErrors = history.find(p => p.count > 0);
      expect(withErrors).toBeDefined();
      expect(withErrors.count).toBe(3);
      expect(withErrors.codes['500']).toBe(2);
      expect(withErrors.codes['502']).toBe(1);
    });

    it('should cap history at 1440 points (24 hours)', async () => {
      const history = await getErrorRateHistory(999, 24);
      expect(history.length).toBe(1440);
    });

    it('should cap at 24 hours even if more requested', async () => {
      const history = await getErrorRateHistory(999, 48);
      expect(history.length).toBe(1440);
    });

    it('should return correct data point shape', async () => {
      const history = await getErrorRateHistory(999, 1);
      const point = history[0];
      expect(point).toHaveProperty('minute');
      expect(point).toHaveProperty('count');
      expect(point).toHaveProperty('codes');
      expect(typeof point.minute).toBe('string');
      expect(typeof point.count).toBe('number');
      expect(typeof point.codes).toBe('object');
    });
  });

  describe('purgeOldEvents', () => {
    it('should delete events older than specified hours', async () => {
      const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      const recentTime = new Date().toISOString();

      await db.run(
        'INSERT INTO error_rate_events (monitor_id, status_code, recorded_at) VALUES (999, 500, ?)',
        [oldTime]
      );
      await db.run(
        'INSERT INTO error_rate_events (monitor_id, status_code, recorded_at) VALUES (999, 500, ?)',
        [recentTime]
      );

      const deleted = await purgeOldEvents(24);
      expect(deleted).toBe(1);

      const remaining = await db.get(
        'SELECT COUNT(*) as count FROM error_rate_events WHERE monitor_id = 999'
      );
      expect(remaining.count).toBe(1);
    });
  });
});
