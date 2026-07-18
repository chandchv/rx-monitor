import { getDb } from './database.js';

/**
 * Valid incident statuses for the status page.
 */
const VALID_STATUSES = ['investigating', 'identified', 'monitoring', 'resolved'];

/**
 * Maximum title length in characters.
 */
const MAX_TITLE_LENGTH = 200;

/**
 * Maximum description/update message length in characters.
 */
const MAX_DESCRIPTION_LENGTH = 2000;

/**
 * Validates an incident title and description before creation or update.
 *
 * @param {string} title - The incident title (1-200 characters required)
 * @param {string} [description] - Optional description (max 2000 characters)
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateIncidentMessage(title, description) {
  const errors = [];

  // Validate title
  if (!title || typeof title !== 'string' || title.trim().length === 0) {
    errors.push('Title is required and must be a non-empty string');
  } else if (title.length > MAX_TITLE_LENGTH) {
    errors.push(`Title must not exceed ${MAX_TITLE_LENGTH} characters (got ${title.length})`);
  }

  // Validate description
  if (description !== undefined && description !== null) {
    if (typeof description !== 'string') {
      errors.push('Description must be a string');
    } else if (description.length > MAX_DESCRIPTION_LENGTH) {
      errors.push(`Description must not exceed ${MAX_DESCRIPTION_LENGTH} characters (got ${description.length})`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Creates a new status page incident.
 *
 * @param {string} title - Incident title (1-200 characters)
 * @param {string} description - Incident description (max 2000 characters)
 * @param {string} status - Initial status (investigating, identified, monitoring, resolved)
 * @returns {Promise<number>} The new incident ID
 */
export async function createStatusIncident(title, description, status) {
  // Validate inputs
  const validation = validateIncidentMessage(title, description);
  if (!validation.valid) {
    throw new Error(`Validation failed: ${validation.errors.join('; ')}`);
  }

  if (!VALID_STATUSES.includes(status)) {
    throw new Error(`Invalid status: ${status}. Must be one of: ${VALID_STATUSES.join(', ')}`);
  }

  const db = await getDb();
  const now = new Date().toISOString();

  const result = await db.run(
    `INSERT INTO status_incidents (title, description, status, created_at, resolved_at)
     VALUES (?, ?, ?, ?, ?)`,
    [title, description || null, status, now, status === 'resolved' ? now : null]
  );

  return result.lastID;
}

/**
 * Updates an existing status page incident by appending an update message
 * and optionally changing the status.
 * Preserves all previous updates in chronological order (Requirement 15.3).
 *
 * @param {number} incidentId - The incident to update
 * @param {string} message - Update message (max 2000 characters)
 * @param {string} newStatus - New status for the incident
 * @returns {Promise<void>}
 */
export async function updateStatusIncident(incidentId, message, newStatus) {
  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    throw new Error('Update message is required and must be a non-empty string');
  }

  if (message.length > MAX_DESCRIPTION_LENGTH) {
    throw new Error(`Update message must not exceed ${MAX_DESCRIPTION_LENGTH} characters (got ${message.length})`);
  }

  if (!VALID_STATUSES.includes(newStatus)) {
    throw new Error(`Invalid status: ${newStatus}. Must be one of: ${VALID_STATUSES.join(', ')}`);
  }

  const db = await getDb();
  const now = new Date().toISOString();

  // Verify incident exists
  const incident = await db.get(
    `SELECT id, status FROM status_incidents WHERE id = ?`,
    [incidentId]
  );

  if (!incident) {
    throw new Error(`Status incident ${incidentId} not found`);
  }

  // Append the update to the history
  await db.run(
    `INSERT INTO status_incident_updates (incident_id, message, status, created_at)
     VALUES (?, ?, ?, ?)`,
    [incidentId, message, newStatus, now]
  );

  // Update the incident status
  const resolvedAt = newStatus === 'resolved' ? now : null;
  await db.run(
    `UPDATE status_incidents SET status = ?, resolved_at = COALESCE(?, resolved_at) WHERE id = ?`,
    [newStatus, resolvedAt, incidentId]
  );
}

/**
 * Retrieves all active (non-resolved) incidents, ordered by most recent first.
 * Active incidents are displayed above other status page content (Requirement 15.4).
 *
 * @returns {Promise<StatusIncident[]>}
 */
export async function getActiveIncidents() {
  const db = await getDb();

  const incidents = await db.all(
    `SELECT id, title, description, status, created_at, resolved_at, created_by
     FROM status_incidents
     WHERE status != 'resolved'
     ORDER BY created_at DESC`
  );

  // Attach updates to each incident
  return await attachUpdates(db, incidents);
}

/**
 * Retrieves resolved incidents visible within the specified number of days.
 * Resolved incidents are visible for 7 days after resolution (Requirement 15.5).
 *
 * @param {number} [daysBack=7] - Number of days back to look for resolved incidents
 * @returns {Promise<StatusIncident[]>}
 */
export async function getResolvedIncidents(daysBack = 7) {
  const db = await getDb();
  const cutoff = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();

  const incidents = await db.all(
    `SELECT id, title, description, status, created_at, resolved_at, created_by
     FROM status_incidents
     WHERE status = 'resolved' AND resolved_at >= ?
     ORDER BY resolved_at DESC`,
    [cutoff]
  );

  // Attach updates to each incident
  return await attachUpdates(db, incidents);
}

/**
 * Attaches chronological update history to each incident.
 *
 * @param {object} db - Database instance
 * @param {object[]} incidents - Array of incident records
 * @returns {Promise<StatusIncident[]>}
 */
async function attachUpdates(db, incidents) {
  const results = [];
  for (const incident of incidents) {
    const updates = await db.all(
      `SELECT id, message, status, created_at
       FROM status_incident_updates
       WHERE incident_id = ?
       ORDER BY created_at ASC`,
      [incident.id]
    );
    results.push({ ...incident, updates });
  }
  return results;
}
