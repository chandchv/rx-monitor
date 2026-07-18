/**
 * Load Tester Module
 * Generates controlled bursts of concurrent HTTP requests to measure degradation under load.
 * Supports 10-1000 concurrent requests with per-request timeout of 30s.
 * Rate limited to 5 tests per user per 60 minutes.
 */

import { getDb } from './database.js';
import { computePercentile } from './percentile-calculator.js';

const PER_REQUEST_TIMEOUT_MS = 30000;
const MAX_TEST_DURATION_MS = 120000;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 60 minutes
const RATE_LIMIT_MAX_TESTS = 5;
const MIN_CONCURRENCY = 10;
const MAX_CONCURRENCY = 1000;

/**
 * Check if a user is allowed to run a load test based on rate limiting.
 * Limits: 5 tests per user per 60-minute rolling window.
 *
 * @param {number} userId - The user ID to check
 * @returns {Promise<{allowed: boolean, retryAfterMs: number}>}
 */
export async function canRunLoadTest(userId) {
  const db = await getDb();
  const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();

  const row = await db.get(
    `SELECT COUNT(*) as count, MIN(started_at) as oldest
     FROM load_tests
     WHERE user_id = ? AND started_at >= ?`,
    [userId, windowStart]
  );

  const count = row?.count || 0;

  if (count < RATE_LIMIT_MAX_TESTS) {
    return { allowed: true, retryAfterMs: 0 };
  }

  // Calculate when the oldest test in the window will expire
  const oldestTime = new Date(row.oldest).getTime();
  const retryAfterMs = Math.max(0, (oldestTime + RATE_LIMIT_WINDOW_MS) - Date.now());

  return { allowed: false, retryAfterMs };
}

/**
 * Compute summary statistics from an array of individual request results.
 *
 * @param {Array<{responseTimeMs: number, statusCode: number|null, error: string|null}>} results
 * @returns {LoadTestSummary}
 */
export function computeLoadTestStats(results) {
  if (!Array.isArray(results) || results.length === 0) {
    return {
      total_requests: 0,
      successful: 0,
      failed: 0,
      avg_response_ms: 0,
      p95_response_ms: 0,
      error_rate_pct: 0,
      requests_per_second: 0,
      status: 'healthy'
    };
  }

  const total = results.length;
  let successful = 0;
  let failed = 0;
  let totalResponseTime = 0;
  const responseTimes = [];

  for (const result of results) {
    const isSuccess = !result.error && result.statusCode >= 200 && result.statusCode < 300;
    if (isSuccess) {
      successful++;
    } else {
      failed++;
    }
    totalResponseTime += result.responseTimeMs || 0;
    responseTimes.push(result.responseTimeMs || 0);
  }

  const avgResponseMs = total > 0 ? totalResponseTime / total : 0;
  const errorRatePct = (failed / total) * 100;

  // Compute p95 using nearest-rank method (same as percentile-calculator)
  const sorted = [...responseTimes].sort((a, b) => a - b);
  let p95ResponseMs = 0;
  if (sorted.length > 0) {
    const index = Math.ceil(95 / 100 * sorted.length) - 1;
    const clampedIndex = Math.max(0, Math.min(index, sorted.length - 1));
    p95ResponseMs = sorted[clampedIndex];
  }

  // Compute requests/second based on total elapsed time
  const maxResponseTime = sorted[sorted.length - 1] || 1;
  const totalDurationMs = maxResponseTime > 0 ? maxResponseTime : 1;
  const requestsPerSecond = total / (totalDurationMs / 1000);

  const status = errorRatePct > 50 ? 'degraded' : 'healthy';

  return {
    total_requests: total,
    successful,
    failed,
    avg_response_ms: Math.round(avgResponseMs * 100) / 100,
    p95_response_ms: Math.round(p95ResponseMs * 100) / 100,
    error_rate_pct: Math.round(errorRatePct * 100) / 100,
    requests_per_second: Math.round(requestsPerSecond * 100) / 100,
    status
  };
}

/**
 * Execute a single HTTP request with timeout and measure response time.
 * @param {string} url - Target URL
 * @param {AbortSignal} signal - Abort signal for cancellation
 * @returns {Promise<{responseTimeMs: number, statusCode: number|null, error: string|null}>}
 */
async function executeRequest(url, signal) {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PER_REQUEST_TIMEOUT_MS);

    // Combine external signal with our timeout signal
    const onAbort = () => controller.abort();
    if (signal) {
      signal.addEventListener('abort', onAbort);
    }

    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        redirect: 'follow'
      });
      clearTimeout(timeoutId);
      if (signal) signal.removeEventListener('abort', onAbort);

      const responseTimeMs = Date.now() - start;
      return {
        responseTimeMs,
        statusCode: response.status,
        error: response.status >= 200 && response.status < 300 ? null : `HTTP ${response.status}`
      };
    } catch (err) {
      clearTimeout(timeoutId);
      if (signal) signal.removeEventListener('abort', onAbort);
      throw err;
    }
  } catch (err) {
    const responseTimeMs = Date.now() - start;
    if (err.name === 'AbortError') {
      return { responseTimeMs, statusCode: null, error: 'timeout' };
    }
    return { responseTimeMs, statusCode: null, error: err.message || 'connection_error' };
  }
}

/**
 * Run a load test against a monitor's URL with configurable concurrency.
 *
 * @param {number} monitorId - The monitor to test
 * @param {number} concurrency - Number of concurrent requests (10-1000)
 * @param {number} userId - The user triggering the test
 * @returns {Promise<LoadTestResult>}
 */
export async function runLoadTest(monitorId, concurrency, userId) {
  // Validate concurrency range
  if (concurrency < MIN_CONCURRENCY || concurrency > MAX_CONCURRENCY) {
    throw new Error(`Concurrency must be between ${MIN_CONCURRENCY} and ${MAX_CONCURRENCY}`);
  }

  const db = await getDb();

  // Check rate limit
  const rateCheck = await canRunLoadTest(userId);
  if (!rateCheck.allowed) {
    throw new Error(`Rate limit exceeded. Retry after ${Math.ceil(rateCheck.retryAfterMs / 1000)} seconds.`);
  }

  // Check for concurrent test on same monitor
  const runningTest = await db.get(
    `SELECT id FROM load_tests WHERE monitor_id = ? AND status = 'running'`,
    [monitorId]
  );
  if (runningTest) {
    throw new Error('A load test is already running on this monitor.');
  }

  // Get monitor URL
  const monitor = await db.get('SELECT url FROM monitors WHERE id = ?', [monitorId]);
  if (!monitor) {
    throw new Error('Monitor not found.');
  }

  // Create load test record
  const startedAt = new Date().toISOString();
  const insertResult = await db.run(
    `INSERT INTO load_tests (monitor_id, user_id, concurrency, status, started_at)
     VALUES (?, ?, ?, 'running', ?)`,
    [monitorId, userId, concurrency, startedAt]
  );
  const testId = insertResult.lastID;

  // Set up auto-abort timer
  const abortController = new AbortController();
  const abortTimeout = setTimeout(() => {
    abortController.abort();
  }, MAX_TEST_DURATION_MS);

  try {
    // Execute concurrent requests
    const promises = [];
    for (let i = 0; i < concurrency; i++) {
      promises.push(executeRequest(monitor.url, abortController.signal));
    }

    const results = await Promise.all(promises);
    clearTimeout(abortTimeout);

    // Compute stats
    const stats = computeLoadTestStats(results);
    const completedAt = new Date().toISOString();

    // Update database record
    await db.run(
      `UPDATE load_tests SET
        status = 'completed',
        total_requests = ?,
        successful = ?,
        failed = ?,
        avg_response_ms = ?,
        p95_response_ms = ?,
        error_rate_pct = ?,
        requests_per_second = ?,
        result_status = ?,
        completed_at = ?
      WHERE id = ?`,
      [
        stats.total_requests,
        stats.successful,
        stats.failed,
        stats.avg_response_ms,
        stats.p95_response_ms,
        stats.error_rate_pct,
        stats.requests_per_second,
        stats.status,
        completedAt,
        testId
      ]
    );

    return {
      id: testId,
      monitor_id: monitorId,
      concurrency,
      ...stats,
      started_at: startedAt,
      completed_at: completedAt
    };
  } catch (err) {
    clearTimeout(abortTimeout);

    // If aborted due to timeout, record partial results
    const completedAt = new Date().toISOString();
    await db.run(
      `UPDATE load_tests SET status = 'aborted', completed_at = ? WHERE id = ?`,
      [completedAt, testId]
    );

    return {
      id: testId,
      monitor_id: monitorId,
      concurrency,
      total_requests: 0,
      successful: 0,
      failed: 0,
      avg_response_ms: 0,
      p95_response_ms: 0,
      error_rate_pct: 0,
      requests_per_second: 0,
      status: 'degraded',
      started_at: startedAt,
      completed_at: completedAt
    };
  }
}
