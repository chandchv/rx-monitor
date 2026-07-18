import { getDb } from './database.js';

/**
 * Valid timeline event types that can be recorded during an incident.
 */
const VALID_EVENT_TYPES = [
  'failure_detected',
  'retry_attempt',
  'escalation_sent',
  'acknowledged',
  'recovery_detected',
  'maintenance_flagged'
];

/**
 * Opens a new incident for a monitor on UP→DOWN transition.
 * Will only create an incident if no open incident already exists for this monitor.
 *
 * @param {number} monitorId - The monitor that transitioned to DOWN
 * @param {string} failureTimestamp - ISO 8601 timestamp of the first failed check
 * @param {string} message - Description of the failure
 * @returns {Promise<number>} The new incident ID
 */
export async function openIncident(monitorId, failureTimestamp, message) {
  const db = await getDb();

  // Check if an open incident already exists for this monitor (downtime_duration = 0 means still open)
  const existing = await db.get(
    `SELECT id FROM incidents WHERE monitor_id = ? AND downtime_duration = 0 AND event_type = 'down'`,
    [monitorId]
  );

  if (existing) {
    return existing.id;
  }

  // Create the incident record
  const result = await db.run(
    `INSERT INTO incidents (monitor_id, event_type, timestamp, message, downtime_duration)
     VALUES (?, 'down', ?, ?, 0)`,
    [monitorId, failureTimestamp, message]
  );

  const incidentId = result.lastID;

  // Add the initial failure_detected event
  await addTimelineEvent(incidentId, 'failure_detected', {
    timestamp: failureTimestamp,
    message
  });

  return incidentId;
}

/**
 * Adds a timeline event to an existing incident.
 *
 * @param {number} incidentId - The incident to add the event to
 * @param {string} eventType - One of the VALID_EVENT_TYPES
 * @param {object} [data={}] - Optional JSON data (response_time_ms, message, etc.)
 * @returns {Promise<void>}
 */
export async function addTimelineEvent(incidentId, eventType, data = {}) {
  if (!VALID_EVENT_TYPES.includes(eventType)) {
    throw new Error(`Invalid event type: ${eventType}. Must be one of: ${VALID_EVENT_TYPES.join(', ')}`);
  }

  const db = await getDb();
  const timestamp = data.timestamp || new Date().toISOString();
  const responseTimeMs = data.response_time_ms || null;

  // Store data as JSON string, excluding timestamp and response_time_ms which have their own columns
  const eventData = { ...data };
  delete eventData.timestamp;
  delete eventData.response_time_ms;

  await db.run(
    `INSERT INTO incident_events (incident_id, event_type, timestamp, data, response_time_ms)
     VALUES (?, ?, ?, ?, ?)`,
    [incidentId, eventType, timestamp, JSON.stringify(eventData), responseTimeMs]
  );
}

/**
 * Closes an incident on DOWN→UP transition.
 * Calculates total downtime and records a recovery_detected event.
 *
 * @param {number} incidentId - The incident to close
 * @param {string} recoveryTimestamp - ISO 8601 timestamp of recovery detection
 * @returns {Promise<void>}
 */
export async function closeIncident(incidentId, recoveryTimestamp) {
  const db = await getDb();

  // Get the incident start timestamp
  const incident = await db.get(
    `SELECT timestamp FROM incidents WHERE id = ?`,
    [incidentId]
  );

  if (!incident) {
    throw new Error(`Incident ${incidentId} not found`);
  }

  const downtimeSeconds = calculateDowntime(incident.timestamp, recoveryTimestamp);

  // Add recovery event
  await addTimelineEvent(incidentId, 'recovery_detected', {
    timestamp: recoveryTimestamp
  });

  // Update the incident record with downtime duration
  await db.run(
    `UPDATE incidents SET downtime_duration = ? WHERE id = ?`,
    [downtimeSeconds, incidentId]
  );
}

/**
 * Calculates downtime in seconds between two ISO 8601 timestamps.
 * Pure function - no side effects.
 *
 * @param {string} startTimestamp - ISO 8601 start timestamp
 * @param {string} endTimestamp - ISO 8601 end timestamp
 * @returns {number} Total downtime in seconds (rounded to nearest integer)
 */
export function calculateDowntime(startTimestamp, endTimestamp) {
  const start = new Date(startTimestamp).getTime();
  const end = new Date(endTimestamp).getTime();
  const diffMs = end - start;
  return Math.round(diffMs / 1000);
}

/**
 * Finds the open incident for a given monitor, if one exists.
 *
 * @param {number} monitorId - The monitor to check
 * @returns {Promise<object|null>} The open incident record or null
 */
export async function getOpenIncident(monitorId) {
  const db = await getDb();
  return await db.get(
    `SELECT * FROM incidents WHERE monitor_id = ? AND downtime_duration = 0 AND event_type = 'down'`,
    [monitorId]
  );
}

/**
 * Handles DOWN→UP transition when no open incident exists.
 * Logs recovery without creating a new incident.
 *
 * @param {number} monitorId - The monitor that recovered
 * @param {string} recoveryTimestamp - ISO 8601 timestamp of recovery
 * @returns {Promise<void>}
 */
export async function logRecoveryWithoutIncident(monitorId, recoveryTimestamp) {
  const db = await getDb();
  // Insert a recovery record that is immediately closed (not a real incident)
  await db.run(
    `INSERT INTO incidents (monitor_id, event_type, timestamp, message, downtime_duration)
     VALUES (?, 'recovery', ?, 'Recovery detected without open incident', -1)`,
    [monitorId, recoveryTimestamp]
  );
}

/**
 * Retrieves all events for an incident ordered chronologically.
 * Returns a maximum of 1000 events per incident (Requirement 14.4).
 *
 * @param {number} incidentId - The incident to retrieve events for
 * @returns {Promise<object[]>} Array of timeline events
 */
export async function getIncidentTimeline(incidentId) {
  const db = await getDb();
  const events = await db.all(
    `SELECT id, incident_id, event_type, timestamp, data, response_time_ms
     FROM incident_events
     WHERE incident_id = ?
     ORDER BY timestamp ASC
     LIMIT 1000`,
    [incidentId]
  );

  return events.map(event => ({
    ...event,
    data: event.data ? JSON.parse(event.data) : null
  }));
}
