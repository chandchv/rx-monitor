import { getDb } from './database.js';

/**
 * Log Ingestion — Centralized log collection service.
 *
 * Accepts log entries from remote servers authenticated via API key.
 * - Max 100 entries per request
 * - Required fields: hostname, timestamp, severity, message
 * - Max message size: 10KB (10240 bytes)
 * - Valid severities: debug, info, warn, error, fatal
 * - Filtering by hostname, severity, time range, keyword
 * - Pagination: up to 100 per page, sorted by timestamp DESC
 * - Auto-purge entries older than 30 days every 6 hours
 */

const MAX_ENTRIES_PER_REQUEST = 100;
const MAX_MESSAGE_SIZE_BYTES = 10240; // 10KB
const VALID_SEVERITIES = ['debug', 'info', 'warn', 'error', 'fatal'];
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_AGE_DAYS = 30;
const PURGE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

let purgeTimer = null;

/**
 * Validates a single log entry for required fields and constraints.
 *
 * @param {object} entry - The log entry to validate
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateLogEntry(entry) {
  const errors = [];

  if (!entry || typeof entry !== 'object') {
    return { valid: false, errors: ['Entry must be a non-null object'] };
  }

  // Check required fields
  if (!entry.hostname || typeof entry.hostname !== 'string' || entry.hostname.trim() === '') {
    errors.push('Missing or invalid required field: hostname');
  }

  if (!entry.timestamp || typeof entry.timestamp !== 'string' || entry.timestamp.trim() === '') {
    errors.push('Missing or invalid required field: timestamp');
  }

  if (!entry.severity || typeof entry.severity !== 'string') {
    errors.push('Missing or invalid required field: severity');
  } else if (!VALID_SEVERITIES.includes(entry.severity)) {
    errors.push(`Invalid severity: "${entry.severity}". Must be one of: ${VALID_SEVERITIES.join(', ')}`);
  }

  if (!entry.message && entry.message !== '') {
    errors.push('Missing required field: message');
  } else if (typeof entry.message !== 'string') {
    errors.push('Missing or invalid required field: message');
  } else {
    // Check message size (10KB limit)
    const messageBytes = Buffer.byteLength(entry.message, 'utf8');
    if (messageBytes > MAX_MESSAGE_SIZE_BYTES) {
      errors.push(`Message exceeds maximum size of 10KB (actual: ${messageBytes} bytes)`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validates a batch of log entries. Separates valid entries from rejected ones.
 * Also enforces the max 100 entries per request limit.
 *
 * @param {Array} entries - Array of log entries to validate
 * @returns {{ valid: object[], rejected: Array<{ index: number, errors: string[] }> }}
 */
export function validateLogBatch(entries) {
  const valid = [];
  const rejected = [];

  if (!Array.isArray(entries)) {
    return { valid: [], rejected: [{ index: 0, errors: ['Entries must be an array'] }] };
  }

  if (entries.length > MAX_ENTRIES_PER_REQUEST) {
    return {
      valid: [],
      rejected: [{ index: -1, errors: [`Batch exceeds maximum of ${MAX_ENTRIES_PER_REQUEST} entries (received: ${entries.length})`] }]
    };
  }

  for (let i = 0; i < entries.length; i++) {
    const result = validateLogEntry(entries[i]);
    if (result.valid) {
      valid.push(entries[i]);
    } else {
      rejected.push({ index: i, errors: result.errors });
    }
  }

  return { valid, rejected };
}

/**
 * Ingests validated log entries into the database.
 *
 * @param {number} apiKeyId - The authenticated API key ID
 * @param {Array} entries - Array of log entries to ingest
 * @returns {Promise<{ ingested: number, rejected: Array<{ index: number, errors: string[] }> }>}
 */
export async function ingestLogs(apiKeyId, entries) {
  const { valid, rejected } = validateLogBatch(entries);

  if (valid.length === 0) {
    return { ingested: 0, rejected };
  }

  const db = await getDb();
  const now = new Date().toISOString();

  const stmt = await db.prepare(
    `INSERT INTO app_logs (api_key_id, hostname, timestamp, severity, message, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );

  let ingested = 0;
  for (const entry of valid) {
    try {
      await stmt.run(apiKeyId, entry.hostname.trim(), entry.timestamp.trim(), entry.severity, entry.message, now);
      ingested++;
    } catch (err) {
      // If individual insert fails, track it but continue processing
      rejected.push({ index: entries.indexOf(entry), errors: [`Database error: ${err.message}`] });
    }
  }

  await stmt.finalize();

  return { ingested, rejected };
}

/**
 * Queries stored logs with filtering and pagination.
 *
 * @param {object} filters - Filter criteria
 * @param {string} [filters.hostname] - Filter by hostname
 * @param {string} [filters.severity] - Filter by severity level
 * @param {string} [filters.startTime] - Filter entries after this timestamp (ISO 8601)
 * @param {string} [filters.endTime] - Filter entries before this timestamp (ISO 8601)
 * @param {string} [filters.keyword] - Substring search in message
 * @param {number} [page=1] - Page number (1-based)
 * @param {number} [pageSize=50] - Number of results per page (max 100)
 * @returns {Promise<{ logs: object[], total: number }>}
 */
export async function queryLogs(filters = {}, page = 1, pageSize = DEFAULT_PAGE_SIZE) {
  const db = await getDb();

  // Normalize pagination params
  page = Math.max(1, Math.floor(page) || 1);
  pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(pageSize) || DEFAULT_PAGE_SIZE));

  const conditions = [];
  const params = [];

  if (filters.hostname) {
    conditions.push('hostname = ?');
    params.push(filters.hostname);
  }

  if (filters.severity) {
    if (VALID_SEVERITIES.includes(filters.severity)) {
      conditions.push('severity = ?');
      params.push(filters.severity);
    }
  }

  if (filters.startTime) {
    conditions.push('timestamp >= ?');
    params.push(filters.startTime);
  }

  if (filters.endTime) {
    conditions.push('timestamp <= ?');
    params.push(filters.endTime);
  }

  if (filters.keyword) {
    conditions.push('message LIKE ?');
    params.push(`%${filters.keyword}%`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const offset = (page - 1) * pageSize;

  // Get total count
  const countResult = await db.get(
    `SELECT COUNT(*) as total FROM app_logs ${whereClause}`,
    params
  );

  // Get paginated results sorted by timestamp DESC
  const logs = await db.all(
    `SELECT id, api_key_id, hostname, timestamp, severity, message, ingested_at
     FROM app_logs ${whereClause}
     ORDER BY timestamp DESC
     LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );

  return { logs, total: countResult.total };
}

/**
 * Purges log entries older than the specified number of days.
 *
 * @param {number} [maxAgeDays=30] - Maximum age in days; entries older than this are deleted
 * @returns {Promise<number>} Number of entries deleted
 */
export async function purgeStaleLogs(maxAgeDays = DEFAULT_MAX_AGE_DAYS) {
  const db = await getDb();
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();

  const result = await db.run(
    'DELETE FROM app_logs WHERE timestamp < ?',
    [cutoff]
  );

  return result.changes || 0;
}

/**
 * Starts the automatic purge scheduler that runs every 6 hours.
 * Cleans log entries older than 30 days.
 */
export function startPurgeScheduler() {
  if (purgeTimer) return; // Already running

  purgeTimer = setInterval(async () => {
    try {
      const deleted = await purgeStaleLogs(DEFAULT_MAX_AGE_DAYS);
      if (deleted > 0) {
        console.log(`[log-ingestion] Purged ${deleted} stale log entries`);
      }
    } catch (err) {
      console.error('[log-ingestion] Purge scheduler error:', err.message);
    }
  }, PURGE_INTERVAL_MS);

  // Don't keep the process alive just for the purge timer
  if (purgeTimer.unref) {
    purgeTimer.unref();
  }
}

/**
 * Stops the automatic purge scheduler.
 */
export function stopPurgeScheduler() {
  if (purgeTimer) {
    clearInterval(purgeTimer);
    purgeTimer = null;
  }
}
