import { getDb } from './database.js';

/**
 * Detect connection limit from level results (pure function).
 * @param {Array} levelResults - Array of { concurrency, avg_response_ms, error_rate_pct, errors, total }
 * @returns {{ limitFound: boolean, limitLevel: number }}
 */
export function detectLimit(levelResults) {
  if (!Array.isArray(levelResults) || levelResults.length === 0) {
    return { limitFound: false, limitLevel: 0 };
  }

  for (const level of levelResults) {
    if (level.error_rate_pct > 10) {
      return { limitFound: true, limitLevel: level.concurrency };
    }
  }

  return { limitFound: false, limitLevel: 0 };
}

/**
 * Check if a user can run a connection test (rate limit: 3 per hour).
 * @param {number} userId
 * @returns {Promise<{ allowed: boolean, retryAfterMs: number|null }>}
 */
async function checkRateLimit(userId) {
  const db = await getDb();
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  const result = await db.get(
    `SELECT COUNT(*) as count, MIN(started_at) as oldest
     FROM connection_tests
     WHERE user_id = ? AND started_at > ?`,
    [userId, oneHourAgo]
  );

  if (result.count >= 3) {
    const oldestTime = new Date(result.oldest).getTime();
    const retryAfterMs = oldestTime + 60 * 60 * 1000 - Date.now();
    return { allowed: false, retryAfterMs: Math.max(0, retryAfterMs) };
  }

  return { allowed: true, retryAfterMs: null };
}

/**
 * Check if a connection test is already running for a monitor.
 * @param {number} monitorId
 * @returns {Promise<boolean>}
 */
async function isTestRunning(monitorId) {
  const db = await getDb();
  const running = await db.get(
    `SELECT id FROM connection_tests WHERE monitor_id = ? AND status = 'running'`,
    [monitorId]
  );
  return !!running;
}

/**
 * Send a batch of concurrent requests to a URL and classify results.
 * @param {string} url - Target URL
 * @param {number} concurrency - Number of concurrent requests
 * @returns {Promise<Array<{ status: number|null, response_time_ms: number, error: boolean }>>}
 */
async function sendRequestBatch(url, concurrency) {
  const TIMEOUT_MS = 10000;
  const results = [];

  const requests = Array.from({ length: concurrency }, async () => {
    const startTime = Date.now();
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: { 'User-Agent': 'RxMonitor-ConnectionDetector/1.0' }
      });

      clearTimeout(timeoutId);
      const responseTime = Date.now() - startTime;
      const statusCode = response.status;
      const isError = statusCode >= 500;

      return { status: statusCode, response_time_ms: responseTime, error: isError };
    } catch (err) {
      const responseTime = Date.now() - startTime;
      // Connection refusal or timeout = error
      return { status: null, response_time_ms: responseTime, error: true };
    }
  });

  const batchResults = await Promise.all(requests);
  return batchResults;
}

/**
 * Run a connection limit detection test.
 * Increments concurrency by 10 from 10 to maxConcurrency.
 * Sends 20 requests at each level. Stops when error rate > 10%.
 *
 * @param {number} monitorId - The monitor to test
 * @param {number} [maxConcurrency=500] - Maximum concurrency level
 * @param {number} userId - The user initiating the test
 * @returns {Promise<{ levels: Array, detected_limit: number|null, completed: boolean, error?: string }>}
 */
export async function runConnectionTest(monitorId, maxConcurrency = 500, userId) {
  const db = await getDb();

  // Check rate limit
  const rateCheck = await checkRateLimit(userId);
  if (!rateCheck.allowed) {
    return {
      levels: [],
      detected_limit: null,
      completed: false,
      error: `Rate limit exceeded. 3 tests per hour allowed. Retry after ${Math.ceil(rateCheck.retryAfterMs / 1000)} seconds.`
    };
  }

  // Check for concurrent test on same monitor
  if (await isTestRunning(monitorId)) {
    return {
      levels: [],
      detected_limit: null,
      completed: false,
      error: 'A connection test is already running for this monitor.'
    };
  }

  // Get monitor URL
  const monitor = await db.get('SELECT url FROM monitors WHERE id = ?', [monitorId]);
  if (!monitor) {
    return {
      levels: [],
      detected_limit: null,
      completed: false,
      error: 'Monitor not found.'
    };
  }

  // Create test record
  const startedAt = new Date().toISOString();
  const insertResult = await db.run(
    `INSERT INTO connection_tests (monitor_id, user_id, max_concurrency, status, started_at)
     VALUES (?, ?, ?, 'running', ?)`,
    [monitorId, userId, maxConcurrency, startedAt]
  );
  const testId = insertResult.lastID;

  const levels = [];
  let detectedLimit = null;

  try {
    const REQUESTS_PER_LEVEL = 20;

    for (let concurrency = 10; concurrency <= maxConcurrency; concurrency += 10) {
      const batchResults = await sendRequestBatch(monitor.url, REQUESTS_PER_LEVEL);

      const errors = batchResults.filter(r => r.error).length;
      const total = batchResults.length;
      const errorRatePct = (errors / total) * 100;
      const avgResponseMs = batchResults.reduce((sum, r) => sum + r.response_time_ms, 0) / total;

      const levelResult = {
        concurrency,
        avg_response_ms: Math.round(avgResponseMs * 100) / 100,
        error_rate_pct: Math.round(errorRatePct * 100) / 100,
        errors,
        total
      };

      levels.push(levelResult);

      // Store level result in database
      await db.run(
        `INSERT INTO connection_test_levels (test_id, concurrency, avg_response_ms, error_rate_pct, errors, total)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [testId, concurrency, levelResult.avg_response_ms, levelResult.error_rate_pct, errors, total]
      );

      // Stop if error rate exceeds 10%
      if (errorRatePct > 10) {
        detectedLimit = concurrency;
        break;
      }
    }

    // Update test record
    const completedAt = new Date().toISOString();
    await db.run(
      `UPDATE connection_tests SET status = 'completed', detected_limit = ?, completed_at = ? WHERE id = ?`,
      [detectedLimit, completedAt, testId]
    );

    return {
      levels,
      detected_limit: detectedLimit,
      completed: true
    };
  } catch (err) {
    // Mark as failed
    await db.run(
      `UPDATE connection_tests SET status = 'failed', completed_at = ? WHERE id = ?`,
      [new Date().toISOString(), testId]
    );

    return {
      levels,
      detected_limit: null,
      completed: false,
      error: err.message
    };
  }
}
