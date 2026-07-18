import { getDb } from './database.js';

/**
 * Valid recurrence types for maintenance windows
 */
const VALID_RECURRENCES = ['once', 'daily', 'weekly', 'monthly'];

/**
 * Maximum maintenance window duration in milliseconds (24 hours)
 */
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;

/**
 * Validates that a timezone string is recognized by the Intl API.
 * @param {string} tz
 * @returns {boolean}
 */
function isValidTimezone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Converts a UTC date to a given timezone and returns component parts.
 * @param {Date} date
 * @param {string} timezone
 * @returns {{ year: number, month: number, day: number, hour: number, minute: number, second: number, dayOfWeek: number }}
 */
function datePartsInTimezone(date, timezone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    weekday: 'short',
  });

  const parts = formatter.formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;

  const dayOfWeekMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  return {
    year: parseInt(get('year'), 10),
    month: parseInt(get('month'), 10),
    day: parseInt(get('day'), 10),
    hour: parseInt(get('hour'), 10),
    minute: parseInt(get('minute'), 10),
    second: parseInt(get('second'), 10),
    dayOfWeek: dayOfWeekMap[get('weekday')] ?? 0,
  };
}

/**
 * Given a window's start/end times and the current time (all as Dates interpreted in the window's timezone),
 * determine if currentTime falls within this window occurrence on the current day (considering recurrence).
 */
function isTimeWithinOccurrence(windowRow, currentTime) {
  const tz = windowRow.timezone || 'UTC';
  const start = new Date(windowRow.start_time);
  const end = new Date(windowRow.end_time);

  if (isNaN(start.getTime()) || isNaN(end.getTime())) return false;

  const recurrence = windowRow.recurrence || 'once';

  if (recurrence === 'once') {
    // For one-time windows, simply check if currentTime is between start and end
    return currentTime >= start && currentTime <= end;
  }

  // For recurring windows, extract time-of-day from start/end in the window's timezone
  const startParts = datePartsInTimezone(start, tz);
  const endParts = datePartsInTimezone(end, tz);
  const currentParts = datePartsInTimezone(currentTime, tz);

  // Check if the recurrence pattern matches today
  if (recurrence === 'weekly' && currentParts.dayOfWeek !== startParts.dayOfWeek) {
    return false;
  }

  if (recurrence === 'monthly' && currentParts.day !== startParts.day) {
    return false;
  }

  // For daily, weekly (matching day), monthly (matching day): check time-of-day range
  const startMinutes = startParts.hour * 60 + startParts.minute;
  const endMinutes = endParts.hour * 60 + endParts.minute;
  const currentMinutes = currentParts.hour * 60 + currentParts.minute;

  // Handle same-day windows (start < end within the day)
  if (startMinutes <= endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
  }

  // Handle overnight windows (start > end, e.g., 23:00 - 01:00)
  return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
}

/**
 * Validates a maintenance window configuration.
 * @param {object} window - The maintenance window to validate
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateMaintenanceWindow(window) {
  const errors = [];

  if (!window || typeof window !== 'object') {
    return { valid: false, errors: ['Window must be a non-null object'] };
  }

  // Validate start_time
  if (!window.start_time) {
    errors.push('start_time is required');
  } else {
    const start = new Date(window.start_time);
    if (isNaN(start.getTime())) {
      errors.push('start_time must be a valid date/time string');
    }
  }

  // Validate end_time
  if (!window.end_time) {
    errors.push('end_time is required');
  } else {
    const end = new Date(window.end_time);
    if (isNaN(end.getTime())) {
      errors.push('end_time must be a valid date/time string');
    }
  }

  // Validate end > start and duration ≤ 24 hours
  if (window.start_time && window.end_time) {
    const start = new Date(window.start_time);
    const end = new Date(window.end_time);
    if (!isNaN(start.getTime()) && !isNaN(end.getTime())) {
      if (end <= start) {
        errors.push('end_time must be after start_time');
      } else {
        const durationMs = end.getTime() - start.getTime();
        if (durationMs > MAX_DURATION_MS) {
          errors.push('Duration must not exceed 24 hours');
        }
      }
    }
  }

  // Validate recurrence
  if (window.recurrence !== null && window.recurrence !== undefined) {
    if (!VALID_RECURRENCES.includes(window.recurrence)) {
      errors.push(`recurrence must be one of: ${VALID_RECURRENCES.join(', ')} (or null)`);
    }
  }

  // Validate timezone
  if (window.timezone !== undefined && window.timezone !== null) {
    if (!isValidTimezone(window.timezone)) {
      errors.push('timezone must be a valid IANA timezone identifier');
    }
  }

  // Validate monitor_id
  if (window.monitor_id === undefined || window.monitor_id === null) {
    errors.push('monitor_id is required');
  } else if (typeof window.monitor_id !== 'number' || !Number.isInteger(window.monitor_id) || window.monitor_id <= 0) {
    errors.push('monitor_id must be a positive integer');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Returns all active maintenance windows that the currentTime falls within for the given monitor.
 * @param {number} monitorId
 * @param {Date|string} currentTime - Date object or ISO string
 * @returns {Promise<Array>} Array of MaintenanceWindow objects
 */
export async function getActiveWindows(monitorId, currentTime) {
  const db = await getDb();
  const now = currentTime instanceof Date ? currentTime : new Date(currentTime);

  // Fetch all active windows for this monitor
  const windows = await db.all(
    'SELECT * FROM maintenance_windows WHERE monitor_id = ? AND active = 1',
    [monitorId]
  );

  const activeWindows = [];

  for (const w of windows) {
    if (isTimeWithinOccurrence(w, now)) {
      activeWindows.push({
        id: w.id,
        monitor_id: w.monitor_id,
        start_time: w.start_time,
        end_time: w.end_time,
        timezone: w.timezone || 'UTC',
        recurrence: w.recurrence || null,
        active: Boolean(w.active),
      });
    }
  }

  return activeWindows;
}

/**
 * Checks if the current time falls within any active maintenance window for the given monitor.
 * @param {number} monitorId
 * @param {Date|string} currentTime - Date object or ISO string
 * @returns {Promise<boolean>}
 */
export async function isWithinMaintenanceWindow(monitorId, currentTime) {
  const activeWindows = await getActiveWindows(monitorId, currentTime);
  return activeWindows.length > 0;
}
