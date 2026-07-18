import { getDb } from './database.js';

/**
 * On-Call Scheduler — Round-robin rotation for alert notification routing.
 *
 * Maintains an ordered list of 2-50 team members with contact details.
 * Routes alerts to the current on-call member based on rotation schedule.
 * Supports daily (24h), weekly (168h), or custom (1-720h) rotation intervals.
 * Advances round-robin on interval elapse, wraps to first after last.
 * Supports manual override until specified end time.
 * Falls back to all system channels if no valid on-call member.
 * Fails over to next member on delivery failure within 60s.
 */

const MIN_TEAM_MEMBERS = 2;
const MAX_TEAM_MEMBERS = 50;
const MIN_INTERVAL_HOURS = 1;
const MAX_INTERVAL_HOURS = 720;
const DAILY_INTERVAL_HOURS = 24;
const WEEKLY_INTERVAL_HOURS = 168;
const FAILOVER_TIMEOUT_MS = 60000;

/**
 * Calculates the current on-call team member based on round-robin rotation.
 *
 * Rotation calculation:
 *   elapsed = currentTime - rotationStartTime
 *   index = floor(elapsed / intervalHours) % teamMembers.length
 *
 * @param {Array<object>} teamMembers - Ordered array of team members
 * @param {number} rotationStartTime - Rotation start timestamp in milliseconds
 * @param {number} intervalHours - Rotation interval in hours
 * @param {number} currentTime - Current timestamp in milliseconds
 * @returns {object|null} The current on-call TeamMember, or null if no valid member
 */
export function getCurrentOnCall(teamMembers, rotationStartTime, intervalHours, currentTime) {
  if (!Array.isArray(teamMembers) || teamMembers.length === 0) {
    return null;
  }

  if (typeof rotationStartTime !== 'number' || typeof currentTime !== 'number') {
    return null;
  }

  if (typeof intervalHours !== 'number' || intervalHours <= 0) {
    return null;
  }

  const intervalMs = intervalHours * 60 * 60 * 1000;
  const elapsed = currentTime - rotationStartTime;

  // If current time is before rotation start, default to first member
  if (elapsed < 0) {
    return teamMembers[0];
  }

  const index = Math.floor(elapsed / intervalMs) % teamMembers.length;
  return teamMembers[index];
}

/**
 * Gets the next on-call team member after the given index (wraps around).
 *
 * @param {Array<object>} teamMembers - Ordered array of team members
 * @param {number} currentIndex - The current member's index in the array
 * @returns {object|null} The next TeamMember in rotation, or null if invalid input
 */
export function getNextOnCall(teamMembers, currentIndex) {
  if (!Array.isArray(teamMembers) || teamMembers.length === 0) {
    return null;
  }

  if (typeof currentIndex !== 'number' || currentIndex < 0) {
    return null;
  }

  const nextIndex = (currentIndex + 1) % teamMembers.length;
  return teamMembers[nextIndex];
}

/**
 * Validates a rotation configuration object.
 *
 * @param {object} config - The rotation config to validate
 * @param {Array<object>} config.teamMembers - Array of team members (2-50)
 * @param {number} config.intervalHours - Rotation interval in hours (1-720)
 * @param {number|string} config.rotationStartTime - Start time (timestamp or ISO string)
 * @param {object} [config.override] - Optional manual override
 * @param {number} config.override.memberId - Override member ID
 * @param {number|string} config.override.endTime - Override end time
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateRotationConfig(config) {
  const errors = [];

  if (!config || typeof config !== 'object') {
    return { valid: false, errors: ['Config must be an object'] };
  }

  // Validate teamMembers
  if (!Array.isArray(config.teamMembers)) {
    errors.push('teamMembers must be an array');
  } else {
    if (config.teamMembers.length < MIN_TEAM_MEMBERS) {
      errors.push(`teamMembers must have at least ${MIN_TEAM_MEMBERS} members, got ${config.teamMembers.length}`);
    }
    if (config.teamMembers.length > MAX_TEAM_MEMBERS) {
      errors.push(`teamMembers must have at most ${MAX_TEAM_MEMBERS} members, got ${config.teamMembers.length}`);
    }

    for (let i = 0; i < config.teamMembers.length; i++) {
      const member = config.teamMembers[i];
      if (!member || typeof member !== 'object') {
        errors.push(`teamMembers[${i}] must be an object`);
        continue;
      }
      if (typeof member.id !== 'number' || !Number.isInteger(member.id)) {
        errors.push(`teamMembers[${i}].id must be an integer`);
      }
      if (!member.name || typeof member.name !== 'string' || member.name.trim() === '') {
        errors.push(`teamMembers[${i}].name must be a non-empty string`);
      }
      // At least one contact method required
      const hasTelegram = member.telegram_chat_id && typeof member.telegram_chat_id === 'string' && member.telegram_chat_id.trim() !== '';
      const hasEmail = member.email && typeof member.email === 'string' && member.email.trim() !== '';
      if (!hasTelegram && !hasEmail) {
        errors.push(`teamMembers[${i}] must have at least one contact method (telegram_chat_id or email)`);
      }
    }
  }

  // Validate intervalHours
  if (typeof config.intervalHours !== 'number') {
    errors.push('intervalHours must be a number');
  } else if (config.intervalHours < MIN_INTERVAL_HOURS || config.intervalHours > MAX_INTERVAL_HOURS) {
    errors.push(`intervalHours must be between ${MIN_INTERVAL_HOURS} and ${MAX_INTERVAL_HOURS}, got ${config.intervalHours}`);
  }

  // Validate rotationStartTime
  if (config.rotationStartTime === undefined || config.rotationStartTime === null) {
    errors.push('rotationStartTime is required');
  } else {
    const startTime = typeof config.rotationStartTime === 'string'
      ? Date.parse(config.rotationStartTime)
      : config.rotationStartTime;
    if (isNaN(startTime)) {
      errors.push('rotationStartTime must be a valid timestamp or ISO date string');
    }
  }

  // Validate optional override
  if (config.override !== undefined && config.override !== null) {
    if (typeof config.override !== 'object') {
      errors.push('override must be an object');
    } else {
      if (typeof config.override.memberId !== 'number' || !Number.isInteger(config.override.memberId)) {
        errors.push('override.memberId must be an integer');
      }
      if (config.override.endTime === undefined || config.override.endTime === null) {
        errors.push('override.endTime is required when override is specified');
      } else {
        const endTime = typeof config.override.endTime === 'string'
          ? Date.parse(config.override.endTime)
          : config.override.endTime;
        if (isNaN(endTime)) {
          errors.push('override.endTime must be a valid timestamp or ISO date string');
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Checks if there is an active manual override for a team at the given time.
 *
 * @param {number} teamId - The on-call team ID
 * @param {number} currentTime - Current timestamp in milliseconds
 * @returns {Promise<object|null>} The override member or null if no active override
 */
export async function getActiveOverride(teamId, currentTime) {
  const db = await getDb();
  const now = new Date(currentTime).toISOString();

  const override = await db.get(
    `SELECT oo.*, om.name, om.email, om.telegram_chat_id
     FROM oncall_overrides oo
     JOIN oncall_members om ON om.id = oo.member_id
     WHERE oo.team_id = ? AND oo.start_time <= ? AND (oo.end_time IS NULL OR oo.end_time > ?)
     ORDER BY oo.start_time DESC LIMIT 1`,
    [teamId, now, now]
  );

  if (!override) return null;

  return {
    id: override.member_id,
    name: override.name,
    email: override.email || null,
    telegram_chat_id: override.telegram_chat_id || null
  };
}

/**
 * Resolves the current on-call member for a team, considering overrides.
 * Falls back to all system channels if no valid member is available.
 *
 * @param {number} teamId - The on-call team ID
 * @param {number} currentTime - Current timestamp in milliseconds
 * @returns {Promise<{ member: object|null, fallback: boolean }>}
 */
export async function resolveOnCall(teamId, currentTime) {
  const db = await getDb();

  // Check for active override first
  const override = await getActiveOverride(teamId, currentTime);
  if (override && hasValidContact(override)) {
    return { member: override, fallback: false };
  }

  // Load team configuration
  const team = await db.get('SELECT * FROM oncall_teams WHERE id = ?', [teamId]);
  if (!team) {
    return { member: null, fallback: true };
  }

  // Load team members ordered by position
  const members = await db.all(
    'SELECT * FROM oncall_members WHERE team_id = ? ORDER BY position ASC',
    [teamId]
  );

  if (members.length === 0) {
    return { member: null, fallback: true };
  }

  const rotationStartTime = new Date(team.rotation_start_time).getTime();
  const intervalHours = team.rotation_interval_hours || WEEKLY_INTERVAL_HOURS;

  const teamMembers = members.map(m => ({
    id: m.id,
    name: m.name,
    email: m.email || null,
    telegram_chat_id: m.telegram_chat_id || null
  }));

  const currentMember = getCurrentOnCall(teamMembers, rotationStartTime, intervalHours, currentTime);

  if (!currentMember || !hasValidContact(currentMember)) {
    return { member: null, fallback: true };
  }

  return { member: currentMember, fallback: false };
}

/**
 * Attempts failover to the next team member when delivery fails.
 * Iterates through remaining members until one with valid contact is found.
 *
 * @param {number} teamId - The on-call team ID
 * @param {number} failedMemberId - The member ID that failed delivery
 * @returns {Promise<object|null>} The next available member or null
 */
export async function failoverToNext(teamId, failedMemberId) {
  const db = await getDb();

  const members = await db.all(
    'SELECT * FROM oncall_members WHERE team_id = ? ORDER BY position ASC',
    [teamId]
  );

  if (members.length === 0) return null;

  const failedIndex = members.findIndex(m => m.id === failedMemberId);
  if (failedIndex === -1) return null;

  // Try each subsequent member in rotation order
  for (let offset = 1; offset < members.length; offset++) {
    const nextIndex = (failedIndex + offset) % members.length;
    const nextMember = members[nextIndex];
    const candidate = {
      id: nextMember.id,
      name: nextMember.name,
      email: nextMember.email || null,
      telegram_chat_id: nextMember.telegram_chat_id || null
    };
    if (hasValidContact(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Checks if a team member has at least one valid contact method.
 *
 * @param {object} member - The team member to check
 * @returns {boolean} True if the member has a valid contact method
 */
function hasValidContact(member) {
  if (!member) return false;
  const hasTelegram = member.telegram_chat_id && typeof member.telegram_chat_id === 'string' && member.telegram_chat_id.trim() !== '';
  const hasEmail = member.email && typeof member.email === 'string' && member.email.trim() !== '';
  return hasTelegram || hasEmail;
}
