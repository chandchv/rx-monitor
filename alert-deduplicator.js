import { getDb } from './database.js';

/**
 * Alert Deduplicator — suppresses redundant alert notifications during ongoing outages.
 *
 * Logic:
 * - shouldSuppress: Pure function. Returns true if (currentTime - lastAlertTime) < windowMinutes * 60 * 1000.
 * - getSuppressedCount: Queries alert_suppression table for the monitor's suppressed_count.
 * - clearSuppression: Deletes the alert_suppression record for the monitor.
 *
 * Suppression window: 5-1440 minutes, default 30.
 * On window expiry + still DOWN → send reminder, restart window.
 * On recovery (DOWN→UP) → clear suppression, send recovery.
 */

const MIN_WINDOW_MINUTES = 5;
const MAX_WINDOW_MINUTES = 1440;
const DEFAULT_WINDOW_MINUTES = 30;

/**
 * Determines whether an alert should be suppressed based on the time elapsed
 * since the last alert and the configured suppression window.
 *
 * @param {number} monitorId - The monitor ID (used for context, not DB access here)
 * @param {number} currentTime - Current timestamp in milliseconds
 * @param {number} lastAlertTime - Timestamp of last alert sent in milliseconds
 * @param {number} [windowMinutes] - Suppression window in minutes (5-1440, default 30)
 * @returns {boolean} True if the alert should be suppressed (i.e., still within the window)
 */
export function shouldSuppress(monitorId, currentTime, lastAlertTime, windowMinutes) {
  const window = normalizeWindow(windowMinutes);
  const windowMs = window * 60 * 1000;
  const elapsed = currentTime - lastAlertTime;
  return elapsed < windowMs;
}

/**
 * Gets the count of suppressed notifications for a given monitor from the database.
 *
 * @param {number} monitorId - The monitor ID
 * @returns {Promise<number>} The number of suppressed notifications
 */
export async function getSuppressedCount(monitorId) {
  const db = await getDb();
  const row = await db.get(
    'SELECT suppressed_count FROM alert_suppression WHERE monitor_id = ?',
    [monitorId]
  );
  return row ? row.suppressed_count : 0;
}

/**
 * Clears the suppression state for a monitor (e.g., on recovery DOWN→UP).
 *
 * @param {number} monitorId - The monitor ID
 * @returns {Promise<void>}
 */
export async function clearSuppression(monitorId) {
  const db = await getDb();
  await db.run('DELETE FROM alert_suppression WHERE monitor_id = ?', [monitorId]);
}

/**
 * Records a suppression event: increments the suppressed count and updates the last alert time.
 * If no suppression record exists, creates one.
 *
 * @param {number} monitorId - The monitor ID
 * @param {number} currentTime - Current timestamp in milliseconds
 * @param {number} [windowMinutes] - Suppression window in minutes (5-1440, default 30)
 * @returns {Promise<void>}
 */
export async function recordSuppression(monitorId, currentTime, windowMinutes) {
  const window = normalizeWindow(windowMinutes);
  const db = await getDb();
  const existing = await db.get(
    'SELECT id FROM alert_suppression WHERE monitor_id = ?',
    [monitorId]
  );

  if (existing) {
    await db.run(
      'UPDATE alert_suppression SET suppressed_count = suppressed_count + 1 WHERE monitor_id = ?',
      [monitorId]
    );
  } else {
    await db.run(
      `INSERT INTO alert_suppression (monitor_id, last_alert_at, suppression_window_min, suppressed_count)
       VALUES (?, ?, ?, 1)`,
      [monitorId, new Date(currentTime).toISOString(), window]
    );
  }
}

/**
 * Starts or restarts the suppression window for a monitor.
 * Called when the initial alert is sent or when a reminder is sent on window expiry.
 *
 * @param {number} monitorId - The monitor ID
 * @param {number} currentTime - Current timestamp in milliseconds
 * @param {number} [windowMinutes] - Suppression window in minutes (5-1440, default 30)
 * @returns {Promise<void>}
 */
export async function startSuppression(monitorId, currentTime, windowMinutes) {
  const window = normalizeWindow(windowMinutes);
  const db = await getDb();
  const existing = await db.get(
    'SELECT id FROM alert_suppression WHERE monitor_id = ?',
    [monitorId]
  );

  if (existing) {
    await db.run(
      'UPDATE alert_suppression SET last_alert_at = ?, suppression_window_min = ? WHERE monitor_id = ?',
      [new Date(currentTime).toISOString(), window, monitorId]
    );
  } else {
    await db.run(
      `INSERT INTO alert_suppression (monitor_id, last_alert_at, suppression_window_min, suppressed_count)
       VALUES (?, ?, ?, 0)`,
      [monitorId, new Date(currentTime).toISOString(), window]
    );
  }
}

/**
 * Gets the full suppression state for a monitor.
 *
 * @param {number} monitorId - The monitor ID
 * @returns {Promise<object|null>} The suppression state or null if none exists
 */
export async function getSuppressionState(monitorId) {
  const db = await getDb();
  const row = await db.get(
    'SELECT * FROM alert_suppression WHERE monitor_id = ?',
    [monitorId]
  );
  return row || null;
}

/**
 * Normalizes the window value to be within valid bounds (5-1440 minutes).
 * Returns the default (30) if the value is not a valid number.
 *
 * @param {number} windowMinutes - The desired window in minutes
 * @returns {number} The normalized window value
 */
function normalizeWindow(windowMinutes) {
  if (typeof windowMinutes !== 'number' || isNaN(windowMinutes)) {
    return DEFAULT_WINDOW_MINUTES;
  }
  if (windowMinutes < MIN_WINDOW_MINUTES) return MIN_WINDOW_MINUTES;
  if (windowMinutes > MAX_WINDOW_MINUTES) return MAX_WINDOW_MINUTES;
  return windowMinutes;
}
