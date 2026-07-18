import { getDb } from './database.js';

/**
 * Default certificate expiry alert thresholds.
 * Sorted by days descending for matching logic.
 */
export const DEFAULT_THRESHOLDS = [
  { days: 14, severity: 'warning' },
  { days: 7, severity: 'critical' },
  { days: 3, severity: 'emergency' }
];

const VALID_SEVERITIES = ['warning', 'critical', 'emergency'];

/**
 * Classify certificate severity based on days remaining and threshold configuration.
 * Returns the severity of the lowest (most severe) threshold that the daysRemaining
 * falls within (i.e., daysRemaining <= threshold.days). When multiple thresholds match,
 * the one with the fewest days wins (most severe).
 *
 * For default thresholds [14/warning, 7/critical, 3/emergency]:
 * - 14 or fewer days AND more than 7 → warning
 * - 7 or fewer days AND more than 3 → critical
 * - 3 or fewer days → emergency
 *
 * @param {number} daysRemaining - Whole calendar days until certificate expiry
 * @param {Array<{days: number, severity: string}>} thresholds - Array of thresholds
 * @returns {'warning'|'critical'|'emergency'|null}
 */
export function classifyCertificateSeverity(daysRemaining, thresholds) {
  if (!Array.isArray(thresholds) || thresholds.length === 0) {
    return null;
  }

  // Sort thresholds by days ascending so we check the most severe (lowest days) first
  const sorted = [...thresholds].sort((a, b) => a.days - b.days);

  let matchedSeverity = null;

  for (const threshold of sorted) {
    if (daysRemaining <= threshold.days) {
      matchedSeverity = threshold.severity;
      break;
    }
  }

  return matchedSeverity;
}

/**
 * Calculate the number of whole calendar days remaining from currentDate to expiryDate.
 * Uses floor to get whole calendar days.
 *
 * @param {Date|string} expiryDate - Certificate expiration date
 * @param {Date|string} currentDate - Current UTC date
 * @returns {number} Whole calendar days remaining (can be negative if expired)
 */
export function calculateDaysRemaining(expiryDate, currentDate) {
  const expiry = new Date(expiryDate);
  const current = new Date(currentDate);

  const diffMs = expiry.getTime() - current.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  return diffDays;
}

/**
 * Validate an array of threshold configurations.
 *
 * Rules:
 * - Must have between 1 and 10 thresholds
 * - Each threshold must have days between 1 and 365
 * - Each threshold must have severity of 'warning', 'critical', or 'emergency'
 *
 * @param {Array<{days: number, severity: string}>} thresholds
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateThresholds(thresholds) {
  const errors = [];

  if (!Array.isArray(thresholds)) {
    errors.push('Thresholds must be an array');
    return { valid: false, errors };
  }

  if (thresholds.length < 1) {
    errors.push('At least 1 threshold is required');
  }

  if (thresholds.length > 10) {
    errors.push('Maximum of 10 thresholds allowed');
  }

  for (let i = 0; i < thresholds.length; i++) {
    const t = thresholds[i];

    if (!t || typeof t !== 'object') {
      errors.push(`Threshold at index ${i} must be an object`);
      continue;
    }

    if (typeof t.days !== 'number' || !Number.isInteger(t.days) || t.days < 1 || t.days > 365) {
      errors.push(`Threshold at index ${i}: days must be an integer between 1 and 365`);
    }

    if (!VALID_SEVERITIES.includes(t.severity)) {
      errors.push(`Threshold at index ${i}: severity must be one of: warning, critical, emergency`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Evaluate certificate alerts for a given monitor.
 * Checks the certificate expiry, classifies severity, and sends alerts
 * if not rate-limited (one per threshold per monitor per 24-hour window).
 *
 * @param {number} monitorId - The monitor ID to evaluate
 * @returns {Promise<void>}
 */
export async function evaluateCertificateAlerts(monitorId) {
  const db = await getDb();

  // Get monitor's SSL expiry date
  const monitor = await db.get('SELECT id, name, url, ssl_expiry FROM monitors WHERE id = ?', [monitorId]);
  if (!monitor || !monitor.ssl_expiry) {
    return;
  }

  const now = new Date();
  const daysRemaining = calculateDaysRemaining(monitor.ssl_expiry, now);

  // Get custom thresholds for this monitor, or use defaults
  const customThresholds = await db.all(
    'SELECT days_remaining AS days, severity FROM cert_alert_thresholds WHERE monitor_id = ? ORDER BY days_remaining DESC',
    [monitorId]
  );

  const thresholds = customThresholds.length > 0 ? customThresholds : DEFAULT_THRESHOLDS;

  const severity = classifyCertificateSeverity(daysRemaining, thresholds);
  if (!severity) {
    // No threshold breached, no alert needed
    return;
  }

  // Rate limiting: check if an alert was already sent for this severity within 24 hours
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const recentAlert = await db.get(
    'SELECT id FROM cert_alert_log WHERE monitor_id = ? AND severity = ? AND alerted_at > ?',
    [monitorId, severity, twentyFourHoursAgo]
  );

  if (recentAlert) {
    // Already alerted for this severity within 24 hours, skip
    return;
  }

  // Log the alert
  await db.run(
    'INSERT INTO cert_alert_log (monitor_id, severity, alerted_at) VALUES (?, ?, ?)',
    [monitorId, severity, now.toISOString()]
  );
}
