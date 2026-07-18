/**
 * SLA Calculator Module
 * Computes actual uptime percentage against SLA targets and calculates
 * remaining error budget for configurable time periods.
 *
 * Formula: (total_monitored_time - total_downtime) / total_monitored_time × 100
 * Rounded to 3 decimal places.
 *
 * Supported periods: monthly, quarterly, yearly
 * Valid SLA targets: 90.0 to 99.999
 */

/**
 * Period durations in seconds (approximate calendar-aligned values).
 */
const PERIOD_SECONDS = {
  monthly: 30 * 24 * 60 * 60,    // 30 days
  quarterly: 90 * 24 * 60 * 60,  // 90 days
  yearly: 365 * 24 * 60 * 60,    // 365 days
};

/**
 * Validates that an SLA target is within the acceptable range of 90.0 to 99.999.
 *
 * @param {number} target - The SLA target percentage
 * @returns {boolean} True if valid, false otherwise
 */
export function validateSLATarget(target) {
  if (target === null || target === undefined || typeof target !== 'number') {
    return false;
  }
  if (Number.isNaN(target)) {
    return false;
  }
  return target >= 90.0 && target <= 99.999;
}

/**
 * Computes actual uptime percentage from monitored time and downtime.
 * Formula: (totalMonitoredSeconds - totalDowntimeSeconds) / totalMonitoredSeconds × 100
 * Rounded to 3 decimal places.
 *
 * Returns null if totalMonitoredSeconds is 0 or negative (no-data indicator).
 *
 * @param {number} totalMonitoredSeconds - Total seconds of monitoring in the period
 * @param {number} totalDowntimeSeconds - Total seconds of downtime in the period
 * @returns {number|null} Uptime percentage rounded to 3 decimal places, or null if no data
 */
export function computeSLA(totalMonitoredSeconds, totalDowntimeSeconds) {
  if (
    totalMonitoredSeconds === null ||
    totalMonitoredSeconds === undefined ||
    totalMonitoredSeconds <= 0
  ) {
    return null;
  }

  if (
    totalDowntimeSeconds === null ||
    totalDowntimeSeconds === undefined ||
    totalDowntimeSeconds < 0
  ) {
    totalDowntimeSeconds = 0;
  }

  // Clamp downtime to monitored time
  if (totalDowntimeSeconds > totalMonitoredSeconds) {
    totalDowntimeSeconds = totalMonitoredSeconds;
  }

  const sla = ((totalMonitoredSeconds - totalDowntimeSeconds) / totalMonitoredSeconds) * 100;
  return Math.round(sla * 1000) / 1000;
}

/**
 * Computes the error budget for a given SLA target and period.
 *
 * @param {number} slaTarget - The SLA target percentage (90.0 to 99.999)
 * @param {number} periodSeconds - Total seconds in the period
 * @param {number} downtimeSeconds - Downtime already consumed in the period
 * @returns {object|null} ErrorBudget object, or null if inputs are invalid
 */
export function computeErrorBudget(slaTarget, periodSeconds, downtimeSeconds) {
  if (!validateSLATarget(slaTarget)) {
    return null;
  }

  if (
    periodSeconds === null ||
    periodSeconds === undefined ||
    periodSeconds <= 0 ||
    typeof periodSeconds !== 'number'
  ) {
    return null;
  }

  if (
    downtimeSeconds === null ||
    downtimeSeconds === undefined ||
    typeof downtimeSeconds !== 'number' ||
    downtimeSeconds < 0
  ) {
    downtimeSeconds = 0;
  }

  const allowedDowntimeSeconds = periodSeconds * (1 - slaTarget / 100);
  const remainingSeconds = allowedDowntimeSeconds - downtimeSeconds;
  const remainingPercentage =
    allowedDowntimeSeconds > 0
      ? Math.round((Math.max(0, remainingSeconds) / allowedDowntimeSeconds) * 100 * 1000) / 1000
      : 0;
  const breached = downtimeSeconds > allowedDowntimeSeconds;

  return {
    allowed_downtime_seconds: Math.round(allowedDowntimeSeconds * 1000) / 1000,
    used_seconds: downtimeSeconds,
    remaining_seconds: Math.round(remainingSeconds * 1000) / 1000,
    remaining_percentage: remainingPercentage,
    breached,
  };
}

/**
 * Returns the period duration in seconds for a named period.
 *
 * @param {string} period - One of 'monthly', 'quarterly', 'yearly'
 * @returns {number|null} Duration in seconds or null if invalid
 */
export function getPeriodSeconds(period) {
  return PERIOD_SECONDS[period] || null;
}

/**
 * Returns the SLA reference table showing allowed downtime per standard SLA level.
 *
 * @returns {Array<object>} Reference table entries
 */
export function getSLAReferenceTable() {
  const levels = [99, 99.5, 99.9, 99.95, 99.99];
  return levels.map((level) => {
    const yearlyAllowed = PERIOD_SECONDS.yearly * (1 - level / 100);
    const monthlyAllowed = PERIOD_SECONDS.monthly * (1 - level / 100);
    const weeklyAllowed = 7 * 24 * 60 * 60 * (1 - level / 100);

    return {
      sla_level: level,
      allowed_downtime_yearly_seconds: Math.round(yearlyAllowed * 100) / 100,
      allowed_downtime_monthly_seconds: Math.round(monthlyAllowed * 100) / 100,
      allowed_downtime_weekly_seconds: Math.round(weeklyAllowed * 100) / 100,
    };
  });
}
