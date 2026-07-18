import { getDb } from './database.js';

/**
 * Error Rate Tracker — counts HTTP 5xx responses per monitor in rolling 1-minute windows
 * and triggers spike alerts when the count exceeds a configurable threshold.
 *
 * Exports:
 * - recordErrorStatus(monitorId, statusCode, timestamp): Records a 5xx error event
 * - getErrorCountInWindow(monitorId, windowStart, windowEnd): Counts errors in a time range
 * - isSpike(errorCount, threshold): Pure function to determine if count exceeds threshold
 * - getErrorRateHistory(monitorId, hours): Returns per-minute error rate history
 *
 * Requirements: 19.1, 19.2, 19.3, 19.4, 19.5, 19.6
 */

const DEFAULT_THRESHOLD = 5;
const MIN_THRESHOLD = 1;
const MAX_THRESHOLD = 100;
const MAX_HISTORY_POINTS = 1440; // 24 hours of per-minute data

/**
 * Records a 5xx error status code for a monitor. Only records status codes in the 500-599 range.
 * After recording, evaluates whether a spike alert should be triggered.
 *
 * @param {number} monitorId - The monitor ID
 * @param {number} statusCode - The HTTP status code (only 500-599 are recorded)
 * @param {string|Date} timestamp - The timestamp of the error event (ISO string or Date)
 * @returns {Promise<void>}
 */
export async function recordErrorStatus(monitorId, statusCode, timestamp) {
  // Only record 5xx status codes
  if (statusCode < 500 || statusCode > 599) {
    return;
  }

  const db = await getDb();
  const recordedAt = timestamp instanceof Date
    ? timestamp.toISOString()
    : typeof timestamp === 'string'
      ? timestamp
      : new Date(timestamp).toISOString();

  await db.run(
    'INSERT INTO error_rate_events (monitor_id, status_code, recorded_at) VALUES (?, ?, ?)',
    [monitorId, statusCode, recordedAt]
  );

  // Evaluate spike after recording
  await evaluateSpike(monitorId, recordedAt);
}

/**
 * Gets the count of error events for a monitor within a time window.
 *
 * @param {number} monitorId - The monitor ID
 * @param {string|Date} windowStart - Start of the time window (ISO string or Date)
 * @param {string|Date} windowEnd - End of the time window (ISO string or Date)
 * @returns {Promise<number>} The count of error events in the window
 */
export async function getErrorCountInWindow(monitorId, windowStart, windowEnd) {
  const db = await getDb();
  const start = windowStart instanceof Date ? windowStart.toISOString() : windowStart;
  const end = windowEnd instanceof Date ? windowEnd.toISOString() : windowEnd;

  const row = await db.get(
    'SELECT COUNT(*) as count FROM error_rate_events WHERE monitor_id = ? AND recorded_at >= ? AND recorded_at <= ?',
    [monitorId, start, end]
  );

  return row ? row.count : 0;
}

/**
 * Pure function that determines whether an error count constitutes a spike
 * based on the configured threshold.
 *
 * @param {number} errorCount - The number of errors in the current window
 * @param {number} [threshold] - The spike threshold (1-100, default 5)
 * @returns {boolean} True if errorCount exceeds the threshold
 */
export function isSpike(errorCount, threshold) {
  const normalizedThreshold = normalizeThreshold(threshold);
  return errorCount > normalizedThreshold;
}

/**
 * Returns per-minute error rate history for a monitor over a specified number of hours.
 * Each data point includes the minute timestamp, error count, and breakdown by status code.
 * Returns zero-count entries for minutes with no errors.
 *
 * @param {number} monitorId - The monitor ID
 * @param {number} [hours=24] - Number of hours of history to retrieve (max 24)
 * @returns {Promise<Array<{minute: string, count: number, codes: Object}>>} Error rate data points
 */
export async function getErrorRateHistory(monitorId, hours) {
  const db = await getDb();
  const effectiveHours = Math.min(Math.max(hours || 24, 1), 24);
  const totalMinutes = Math.min(effectiveHours * 60, MAX_HISTORY_POINTS);

  const now = new Date();
  // Truncate to current minute start
  const currentMinuteStart = new Date(
    now.getFullYear(), now.getMonth(), now.getDate(),
    now.getHours(), now.getMinutes(), 0, 0
  );

  const startTime = new Date(currentMinuteStart.getTime() - (totalMinutes - 1) * 60000);

  // Fetch all error events in the time range
  const events = await db.all(
    'SELECT status_code, recorded_at FROM error_rate_events WHERE monitor_id = ? AND recorded_at >= ? ORDER BY recorded_at ASC',
    [monitorId, startTime.toISOString()]
  );

  // Build a map of minute -> { count, codes }
  const minuteMap = new Map();

  for (const event of events) {
    const eventTime = new Date(event.recorded_at);
    const minuteKey = formatMinuteKey(eventTime);

    if (!minuteMap.has(minuteKey)) {
      minuteMap.set(minuteKey, { count: 0, codes: {} });
    }

    const entry = minuteMap.get(minuteKey);
    entry.count++;
    const codeStr = String(event.status_code);
    entry.codes[codeStr] = (entry.codes[codeStr] || 0) + 1;
  }

  // Build the full history array with zero-fill for empty minutes
  const history = [];
  for (let i = 0; i < totalMinutes; i++) {
    const minuteTime = new Date(startTime.getTime() + i * 60000);
    const minuteKey = formatMinuteKey(minuteTime);
    const data = minuteMap.get(minuteKey) || { count: 0, codes: {} };

    history.push({
      minute: minuteKey,
      count: data.count,
      codes: data.codes
    });
  }

  return history;
}

/**
 * Gets the current spike alert state for a monitor.
 *
 * @param {number} monitorId - The monitor ID
 * @returns {Promise<object|null>} The active spike alert record or null
 */
export async function getActiveSpikeAlert(monitorId) {
  const db = await getDb();
  const row = await db.get(
    'SELECT * FROM error_rate_alerts WHERE monitor_id = ? AND spike_active = 1',
    [monitorId]
  );
  return row || null;
}

/**
 * Purges error rate events older than the specified number of hours.
 * Default retention: 24 hours.
 *
 * @param {number} [maxAgeHours=24] - Maximum age of events to keep
 * @returns {Promise<number>} Number of deleted events
 */
export async function purgeOldEvents(maxAgeHours = 24) {
  const db = await getDb();
  const cutoff = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000).toISOString();
  const result = await db.run(
    'DELETE FROM error_rate_events WHERE recorded_at < ?',
    [cutoff]
  );
  return result.changes || 0;
}

// --- Internal helpers ---

/**
 * Evaluates whether a spike alert should be triggered or recovered for a monitor.
 * - If spike is not active and error count exceeds threshold: trigger spike alert
 * - If spike is active and error count drops below/equal threshold: send recovery
 * - If spike is already active: suppress additional alerts (Req 19.6)
 *
 * @param {number} monitorId - The monitor ID
 * @param {string} currentTimestamp - The current time as ISO string
 * @returns {Promise<void>}
 */
async function evaluateSpike(monitorId, currentTimestamp) {
  const db = await getDb();

  // Get the monitor's configured threshold
  const monitor = await db.get(
    'SELECT error_rate_threshold FROM monitors WHERE id = ?',
    [monitorId]
  );
  const threshold = monitor ? normalizeThreshold(monitor.error_rate_threshold) : DEFAULT_THRESHOLD;

  // Calculate error count in the current 1-minute window
  const currentTime = new Date(currentTimestamp);
  const windowStart = new Date(currentTime.getTime() - 60000);

  const errorCount = await getErrorCountInWindow(monitorId, windowStart.toISOString(), currentTimestamp);

  const activeAlert = await getActiveSpikeAlert(monitorId);

  if (isSpike(errorCount, threshold)) {
    if (!activeAlert) {
      // Trigger new spike alert (Req 19.2)
      await db.run(
        'INSERT INTO error_rate_alerts (monitor_id, spike_active, triggered_at) VALUES (?, 1, ?)',
        [monitorId, currentTimestamp]
      );
    }
    // If spike is already active, suppress additional alerts (Req 19.6)
  } else {
    if (activeAlert) {
      // Rate dropped below threshold — send recovery (Req 19.3)
      await db.run(
        'UPDATE error_rate_alerts SET spike_active = 0, resolved_at = ? WHERE id = ?',
        [currentTimestamp, activeAlert.id]
      );
    }
  }
}

/**
 * Formats a Date to a minute-level key string (YYYY-MM-DDTHH:MM).
 *
 * @param {Date} date - The date to format
 * @returns {string} The formatted minute key
 */
function formatMinuteKey(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

/**
 * Normalizes the threshold value to be within valid bounds (1-100).
 * Returns the default (5) if the value is not a valid number.
 *
 * @param {number} threshold - The desired threshold
 * @returns {number} The normalized threshold value
 */
function normalizeThreshold(threshold) {
  if (typeof threshold !== 'number' || isNaN(threshold)) {
    return DEFAULT_THRESHOLD;
  }
  if (threshold < MIN_THRESHOLD) return MIN_THRESHOLD;
  if (threshold > MAX_THRESHOLD) return MAX_THRESHOLD;
  return Math.floor(threshold);
}
