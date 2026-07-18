import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { computeLoadTestStats, canRunLoadTest } from '../../load-tester.js';

describe('load-tester', () => {
  describe('computeLoadTestStats', () => {
    it('returns zero summary for empty results array', () => {
      const stats = computeLoadTestStats([]);
      expect(stats).toEqual({
        total_requests: 0,
        successful: 0,
        failed: 0,
        avg_response_ms: 0,
        p95_response_ms: 0,
        error_rate_pct: 0,
        requests_per_second: 0,
        status: 'healthy'
      });
    });

    it('returns zero summary for null input', () => {
      const stats = computeLoadTestStats(null);
      expect(stats.total_requests).toBe(0);
    });

    it('returns zero summary for undefined input', () => {
      const stats = computeLoadTestStats(undefined);
      expect(stats.total_requests).toBe(0);
    });

    it('correctly counts all successful requests', () => {
      const results = [
        { responseTimeMs: 100, statusCode: 200, error: null },
        { responseTimeMs: 150, statusCode: 201, error: null },
        { responseTimeMs: 200, statusCode: 204, error: null },
      ];
      const stats = computeLoadTestStats(results);
      expect(stats.total_requests).toBe(3);
      expect(stats.successful).toBe(3);
      expect(stats.failed).toBe(0);
      expect(stats.status).toBe('healthy');
    });

    it('correctly counts failed requests (non-2xx status)', () => {
      const results = [
        { responseTimeMs: 100, statusCode: 200, error: null },
        { responseTimeMs: 200, statusCode: 500, error: 'HTTP 500' },
        { responseTimeMs: 300, statusCode: 404, error: 'HTTP 404' },
      ];
      const stats = computeLoadTestStats(results);
      expect(stats.total_requests).toBe(3);
      expect(stats.successful).toBe(1);
      expect(stats.failed).toBe(2);
    });

    it('correctly counts failed requests (connection errors)', () => {
      const results = [
        { responseTimeMs: 100, statusCode: null, error: 'timeout' },
        { responseTimeMs: 200, statusCode: null, error: 'connection_error' },
        { responseTimeMs: 50, statusCode: 200, error: null },
      ];
      const stats = computeLoadTestStats(results);
      expect(stats.successful).toBe(1);
      expect(stats.failed).toBe(2);
    });

    it('computes correct average response time', () => {
      const results = [
        { responseTimeMs: 100, statusCode: 200, error: null },
        { responseTimeMs: 200, statusCode: 200, error: null },
        { responseTimeMs: 300, statusCode: 200, error: null },
      ];
      const stats = computeLoadTestStats(results);
      expect(stats.avg_response_ms).toBe(200);
    });

    it('computes p95 response time using nearest-rank method', () => {
      // 20 values: 10, 20, 30, ..., 200
      const results = Array.from({ length: 20 }, (_, i) => ({
        responseTimeMs: (i + 1) * 10,
        statusCode: 200,
        error: null
      }));
      const stats = computeLoadTestStats(results);
      // nearest-rank: index = ceil(95/100 * 20) - 1 = ceil(19) - 1 = 18
      // sorted[18] = 190
      expect(stats.p95_response_ms).toBe(190);
    });

    it('computes p95 for small result sets', () => {
      // 5 values: 100, 200, 300, 400, 500
      const results = [
        { responseTimeMs: 100, statusCode: 200, error: null },
        { responseTimeMs: 200, statusCode: 200, error: null },
        { responseTimeMs: 300, statusCode: 200, error: null },
        { responseTimeMs: 400, statusCode: 200, error: null },
        { responseTimeMs: 500, statusCode: 200, error: null },
      ];
      const stats = computeLoadTestStats(results);
      // nearest-rank: index = ceil(95/100 * 5) - 1 = ceil(4.75) - 1 = 5 - 1 = 4
      // sorted[4] = 500
      expect(stats.p95_response_ms).toBe(500);
    });

    it('computes error_rate_pct correctly', () => {
      const results = [
        { responseTimeMs: 100, statusCode: 200, error: null },
        { responseTimeMs: 200, statusCode: 500, error: 'HTTP 500' },
        { responseTimeMs: 300, statusCode: 200, error: null },
        { responseTimeMs: 400, statusCode: 503, error: 'HTTP 503' },
      ];
      const stats = computeLoadTestStats(results);
      expect(stats.error_rate_pct).toBe(50);
    });

    it('computes requests_per_second based on max response time', () => {
      const results = [
        { responseTimeMs: 100, statusCode: 200, error: null },
        { responseTimeMs: 200, statusCode: 200, error: null },
        { responseTimeMs: 1000, statusCode: 200, error: null },
      ];
      const stats = computeLoadTestStats(results);
      // total=3, max response time = 1000ms = 1s
      // rps = 3 / (1000/1000) = 3
      expect(stats.requests_per_second).toBe(3);
    });

    it('marks result as degraded when error_rate > 50%', () => {
      const results = [
        { responseTimeMs: 100, statusCode: 200, error: null },
        { responseTimeMs: 200, statusCode: 500, error: 'HTTP 500' },
        { responseTimeMs: 300, statusCode: 500, error: 'HTTP 500' },
        { responseTimeMs: 400, statusCode: 500, error: 'HTTP 500' },
      ];
      const stats = computeLoadTestStats(results);
      // 3/4 = 75% error rate
      expect(stats.error_rate_pct).toBe(75);
      expect(stats.status).toBe('degraded');
    });

    it('marks result as healthy when error_rate exactly 50%', () => {
      const results = [
        { responseTimeMs: 100, statusCode: 200, error: null },
        { responseTimeMs: 200, statusCode: 500, error: 'HTTP 500' },
      ];
      const stats = computeLoadTestStats(results);
      expect(stats.error_rate_pct).toBe(50);
      expect(stats.status).toBe('healthy');
    });

    it('marks result as healthy when all requests succeed', () => {
      const results = Array.from({ length: 10 }, (_, i) => ({
        responseTimeMs: (i + 1) * 50,
        statusCode: 200,
        error: null
      }));
      const stats = computeLoadTestStats(results);
      expect(stats.error_rate_pct).toBe(0);
      expect(stats.status).toBe('healthy');
    });

    it('marks result as degraded when all requests fail', () => {
      const results = Array.from({ length: 10 }, (_, i) => ({
        responseTimeMs: (i + 1) * 50,
        statusCode: null,
        error: 'timeout'
      }));
      const stats = computeLoadTestStats(results);
      expect(stats.error_rate_pct).toBe(100);
      expect(stats.status).toBe('degraded');
    });

    it('handles zero responseTimeMs values', () => {
      const results = [
        { responseTimeMs: 0, statusCode: 200, error: null },
        { responseTimeMs: 0, statusCode: 200, error: null },
      ];
      const stats = computeLoadTestStats(results);
      expect(stats.avg_response_ms).toBe(0);
      expect(stats.p95_response_ms).toBe(0);
    });

    it('handles mixed successful and failed with varying response times', () => {
      const results = [
        { responseTimeMs: 50, statusCode: 200, error: null },
        { responseTimeMs: 100, statusCode: 200, error: null },
        { responseTimeMs: 150, statusCode: 200, error: null },
        { responseTimeMs: 200, statusCode: 200, error: null },
        { responseTimeMs: 250, statusCode: 200, error: null },
        { responseTimeMs: 300, statusCode: 200, error: null },
        { responseTimeMs: 350, statusCode: 200, error: null },
        { responseTimeMs: 400, statusCode: 500, error: 'HTTP 500' },
        { responseTimeMs: 5000, statusCode: null, error: 'timeout' },
        { responseTimeMs: 3000, statusCode: null, error: 'connection_error' },
      ];
      const stats = computeLoadTestStats(results);
      expect(stats.total_requests).toBe(10);
      expect(stats.successful).toBe(7);
      expect(stats.failed).toBe(3);
      expect(stats.error_rate_pct).toBe(30);
      expect(stats.status).toBe('healthy');
    });
  });

  describe('canRunLoadTest', () => {
    // These tests require a real database connection.
    // They use the project's actual SQLite database module.
    let db;

    beforeEach(async () => {
      const { getDb } = await import('../../database.js');
      db = await getDb();
      // Clean up load_tests for our test user
      await db.run('DELETE FROM load_tests WHERE user_id = 99999');
    });

    afterEach(async () => {
      if (db) {
        await db.run('DELETE FROM load_tests WHERE user_id = 99999');
      }
    });

    it('allows test when user has no previous tests', async () => {
      const result = await canRunLoadTest(99999);
      expect(result.allowed).toBe(true);
      expect(result.retryAfterMs).toBe(0);
    });

    it('allows test when user has fewer than 5 tests in the window', async () => {
      const now = new Date();
      for (let i = 0; i < 4; i++) {
        const startedAt = new Date(now.getTime() - i * 60000).toISOString();
        await db.run(
          `INSERT INTO load_tests (monitor_id, user_id, concurrency, status, started_at)
           VALUES (1, 99999, 10, 'completed', ?)`,
          [startedAt]
        );
      }
      const result = await canRunLoadTest(99999);
      expect(result.allowed).toBe(true);
      expect(result.retryAfterMs).toBe(0);
    });

    it('denies test when user has 5 tests in the window', async () => {
      const now = new Date();
      for (let i = 0; i < 5; i++) {
        const startedAt = new Date(now.getTime() - i * 60000).toISOString();
        await db.run(
          `INSERT INTO load_tests (monitor_id, user_id, concurrency, status, started_at)
           VALUES (1, 99999, 10, 'completed', ?)`,
          [startedAt]
        );
      }
      const result = await canRunLoadTest(99999);
      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBeGreaterThan(0);
    });

    it('allows test when old tests are outside the 60-minute window', async () => {
      const now = new Date();
      for (let i = 0; i < 5; i++) {
        // All tests are 65 minutes ago
        const startedAt = new Date(now.getTime() - 65 * 60000 - i * 1000).toISOString();
        await db.run(
          `INSERT INTO load_tests (monitor_id, user_id, concurrency, status, started_at)
           VALUES (1, 99999, 10, 'completed', ?)`,
          [startedAt]
        );
      }
      const result = await canRunLoadTest(99999);
      expect(result.allowed).toBe(true);
      expect(result.retryAfterMs).toBe(0);
    });

    it('returns retryAfterMs indicating when next test is available', async () => {
      const now = new Date();
      // 5 tests, the oldest is 30 minutes ago
      for (let i = 0; i < 5; i++) {
        const startedAt = new Date(now.getTime() - (30 - i) * 60000).toISOString();
        await db.run(
          `INSERT INTO load_tests (monitor_id, user_id, concurrency, status, started_at)
           VALUES (1, 99999, 10, 'completed', ?)`,
          [startedAt]
        );
      }
      const result = await canRunLoadTest(99999);
      expect(result.allowed).toBe(false);
      // The oldest test was 30 min ago, so retry after ~30 more minutes
      expect(result.retryAfterMs).toBeGreaterThan(25 * 60000); // at least ~25 min
      expect(result.retryAfterMs).toBeLessThanOrEqual(31 * 60000); // at most ~31 min
    });
  });
});
