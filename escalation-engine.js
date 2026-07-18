import { getDb } from './database.js';

/**
 * In-memory store for active escalation timers.
 * Key: alertId, Value: { timerId, retryTimerId }
 */
const activeTimers = new Map();

/**
 * Validates an escalation policy configuration.
 * @param {object} policy - The escalation policy to validate
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateEscalationPolicy(policy) {
  const errors = [];

  if (!policy || typeof policy !== 'object') {
    return { valid: false, errors: ['Policy must be an object'] };
  }

  if (!Array.isArray(policy.tiers)) {
    return { valid: false, errors: ['Policy must have a tiers array'] };
  }

  if (policy.tiers.length < 3 || policy.tiers.length > 10) {
    errors.push(`Policy must have between 3 and 10 tiers, got ${policy.tiers.length}`);
  }

  const validChannels = ['telegram', 'email'];

  for (let i = 0; i < policy.tiers.length; i++) {
    const tier = policy.tiers[i];

    if (!tier || typeof tier !== 'object') {
      errors.push(`Tier at index ${i} must be an object`);
      continue;
    }

    if (typeof tier.level !== 'number' || tier.level < 1 || tier.level > 10 || !Number.isInteger(tier.level)) {
      errors.push(`Tier at index ${i}: level must be an integer between 1 and 10`);
    }

    if (!validChannels.includes(tier.channel)) {
      errors.push(`Tier at index ${i}: channel must be 'telegram' or 'email', got '${tier.channel}'`);
    }

    if (!tier.contact || typeof tier.contact !== 'string' || tier.contact.trim() === '') {
      errors.push(`Tier at index ${i}: contact must be a non-empty string`);
    }

    if (typeof tier.delay_minutes !== 'number' || tier.delay_minutes < 1 || tier.delay_minutes > 60 || !Number.isInteger(tier.delay_minutes)) {
      errors.push(`Tier at index ${i}: delay_minutes must be an integer between 1 and 60`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Delivers a notification via the specified channel.
 * @param {string} channel - 'telegram' or 'email'
 * @param {string} contact - The contact address/id
 * @param {string} message - The notification message
 * @returns {Promise<boolean>} true if delivery succeeded
 */
async function deliverNotification(channel, contact, message) {
  const db = await getDb();
  const rows = await db.all('SELECT key, value FROM settings');
  const settings = {};
  rows.forEach(r => { settings[r.key] = r.value; });

  if (channel === 'telegram') {
    const token = settings.telegram_bot_token;
    if (!token) return false;

    try {
      const telegramUrl = `https://api.telegram.org/bot${token}/sendMessage`;
      const response = await fetch(telegramUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: contact,
          text: message,
          parse_mode: 'HTML'
        })
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  if (channel === 'email') {
    try {
      const nodemailer = await import('nodemailer');
      const transporter = nodemailer.default.createTransport({
        host: settings.email_smtp_host,
        port: parseInt(settings.email_smtp_port) || 587,
        secure: parseInt(settings.email_smtp_port) === 465,
        auth: {
          user: settings.email_smtp_user,
          pass: settings.email_smtp_pass
        }
      });

      await transporter.sendMail({
        from: settings.email_sender || '"RxMonitor" <noreply@rxmonitor.local>',
        to: contact,
        subject: '[RxMonitor] Escalation Alert',
        text: message,
        html: `<div style="font-family: sans-serif; padding: 20px;">${message}</div>`
      });
      return true;
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * Attempts notification delivery with one retry after 30 seconds on failure.
 * Returns true if delivery ultimately succeeds, false otherwise.
 */
async function deliverWithRetry(channel, contact, message, alertId) {
  const success = await deliverNotification(channel, contact, message);
  if (success) return true;

  // Retry once after 30 seconds
  return new Promise((resolve) => {
    const retryTimer = setTimeout(async () => {
      const state = activeTimers.get(alertId);
      if (state) {
        state.retryTimerId = null;
      }
      const retrySuccess = await deliverNotification(channel, contact, message);
      resolve(retrySuccess);
    }, 30000);

    // Store retry timer so it can be cancelled on acknowledgment
    const state = activeTimers.get(alertId);
    if (state) {
      state.retryTimerId = retryTimer;
    }
  });
}

/**
 * Schedules the next tier escalation after the specified delay.
 */
function scheduleNextTier(alertId, policyId, tiers, currentTierIndex, message) {
  const currentTier = tiers[currentTierIndex];
  const delayMs = currentTier.delay_minutes * 60 * 1000;

  const timerId = setTimeout(async () => {
    // Check if alert is still active
    const state = activeTimers.get(alertId);
    if (!state || state.cancelled) return;

    const nextTierIndex = currentTierIndex + 1;

    if (nextTierIndex >= tiers.length) {
      // All tiers exhausted - notify all channels simultaneously
      await handleTierExhaustion(alertId, policyId, tiers, message);
      return;
    }

    // Advance to next tier
    const db = await getDb();
    await db.run(
      'UPDATE escalation_states SET current_tier = ? WHERE alert_id = ? AND status = ?',
      [nextTierIndex + 1, alertId, 'active']
    );

    const nextTier = tiers[nextTierIndex];
    const tierMessage = `🚨 <b>Escalation Level ${nextTier.level}</b>\n\n${message}`;

    const delivered = await deliverWithRetry(nextTier.channel, nextTier.contact, tierMessage, alertId);

    if (!delivered) {
      // Retry failed - proceed to next tier immediately
      scheduleNextTier(alertId, policyId, tiers, nextTierIndex, message);
    } else {
      // Schedule advancement to the tier after this one
      scheduleNextTier(alertId, policyId, tiers, nextTierIndex, message);
    }
  }, delayMs);

  const state = activeTimers.get(alertId);
  if (state) {
    state.timerId = timerId;
  }
}

/**
 * Handles tier exhaustion: notifies all channels and marks escalation as exhausted.
 */
async function handleTierExhaustion(alertId, policyId, tiers, message) {
  const db = await getDb();

  // Update state to exhausted
  await db.run(
    'UPDATE escalation_states SET status = ? WHERE alert_id = ? AND policy_id = ?',
    ['exhausted', alertId, policyId]
  );

  // Notify all configured channels simultaneously
  const exhaustionMessage = `🚨🚨 <b>ESCALATION EXHAUSTED</b>\n\nAll escalation tiers have been exhausted without acknowledgment.\n\n${message}`;

  const deliveryPromises = tiers.map(tier =>
    deliverNotification(tier.channel, tier.contact, exhaustionMessage)
  );

  await Promise.allSettled(deliveryPromises);

  // Clean up timers
  activeTimers.delete(alertId);
}

/**
 * Triggers an escalation sequence for a given alert and policy.
 * Creates an escalation_states record, starts first tier notification,
 * and schedules tier advancement.
 * 
 * @param {number} alertId - The alert ID triggering escalation
 * @param {number} policyId - The escalation policy ID to use
 */
export async function triggerEscalation(alertId, policyId) {
  const db = await getDb();

  // Load the policy and its tiers
  const policy = await db.get('SELECT * FROM escalation_policies WHERE id = ?', [policyId]);
  if (!policy) {
    throw new Error(`Escalation policy ${policyId} not found`);
  }

  const tiers = await db.all(
    'SELECT * FROM escalation_tiers WHERE policy_id = ? ORDER BY level ASC',
    [policyId]
  );

  if (tiers.length === 0) {
    throw new Error(`Escalation policy ${policyId} has no tiers configured`);
  }

  // Create escalation state record
  const now = new Date().toISOString();
  await db.run(
    'INSERT INTO escalation_states (alert_id, policy_id, current_tier, status, triggered_at) VALUES (?, ?, ?, ?, ?)',
    [alertId, policyId, 1, 'active', now]
  );

  // Initialize timer state
  activeTimers.set(alertId, { timerId: null, retryTimerId: null, cancelled: false });

  // Load monitor info for the message
  const monitor = await db.get(
    `SELECT m.name, m.url FROM monitors m 
     JOIN escalation_policies ep ON ep.monitor_id = m.id 
     WHERE ep.id = ?`,
    [policyId]
  );

  const message = monitor
    ? `Monitor "<b>${monitor.name}</b>" (${monitor.url}) requires attention.`
    : `Alert ID ${alertId} requires attention.`;

  // Deliver first notification immediately (within 5 seconds)
  const firstTier = tiers[0];
  const firstMessage = `🚨 <b>Escalation Level ${firstTier.level}</b>\n\n${message}`;

  const delivered = await deliverWithRetry(firstTier.channel, firstTier.contact, firstMessage, alertId);

  if (!delivered && tiers.length > 1) {
    // First tier delivery failed even after retry - proceed to next tier
    const db2 = await getDb();
    await db2.run(
      'UPDATE escalation_states SET current_tier = ? WHERE alert_id = ? AND status = ?',
      [2, alertId, 'active']
    );
    scheduleNextTier(alertId, policyId, tiers, 1, message);
  } else if (tiers.length > 1) {
    // Schedule next tier after delay
    scheduleNextTier(alertId, policyId, tiers, 0, message);
  } else if (!delivered) {
    // Only one tier and it failed - exhausted
    await handleTierExhaustion(alertId, policyId, tiers, message);
  }
}

/**
 * Acknowledges an alert, cancelling all pending escalation timers.
 * 
 * @param {number} alertId - The alert to acknowledge
 * @param {number} userId - The user acknowledging the alert
 */
export async function acknowledgeAlert(alertId, userId) {
  const db = await getDb();

  // Update escalation state
  const now = new Date().toISOString();
  await db.run(
    'UPDATE escalation_states SET status = ?, acknowledged_at = ?, acknowledged_by = ? WHERE alert_id = ? AND status = ?',
    ['acknowledged', now, userId, alertId, 'active']
  );

  // Cancel pending timers
  const state = activeTimers.get(alertId);
  if (state) {
    state.cancelled = true;
    if (state.timerId) {
      clearTimeout(state.timerId);
      state.timerId = null;
    }
    if (state.retryTimerId) {
      clearTimeout(state.retryTimerId);
      state.retryTimerId = null;
    }
    activeTimers.delete(alertId);
  }
}

/**
 * Returns the active timers map (for testing purposes).
 */
export function _getActiveTimers() {
  return activeTimers;
}
