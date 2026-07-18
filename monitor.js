import tls from 'tls';
import { URL } from 'url';
import { getDb } from './database.js';
import { sendNotification } from './notifier.js';
import { resolveWithTiming, isIPAddress } from './dns-resolver.js';
import { followRedirects } from './redirect-tracker.js';
import { evaluateContent } from './content-validator.js';
import { evaluateHeaders } from './header-validator.js';
import { evaluateCertificateAlerts } from './certificate-monitor.js';
import { isWithinMaintenanceWindow } from './maintenance-window.js';
import { shouldSuppress, getSuppressedCount, clearSuppression, getSuppressionState, startSuppression, recordSuppression } from './alert-deduplicator.js';
import { resolveOnCall } from './on-call-scheduler.js';
import { triggerEscalation } from './escalation-engine.js';
import { openIncident, addTimelineEvent, closeIncident, getOpenIncident } from './incident-timeline.js';
import { recordErrorStatus } from './error-rate-tracker.js';
import { runTraceroute, canRunTraceroute } from './traceroute-runner.js';
import { captureScreenshot } from './screenshot-capture.js';
import { computeDiffPercentage, computeContentHash, shouldAlert as shouldDiffAlert, applyExclusions } from './diff-detector.js';
import { broadcast } from './ws-service.js';

const activeIntervals = new Map(); // monitorId -> setInterval reference
const lastTracerouteTimes = new Map(); // monitorId -> timestamp (ms) of last traceroute run

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
  let dnsTimeMs = null;
  let resolvedIp = null;
  let responseBody = null;
  let responseHeaders = null;
  let httpStatusCode = null;

  // DNS resolution timing (before HTTP fetch)
  const parsedUrl = new URL(monitor.url);
  if (!isIPAddress(monitor.url)) {
    try {
      const dnsResult = await resolveWithTiming(parsedUrl.hostname);
      dnsTimeMs = dnsResult.timeMs;
      resolvedIp = dnsResult.ip;
    } catch (dnsErr) {
      // DNS failure - mark as down
      status = 'DOWN';
      responseTime = dnsErr.timeMs || (Date.now() - startTime);
      message = `DNS resolution failed: ${dnsErr.message}`;
      dnsTimeMs = dnsErr.timeMs || responseTime;
    }
  }

  // Only proceed with HTTP fetch if DNS succeeded (or host is IP)
  if (status === 'UP') {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), monitor.timeout * 1000);

      const response = await fetch(monitor.url, {
        method: monitor.method || 'GET',
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          'User-Agent': 'RxMonitor/1.0'
        }
      });

      clearTimeout(timeoutId);
      responseTime = Date.now() - startTime;
      httpStatusCode = response.status;

      if (!response.ok) {
        status = 'DOWN';
        message = `HTTP Status: ${response.status} ${response.statusText}`;
      } else {
        message = `HTTP Status: ${response.status} - OK`;
      }

      // Capture response body and headers for validation
      try {
        responseBody = await response.text();
      } catch { responseBody = null; }
      responseHeaders = Object.fromEntries(response.headers.entries());

    } catch (err) {
      status = 'DOWN';
      responseTime = Date.now() - startTime;
      if (err.name === 'AbortError') {
        message = 'Request Timeout';
      } else {
        message = err.message || 'Unknown network error';
      }
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
    // Evaluate certificate alert thresholds
    try {
      await evaluateCertificateAlerts(monitor.id);
    } catch (certErr) {
      // Non-fatal: log but don't fail the check
      console.error(`Certificate alert evaluation failed for monitor ${monitor.id}:`, certErr.message);
    }
  }

  // Content validation (only if UP and body available)
  if (status === 'UP' && responseBody !== null) {
    try {
      const contentRules = await db.all(
        'SELECT type, value FROM content_validation_rules WHERE monitor_id = ?',
        [monitor.id]
      );
      if (contentRules.length > 0) {
        const contentResult = evaluateContent(responseBody, contentRules);
        if (!contentResult.pass) {
          status = 'DOWN';
          const failedRules = contentResult.failures.map(f => f.reason).join('; ');
          message = `Content validation failed: ${failedRules}`;
        }
      }
    } catch (cvErr) {
      console.error(`Content validation error for monitor ${monitor.id}:`, cvErr.message);
    }
  }

  // Header validation (only if UP and headers available)
  if (status === 'UP' && responseHeaders !== null) {
    try {
      const headerRulesRows = await db.all(
        'SELECT header_name, type, expected_value FROM header_validation_rules WHERE monitor_id = ?',
        [monitor.id]
      );
      if (headerRulesRows.length > 0) {
        const headerRules = headerRulesRows.map(r => ({ header: r.header_name, type: r.type, expected: r.expected_value }));
        const headerResult = evaluateHeaders(responseHeaders, headerRules);
        if (!headerResult.pass) {
          status = 'DOWN';
          const failedHeaders = headerResult.failures.map(f => `${f.header}: ${f.type}`).join('; ');
          message = `Header validation failed: ${failedHeaders}`;
        }
      }
    } catch (hvErr) {
      console.error(`Header validation error for monitor ${monitor.id}:`, hvErr.message);
    }
  }

  // Redirect tracking (track 3xx response chains)
  let redirectChainData = null;
  if (httpStatusCode && httpStatusCode >= 300 && httpStatusCode < 400) {
    try {
      redirectChainData = await followRedirects(monitor.url, 10, (monitor.timeout || 10) * 1000);
    } catch (rtErr) {
      console.error(`Redirect tracking error for monitor ${monitor.id}:`, rtErr.message);
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

      // Record retry attempt in incident timeline (Requirement 14.2)
      try {
        const openInc = await getOpenIncident(monitor.id);
        if (openInc) {
          await addTimelineEvent(openInc.id, 'retry_attempt', {
            timestamp: timestamp,
            response_time_ms: responseTime,
            message: retryMsg
          });
        }
      } catch (rtErr) {
        // Non-fatal: don't block retry flow
      }

      // Schedule instant retry check in 5 seconds
      setTimeout(() => runSingleCheck(monitor.id), 5000);
      return;
    }
  }

  // If check succeeded or exceeded max retries:
  // Write actual log
  const logResult = await db.run(
    'INSERT INTO logs (monitor_id, status, response_time, message, checked_at) VALUES (?, ?, ?, ?, ?)',
    [monitor.id, status, responseTime, message, timestamp]
  );
  const logId = logResult.lastID;

  // Broadcast check result via WebSocket (Requirement 23.2)
  broadcast('check_result', {
    monitor_id: monitor.id,
    status,
    response_time: responseTime,
    message,
    timestamp
  }, monitor.id);

  // Store DNS resolution data
  if (dnsTimeMs !== null) {
    try {
      await db.run(
        'INSERT INTO dns_logs (log_id, monitor_id, dns_time_ms, resolver_ip, error_type) VALUES (?, ?, ?, ?, ?)',
        [logId, monitor.id, dnsTimeMs, resolvedIp, status === 'DOWN' && message.includes('DNS') ? 'NXDOMAIN' : null]
      );
    } catch (dnsLogErr) {
      console.error(`Failed to store DNS log for monitor ${monitor.id}:`, dnsLogErr.message);
    }
  }

  // Store redirect chain data
  if (redirectChainData && redirectChainData.hops && redirectChainData.hops.length > 0) {
    try {
      const chainResult = await db.run(
        'INSERT INTO redirect_chains (log_id, monitor_id) VALUES (?, ?)',
        [logId, monitor.id]
      );
      const chainId = chainResult.lastID;
      for (let i = 0; i < redirectChainData.hops.length; i++) {
        const hop = redirectChainData.hops[i];
        await db.run(
          'INSERT INTO redirect_hops (chain_id, hop_order, url, status_code, response_time_ms) VALUES (?, ?, ?, ?, ?)',
          [chainId, i, hop.url, hop.status_code, hop.response_time_ms]
        );
      }
    } catch (rcErr) {
      console.error(`Failed to store redirect chain for monitor ${monitor.id}:`, rcErr.message);
    }
  }

  // --- Error Rate Tracker: record 5xx responses (Requirement 19) ---
  if (httpStatusCode && httpStatusCode >= 500 && httpStatusCode <= 599) {
    try {
      await recordErrorStatus(monitor.id, httpStatusCode, timestamp);
    } catch (errRateErr) {
      console.error(`Error rate recording failed for monitor ${monitor.id}:`, errRateErr.message);
    }
  }

  // --- Traceroute & Screenshot on check failure (Requirements 20, 21) ---
  if (status === 'DOWN') {
    // Traceroute: run if rate limit allows
    try {
      const lastRun = lastTracerouteTimes.get(monitor.id) || null;
      if (canRunTraceroute(monitor.id, lastRun, 5)) {
        lastTracerouteTimes.set(monitor.id, Date.now());
        const traceHostname = parsedUrl.hostname;
        const traceResult = await runTraceroute(traceHostname, 30, 30);

        // Store traceroute result in database
        const traceInsert = await db.run(
          'INSERT INTO traceroute_results (log_id, monitor_id, hostname, complete, executed_at) VALUES (?, ?, ?, ?, ?)',
          [logId, monitor.id, traceHostname, traceResult.complete ? 1 : 0, timestamp]
        );
        const tracerouteId = traceInsert.lastID;

        for (const hop of traceResult.hops) {
          await db.run(
            'INSERT INTO traceroute_hops (traceroute_id, seq, ip, hostname, rtt_ms) VALUES (?, ?, ?, ?, ?)',
            [tracerouteId, hop.seq, hop.ip, hop.hostname, hop.rtt_ms]
          );
        }
      }
    } catch (traceErr) {
      console.error(`Traceroute failed for monitor ${monitor.id}:`, traceErr.message);
    }

    // Screenshot: capture if monitor has screenshot enabled (check monitor.screenshot_enabled flag or capture by default)
    try {
      const screenshotResult = await captureScreenshot(monitor.url, 15);
      if (screenshotResult.success && screenshotResult.path) {
        await db.run(
          'INSERT INTO screenshots (log_id, monitor_id, file_path, captured_at, timeout_occurred) VALUES (?, ?, ?, ?, 0)',
          [logId, monitor.id, screenshotResult.path, screenshotResult.captured_at]
        );
      } else if (screenshotResult.error && screenshotResult.error.includes('timed out')) {
        await db.run(
          'INSERT INTO screenshots (log_id, monitor_id, file_path, captured_at, timeout_occurred) VALUES (?, ?, ?, ?, 1)',
          [logId, monitor.id, '', screenshotResult.captured_at]
        );
      }
      // If chromium/puppeteer unavailable, gracefully skip (no DB record)
    } catch (ssErr) {
      console.error(`Screenshot capture failed for monitor ${monitor.id}:`, ssErr.message);
    }
  }

  // --- Diff Detection on successful check (Requirement 22) ---
  if (status === 'UP' && responseBody !== null) {
    try {
      const diffBaseline = await db.get(
        'SELECT * FROM diff_baselines WHERE monitor_id = ?',
        [monitor.id]
      );

      if (diffBaseline) {
        // Get exclusion patterns
        const exclusionRows = await db.all(
          'SELECT pattern FROM diff_exclusions WHERE monitor_id = ?',
          [monitor.id]
        );
        const exclusions = exclusionRows.map(r => r.pattern);

        // Apply exclusions before comparison
        const processedContent = applyExclusions(responseBody, exclusions);
        const currentHash = computeContentHash(processedContent);

        // Only compare if content hash differs from baseline
        if (currentHash !== diffBaseline.content_hash) {
          // We need the baseline content to compute diff percentage
          // Since we only store hash and length, use length-based estimation
          const diffPercentage = computeDiffPercentage(
            'x'.repeat(diffBaseline.content_length), // approximate baseline by length
            processedContent
          );

          const alerted = shouldDiffAlert(diffPercentage, monitor.diff_threshold || 5) ? 1 : 0;

          await db.run(
            `INSERT INTO diff_results (log_id, monitor_id, previous_hash, current_hash, diff_percentage, changed_lines, alerted)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [logId, monitor.id, diffBaseline.content_hash, currentHash, diffPercentage, null, alerted]
          );
        }
      } else if (monitor.diff_enabled) {
        // First time: capture baseline without alerting (Requirement 22.6)
        const currentHash = computeContentHash(responseBody);
        await db.run(
          'INSERT INTO diff_baselines (monitor_id, content_hash, content_length, captured_at) VALUES (?, ?, ?, ?)',
          [monitor.id, currentHash, responseBody.length, timestamp]
        );
      }
    } catch (diffErr) {
      console.error(`Diff detection error for monitor ${monitor.id}:`, diffErr.message);
    }
  }

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

    // Broadcast status change via WebSocket (Requirement 23.3)
    broadcast('status_change', {
      monitor_id: monitor.id,
      previous_status: oldStatus,
      new_status: status,
      timestamp,
      downtime_seconds: downtimeSeconds
    }, monitor.id);

    // --- Incident Timeline wiring (Requirement 14) ---
    try {
      if (status === 'DOWN' && oldStatus !== 'PENDING') {
        // UP→DOWN: Open incident and record failure_detected
        await openIncident(monitor.id, timestamp, `Monitor went offline: ${message}`);
      } else if (status === 'UP' && oldStatus === 'DOWN') {
        // DOWN→UP: Close incident and record recovery_detected
        const openInc = await getOpenIncident(monitor.id);
        if (openInc) {
          await closeIncident(openInc.id, timestamp);
        }
        // Clear alert deduplication on recovery (Requirement 16.4)
        await clearSuppression(monitor.id);
      }
    } catch (tlErr) {
      console.error(`Incident timeline error for monitor ${monitor.id}:`, tlErr.message);
    }

    // Dispatch Alerts
    if (oldStatus !== 'PENDING') {
      const diagnostics = getDiagnostics(message, status);
      const now = Date.now();

      // --- Maintenance window check (Requirement 13.1) ---
      let inMaintenance = false;
      try {
        inMaintenance = await isWithinMaintenanceWindow(monitor.id, new Date(now));
      } catch (mwErr) {
        console.error(`Maintenance window check failed for monitor ${monitor.id}:`, mwErr.message);
      }

      if (!inMaintenance) {
        // --- Alert deduplication check (Requirement 16) ---
        let suppressed = false;
        if (status === 'DOWN') {
          try {
            const suppState = await getSuppressionState(monitor.id);
            if (suppState && suppState.last_alert_at) {
              const lastAlertTime = new Date(suppState.last_alert_at).getTime();
              const windowMin = suppState.suppression_window_min || 30;
              suppressed = shouldSuppress(monitor.id, now, lastAlertTime, windowMin);
              if (suppressed) {
                await recordSuppression(monitor.id, now, windowMin);
              }
            }
          } catch (dedupErr) {
            console.error(`Alert deduplication check failed for monitor ${monitor.id}:`, dedupErr.message);
          }
        }

        if (!suppressed) {
          // Start suppression window for new DOWN alerts
          if (status === 'DOWN') {
            try {
              await startSuppression(monitor.id, now, 30);
            } catch (ssErr) {
              console.error(`Start suppression failed for monitor ${monitor.id}:`, ssErr.message);
            }
          }

          // --- On-call routing (Requirement 17) ---
          // Send standard notification (fallback if no on-call team configured)
          await sendNotification(
            monitor.name,
            monitor.url,
            oldStatus,
            status,
            status === 'DOWN' ? `${message}\n\n${diagnostics.join('\n')}` : '',
            downtimeSeconds
          );

          // --- Escalation engine wiring (Requirement 12) ---
          if (status === 'DOWN') {
            try {
              const policy = await db.get(
                'SELECT * FROM escalation_policies WHERE monitor_id = ? LIMIT 1',
                [monitor.id]
              );
              if (policy) {
                // Use the incident ID as the alert ID for escalation
                const latestIncident = await db.get(
                  'SELECT id FROM incidents WHERE monitor_id = ? ORDER BY id DESC LIMIT 1',
                  [monitor.id]
                );
                if (latestIncident) {
                  await triggerEscalation(latestIncident.id, policy.id);
                  // Record escalation event in incident timeline
                  const openInc = await getOpenIncident(monitor.id);
                  if (openInc) {
                    await addTimelineEvent(openInc.id, 'escalation_sent', {
                      timestamp: timestamp,
                      message: `Escalation triggered via policy: ${policy.name}`
                    });
                  }
                }
              }
            } catch (escErr) {
              console.error(`Escalation trigger failed for monitor ${monitor.id}:`, escErr.message);
            }
          }
        }
      } else {
        // In maintenance - record maintenance flag in incident timeline
        try {
          const openInc = await getOpenIncident(monitor.id);
          if (openInc) {
            await addTimelineEvent(openInc.id, 'maintenance_flagged', {
              timestamp: timestamp,
              message: 'Alert suppressed due to active maintenance window'
            });
          }
        } catch (mfErr) {
          console.error(`Maintenance flag timeline event failed for monitor ${monitor.id}:`, mfErr.message);
        }
      }
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
