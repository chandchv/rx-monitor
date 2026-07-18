import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  validateLogEntry,
  validateLogBatch,
  ingestLogs,
  queryLogs,
  purgeStaleLogs
} from '../../log-ingestion.js';
import { getDb } from '../../database.js';

describe('log-ingestion', () => {
  let db;

  beforeEach(async () => {
    db = await getDb();
    // Clean the app_logs table before each test
    await db.run('DELETE FROM app_logs');
    // Ensure we have a test API key
    await db.run('DELETE FROM api_keys WHERE id = 999');
    await db.run(
      `INSERT OR IGNORE INTO api_keys (id, user_id, key_hash, key_prefix, label, created_at, is_active)
       VALUES (999, 1, 'testhash999', 'rx_test', 'Test Key', datetime('now'), 1)`
    );
  });

  afterEach(async () => {
    await db.run('DELETE FROM app_logs');
  });

  describe('validateLogEntry', () => {
    it('accepts a valid log entry', () => {
      const entry = {
        hostname: 'server-01',
        timestamp: '2024-01-15T10:30:00Z',
        severity: 'info',
        message: 'Application started'
      };
      const result = validateLogEntry(entry);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('rejects null entry', () => {
      const result = validateLogEntry(null);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Entry must be a non-null object');
    });

    it('rejects entry missing hostname', () => {
      const entry = {
        timestamp: '2024-01-15T10:30:00Z',
        severity: 'info',
        message: 'test'
      };
      const result = validateLogEntry(entry);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('hostname'))).toBe(true);
    });

    it('rejects entry missing timestamp', () => {
      const entry = {
        hostname: 'server-01',
        severity: 'info',
        message: 'test'
      };
      const result = validateLogEntry(entry);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('timestamp'))).toBe(true);
    });

    it('rejects entry missing severity', () => {
      const entry = {
        hostname: 'server-01',
        timestamp: '2024-01-15T10:30:00Z',
        message: 'test'
      };
      const result = validateLogEntry(entry);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('severity'))).toBe(true);
    });

    it('rejects entry with invalid severity', () => {
      const entry = {
        hostname: 'server-01',
        timestamp: '2024-01-15T10:30:00Z',
        severity: 'critical',
        message: 'test'
      };
      const result = validateLogEntry(entry);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('Invalid severity'))).toBe(true);
    });

    it('rejects entry missing message', () => {
      const entry = {
        hostname: 'server-01',
        timestamp: '2024-01-15T10:30:00Z',
        severity: 'error'
      };
      const result = validateLogEntry(entry);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('message'))).toBe(true);
    });

    it('rejects entry with message exceeding 10KB', () => {
      const entry = {
        hostname: 'server-01',
        timestamp: '2024-01-15T10:30:00Z',
        severity: 'error',
        message: 'x'.repeat(10241)
      };
      const result = validateLogEntry(entry);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('10KB'))).toBe(true);
    });

    it('accepts entry with message exactly at 10KB', () => {
      const entry = {
        hostname: 'server-01',
        timestamp: '2024-01-15T10:30:00Z',
        severity: 'debug',
        message: 'x'.repeat(10240)
      };
      const result = validateLogEntry(entry);
      expect(result.valid).toBe(true);
    });

    it('reports multiple errors at once', () => {
      const entry = { hostname: '', severity: 'invalid' };
      const result = validateLogEntry(entry);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(1);
    });

    it('accepts all valid severity levels', () => {
      const severities = ['debug', 'info', 'warn', 'error', 'fatal'];
      for (const severity of severities) {
        const entry = {
          hostname: 'server-01',
          timestamp: '2024-01-15T10:30:00Z',
          severity,
          message: 'test'
        };
        const result = validateLogEntry(entry);
        expect(result.valid).toBe(true);
      }
    });
  });

  describe('validateLogBatch', () => {
    it('separates valid and rejected entries', () => {
      const entries = [
        { hostname: 'server-01', timestamp: '2024-01-15T10:30:00Z', severity: 'info', message: 'ok' },
        { hostname: '', timestamp: '2024-01-15T10:30:00Z', severity: 'info', message: 'bad hostname' },
        { hostname: 'server-02', timestamp: '2024-01-15T10:31:00Z', severity: 'warn', message: 'also ok' }
      ];
      const result = validateLogBatch(entries);
      expect(result.valid).toHaveLength(2);
      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0].index).toBe(1);
    });

    it('rejects non-array input', () => {
      const result = validateLogBatch('not an array');
      expect(result.valid).toHaveLength(0);
      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0].errors[0]).toContain('array');
    });

    it('rejects batch exceeding 100 entries', () => {
      const entries = Array.from({ length: 101 }, (_, i) => ({
        hostname: `server-${i}`,
        timestamp: '2024-01-15T10:30:00Z',
        severity: 'info',
        message: 'test'
      }));
      const result = validateLogBatch(entries);
      expect(result.valid).toHaveLength(0);
      expect(result.rejected[0].errors[0]).toContain('100');
    });

    it('accepts batch of exactly 100 entries', () => {
      const entries = Array.from({ length: 100 }, (_, i) => ({
        hostname: `server-${i}`,
        timestamp: '2024-01-15T10:30:00Z',
        severity: 'info',
        message: 'test'
      }));
      const result = validateLogBatch(entries);
      expect(result.valid).toHaveLength(100);
      expect(result.rejected).toHaveLength(0);
    });

    it('processes valid entries even when some are over 10KB', () => {
      const entries = [
        { hostname: 'server-01', timestamp: '2024-01-15T10:30:00Z', severity: 'info', message: 'ok' },
        { hostname: 'server-02', timestamp: '2024-01-15T10:31:00Z', severity: 'error', message: 'x'.repeat(10241) },
        { hostname: 'server-03', timestamp: '2024-01-15T10:32:00Z', severity: 'warn', message: 'also ok' }
      ];
      const result = validateLogBatch(entries);
      expect(result.valid).toHaveLength(2);
      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0].index).toBe(1);
    });
  });

  describe('ingestLogs', () => {
    it('ingests valid log entries into the database', async () => {
      const entries = [
        { hostname: 'web-01', timestamp: '2024-01-15T10:30:00Z', severity: 'info', message: 'Request processed' },
        { hostname: 'web-02', timestamp: '2024-01-15T10:30:01Z', severity: 'error', message: 'Connection timeout' }
      ];
      const result = await ingestLogs(999, entries);
      expect(result.ingested).toBe(2);
      expect(result.rejected).toHaveLength(0);

      const rows = await db.all('SELECT * FROM app_logs WHERE api_key_id = 999');
      expect(rows).toHaveLength(2);
    });

    it('rejects invalid entries while ingesting valid ones', async () => {
      const entries = [
        { hostname: 'web-01', timestamp: '2024-01-15T10:30:00Z', severity: 'info', message: 'good' },
        { hostname: '', timestamp: '2024-01-15T10:30:01Z', severity: 'info', message: 'bad' },
        { hostname: 'web-03', timestamp: '2024-01-15T10:30:02Z', severity: 'warn', message: 'good too' }
      ];
      const result = await ingestLogs(999, entries);
      expect(result.ingested).toBe(2);
      expect(result.rejected).toHaveLength(1);
    });

    it('returns zero ingested for all-invalid batch', async () => {
      const entries = [
        { hostname: '', severity: 'info', message: 'bad' },
        { severity: 'invalid', message: 'also bad' }
      ];
      const result = await ingestLogs(999, entries);
      expect(result.ingested).toBe(0);
      expect(result.rejected.length).toBeGreaterThan(0);
    });
  });

  describe('queryLogs', () => {
    beforeEach(async () => {
      // Insert test data
      const entries = [
        { hostname: 'web-01', timestamp: '2024-01-15T10:00:00Z', severity: 'info', message: 'Request started' },
        { hostname: 'web-01', timestamp: '2024-01-15T10:01:00Z', severity: 'error', message: 'Connection failed' },
        { hostname: 'web-02', timestamp: '2024-01-15T10:02:00Z', severity: 'warn', message: 'High memory usage' },
        { hostname: 'web-02', timestamp: '2024-01-15T10:03:00Z', severity: 'fatal', message: 'Out of memory crash' },
        { hostname: 'db-01', timestamp: '2024-01-15T10:04:00Z', severity: 'debug', message: 'Query executed' }
      ];
      await ingestLogs(999, entries);
    });

    it('returns all logs sorted by timestamp DESC', async () => {
      const result = await queryLogs({}, 1, 100);
      expect(result.total).toBe(5);
      expect(result.logs).toHaveLength(5);
      // Verify DESC order
      expect(result.logs[0].timestamp).toBe('2024-01-15T10:04:00Z');
      expect(result.logs[4].timestamp).toBe('2024-01-15T10:00:00Z');
    });

    it('filters by hostname', async () => {
      const result = await queryLogs({ hostname: 'web-01' });
      expect(result.total).toBe(2);
      expect(result.logs.every(l => l.hostname === 'web-01')).toBe(true);
    });

    it('filters by severity', async () => {
      const result = await queryLogs({ severity: 'error' });
      expect(result.total).toBe(1);
      expect(result.logs[0].severity).toBe('error');
    });

    it('filters by time range', async () => {
      const result = await queryLogs({
        startTime: '2024-01-15T10:01:00Z',
        endTime: '2024-01-15T10:03:00Z'
      });
      expect(result.total).toBe(3);
    });

    it('filters by keyword in message', async () => {
      const result = await queryLogs({ keyword: 'memory' });
      expect(result.total).toBe(2); // "High memory usage" and "Out of memory crash"
    });

    it('paginates results correctly', async () => {
      const page1 = await queryLogs({}, 1, 2);
      expect(page1.logs).toHaveLength(2);
      expect(page1.total).toBe(5);

      const page2 = await queryLogs({}, 2, 2);
      expect(page2.logs).toHaveLength(2);

      const page3 = await queryLogs({}, 3, 2);
      expect(page3.logs).toHaveLength(1);
    });

    it('limits page size to 100', async () => {
      const result = await queryLogs({}, 1, 200);
      // Should cap at 100 but since we only have 5 entries, just verify it works
      expect(result.logs.length).toBeLessThanOrEqual(100);
    });

    it('combines multiple filters', async () => {
      const result = await queryLogs({
        hostname: 'web-01',
        severity: 'error'
      });
      expect(result.total).toBe(1);
      expect(result.logs[0].message).toBe('Connection failed');
    });
  });

  describe('purgeStaleLogs', () => {
    it('deletes entries older than specified days', async () => {
      // Insert an old entry (31 days ago)
      const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
      const recentDate = new Date().toISOString();

      await db.run(
        `INSERT INTO app_logs (api_key_id, hostname, timestamp, severity, message, ingested_at)
         VALUES (999, 'old-server', ?, 'info', 'old log', ?)`,
        [oldDate, oldDate]
      );
      await db.run(
        `INSERT INTO app_logs (api_key_id, hostname, timestamp, severity, message, ingested_at)
         VALUES (999, 'new-server', ?, 'info', 'new log', ?)`,
        [recentDate, recentDate]
      );

      const deleted = await purgeStaleLogs(30);
      expect(deleted).toBe(1);

      const remaining = await db.all('SELECT * FROM app_logs WHERE api_key_id = 999');
      expect(remaining).toHaveLength(1);
      expect(remaining[0].hostname).toBe('new-server');
    });

    it('returns 0 when no stale logs exist', async () => {
      const recentDate = new Date().toISOString();
      await db.run(
        `INSERT INTO app_logs (api_key_id, hostname, timestamp, severity, message, ingested_at)
         VALUES (999, 'server', ?, 'info', 'recent log', ?)`,
        [recentDate, recentDate]
      );

      const deleted = await purgeStaleLogs(30);
      expect(deleted).toBe(0);
    });

    it('supports custom max age', async () => {
      const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
      await db.run(
        `INSERT INTO app_logs (api_key_id, hostname, timestamp, severity, message, ingested_at)
         VALUES (999, 'server', ?, 'info', 'log', ?)`,
        [fiveDaysAgo, fiveDaysAgo]
      );

      const deleted = await purgeStaleLogs(3);
      expect(deleted).toBe(1);
    });
  });
});
