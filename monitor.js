import tls from 'tls';
import { URL } from 'url';
import { getDb } from './database.js';
import { sendNotification } from './notifier.js';

const activeIntervals = new Map(); // monitorId -> setInterval reference

export async function initMonitoring() {
  await syncMonitors();
}

export async function syncMonitors() {
  const db = await getDb();
  const monitors = await db.all('SELECT * FROM monitors WHERE active = 1');
  const monitorIds = new Set(monitors.map(m => m.id));

  // Stop intervals for monitors that are no longer active or deleted
  for (const id of activeIntervals.keys()) {
    if (!monitorIds.has(id)) {
      clearInterval(activeIntervals.get(id));
      activeIntervals.delete(id);
    }
  }

  // Start/update intervals for active monitors
  for (const monitor of monitors) {
    const existing = activeIntervals.get(monitor.id);
    if (!existing) {
      // First check runs immediately
      runSingleCheck(monitor.id);
      
      // Schedule subsequent checks
      const intervalMs = monitor.interval * 1000;
      const timer = setInterval(() => runSingleCheck(monitor.id), intervalMs);
      activeIntervals.set(monitor.id, timer);
    }
  }
}

// SSL Check Helper
async function checkSSLExpiry(urlString) {
  try {
    if (!urlString.startsWith('https://')) return null;
    const parsedUrl = new URL(urlString);
    const host = parsedUrl.hostname;
    
    return new Promise((resolve) => {
      const socket = tls.connect({
        host: host,
        port: 443,
        servername: host,
        rejectUnauthorized: false
      }, () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        if (cert && cert.valid_to) {
          resolve(new Date(cert.valid_to).toISOString());
        } else {
          resolve(null);
        }
      });
      socket.on('error', () => resolve(null));
      socket.setTimeout(5000, () => {
        socket.destroy();
        resolve(null);
      });
    });
  } catch (e) {
    return null;
  }
}

// Diagnostic troubleshooting suggestions helper
export function getDiagnostics(message, status) {
  if (status === 'UP') return [];
  const msg = (message || '').toLowerCase();
  
  if (msg.includes('500') || msg.includes('internal server error')) {
    return [
      'Application responded but returned Internal Server Error (500).',
      'Suggested checks:',
      ' • Check application crash logs',
      ' • Verify docker container is running and not restarting',
      ' • Inspect database connection settings and logs'
    ];
  }
  if (msg.includes('502') || msg.includes('bad gateway') || msg.includes('504') || msg.includes('gateway timeout')) {
    return [
      'Bad Gateway / Gateway Timeout.',
      'Suggested checks:',
      ' • Verify the backend application server (e.g. Node/Python/PHP) is running',
      ' • Check Nginx/Apache configuration and service status',
      ' • Verify reverse proxy target port matches'
    ];
  }
  if (msg.includes('timeout') || msg.includes('aborterror')) {
    return [
      'Connection timed out. Server failed to respond in time.',
      'Suggested checks:',
      ' • Check if VM/Host is frozen or running high on CPU/RAM',
      ' • Check hosting provider console for server power status',
      ' • Verify network firewalls allow traffic on the target port'
    ];
  }
  if (msg.includes('econnrefused')) {
    return [
      'Connection refused. The server actively rejected the connection.',
      'Suggested checks:',
      ' • Verify the application server is started and listening on the expected port',
      ' • Ensure the local firewall (iptables/ufw) allows traffic on that port'
    ];
  }
  return [
    'Connection failed or returned error code.',
    'Suggested checks:',
    ' • Verify the target URL domain name resolves correctly (DNS)',
    ' • Double check the exact protocol (HTTP/HTTPS) and URI path'
  ];
}

export async function runSingleCheck(monitorId) {
  const db = await getDb();
  const monitor = await db.get('SELECT * FROM monitors WHERE id = ?', [monitorId]);
  if (!monitor || monitor.active !== 1) return;

  // Maintenance mode handling
  if (monitor.is_maintenance === 1) {
    const timestamp = new Date().toISOString();
    await db.run(
      'UPDATE monitors SET status = ?, last_checked = ?, current_fails = 0 WHERE id = ?',
      ['MAINTENANCE', timestamp, monitor.id]
    );
    return;
  }

  const startTime = Date.now();
  let status = 'UP';
  let message = 'OK';
  let responseTime = 0;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), monitor.timeout * 1000);

    const response = await fetch(monitor.url, {
      method: monitor.method || 'GET',
      signal: controller.signal,
      headers: {
        'User-Agent': 'RxMonitor/1.0'
      }
    });

    clearTimeout(timeoutId);
    responseTime = Date.now() - startTime;

    if (!response.ok) {
      status = 'DOWN';
      message = `HTTP Status: ${response.status} ${response.statusText}`;
    } else {
      message = `HTTP Status: ${response.status} - OK`;
    }
  } catch (err) {
    status = 'DOWN';
    responseTime = Date.now() - startTime;
    if (err.name === 'AbortError') {
      message = 'Request Timeout';
    } else {
      message = err.message || 'Unknown network error';
    }
  }

  // Handle SSL Certificate check if HTTPS and successfully reached
  let sslExpiry = monitor.ssl_expiry;
  if (monitor.url.startsWith('https://') && status === 'UP') {
    const freshSSL = await checkSSLExpiry(monitor.url);
    if (freshSSL) {
      sslExpiry = freshSSL;
      await db.run('UPDATE monitors SET ssl_expiry = ? WHERE id = ?', [sslExpiry, monitor.id]);
    }
  }

  const timestamp = new Date().toISOString();

  // Retry Verification Logic
  if (status === 'DOWN') {
    const nextFailCount = (monitor.current_fails || 0) + 1;
    const maxRetries = monitor.max_retries || 3;

    if (nextFailCount < maxRetries) {
      // Log as a PENDING retry log, do not trigger alerts
      const retryMsg = `Retry ${nextFailCount}/${maxRetries} due to: ${message}`;
      await db.run(
        'INSERT INTO logs (monitor_id, status, response_time, message, checked_at) VALUES (?, ?, ?, ?, ?)',
        [monitor.id, 'PENDING', responseTime, retryMsg, timestamp]
      );

      await db.run(
        'UPDATE monitors SET current_fails = ?, last_checked = ? WHERE id = ?',
        [nextFailCount, timestamp, monitor.id]
      );

      // Schedule instant retry check in 5 seconds
      setTimeout(() => runSingleCheck(monitor.id), 5000);
      return;
    }
  }

  // If check succeeded or exceeded max retries:
  // Write actual log
  await db.run(
    'INSERT INTO logs (monitor_id, status, response_time, message, checked_at) VALUES (?, ?, ?, ?, ?)',
    [monitor.id, status, responseTime, message, timestamp]
  );

  const oldStatus = monitor.status;
  
  if (oldStatus !== status) {
    // Status transitioned!
    await db.run(
      'UPDATE monitors SET status = ?, last_checked = ?, last_status_change = ?, current_fails = 0 WHERE id = ?',
      [status, timestamp, timestamp, monitor.id]
    );

    // Calculate downtime duration if recovering to UP
    let downtimeSeconds = 0;
    if (status === 'UP' && oldStatus === 'DOWN' && monitor.last_status_change) {
      downtimeSeconds = Math.round((new Date(timestamp) - new Date(monitor.last_status_change)) / 1000);
    }

    // Insert Incident event
    const incidentMsg = status === 'DOWN' ? `Monitor went offline: ${message}` : `Monitor recovered after downtime.`;
    await db.run(
      'INSERT INTO incidents (monitor_id, event_type, timestamp, message, downtime_duration) VALUES (?, ?, ?, ?, ?)',
      [monitor.id, status, timestamp, incidentMsg, downtimeSeconds]
    );

    // Dispatch Alerts
    if (oldStatus !== 'PENDING') {
      const diagnostics = getDiagnostics(message, status);
      await sendNotification(
        monitor.name,
        monitor.url,
        oldStatus,
        status,
        status === 'DOWN' ? `${message}\n\n${diagnostics.join('\n')}` : '',
        downtimeSeconds
      );
    }
  } else {
    // No transition, just update last_checked and reset fail count (if UP)
    await db.run(
      'UPDATE monitors SET last_checked = ?, current_fails = ? WHERE id = ?',
      [timestamp, status === 'UP' ? 0 : monitor.current_fails, monitor.id]
    );
  }
}

export function stopAllMonitoring() {
  for (const timer of activeIntervals.values()) {
    clearInterval(timer);
  }
  activeIntervals.clear();
}
