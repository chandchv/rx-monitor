import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import os from 'os';
import fs from 'fs';
import http from 'http';
import nodemailer from 'nodemailer';
import { fileURLToPath } from 'url';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import Razorpay from 'razorpay';
import crypto from 'crypto';
import { getDb } from './database.js';
import { initMonitoring, syncMonitors, runSingleCheck, stopAllMonitoring } from './monitor.js';
import { initWebSocket, getConnectedClientCount } from './ws-service.js';
import { computeSLA, computeErrorBudget, validateSLATarget, getPeriodSeconds } from './sla-calculator.js';
import { testTelegram, testEmail, startDailyScheduler } from './notifier.js';
import { computeAllPercentiles, isValidTimeWindow } from './percentile-calculator.js';
import { computeApdexFromResults } from './apdex-calculator.js';
import { runLoadTest, canRunLoadTest } from './load-tester.js';
import { runConnectionTest, detectLimit } from './connection-detector.js';
import { runGeographicCheck, computeConsensus, validateRegionConfig } from './geographic-checker.js';
import { validateTransactionConfig, executeSyntheticTransaction, getTransactionResults } from './synthetic.js';
import { validateContentRules, evaluateContent } from './content-validator.js';
import { validateHeaderRules, evaluateHeaders } from './header-validator.js';
import { DEFAULT_THRESHOLDS, validateThresholds, evaluateCertificateAlerts } from './certificate-monitor.js';
import { resolveWithTiming, isIPAddress, computeDnsStats } from './dns-resolver.js';
import { followRedirects } from './redirect-tracker.js';
import { triggerEscalation, acknowledgeAlert, validateEscalationPolicy } from './escalation-engine.js';
import { isWithinMaintenanceWindow, validateMaintenanceWindow, getActiveWindows } from './maintenance-window.js';
import { shouldSuppress, getSuppressedCount, clearSuppression, getSuppressionState, startSuppression, recordSuppression } from './alert-deduplicator.js';
import { getCurrentOnCall, getNextOnCall, validateRotationConfig, resolveOnCall } from './on-call-scheduler.js';
import { openIncident, addTimelineEvent, closeIncident, calculateDowntime, getIncidentTimeline, getOpenIncident } from './incident-timeline.js';
import { validateIncidentMessage, createStatusIncident, updateStatusIncident, getActiveIncidents, getResolvedIncidents } from './status-page-manager.js';
import { ingestLogs, queryLogs, purgeStaleLogs } from './log-ingestion.js';
import { recordErrorStatus, getErrorRateHistory, purgeOldEvents } from './error-rate-tracker.js';
import { runTraceroute, canRunTraceroute } from './traceroute-runner.js';
import { captureScreenshot, getScreenshotPath, purgeOldScreenshots } from './screenshot-capture.js';
import { computeDiffPercentage, computeContentHash, shouldAlert as shouldDiffAlert, applyExclusions } from './diff-detector.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'rx-monitor-default-jwt-secret-key-12345';

function decodeJwt(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1], 'base64').toString('utf8');
    return JSON.parse(payload);
  } catch (e) {
    return null;
  }
}

// --- Authentication Middleware ---
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'] || req.headers['Authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    req.user = null;
    return next();
  }

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      req.user = null;
    } else {
      req.user = decoded;
    }
    next();
  });
}

function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Sign-in is required for this action.' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access denied. Admin privileges required.' });
  }
  next();
}

async function checkMonitorOwnership(req, res, monitorId) {
  const db = await getDb();
  const monitor = await db.get('SELECT * FROM monitors WHERE id = ?', [monitorId]);
  if (!monitor) {
    res.status(404).json({ error: 'Monitor not found' });
    return null;
  }

  // Admins can access everything
  if (req.user && req.user.role === 'admin') {
    return monitor;
  }

  // Logged-in user owns this monitor
  if (req.user && monitor.user_id === req.user.id) {
    return monitor;
  }

  const visitorId = req.headers['x-visitor-id'];

  // Guest visitor owns this monitor via visitor_id
  if (!req.user && monitor.user_id === null && visitorId && monitor.visitor_id === visitorId) {
    return monitor;
  }

  // Legacy/unclaimed monitor — created before auth was added (both user_id and visitor_id are NULL).
  // Allow access so pre-existing monitors are not permanently locked out.
  if (monitor.user_id === null && monitor.visitor_id === null) {
    return monitor;
  }

  res.status(403).json({ error: 'Access denied. You do not own this monitor.' });
  return null;
}


app.use(cors());
app.use(express.json());
app.use(authenticateToken);

// --- Custom Domain Middleware & Cache ---
let cachedCustomDomain = '';

async function updateCustomDomainCache() {
  try {
    const db = await getDb();
    const row = await db.get("SELECT value FROM settings WHERE key = 'custom_domain'");
    cachedCustomDomain = row ? row.value.trim().toLowerCase() : '';
  } catch (err) {
    console.error('Failed to load custom domain cache:', err);
  }
}

app.use(async (req, res, next) => {
  const host = (req.headers.host || '').toLowerCase();
  
  if (cachedCustomDomain && (host === cachedCustomDomain || host.startsWith(cachedCustomDomain + ':'))) {
    // If accessing main root index under the custom domain, serve the public status page
    if (req.path === '/' || req.path === '/index.html') {
      return res.sendFile(path.join(__dirname, 'public', 'status.html'));
    }
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// Public status page redirects
app.get('/status', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'status.html'));
});

// --- Public APIs ---

app.get('/api/public/monitors', async (req, res) => {
  try {
    const db = await getDb();
    const monitors = await db.all('SELECT * FROM monitors WHERE active = 1 AND is_public = 1');
    
    const results = [];
    for (const monitor of monitors) {
      const logs = await db.all(
        'SELECT status, response_time, checked_at FROM logs WHERE monitor_id = ? ORDER BY checked_at DESC LIMIT 30',
        [monitor.id]
      );
      
      const totalLogs = await db.get(
        'SELECT COUNT(*) as count FROM logs WHERE monitor_id = ?',
        [monitor.id]
      );
      const upLogs = await db.get(
        "SELECT COUNT(*) as count FROM logs WHERE monitor_id = ? AND status = 'UP'",
        [monitor.id]
      );

      const uptimePct = totalLogs.count > 0 
        ? Math.round((upLogs.count / totalLogs.count) * 1000) / 10 
        : 100.0;

      // Scrutinize monitor data for public view (only return safe metrics)
      results.push({
        id: monitor.id,
        name: monitor.name,
        url: monitor.url,
        status: monitor.status,
        last_checked: monitor.last_checked,
        last_status_change: monitor.last_status_change,
        ssl_expiry: monitor.ssl_expiry,
        recentLogs: logs.reverse(),
        uptimePct
      });
    }

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Monitors APIs ---

app.get('/api/monitors', async (req, res) => {
  try {
    const db = await getDb();
    let monitors;
    const visitorId = req.headers['x-visitor-id'];

    if (req.user) {
      if (req.user.role === 'admin') {
        monitors = await db.all('SELECT * FROM monitors');
      } else {
        monitors = await db.all('SELECT * FROM monitors WHERE user_id = ?', [req.user.id]);
      }
    } else if (visitorId) {
      monitors = await db.all(
        'SELECT * FROM monitors WHERE user_id IS NULL AND (visitor_id = ? OR visitor_id IS NULL)',
        [visitorId]
      );
    } else {
      // No token, no visitor id — still show unclaimed legacy monitors
      monitors = await db.all(
        'SELECT * FROM monitors WHERE user_id IS NULL AND visitor_id IS NULL'
      );
    }
    
    const results = [];
    for (const monitor of monitors) {
      const logs = await db.all(
        'SELECT status, response_time, checked_at FROM logs WHERE monitor_id = ? ORDER BY checked_at DESC LIMIT 30',
        [monitor.id]
      );
      
      const totalLogs = await db.get(
        'SELECT COUNT(*) as count FROM logs WHERE monitor_id = ?',
        [monitor.id]
      );
      const upLogs = await db.get(
        "SELECT COUNT(*) as count FROM logs WHERE monitor_id = ? AND status = 'UP'",
        [monitor.id]
      );

      const uptimePct = totalLogs.count > 0 
        ? Math.round((upLogs.count / totalLogs.count) * 1000) / 10 
        : 100.0;

      results.push({
        ...monitor,
        recentLogs: logs.reverse(),
        uptimePct
      });
    }

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/monitors', async (req, res) => {
  const { name, url, method, interval, timeout, max_retries, is_public } = req.body;
  if (!name || !url) {
    return res.status(400).json({ error: 'Name and URL are required.' });
  }
  const visitorId = req.headers['x-visitor-id'];

  try {
    const db = await getDb();

    if (req.user) {
      // Check limits based on tier
      const user = await db.get('SELECT subscription_tier FROM users WHERE id = ?', [req.user.id]);
      const tier = user ? user.subscription_tier : 'free';
      const monitorCount = await db.get('SELECT COUNT(*) as count FROM monitors WHERE user_id = ?', [req.user.id]);

      if (tier === 'free' && monitorCount.count >= 5) {
        return res.status(400).json({ 
          error: 'You have reached the limit of 5 monitors for the free tier. Please upgrade using Razorpay for unlimited monitors!',
          limitExceeded: true
        });
      }

      const result = await db.run(
        `INSERT INTO monitors 
          (name, url, method, interval, timeout, max_retries, is_public, status, user_id) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [name, url, method || 'GET', interval || 60, timeout || 10, max_retries || 3, is_public || 0, 'PENDING', req.user.id]
      );
      await syncMonitors();
      res.status(201).json({ id: result.lastID });

    } else {
      // Anonymous user
      if (!visitorId) {
        return res.status(400).json({ error: 'Visitor identification is required.' });
      }

      const monitorCount = await db.get(
        'SELECT COUNT(*) as count FROM monitors WHERE user_id IS NULL AND visitor_id = ?', 
        [visitorId]
      );

      if (monitorCount.count >= 1) {
        return res.status(400).json({ 
          error: 'Guest limit reached. Anonymous users can monitor up to 1 server. Please sign up or sign in to add more monitors!',
          limitExceeded: true
        });
      }

      const result = await db.run(
        `INSERT INTO monitors 
          (name, url, method, interval, timeout, max_retries, is_public, status, visitor_id) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [name, url, method || 'GET', interval || 60, timeout || 10, max_retries || 3, is_public || 0, 'PENDING', visitorId]
      );
      await syncMonitors();
      res.status(201).json({ id: result.lastID });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Comparison Data Route (Requirement 25) ---
// NOTE: Must be defined BEFORE /api/monitors/:id to avoid route conflict
app.get('/api/monitors/comparison', async (req, res) => {
  try {
    const idsParam = req.query.ids || req.query.monitors;
    if (!idsParam) {
      return res.status(400).json({ error: 'Monitor IDs required (ids=1,2,3).' });
    }

    const monitorIds = idsParam.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
    if (monitorIds.length < 2) {
      return res.status(400).json({ error: 'At least 2 monitors must be selected for comparison.' });
    }
    if (monitorIds.length > 10) {
      return res.status(400).json({ error: 'Maximum of 10 monitors for comparison.' });
    }

    const timeWindow = req.query.window || '24h';
    const validWindows = { '1h': 3600, '6h': 21600, '24h': 86400, '7d': 604800 };
    if (!validWindows[timeWindow]) {
      return res.status(400).json({ error: 'Invalid time window. Use 1h, 6h, 24h, or 7d.' });
    }

    const windowSeconds = validWindows[timeWindow];
    const since = new Date(Date.now() - windowSeconds * 1000).toISOString();

    const db = await getDb();
    const result = [];

    for (const monitorId of monitorIds) {
      const monitor = await db.get('SELECT id, name, url FROM monitors WHERE id = ?', [monitorId]);
      if (!monitor) {
        result.push({ id: monitorId, name: `Monitor ${monitorId}`, data: [] });
        continue;
      }

      const logs = await db.all(
        "SELECT response_time, checked_at FROM logs WHERE monitor_id = ? AND checked_at >= ? AND status = 'UP' ORDER BY checked_at ASC",
        [monitorId, since]
      );

      result.push({
        id: monitor.id,
        name: monitor.name,
        data: logs.map(l => ({
          timestamp: l.checked_at,
          response_time: l.response_time
        }))
      });
    }

    res.json({ monitors: result, time_window: timeWindow });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/monitors/:id', async (req, res) => {
  try {
    const monitor = await checkMonitorOwnership(req, res, req.params.id);
    if (!monitor) return; // Response already handled

    const db = await getDb();
    const logs = await db.all(
      'SELECT * FROM logs WHERE monitor_id = ? ORDER BY checked_at DESC LIMIT 50',
      [req.params.id]
    );

    const incidents = await db.all(
      'SELECT * FROM incidents WHERE monitor_id = ? ORDER BY timestamp DESC LIMIT 20',
      [req.params.id]
    );

    const totalLogs = await db.get(
      'SELECT COUNT(*) as count FROM logs WHERE monitor_id = ?',
      [req.params.id]
    );
    const upLogs = await db.get(
      "SELECT COUNT(*) as count FROM logs WHERE monitor_id = ? AND status = 'UP'",
      [req.params.id]
    );
    const uptimePct = totalLogs.count > 0 
      ? Math.round((upLogs.count / totalLogs.count) * 1000) / 10 
      : 100.0;

    // Include latest redirect chain data if available
    const latestRedirectChain = await db.get(
      `SELECT rc.id, rc.log_id FROM redirect_chains rc
       WHERE rc.monitor_id = ?
       ORDER BY rc.id DESC LIMIT 1`,
      [req.params.id]
    );
    let redirectChain = null;
    if (latestRedirectChain) {
      const hops = await db.all(
        'SELECT hop_order, url, status_code, response_time_ms FROM redirect_hops WHERE chain_id = ? ORDER BY hop_order ASC',
        [latestRedirectChain.id]
      );
      redirectChain = { id: latestRedirectChain.id, log_id: latestRedirectChain.log_id, hops };
    }

    res.json({ ...monitor, logs, incidents, uptimePct, redirectChain });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/monitors/:id', async (req, res) => {
  const { name, url, method, interval, timeout, active, max_retries, is_public, is_maintenance } = req.body;
  try {
    const monitor = await checkMonitorOwnership(req, res, req.params.id);
    if (!monitor) return;

    const db = await getDb();
    await db.run(
      `UPDATE monitors SET 
        name = COALESCE(?, name),
        url = COALESCE(?, url),
        method = COALESCE(?, method),
        interval = COALESCE(?, interval),
        timeout = COALESCE(?, timeout),
        active = COALESCE(?, active),
        max_retries = COALESCE(?, max_retries),
        is_public = COALESCE(?, is_public),
        is_maintenance = COALESCE(?, is_maintenance)
       WHERE id = ?`,
      [name, url, method, interval, timeout, active, max_retries, is_public, is_maintenance, req.params.id]
    );
    await syncMonitors();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/monitors/:id', async (req, res) => {
  try {
    const monitor = await checkMonitorOwnership(req, res, req.params.id);
    if (!monitor) return;

    const db = await getDb();
    await db.run('DELETE FROM monitors WHERE id = ?', [req.params.id]);
    await db.run('DELETE FROM logs WHERE monitor_id = ?', [req.params.id]);
    await db.run('DELETE FROM incidents WHERE monitor_id = ?', [req.params.id]);
    await syncMonitors();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/monitors/:id/check', async (req, res) => {
  try {
    const monitor = await checkMonitorOwnership(req, res, req.params.id);
    if (!monitor) return;

    await runSingleCheck(req.params.id);
    const db = await getDb();
    const updated = await db.get('SELECT * FROM monitors WHERE id = ?', [req.params.id]);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Auth APIs ---

app.post('/api/auth/signup', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  try {
    const db = await getDb();
    const existing = await db.get('SELECT * FROM users WHERE email = ?', [email]);
    if (existing) {
      return res.status(400).json({ error: 'Email is already registered.' });
    }

    // Auto-promote the first user to admin
    const totalUsers = await db.get('SELECT COUNT(*) as count FROM users');
    const role = totalUsers.count === 0 ? 'admin' : 'user';

    const hashedPassword = await bcrypt.hash(password, 10);
    const verificationToken = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);

    await db.run(
      `INSERT INTO users (email, password, role, is_verified, verification_token, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [email, hashedPassword, role, 0, verificationToken, new Date().toISOString()]
    );

    // Get SMTP configuration
    const rows = await db.all('SELECT key, value FROM settings');
    const settings = {};
    rows.forEach(r => { settings[r.key] = r.value; });

    const verificationLink = `${process.env.BASE_URL || 'http://localhost:' + PORT}/api/auth/verify?token=${verificationToken}`;
    console.log(`\n✉️ [Email Verification Link for ${email}]: ${verificationLink}\n`);

    if (settings.email_enabled === 'true' && settings.email_smtp_host) {
      try {
        const transporter = nodemailer.createTransport({
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
          to: email,
          subject: '[RxMonitor] Verify your email address',
          text: `Please verify your email by clicking the following link: ${verificationLink}`,
          html: `<div style="font-family: sans-serif; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px; max-width: 500px;">
                  <h2>Welcome to RxMonitor!</h2>
                  <p>Thank you for signing up. Please click the button below to verify your email address and activate your account:</p>
                  <a href="${verificationLink}" style="display: inline-block; background: #6366f1; color: white; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: bold; margin: 15px 0;">Verify Email Address</a>
                  <p style="font-size: 0.8em; color: #64748b;">Or copy and paste this link in your browser:<br>${verificationLink}</p>
                 </div>`
        });
      } catch (err) {
        console.error('Failed to send verification email:', err);
      }
    }

    res.json({ 
      success: true, 
      message: 'Signup successful! Please check your email or server console for the verification link.',
      verificationLink // Return verification link for easy development testing
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/auth/verify', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send('Verification token is missing.');

  try {
    const db = await getDb();
    const user = await db.get('SELECT * FROM users WHERE verification_token = ?', [token]);
    if (!user) {
      return res.status(400).send('Invalid or expired verification token.');
    }

    await db.run('UPDATE users SET is_verified = 1, verification_token = NULL WHERE id = ?', [user.id]);
    
    // Serve a nice HTML verification page
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Email Verified</title>
        <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600&display=swap" rel="stylesheet">
        <style>
          body { font-family: 'Outfit', sans-serif; background: #0a0b10; color: #e2e8f0; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
          .card { background: rgba(20, 22, 33, 0.65); border: 1px solid rgba(255, 255, 255, 0.08); padding: 40px; border-radius: 16px; text-align: center; max-width: 400px; box-shadow: 0 8px 32px rgba(0,0,0,0.2); }
          h1 { color: #10b981; margin-bottom: 16px; }
          a { display: inline-block; margin-top: 24px; padding: 12px 24px; background: #6366f1; color: white; text-decoration: none; border-radius: 8px; font-weight: 500; }
          a:hover { background: #4f46e5; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>Email Verified!</h1>
          <p>Your email has been successfully verified. You can now log in to your account on the dashboard.</p>
          <a href="/">Go to Dashboard</a>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  try {
    const db = await getDb();
    const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
    if (!user) {
      return res.status(400).json({ error: 'Invalid email or password.' });
    }

    if (!user.password) {
      return res.status(400).json({ error: 'This account is set up for Google Login. Please sign in with Google.' });
    }

    const matches = await bcrypt.compare(password, user.password);
    if (!matches) {
      return res.status(400).json({ error: 'Invalid email or password.' });
    }

    if (user.is_verified === 0) {
      return res.status(400).json({ error: 'Please verify your email address before logging in. Check your server console logs for the link.' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        tier: user.subscription_tier
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/google', async (req, res) => {
  const { credential } = req.body;
  if (!credential) {
    return res.status(400).json({ error: 'Google credential token is missing.' });
  }

  try {
    const payload = decodeJwt(credential);
    if (!payload || !payload.email) {
      return res.status(400).json({ error: 'Invalid Google credential token.' });
    }

    const db = await getDb();
    let user = await db.get('SELECT * FROM users WHERE google_id = ? OR email = ?', [payload.sub, payload.email]);

    if (!user) {
      // Create user
      const totalUsers = await db.get('SELECT COUNT(*) as count FROM users');
      const role = totalUsers.count === 0 ? 'admin' : 'user';

      const result = await db.run(
        `INSERT INTO users (email, role, is_verified, google_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [payload.email, role, 1, payload.sub, new Date().toISOString()]
      );
      user = {
        id: result.lastID,
        email: payload.email,
        role,
        subscription_tier: 'free'
      };
    } else if (!user.google_id) {
      // Link Google ID if registered via email previously
      await db.run('UPDATE users SET google_id = ?, is_verified = 1 WHERE id = ?', [payload.sub, user.id]);
      user.google_id = payload.sub;
      user.is_verified = 1;
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        tier: user.subscription_tier
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Razorpay Payment APIs ---

app.post('/api/payment/create-order', requireAuth, async (req, res) => {
  try {
    const db = await getDb();
    
    const keyIdRow = await db.get("SELECT value FROM settings WHERE key = 'razorpay_key_id'");
    const keySecretRow = await db.get("SELECT value FROM settings WHERE key = 'razorpay_key_secret'");
    
    const keyId = keyIdRow ? keyIdRow.value.trim() : '';
    const keySecret = keySecretRow ? keySecretRow.value.trim() : '';

    const orderId = `order_${Math.random().toString(36).substring(2, 15)}`;
    const amount = 49900; // INR 499 (in paise)

    if (keyId && keySecret) {
      const rzp = new Razorpay({
        key_id: keyId,
        key_secret: keySecret
      });
      const order = await rzp.orders.create({
        amount: amount,
        currency: 'INR',
        receipt: `receipt_${req.user.id}_${Date.now()}`
      });
      
      await db.run(
        'INSERT INTO payments (user_id, order_id, amount, status, created_at) VALUES (?, ?, ?, ?, ?)',
        [req.user.id, order.id, amount, 'created', new Date().toISOString()]
      );

      res.json({
        id: order.id,
        amount: order.amount,
        currency: order.currency,
        key: keyId,
        mock: false
      });
    } else {
      await db.run(
        'INSERT INTO payments (user_id, order_id, amount, status, created_at) VALUES (?, ?, ?, ?, ?)',
        [req.user.id, orderId, amount, 'created', new Date().toISOString()]
      );

      res.json({
        id: orderId,
        amount: amount,
        currency: 'INR',
        key: 'rzp_test_mockkey12345',
        mock: true
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/payment/verify-payment', requireAuth, async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, mock } = req.body;

  try {
    const db = await getDb();

    if (mock) {
      await db.run(
        'UPDATE payments SET payment_id = ?, status = ? WHERE order_id = ? AND user_id = ?',
        [razorpay_payment_id || 'pay_mock_' + Math.random().toString(36).substring(2, 10), 'success', razorpay_order_id, req.user.id]
      );
    } else {
      const keySecretRow = await db.get("SELECT value FROM settings WHERE key = 'razorpay_key_secret'");
      const keySecret = keySecretRow ? keySecretRow.value.trim() : '';

      const generatedSignature = crypto
        .createHmac('sha256', keySecret)
        .update(razorpay_order_id + '|' + razorpay_payment_id)
        .digest('hex');

      if (generatedSignature !== razorpay_signature) {
        return res.status(400).json({ error: 'Signature verification failed' });
      }

      await db.run(
        'UPDATE payments SET payment_id = ?, status = ? WHERE order_id = ? AND user_id = ?',
        [razorpay_payment_id, 'success', razorpay_order_id, req.user.id]
      );
    }

    await db.run("UPDATE users SET subscription_tier = 'premium' WHERE id = ?", [req.user.id]);
    res.json({ success: true });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Administrative APIs ---

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const totalUsers = await db.get('SELECT COUNT(*) as count FROM users');
    const premiumUsers = await db.get("SELECT COUNT(*) as count FROM users WHERE subscription_tier = 'premium'");
    const totalPayments = await db.get("SELECT SUM(amount) as sum FROM payments WHERE status = 'success'");
    const totalMonitors = await db.get('SELECT COUNT(*) as count FROM monitors');

    res.json({
      totalUsers: totalUsers.count,
      premiumUsers: premiumUsers.count,
      totalRevenue: (totalPayments.sum || 0) / 100, // convert paise to INR
      totalMonitors: totalMonitors.count
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const users = await db.all(`
      SELECT u.id, u.email, u.role, u.is_verified, u.subscription_tier, u.created_at,
             (SELECT COUNT(*) FROM monitors m WHERE m.user_id = u.id) as monitor_count
      FROM users u
      ORDER BY u.created_at DESC
    `);
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/users/:id', requireAdmin, async (req, res) => {
  const { role, subscription_tier, is_verified } = req.body;
  try {
    const db = await getDb();
    await db.run(
      `UPDATE users SET
         role = COALESCE(?, role),
         subscription_tier = COALESCE(?, subscription_tier),
         is_verified = COALESCE(?, is_verified)
       WHERE id = ?`,
      [role, subscription_tier, is_verified, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const userMonitors = await db.all('SELECT id FROM monitors WHERE user_id = ?', [req.params.id]);
    for (const monitor of userMonitors) {
      await db.run('DELETE FROM logs WHERE monitor_id = ?', [monitor.id]);
      await db.run('DELETE FROM incidents WHERE monitor_id = ?', [monitor.id]);
    }
    await db.run('DELETE FROM monitors WHERE user_id = ?', [req.params.id]);
    await db.run('DELETE FROM users WHERE id = ?', [req.params.id]);
    await syncMonitors();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Settings APIs ---

app.get('/api/settings', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const rows = await db.all('SELECT key, value FROM settings');
    const settings = {};
    rows.forEach(r => {
      if (r.key === 'email_smtp_pass' && r.value) {
        settings[r.key] = '••••••••';
      } else {
        settings[r.key] = r.value;
      }
    });
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/settings', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const settings = req.body;
    for (const [key, value] of Object.entries(settings)) {
      if (key === 'email_smtp_pass' && value === '••••••••') {
        continue;
      }
      await db.run(
        'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
        [key, String(value)]
      );
    }
    await updateCustomDomainCache();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Settings Testing APIs ---

app.post('/api/settings/test-telegram', requireAdmin, async (req, res) => {
  const { token, chatId } = req.body;
  try {
    await testTelegram(token, chatId);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/settings/test-email', requireAdmin, async (req, res) => {
  const { host, port, user, pass, sender, recipient } = req.body;
  
  let smtpPass = pass;
  if (pass === '••••••••') {
    const db = await getDb();
    const row = await db.get("SELECT value FROM settings WHERE key = 'email_smtp_pass'");
    smtpPass = row ? row.value : '';
  }

  try {
    await testEmail(host, port, user, smtpPass, sender, recipient);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- System Status & System Logs APIs ---

app.get('/api/system-status', async (req, res) => {
  try {
    const db = await getDb();
    let monitorsCount, logsCount, incidentsCount;
    const visitorId = req.headers['x-visitor-id'];

    if (req.user) {
      if (req.user.role === 'admin') {
        monitorsCount = await db.get('SELECT COUNT(*) as count FROM monitors');
        logsCount = await db.get('SELECT COUNT(*) as count FROM logs');
        incidentsCount = await db.get('SELECT COUNT(*) as count FROM incidents');
      } else {
        monitorsCount = await db.get('SELECT COUNT(*) as count FROM monitors WHERE user_id = ?', [req.user.id]);
        logsCount = await db.get(
          'SELECT COUNT(*) as count FROM logs WHERE monitor_id IN (SELECT id FROM monitors WHERE user_id = ?)', 
          [req.user.id]
        );
        incidentsCount = await db.get(
          'SELECT COUNT(*) as count FROM incidents WHERE monitor_id IN (SELECT id FROM monitors WHERE user_id = ?)', 
          [req.user.id]
        );
      }
    } else if (visitorId) {
      monitorsCount = await db.get('SELECT COUNT(*) as count FROM monitors WHERE user_id IS NULL AND visitor_id = ?', [visitorId]);
      logsCount = await db.get(
        'SELECT COUNT(*) as count FROM logs WHERE monitor_id IN (SELECT id FROM monitors WHERE user_id IS NULL AND visitor_id = ?)', 
        [visitorId]
      );
      incidentsCount = await db.get(
        'SELECT COUNT(*) as count FROM incidents WHERE monitor_id IN (SELECT id FROM monitors WHERE user_id IS NULL AND visitor_id = ?)', 
        [visitorId]
      );
    } else {
      monitorsCount = { count: 0 };
      logsCount = { count: 0 };
      incidentsCount = { count: 0 };
    }

    const dbFilePath = path.join(__dirname, 'monitor.db');
    let dbSize = 0;
    if (fs.existsSync(dbFilePath)) {
      const stats = fs.statSync(dbFilePath);
      dbSize = stats.size;
    }

    const statusData = {
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      cpuCount: os.cpus().length,
      freeMemory: Math.round(os.freemem() / (1024 * 1024)),
      totalMemory: Math.round(os.totalmem() / (1024 * 1024)),
      nodeVersion: process.version,
      serverUptime: Math.round(process.uptime()),
      monitorsCount: monitorsCount.count,
      logsCount: logsCount.count,
      incidentsCount: incidentsCount.count,
      dbSize: Math.round(dbSize / 1024) // KB
    };
    res.json(statusData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/system-logs', async (req, res) => {
  try {
    const db = await getDb();
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;
    const visitorId = req.headers['x-visitor-id'];
    
    let logs;
    if (req.user) {
      if (req.user.role === 'admin') {
        logs = await db.all(
          `SELECT l.*, m.name as monitor_name 
           FROM logs l 
           JOIN monitors m ON l.monitor_id = m.id 
           ORDER BY l.checked_at DESC 
           LIMIT ? OFFSET ?`,
          [limit, offset]
        );
      } else {
        logs = await db.all(
          `SELECT l.*, m.name as monitor_name 
           FROM logs l 
           JOIN monitors m ON l.monitor_id = m.id 
           WHERE m.user_id = ?
           ORDER BY l.checked_at DESC 
           LIMIT ? OFFSET ?`,
          [req.user.id, limit, offset]
        );
      }
    } else if (visitorId) {
      logs = await db.all(
        `SELECT l.*, m.name as monitor_name 
         FROM logs l 
         JOIN monitors m ON l.monitor_id = m.id 
         WHERE m.user_id IS NULL AND m.visitor_id = ?
         ORDER BY l.checked_at DESC 
         LIMIT ? OFFSET ?`,
        [visitorId, limit, offset]
      );
    } else {
      logs = [];
    }
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/system-logs/download', async (req, res) => {
  try {
    const db = await getDb();
    const visitorId = req.headers['x-visitor-id'];
    let logs;

    if (req.user) {
      if (req.user.role === 'admin') {
        logs = await db.all(
          `SELECT l.id, m.name as monitor_name, m.url, l.status, l.response_time, l.message, l.checked_at 
           FROM logs l 
           JOIN monitors m ON l.monitor_id = m.id 
           ORDER BY l.checked_at DESC`
        );
      } else {
        logs = await db.all(
          `SELECT l.id, m.name as monitor_name, m.url, l.status, l.response_time, l.message, l.checked_at 
           FROM logs l 
           JOIN monitors m ON l.monitor_id = m.id 
           WHERE m.user_id = ?
           ORDER BY l.checked_at DESC`,
          [req.user.id]
        );
      }
    } else if (visitorId) {
      logs = await db.all(
        `SELECT l.id, m.name as monitor_name, m.url, l.status, l.response_time, l.message, l.checked_at 
         FROM logs l 
         JOIN monitors m ON l.monitor_id = m.id 
         WHERE m.user_id IS NULL AND m.visitor_id = ?
         ORDER BY l.checked_at DESC`,
        [visitorId]
      );
    } else {
      logs = [];
    }

    let csvContent = 'Log ID,Monitor Name,URL,Status,Response Time (ms),Message,Timestamp\n';
    logs.forEach(l => {
      const escapedMsg = (l.message || '').replace(/"/g, '""');
      csvContent += `${l.id},"${l.monitor_name}","${l.url}",${l.status},${l.response_time},"${escapedMsg}",${l.checked_at}\n`;
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=rxmonitor_logs.csv');
    res.status(200).send(csvContent);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/system-logs/email', async (req, res) => {
  try {
    const db = await getDb();
    const rows = await db.all('SELECT key, value FROM settings');
    const settings = {};
    rows.forEach(r => { settings[r.key] = r.value; });

    if (settings.email_enabled !== 'true' || !settings.email_smtp_host || !settings.email_recipient) {
      return res.status(400).json({ error: 'SMTP email notifications are not configured or enabled.' });
    }

    const visitorId = req.headers['x-visitor-id'];
    let logs;

    if (req.user) {
      if (req.user.role === 'admin') {
        logs = await db.all(
          `SELECT l.id, m.name as monitor_name, m.url, l.status, l.response_time, l.message, l.checked_at 
           FROM logs l 
           JOIN monitors m ON l.monitor_id = m.id 
           ORDER BY l.checked_at DESC LIMIT 500`
        );
      } else {
        logs = await db.all(
          `SELECT l.id, m.name as monitor_name, m.url, l.status, l.response_time, l.message, l.checked_at 
           FROM logs l 
           JOIN monitors m ON l.monitor_id = m.id 
           WHERE m.user_id = ?
           ORDER BY l.checked_at DESC LIMIT 500`,
          [req.user.id]
        );
      }
    } else if (visitorId) {
      logs = await db.all(
        `SELECT l.id, m.name as monitor_name, m.url, l.status, l.response_time, l.message, l.checked_at 
         FROM logs l 
         JOIN monitors m ON l.monitor_id = m.id 
         WHERE m.user_id IS NULL AND m.visitor_id = ?
         ORDER BY l.checked_at DESC LIMIT 500`,
        [visitorId]
      );
    } else {
      logs = [];
    }

    let csvContent = 'Log ID,Monitor Name,URL,Status,Response Time (ms),Message,Timestamp\n';
    logs.forEach(l => {
      const escapedMsg = (l.message || '').replace(/"/g, '""');
      csvContent += `${l.id},"${l.monitor_name}","${l.url}",${l.status},${l.response_time},"${escapedMsg}",${l.checked_at}\n`;
    });

    const transporter = nodemailer.createTransport({
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
      to: req.user ? req.user.email : settings.email_recipient,
      subject: '[RxMonitor] System Logs Export',
      text: `Hello,\n\nPlease find attached the latest system uptime logs exported from RxMonitor.\n\nDate: ${new Date().toLocaleString()}`,
      attachments: [
        {
          filename: 'rxmonitor_system_logs.csv',
          content: csvContent
        }
      ]
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- API Key Management ---

app.post('/api/keys', requireAuth, async (req, res) => {
  const { label } = req.body;
  try {
    const db = await getDb();
    // Generate a random API key
    const rawKey = 'rxm_' + crypto.randomBytes(24).toString('hex');
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const keyPrefix = rawKey.substring(0, 12);

    await db.run(
      'INSERT INTO api_keys (user_id, key_hash, key_prefix, label, created_at, is_active) VALUES (?, ?, ?, ?, ?, 1)',
      [req.user.id, keyHash, keyPrefix, label || 'Default', new Date().toISOString()]
    );

    // Return the full key only once — user must save it
    res.json({ key: rawKey, prefix: keyPrefix, label: label || 'Default' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/keys', requireAuth, async (req, res) => {
  try {
    const db = await getDb();
    const keys = await db.all(
      'SELECT id, key_prefix, label, created_at, last_used_at, is_active FROM api_keys WHERE user_id = ? ORDER BY created_at DESC',
      [req.user.id]
    );
    res.json(keys);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/keys/:id', requireAuth, async (req, res) => {
  try {
    const db = await getDb();
    await db.run('DELETE FROM api_keys WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Server Agent Metrics API ---

// Authenticate agent by API key (no JWT needed)
async function authenticateAgentKey(req, res) {
  const authHeader = req.headers['authorization'] || '';
  const key = authHeader.replace('Bearer ', '').trim();
  if (!key || !key.startsWith('rxm_')) {
    res.status(401).json({ error: 'Invalid or missing API key.' });
    return null;
  }

  const keyHash = crypto.createHash('sha256').update(key).digest('hex');
  const db = await getDb();
  const apiKey = await db.get('SELECT * FROM api_keys WHERE key_hash = ? AND is_active = 1', [keyHash]);

  if (!apiKey) {
    res.status(401).json({ error: 'API key is invalid or has been revoked.' });
    return null;
  }

  // Update last_used_at
  await db.run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', [new Date().toISOString(), apiKey.id]);
  return apiKey;
}

app.post('/api/agent/metrics', async (req, res) => {
  try {
    const apiKey = await authenticateAgentKey(req, res);
    if (!apiKey) return;

    const { hostname, cpu, memory, disk, load, network_rx, network_tx, processes, uptime } = req.body;

    const db = await getDb();
    await db.run(
      `INSERT INTO server_metrics 
        (api_key_id, user_id, hostname, cpu_percent, memory_percent, disk_percent, load_avg, network_rx_bytes, network_tx_bytes, process_count, uptime_seconds, collected_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [apiKey.id, apiKey.user_id, hostname || 'unknown', cpu || 0, memory || 0, disk || 0, load || 0, network_rx || 0, network_tx || 0, processes || 0, uptime || 0, new Date().toISOString()]
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get metrics for the authenticated user's servers
app.get('/api/agent/metrics', requireAuth, async (req, res) => {
  try {
    const db = await getDb();
    const hours = parseInt(req.query.hours) || 24;
    const keyId = req.query.key_id;
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

    let metrics;
    if (keyId) {
      metrics = await db.all(
        `SELECT * FROM server_metrics WHERE user_id = ? AND api_key_id = ? AND collected_at >= ? ORDER BY collected_at ASC`,
        [req.user.id, keyId, since]
      );
    } else {
      metrics = await db.all(
        `SELECT * FROM server_metrics WHERE user_id = ? AND collected_at >= ? ORDER BY collected_at ASC`,
        [req.user.id, since]
      );
    }

    res.json(metrics);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get latest metric per server (summary view)
app.get('/api/agent/servers', requireAuth, async (req, res) => {
  try {
    const db = await getDb();
    const servers = await db.all(`
      SELECT sm.*, ak.label, ak.key_prefix, ak.id as key_id
      FROM server_metrics sm
      INNER JOIN api_keys ak ON sm.api_key_id = ak.id
      WHERE sm.user_id = ?
        AND sm.id IN (
          SELECT MAX(id) FROM server_metrics WHERE user_id = ? GROUP BY api_key_id
        )
      ORDER BY sm.collected_at DESC
    `, [req.user.id, req.user.id]);

    res.json(servers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Response Time Analytics ---

app.get('/api/monitors/:id/analytics', async (req, res) => {
  try {
    const monitor = await checkMonitorOwnership(req, res, req.params.id);
    if (!monitor) return;

    const db = await getDb();
    const hours = parseInt(req.query.hours) || 24;
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

    // Get response time data points
    const dataPoints = await db.all(
      `SELECT response_time, status, checked_at FROM logs 
       WHERE monitor_id = ? AND checked_at >= ? 
       ORDER BY checked_at ASC`,
      [req.params.id, since]
    );

    // Calculate percentiles using percentile-calculator module (nearest-rank method)
    const times = dataPoints.filter(d => d.status === 'UP').map(d => d.response_time);
    const percentilesResult = computeAllPercentiles(times);
    const sorted = [...times].sort((a, b) => a - b);
    const avg = sorted.length > 0 ? Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length) : 0;
    const min = sorted.length > 0 ? sorted[0] : 0;
    const max = sorted.length > 0 ? sorted[sorted.length - 1] : 0;
    const p50 = percentilesResult.p50 !== null ? percentilesResult.p50 : (sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.5)] : 0);
    const p95 = percentilesResult.p95 !== null ? percentilesResult.p95 : (sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.95)] : 0);
    const p99 = percentilesResult.p99 !== null ? percentilesResult.p99 : (sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.99)] : 0);

    // Uptime heatmap data (last 30 days, grouped by day)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const dailyStats = await db.all(`
      SELECT 
        DATE(checked_at) as day,
        COUNT(*) as total,
        SUM(CASE WHEN status = 'UP' THEN 1 ELSE 0 END) as up_count
      FROM logs 
      WHERE monitor_id = ? AND checked_at >= ?
      GROUP BY DATE(checked_at)
      ORDER BY day ASC
    `, [req.params.id, thirtyDaysAgo]);

    const heatmap = dailyStats.map(d => ({
      day: d.day,
      uptime: d.total > 0 ? Math.round((d.up_count / d.total) * 1000) / 10 : 100
    }));

    // SSL days remaining
    let sslDaysLeft = null;
    if (monitor.ssl_expiry) {
      sslDaysLeft = Math.ceil((new Date(monitor.ssl_expiry) - new Date()) / (1000 * 60 * 60 * 24));
    }

    // Apdex score (threshold: 500ms satisfied, 2000ms tolerating)
    const satisfiedThreshold = 500;
    const toleratingThreshold = 2000;
    const satisfied = times.filter(t => t <= satisfiedThreshold).length;
    const tolerating = times.filter(t => t > satisfiedThreshold && t <= toleratingThreshold).length;
    const apdex = times.length > 0 ? Math.round(((satisfied + tolerating / 2) / times.length) * 100) / 100 : 1.0;

    // DNS stats for this time window
    const dnsEntries = await db.all(
      `SELECT dns_time_ms, error_type FROM dns_logs 
       WHERE monitor_id = ? AND log_id IN (SELECT id FROM logs WHERE checked_at >= ?)`,
      [req.params.id, since]
    );
    const dnsTimes = dnsEntries.filter(e => !e.error_type).map(e => e.dns_time_ms);
    const dnsStats = computeDnsStats(dnsTimes);

    res.json({
      dataPoints,
      percentiles: { p50, p95, p99, avg, min, max },
      heatmap,
      sslDaysLeft,
      apdex,
      dnsStats,
      totalChecks: dataPoints.length,
      upChecks: times.length,
      downChecks: dataPoints.filter(d => d.status === 'DOWN').length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Agent Install Script (served as plain text) ---

app.get('/install-agent.sh', (req, res) => {
  const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
  const script = `#!/bin/bash
# RxMonitor Server Agent Installer
# This script installs a lightweight monitoring agent that reports
# CPU, memory, disk, load, and network metrics to your RxMonitor dashboard.
#
# Usage: curl -sSL ${baseUrl}/install-agent.sh | bash -s YOUR_API_KEY
#
# The agent runs as a systemd service and pushes metrics every 60 seconds.
# It only makes outbound HTTPS calls — no ports are opened on your server.

set -e

API_KEY="\${1:-}"
ENDPOINT="${baseUrl}/api/agent/metrics"
INSTALL_DIR="/opt/rxmonitor-agent"
SERVICE_NAME="rxmonitor-agent"

if [ -z "$API_KEY" ]; then
  echo "❌ Error: API key is required."
  echo "Usage: curl -sSL ${baseUrl}/install-agent.sh | bash -s YOUR_API_KEY"
  exit 1
fi

echo "📡 Installing RxMonitor Agent..."
echo "   Endpoint: $ENDPOINT"
echo ""

# Create install directory
sudo mkdir -p "$INSTALL_DIR"

# Write the agent script
sudo tee "$INSTALL_DIR/agent.sh" > /dev/null << 'AGENT_SCRIPT'
#!/bin/bash
API_KEY="__API_KEY__"
ENDPOINT="__ENDPOINT__"
HOSTNAME=$(hostname)

while true; do
  # CPU usage (percentage)
  CPU=$(top -bn1 2>/dev/null | grep "Cpu(s)" | awk '{print $2}' || echo "0")
  
  # Memory usage (percentage)
  MEM=$(free 2>/dev/null | awk '/Mem:/ {printf "%.1f", $3/$2 * 100}' || echo "0")
  
  # Disk usage (percentage, root partition)
  DISK=$(df / 2>/dev/null | awk 'NR==2 {print $5}' | tr -d '%' || echo "0")
  
  # Load average (1 min)
  LOAD=$(cat /proc/loadavg 2>/dev/null | awk '{print $1}' || echo "0")
  
  # Network bytes (rx/tx on primary interface)
  IFACE=$(ip route get 1.1.1.1 2>/dev/null | awk '{print $5; exit}' || echo "eth0")
  NET_RX=$(cat /sys/class/net/$IFACE/statistics/rx_bytes 2>/dev/null || echo "0")
  NET_TX=$(cat /sys/class/net/$IFACE/statistics/tx_bytes 2>/dev/null || echo "0")
  
  # Process count
  PROCS=$(ps aux 2>/dev/null | wc -l || echo "0")
  
  # System uptime in seconds
  UPTIME=$(awk '{print int($1)}' /proc/uptime 2>/dev/null || echo "0")

  # Push metrics
  curl -s -X POST "$ENDPOINT" \\
    -H "Authorization: Bearer $API_KEY" \\
    -H "Content-Type: application/json" \\
    -d "{
      \\"hostname\\": \\"$HOSTNAME\\",
      \\"cpu\\": $CPU,
      \\"memory\\": $MEM,
      \\"disk\\": $DISK,
      \\"load\\": $LOAD,
      \\"network_rx\\": $NET_RX,
      \\"network_tx\\": $NET_TX,
      \\"processes\\": $PROCS,
      \\"uptime\\": $UPTIME
    }" > /dev/null 2>&1

  sleep 60
done
AGENT_SCRIPT

# Replace placeholders
sudo sed -i "s|__API_KEY__|$API_KEY|g" "$INSTALL_DIR/agent.sh"
sudo sed -i "s|__ENDPOINT__|$ENDPOINT|g" "$INSTALL_DIR/agent.sh"
sudo chmod +x "$INSTALL_DIR/agent.sh"

# Create systemd service
sudo tee "/etc/systemd/system/$SERVICE_NAME.service" > /dev/null << EOF
[Unit]
Description=RxMonitor Server Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/bin/bash $INSTALL_DIR/agent.sh
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

# Enable and start
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"
sudo systemctl start "$SERVICE_NAME"

echo ""
echo "✅ RxMonitor Agent installed successfully!"
echo "   Service: $SERVICE_NAME"
echo "   Status:  sudo systemctl status $SERVICE_NAME"
echo "   Logs:    sudo journalctl -u $SERVICE_NAME -f"
echo "   Remove:  sudo systemctl stop $SERVICE_NAME && sudo rm -rf $INSTALL_DIR /etc/systemd/system/$SERVICE_NAME.service && sudo systemctl daemon-reload"
echo ""
echo "📊 Metrics will appear in your dashboard within 60 seconds."
`;

  res.setHeader('Content-Type', 'text/plain');
  res.send(script);
});

// --- Metrics Cleanup (auto-delete old metrics older than 30 days) ---

async function cleanupOldMetrics() {
  try {
    const db = await getDb();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    await db.run('DELETE FROM server_metrics WHERE collected_at < ?', [thirtyDaysAgo]);
  } catch (err) {
    console.error('Metrics cleanup error:', err);
  }
}

// --- HTTP Deep Checks: Synthetic Transactions ---

app.post('/api/monitors/:id/synthetic', requireAuth, async (req, res) => {
  try {
    const monitor = await checkMonitorOwnership(req, res, req.params.id);
    if (!monitor) return;

    const { name, steps } = req.body;
    if (!name || !steps) {
      return res.status(400).json({ error: 'Name and steps are required.' });
    }

    const validation = validateTransactionConfig({ steps });
    if (!validation.valid) {
      return res.status(400).json({ error: 'Invalid transaction config', details: validation.errors });
    }

    const db = await getDb();
    const now = new Date().toISOString();
    const result = await db.run(
      'INSERT INTO synthetic_transactions (monitor_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
      [req.params.id, name, now, now]
    );
    const transactionId = result.lastID;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      await db.run(
        `INSERT INTO synthetic_steps (transaction_id, step_order, url, method, headers, body, timeout, extract_rules, validation_rules)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [transactionId, i, step.url, step.method || 'GET', JSON.stringify(step.headers || {}), step.body || null, step.timeout || 10, JSON.stringify(step.extract || []), JSON.stringify(step.validations || [])]
      );
    }

    res.status(201).json({ id: transactionId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/monitors/:id/synthetic', requireAuth, async (req, res) => {
  try {
    const monitor = await checkMonitorOwnership(req, res, req.params.id);
    if (!monitor) return;

    const db = await getDb();
    const transactions = await db.all(
      'SELECT * FROM synthetic_transactions WHERE monitor_id = ? ORDER BY created_at DESC',
      [req.params.id]
    );
    res.json(transactions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/synthetic/:transactionId', requireAuth, async (req, res) => {
  try {
    const db = await getDb();
    const transaction = await db.get('SELECT * FROM synthetic_transactions WHERE id = ?', [req.params.transactionId]);
    if (!transaction) return res.status(404).json({ error: 'Transaction not found' });

    const monitor = await checkMonitorOwnership(req, res, transaction.monitor_id);
    if (!monitor) return;

    const { name, steps } = req.body;
    if (steps) {
      const validation = validateTransactionConfig({ steps });
      if (!validation.valid) {
        return res.status(400).json({ error: 'Invalid transaction config', details: validation.errors });
      }
    }

    const now = new Date().toISOString();
    await db.run('UPDATE synthetic_transactions SET name = COALESCE(?, name), updated_at = ? WHERE id = ?',
      [name, now, req.params.transactionId]);

    if (steps) {
      await db.run('DELETE FROM synthetic_steps WHERE transaction_id = ?', [req.params.transactionId]);
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        await db.run(
          `INSERT INTO synthetic_steps (transaction_id, step_order, url, method, headers, body, timeout, extract_rules, validation_rules)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [req.params.transactionId, i, step.url, step.method || 'GET', JSON.stringify(step.headers || {}), step.body || null, step.timeout || 10, JSON.stringify(step.extract || []), JSON.stringify(step.validations || [])]
        );
      }
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/synthetic/:transactionId', requireAuth, async (req, res) => {
  try {
    const db = await getDb();
    const transaction = await db.get('SELECT * FROM synthetic_transactions WHERE id = ?', [req.params.transactionId]);
    if (!transaction) return res.status(404).json({ error: 'Transaction not found' });

    const monitor = await checkMonitorOwnership(req, res, transaction.monitor_id);
    if (!monitor) return;

    await db.run('DELETE FROM synthetic_step_results WHERE result_id IN (SELECT id FROM synthetic_results WHERE transaction_id = ?)', [req.params.transactionId]);
    await db.run('DELETE FROM synthetic_results WHERE transaction_id = ?', [req.params.transactionId]);
    await db.run('DELETE FROM synthetic_steps WHERE transaction_id = ?', [req.params.transactionId]);
    await db.run('DELETE FROM synthetic_transactions WHERE id = ?', [req.params.transactionId]);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/synthetic/:transactionId/execute', requireAuth, async (req, res) => {
  try {
    const db = await getDb();
    const transaction = await db.get('SELECT * FROM synthetic_transactions WHERE id = ?', [req.params.transactionId]);
    if (!transaction) return res.status(404).json({ error: 'Transaction not found' });

    const monitor = await checkMonitorOwnership(req, res, transaction.monitor_id);
    if (!monitor) return;

    const result = await executeSyntheticTransaction(parseInt(req.params.transactionId));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/synthetic/:transactionId/results', requireAuth, async (req, res) => {
  try {
    const db = await getDb();
    const transaction = await db.get('SELECT * FROM synthetic_transactions WHERE id = ?', [req.params.transactionId]);
    if (!transaction) return res.status(404).json({ error: 'Transaction not found' });

    const monitor = await checkMonitorOwnership(req, res, transaction.monitor_id);
    if (!monitor) return;

    const limit = parseInt(req.query.limit) || 10;
    const results = await getTransactionResults(parseInt(req.params.transactionId), limit);
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- HTTP Deep Checks: Content Validation Rules ---

app.post('/api/monitors/:id/content-rules', requireAuth, async (req, res) => {
  try {
    const monitor = await checkMonitorOwnership(req, res, req.params.id);
    if (!monitor) return;

    const { rules } = req.body;
    if (!rules) return res.status(400).json({ error: 'Rules array is required.' });

    const validation = validateContentRules(rules);
    if (!validation.valid) {
      return res.status(400).json({ error: 'Invalid content rules', details: validation.errors });
    }

    const db = await getDb();
    // Replace existing rules for this monitor
    await db.run('DELETE FROM content_validation_rules WHERE monitor_id = ?', [req.params.id]);
    for (const rule of rules) {
      await db.run(
        'INSERT INTO content_validation_rules (monitor_id, type, value, description) VALUES (?, ?, ?, ?)',
        [req.params.id, rule.type, rule.value, rule.description || null]
      );
    }

    res.json({ success: true, count: rules.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/monitors/:id/content-rules', requireAuth, async (req, res) => {
  try {
    const monitor = await checkMonitorOwnership(req, res, req.params.id);
    if (!monitor) return;

    const db = await getDb();
    const rules = await db.all(
      'SELECT id, type, value, description FROM content_validation_rules WHERE monitor_id = ?',
      [req.params.id]
    );
    res.json(rules);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- HTTP Deep Checks: Header Validation Rules ---

app.post('/api/monitors/:id/header-rules', requireAuth, async (req, res) => {
  try {
    const monitor = await checkMonitorOwnership(req, res, req.params.id);
    if (!monitor) return;

    const { rules } = req.body;
    if (!rules) return res.status(400).json({ error: 'Rules array is required.' });

    const headerRules = rules.map(r => ({ header: r.header_name || r.header, type: r.type, expected: r.expected_value || r.expected || null }));
    const validation = validateHeaderRules(headerRules);
    if (!validation.valid) {
      return res.status(400).json({ error: 'Invalid header rules', details: validation.errors });
    }

    const db = await getDb();
    await db.run('DELETE FROM header_validation_rules WHERE monitor_id = ?', [req.params.id]);
    for (const rule of rules) {
      await db.run(
        'INSERT INTO header_validation_rules (monitor_id, header_name, type, expected_value) VALUES (?, ?, ?, ?)',
        [req.params.id, rule.header_name || rule.header, rule.type, rule.expected_value || rule.expected || null]
      );
    }

    res.json({ success: true, count: rules.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/monitors/:id/header-rules', requireAuth, async (req, res) => {
  try {
    const monitor = await checkMonitorOwnership(req, res, req.params.id);
    if (!monitor) return;

    const db = await getDb();
    const rules = await db.all(
      'SELECT id, header_name, type, expected_value FROM header_validation_rules WHERE monitor_id = ?',
      [req.params.id]
    );
    res.json(rules);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- HTTP Deep Checks: Certificate Alert Thresholds ---

app.get('/api/monitors/:id/cert-thresholds', requireAuth, async (req, res) => {
  try {
    const monitor = await checkMonitorOwnership(req, res, req.params.id);
    if (!monitor) return;

    const db = await getDb();
    const custom = await db.all(
      'SELECT id, days_remaining, severity FROM cert_alert_thresholds WHERE monitor_id = ? ORDER BY days_remaining DESC',
      [req.params.id]
    );

    if (custom.length > 0) {
      res.json({ thresholds: custom, isCustom: true });
    } else {
      res.json({ thresholds: DEFAULT_THRESHOLDS.map(t => ({ days_remaining: t.days, severity: t.severity })), isCustom: false });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/monitors/:id/cert-thresholds', requireAuth, async (req, res) => {
  try {
    const monitor = await checkMonitorOwnership(req, res, req.params.id);
    if (!monitor) return;

    const { thresholds } = req.body;
    if (!thresholds) return res.status(400).json({ error: 'Thresholds array is required.' });

    const normalized = thresholds.map(t => ({ days: t.days_remaining || t.days, severity: t.severity }));
    const validation = validateThresholds(normalized);
    if (!validation.valid) {
      return res.status(400).json({ error: 'Invalid thresholds', details: validation.errors });
    }

    const db = await getDb();
    await db.run('DELETE FROM cert_alert_thresholds WHERE monitor_id = ?', [req.params.id]);
    for (const t of normalized) {
      await db.run(
        'INSERT INTO cert_alert_thresholds (monitor_id, days_remaining, severity) VALUES (?, ?, ?)',
        [req.params.id, t.days, t.severity]
      );
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- HTTP Deep Checks: DNS Stats in Analytics ---

app.get('/api/monitors/:id/dns-stats', requireAuth, async (req, res) => {
  try {
    const monitor = await checkMonitorOwnership(req, res, req.params.id);
    if (!monitor) return;

    const db = await getDb();
    const hours = parseInt(req.query.hours) || 24;
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

    const dnsEntries = await db.all(
      `SELECT dns_time_ms, resolver_ip, error_type FROM dns_logs 
       WHERE monitor_id = ? AND log_id IN (SELECT id FROM logs WHERE checked_at >= ?)
       ORDER BY log_id DESC`,
      [req.params.id, since]
    );

    const times = dnsEntries.filter(e => !e.error_type).map(e => e.dns_time_ms);
    const stats = computeDnsStats(times);
    const errors = dnsEntries.filter(e => e.error_type);

    res.json({
      stats,
      totalLookups: dnsEntries.length,
      successfulLookups: times.length,
      failedLookups: errors.length,
      errors: errors.slice(0, 10),
      recentTimes: times.slice(0, 50)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- HTTP Deep Checks: Redirect Chain Data ---

app.get('/api/monitors/:id/redirects', requireAuth, async (req, res) => {
  try {
    const monitor = await checkMonitorOwnership(req, res, req.params.id);
    if (!monitor) return;

    const db = await getDb();
    const limit = parseInt(req.query.limit) || 10;

    const chains = await db.all(
      `SELECT rc.id, rc.log_id, l.checked_at FROM redirect_chains rc
       JOIN logs l ON rc.log_id = l.id
       WHERE rc.monitor_id = ?
       ORDER BY l.checked_at DESC LIMIT ?`,
      [req.params.id, limit]
    );

    const results = [];
    for (const chain of chains) {
      const hops = await db.all(
        'SELECT hop_order, url, status_code, response_time_ms FROM redirect_hops WHERE chain_id = ? ORDER BY hop_order ASC',
        [chain.id]
      );
      results.push({ id: chain.id, log_id: chain.log_id, checked_at: chain.checked_at, hops });
    }

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Performance & Load Testing API Routes ---

// Dedicated percentile endpoint with time window support
app.get('/api/monitors/:id/percentiles', requireAuth, async (req, res) => {
  try {
    const monitor = await checkMonitorOwnership(req, res, req.params.id);
    if (!monitor) return;

    const window = req.query.window || '24h';
    if (!isValidTimeWindow(window)) {
      return res.status(400).json({ error: `Invalid time window. Valid options: 1h, 6h, 24h, 7d, 30d` });
    }

    const db = await getDb();
    const windowMs = { '1h': 3600000, '6h': 21600000, '24h': 86400000, '7d': 604800000, '30d': 2592000000 };
    const since = new Date(Date.now() - windowMs[window]).toISOString();

    const logs = await db.all(
      `SELECT response_time FROM logs WHERE monitor_id = ? AND status = 'UP' AND checked_at >= ? ORDER BY checked_at ASC`,
      [req.params.id, since]
    );

    const times = logs.map(l => l.response_time);
    const percentiles = computeAllPercentiles(times);

    res.json({
      monitor_id: parseInt(req.params.id),
      window,
      data_points: times.length,
      percentiles: {
        p50: percentiles.p50,
        p95: percentiles.p95,
        p99: percentiles.p99
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Dedicated Apdex endpoint with time window and threshold support
app.get('/api/monitors/:id/apdex', requireAuth, async (req, res) => {
  try {
    const monitor = await checkMonitorOwnership(req, res, req.params.id);
    if (!monitor) return;

    const window = req.query.window || '24h';
    if (!isValidTimeWindow(window)) {
      return res.status(400).json({ error: `Invalid time window. Valid options: 1h, 6h, 24h, 7d, 30d` });
    }

    const thresholdMs = parseInt(req.query.threshold) || 500;
    const db = await getDb();
    const windowMs = { '1h': 3600000, '6h': 21600000, '24h': 86400000, '7d': 604800000, '30d': 2592000000 };
    const since = new Date(Date.now() - windowMs[window]).toISOString();

    const logs = await db.all(
      `SELECT response_time, status FROM logs WHERE monitor_id = ? AND checked_at >= ? ORDER BY checked_at ASC`,
      [req.params.id, since]
    );

    const results = logs.map(l => ({
      responseTime: l.response_time,
      success: l.status === 'UP'
    }));

    const apdexResult = computeApdexFromResults(results, thresholdMs);

    res.json({
      monitor_id: parseInt(req.params.id),
      window,
      ...apdexResult
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Trigger a load test
app.post('/api/monitors/:id/load-test', requireAuth, async (req, res) => {
  try {
    const monitor = await checkMonitorOwnership(req, res, req.params.id);
    if (!monitor) return;

    const concurrency = parseInt(req.body.concurrency) || 50;
    if (concurrency < 10 || concurrency > 1000) {
      return res.status(400).json({ error: 'Concurrency must be between 10 and 1000.' });
    }

    // Check rate limit before running
    const rateCheck = await canRunLoadTest(req.user.id);
    if (!rateCheck.allowed) {
      return res.status(429).json({
        error: 'Rate limit exceeded.',
        retryAfterMs: rateCheck.retryAfterMs,
        retryAfterSeconds: Math.ceil(rateCheck.retryAfterMs / 1000)
      });
    }

    const result = await runLoadTest(parseInt(req.params.id), concurrency, req.user.id);
    res.json(result);
  } catch (err) {
    if (err.message.includes('Rate limit') || err.message.includes('already running')) {
      return res.status(429).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

// Get load test results for a monitor
app.get('/api/monitors/:id/load-test', requireAuth, async (req, res) => {
  try {
    const monitor = await checkMonitorOwnership(req, res, req.params.id);
    if (!monitor) return;

    const db = await getDb();
    const limit = parseInt(req.query.limit) || 10;

    const tests = await db.all(
      `SELECT * FROM load_tests WHERE monitor_id = ? ORDER BY started_at DESC LIMIT ?`,
      [req.params.id, limit]
    );

    res.json(tests);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Trigger a connection limit test
app.post('/api/monitors/:id/connection-test', requireAuth, async (req, res) => {
  try {
    const monitor = await checkMonitorOwnership(req, res, req.params.id);
    if (!monitor) return;

    const maxConcurrency = parseInt(req.body.maxConcurrency) || 500;

    const result = await runConnectionTest(parseInt(req.params.id), maxConcurrency, req.user.id);

    if (result.error) {
      const statusCode = result.error.includes('Rate limit') || result.error.includes('already running') ? 429 : 400;
      return res.status(statusCode).json({ error: result.error });
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get connection test results for a monitor
app.get('/api/monitors/:id/connection-test', requireAuth, async (req, res) => {
  try {
    const monitor = await checkMonitorOwnership(req, res, req.params.id);
    if (!monitor) return;

    const db = await getDb();
    const limit = parseInt(req.query.limit) || 10;

    const tests = await db.all(
      `SELECT * FROM connection_tests WHERE monitor_id = ? ORDER BY started_at DESC LIMIT ?`,
      [req.params.id, limit]
    );

    // Include level details for each test
    const results = [];
    for (const test of tests) {
      const levels = await db.all(
        `SELECT concurrency, avg_response_ms, error_rate_pct, errors, total FROM connection_test_levels WHERE test_id = ? ORDER BY concurrency ASC`,
        [test.id]
      );
      results.push({ ...test, levels });
    }

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create geographic region configuration
app.post('/api/monitors/:id/geo-regions', requireAuth, async (req, res) => {
  try {
    const monitor = await checkMonitorOwnership(req, res, req.params.id);
    if (!monitor) return;

    const { regions } = req.body;
    const validation = validateRegionConfig(regions);
    if (!validation.valid) {
      return res.status(400).json({ error: 'Invalid region configuration.', details: validation.errors });
    }

    const db = await getDb();

    // Clear existing regions for this monitor and insert new ones
    await db.run('DELETE FROM geo_regions WHERE monitor_id = ?', [req.params.id]);

    for (const region of regions) {
      await db.run(
        `INSERT INTO geo_regions (monitor_id, name, endpoint_url) VALUES (?, ?, ?)`,
        [req.params.id, region.name, region.endpoint_url]
      );
    }

    res.status(201).json({ success: true, count: regions.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get geographic region configuration
app.get('/api/monitors/:id/geo-regions', requireAuth, async (req, res) => {
  try {
    const monitor = await checkMonitorOwnership(req, res, req.params.id);
    if (!monitor) return;

    const db = await getDb();
    const regions = await db.all(
      `SELECT * FROM geo_regions WHERE monitor_id = ? ORDER BY id ASC`,
      [req.params.id]
    );

    res.json(regions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update a specific geographic region
app.put('/api/monitors/:id/geo-regions/:regionId', requireAuth, async (req, res) => {
  try {
    const monitor = await checkMonitorOwnership(req, res, req.params.id);
    if (!monitor) return;

    const { name, endpoint_url } = req.body;
    if (!name || !endpoint_url) {
      return res.status(400).json({ error: 'Name and endpoint_url are required.' });
    }

    // Validate the URL
    try {
      const url = new URL(endpoint_url);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return res.status(400).json({ error: 'endpoint_url must use http or https scheme.' });
      }
    } catch {
      return res.status(400).json({ error: 'Invalid endpoint_url.' });
    }

    const db = await getDb();
    const region = await db.get(
      `SELECT * FROM geo_regions WHERE id = ? AND monitor_id = ?`,
      [req.params.regionId, req.params.id]
    );

    if (!region) {
      return res.status(404).json({ error: 'Region not found.' });
    }

    await db.run(
      `UPDATE geo_regions SET name = ?, endpoint_url = ? WHERE id = ?`,
      [name, endpoint_url, req.params.regionId]
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a specific geographic region
app.delete('/api/monitors/:id/geo-regions/:regionId', requireAuth, async (req, res) => {
  try {
    const monitor = await checkMonitorOwnership(req, res, req.params.id);
    if (!monitor) return;

    const db = await getDb();
    const region = await db.get(
      `SELECT * FROM geo_regions WHERE id = ? AND monitor_id = ?`,
      [req.params.regionId, req.params.id]
    );

    if (!region) {
      return res.status(404).json({ error: 'Region not found.' });
    }

    // Check if removing this region would leave fewer than 3
    const count = await db.get(
      `SELECT COUNT(*) as count FROM geo_regions WHERE monitor_id = ?`,
      [req.params.id]
    );

    if (count.count <= 3) {
      return res.status(400).json({ error: 'Cannot delete region. At least 3 regions are required.' });
    }

    await db.run('DELETE FROM geo_regions WHERE id = ?', [req.params.regionId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Run geographic check and get results
app.get('/api/monitors/:id/geo-results', requireAuth, async (req, res) => {
  try {
    const monitor = await checkMonitorOwnership(req, res, req.params.id);
    if (!monitor) return;

    const db = await getDb();
    const regions = await db.all(
      `SELECT name, endpoint_url FROM geo_regions WHERE monitor_id = ? ORDER BY id ASC`,
      [req.params.id]
    );

    if (regions.length < 3) {
      return res.status(400).json({ error: 'At least 3 geographic regions must be configured to run a check.' });
    }

    // Run the geographic check
    const result = await runGeographicCheck(parseInt(req.params.id), regions);

    // Create a log entry as reference for geo_results
    const checkedAt = new Date().toISOString();
    const logResult = await db.run(
      `INSERT INTO logs (monitor_id, status, response_time, checked_at)
       VALUES (?, ?, ?, ?)`,
      [req.params.id, result.overall_status, 0, checkedAt]
    );
    const logId = logResult.lastID;

    // Store results in database
    for (const regionResult of result.regions) {
      await db.run(
        `INSERT INTO geo_results (log_id, monitor_id, region_name, status, response_time_ms)
         VALUES (?, ?, ?, ?, ?)`,
        [logId, req.params.id, regionResult.name, regionResult.status, regionResult.response_time_ms]
      );
    }

    res.json({
      monitor_id: parseInt(req.params.id),
      overall_status: result.overall_status,
      regions: result.regions,
      down_regions: result.down_regions,
      checked_at: checkedAt
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Alerting & Incidents APIs (Requirements 12-17) ---

// --- Escalation Policies CRUD (Requirement 12) ---

app.post('/api/escalation-policies', requireAuth, async (req, res) => {
  try {
    const { monitor_id, name, tiers } = req.body;
    const validation = validateEscalationPolicy({ tiers });
    if (!validation.valid) {
      return res.status(400).json({ error: 'Invalid escalation policy', details: validation.errors });
    }

    const db = await getDb();
    const result = await db.run(
      'INSERT INTO escalation_policies (monitor_id, name, created_by) VALUES (?, ?, ?)',
      [monitor_id, name || 'Unnamed Policy', req.user.id]
    );
    const policyId = result.lastID;

    for (const tier of tiers) {
      await db.run(
        'INSERT INTO escalation_tiers (policy_id, level, channel, contact, delay_minutes) VALUES (?, ?, ?, ?, ?)',
        [policyId, tier.level, tier.channel, tier.contact, tier.delay_minutes]
      );
    }

    res.status(201).json({ id: policyId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/escalation-policies', requireAuth, async (req, res) => {
  try {
    const db = await getDb();
    const monitorId = req.query.monitor_id;
    let policies;
    if (monitorId) {
      policies = await db.all('SELECT * FROM escalation_policies WHERE monitor_id = ?', [monitorId]);
    } else {
      policies = await db.all('SELECT * FROM escalation_policies WHERE created_by = ?', [req.user.id]);
    }

    for (const policy of policies) {
      policy.tiers = await db.all(
        'SELECT * FROM escalation_tiers WHERE policy_id = ? ORDER BY level ASC',
        [policy.id]
      );
    }

    res.json(policies);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/escalation-policies/:id', requireAuth, async (req, res) => {
  try {
    const { name, tiers } = req.body;
    const db = await getDb();
    const policy = await db.get('SELECT * FROM escalation_policies WHERE id = ?', [req.params.id]);
    if (!policy) return res.status(404).json({ error: 'Escalation policy not found' });

    if (tiers) {
      const validation = validateEscalationPolicy({ tiers });
      if (!validation.valid) {
        return res.status(400).json({ error: 'Invalid escalation policy', details: validation.errors });
      }
      await db.run('DELETE FROM escalation_tiers WHERE policy_id = ?', [req.params.id]);
      for (const tier of tiers) {
        await db.run(
          'INSERT INTO escalation_tiers (policy_id, level, channel, contact, delay_minutes) VALUES (?, ?, ?, ?, ?)',
          [req.params.id, tier.level, tier.channel, tier.contact, tier.delay_minutes]
        );
      }
    }

    if (name) {
      await db.run('UPDATE escalation_policies SET name = ? WHERE id = ?', [name, req.params.id]);
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/escalation-policies/:id', requireAuth, async (req, res) => {
  try {
    const db = await getDb();
    const policy = await db.get('SELECT * FROM escalation_policies WHERE id = ?', [req.params.id]);
    if (!policy) return res.status(404).json({ error: 'Escalation policy not found' });

    await db.run('DELETE FROM escalation_tiers WHERE policy_id = ?', [req.params.id]);
    await db.run('DELETE FROM escalation_policies WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Alert Acknowledgment (Requirement 12.4) ---

app.post('/api/alerts/:alertId/acknowledge', requireAuth, async (req, res) => {
  try {
    await acknowledgeAlert(parseInt(req.params.alertId), req.user.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Maintenance Windows CRUD (Requirement 13) ---

app.post('/api/maintenance-windows', requireAuth, async (req, res) => {
  try {
    const { monitor_id, start_time, end_time, timezone, recurrence } = req.body;
    const validation = validateMaintenanceWindow({ monitor_id, start_time, end_time, timezone, recurrence });
    if (!validation.valid) {
      return res.status(400).json({ error: 'Invalid maintenance window', details: validation.errors });
    }

    const db = await getDb();
    const result = await db.run(
      'INSERT INTO maintenance_windows (monitor_id, start_time, end_time, timezone, recurrence, active) VALUES (?, ?, ?, ?, ?, 1)',
      [monitor_id, start_time, end_time, timezone || 'UTC', recurrence || 'once']
    );

    res.status(201).json({ id: result.lastID });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/maintenance-windows', requireAuth, async (req, res) => {
  try {
    const db = await getDb();
    const monitorId = req.query.monitor_id;
    let windows;
    if (monitorId) {
      windows = await db.all('SELECT * FROM maintenance_windows WHERE monitor_id = ?', [monitorId]);
    } else {
      windows = await db.all('SELECT * FROM maintenance_windows');
    }
    res.json(windows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/maintenance-windows/:id', requireAuth, async (req, res) => {
  try {
    const { start_time, end_time, timezone, recurrence, active } = req.body;
    const db = await getDb();
    const window = await db.get('SELECT * FROM maintenance_windows WHERE id = ?', [req.params.id]);
    if (!window) return res.status(404).json({ error: 'Maintenance window not found' });

    if (start_time || end_time) {
      const validationInput = {
        monitor_id: window.monitor_id,
        start_time: start_time || window.start_time,
        end_time: end_time || window.end_time,
        timezone: timezone !== undefined ? timezone : window.timezone,
        recurrence: recurrence !== undefined ? recurrence : window.recurrence
      };
      const validation = validateMaintenanceWindow(validationInput);
      if (!validation.valid) {
        return res.status(400).json({ error: 'Invalid maintenance window', details: validation.errors });
      }
    }

    await db.run(
      `UPDATE maintenance_windows SET
        start_time = COALESCE(?, start_time),
        end_time = COALESCE(?, end_time),
        timezone = COALESCE(?, timezone),
        recurrence = COALESCE(?, recurrence),
        active = COALESCE(?, active)
       WHERE id = ?`,
      [start_time, end_time, timezone, recurrence, active, req.params.id]
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/maintenance-windows/:id', requireAuth, async (req, res) => {
  try {
    const db = await getDb();
    const window = await db.get('SELECT * FROM maintenance_windows WHERE id = ?', [req.params.id]);
    if (!window) return res.status(404).json({ error: 'Maintenance window not found' });

    await db.run('DELETE FROM maintenance_windows WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Incident Timeline & Events (Requirement 14) ---

app.get('/api/incidents/:id/timeline', requireAuth, async (req, res) => {
  try {
    const events = await getIncidentTimeline(parseInt(req.params.id));
    res.json(events);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/incidents/:id/events', requireAuth, async (req, res) => {
  try {
    const db = await getDb();
    const events = await db.all(
      `SELECT * FROM incident_events WHERE incident_id = ? ORDER BY timestamp ASC LIMIT 1000`,
      [req.params.id]
    );
    res.json(events.map(e => ({ ...e, data: e.data ? JSON.parse(e.data) : null })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Status Page Incidents (Requirement 15) ---

app.post('/api/status-incidents', requireAuth, async (req, res) => {
  try {
    const { title, description, status } = req.body;
    const validation = validateIncidentMessage(title, description);
    if (!validation.valid) {
      return res.status(400).json({ error: 'Validation failed', details: validation.errors });
    }

    const incidentId = await createStatusIncident(title, description || '', status || 'investigating');
    res.status(201).json({ id: incidentId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/status-incidents', async (req, res) => {
  try {
    const active = await getActiveIncidents();
    const resolved = await getResolvedIncidents(parseInt(req.query.days_back) || 7);
    res.json({ active, resolved });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/status-incidents/:id', requireAuth, async (req, res) => {
  try {
    const { message, status } = req.body;
    if (!message || !status) {
      return res.status(400).json({ error: 'message and status are required' });
    }
    await updateStatusIncident(parseInt(req.params.id), message, status);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Alert Deduplication Configuration (Requirement 16) ---

app.get('/api/monitors/:id/deduplication', requireAuth, async (req, res) => {
  try {
    const monitor = await checkMonitorOwnership(req, res, req.params.id);
    if (!monitor) return;

    const state = await getSuppressionState(parseInt(req.params.id));
    const count = await getSuppressedCount(parseInt(req.params.id));
    res.json({ monitor_id: parseInt(req.params.id), suppression_state: state, suppressed_count: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/monitors/:id/deduplication', requireAuth, async (req, res) => {
  try {
    const monitor = await checkMonitorOwnership(req, res, req.params.id);
    if (!monitor) return;

    const { suppression_window_min } = req.body;
    const db = await getDb();

    // Update or insert the suppression configuration
    const existing = await db.get('SELECT id FROM alert_suppression WHERE monitor_id = ?', [req.params.id]);
    if (existing) {
      await db.run(
        'UPDATE alert_suppression SET suppression_window_min = ? WHERE monitor_id = ?',
        [suppression_window_min || 30, req.params.id]
      );
    } else {
      await db.run(
        'INSERT INTO alert_suppression (monitor_id, last_alert_at, suppression_window_min, suppressed_count) VALUES (?, ?, ?, 0)',
        [req.params.id, new Date().toISOString(), suppression_window_min || 30]
      );
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- On-Call Teams, Members, and Overrides (Requirement 17) ---

app.post('/api/oncall-teams', requireAuth, async (req, res) => {
  try {
    const { name, rotation_interval_hours, rotation_start_time } = req.body;
    if (!name) return res.status(400).json({ error: 'Team name is required' });

    const db = await getDb();
    const result = await db.run(
      'INSERT INTO oncall_teams (name, rotation_interval_hours, rotation_start_time, created_by) VALUES (?, ?, ?, ?)',
      [name, rotation_interval_hours || 168, rotation_start_time || new Date().toISOString(), req.user.id]
    );

    res.status(201).json({ id: result.lastID });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/oncall-teams', requireAuth, async (req, res) => {
  try {
    const db = await getDb();
    const teams = await db.all('SELECT * FROM oncall_teams WHERE created_by = ?', [req.user.id]);
    for (const team of teams) {
      team.members = await db.all('SELECT * FROM oncall_members WHERE team_id = ? ORDER BY position ASC', [team.id]);
    }
    res.json(teams);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/oncall-teams/:id', requireAuth, async (req, res) => {
  try {
    const { name, rotation_interval_hours, rotation_start_time } = req.body;
    const db = await getDb();
    const team = await db.get('SELECT * FROM oncall_teams WHERE id = ?', [req.params.id]);
    if (!team) return res.status(404).json({ error: 'On-call team not found' });

    await db.run(
      `UPDATE oncall_teams SET
        name = COALESCE(?, name),
        rotation_interval_hours = COALESCE(?, rotation_interval_hours),
        rotation_start_time = COALESCE(?, rotation_start_time)
       WHERE id = ?`,
      [name, rotation_interval_hours, rotation_start_time, req.params.id]
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/oncall-teams/:id', requireAuth, async (req, res) => {
  try {
    const db = await getDb();
    const team = await db.get('SELECT * FROM oncall_teams WHERE id = ?', [req.params.id]);
    if (!team) return res.status(404).json({ error: 'On-call team not found' });

    await db.run('DELETE FROM oncall_overrides WHERE team_id = ?', [req.params.id]);
    await db.run('DELETE FROM oncall_members WHERE team_id = ?', [req.params.id]);
    await db.run('DELETE FROM oncall_teams WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- On-Call Members ---

app.post('/api/oncall-teams/:teamId/members', requireAuth, async (req, res) => {
  try {
    const { name, email, telegram_chat_id, position } = req.body;
    if (!name) return res.status(400).json({ error: 'Member name is required' });
    if (!email && !telegram_chat_id) {
      return res.status(400).json({ error: 'At least one contact method (email or telegram_chat_id) is required' });
    }

    const db = await getDb();
    const team = await db.get('SELECT * FROM oncall_teams WHERE id = ?', [req.params.teamId]);
    if (!team) return res.status(404).json({ error: 'On-call team not found' });

    const memberCount = await db.get('SELECT COUNT(*) as count FROM oncall_members WHERE team_id = ?', [req.params.teamId]);
    const pos = position !== undefined ? position : memberCount.count;

    const result = await db.run(
      'INSERT INTO oncall_members (team_id, name, email, telegram_chat_id, position) VALUES (?, ?, ?, ?, ?)',
      [req.params.teamId, name, email || null, telegram_chat_id || null, pos]
    );

    res.status(201).json({ id: result.lastID });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/oncall-teams/:teamId/members', requireAuth, async (req, res) => {
  try {
    const db = await getDb();
    const members = await db.all(
      'SELECT * FROM oncall_members WHERE team_id = ? ORDER BY position ASC',
      [req.params.teamId]
    );
    res.json(members);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/oncall-members/:id', requireAuth, async (req, res) => {
  try {
    const { name, email, telegram_chat_id, position } = req.body;
    const db = await getDb();
    const member = await db.get('SELECT * FROM oncall_members WHERE id = ?', [req.params.id]);
    if (!member) return res.status(404).json({ error: 'On-call member not found' });

    await db.run(
      `UPDATE oncall_members SET
        name = COALESCE(?, name),
        email = COALESCE(?, email),
        telegram_chat_id = COALESCE(?, telegram_chat_id),
        position = COALESCE(?, position)
       WHERE id = ?`,
      [name, email, telegram_chat_id, position, req.params.id]
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/oncall-members/:id', requireAuth, async (req, res) => {
  try {
    const db = await getDb();
    const member = await db.get('SELECT * FROM oncall_members WHERE id = ?', [req.params.id]);
    if (!member) return res.status(404).json({ error: 'On-call member not found' });

    await db.run('DELETE FROM oncall_members WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- On-Call Overrides ---

app.post('/api/oncall-teams/:teamId/overrides', requireAuth, async (req, res) => {
  try {
    const { member_id, start_time, end_time } = req.body;
    if (!member_id) return res.status(400).json({ error: 'member_id is required' });

    const db = await getDb();
    const team = await db.get('SELECT * FROM oncall_teams WHERE id = ?', [req.params.teamId]);
    if (!team) return res.status(404).json({ error: 'On-call team not found' });

    const member = await db.get('SELECT * FROM oncall_members WHERE id = ? AND team_id = ?', [member_id, req.params.teamId]);
    if (!member) return res.status(404).json({ error: 'Member not found in this team' });

    const result = await db.run(
      'INSERT INTO oncall_overrides (team_id, member_id, start_time, end_time) VALUES (?, ?, ?, ?)',
      [req.params.teamId, member_id, start_time || new Date().toISOString(), end_time || null]
    );

    res.status(201).json({ id: result.lastID });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/oncall-teams/:teamId/overrides', requireAuth, async (req, res) => {
  try {
    const db = await getDb();
    const overrides = await db.all(
      'SELECT * FROM oncall_overrides WHERE team_id = ? ORDER BY start_time DESC',
      [req.params.teamId]
    );
    res.json(overrides);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/oncall-overrides/:id', requireAuth, async (req, res) => {
  try {
    const { end_time } = req.body;
    const db = await getDb();
    const override = await db.get('SELECT * FROM oncall_overrides WHERE id = ?', [req.params.id]);
    if (!override) return res.status(404).json({ error: 'Override not found' });

    await db.run('UPDATE oncall_overrides SET end_time = ? WHERE id = ?', [end_time, req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/oncall-overrides/:id', requireAuth, async (req, res) => {
  try {
    const db = await getDb();
    const override = await db.get('SELECT * FROM oncall_overrides WHERE id = ?', [req.params.id]);
    if (!override) return res.status(404).json({ error: 'Override not found' });

    await db.run('DELETE FROM oncall_overrides WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Logs & Diagnostics APIs ---

// POST: Log ingestion (authenticated via API key)
app.post('/api/logs/ingest', async (req, res) => {
  try {
    const apiKey = await authenticateAgentKey(req, res);
    if (!apiKey) return;

    const { entries } = req.body;
    if (!entries || !Array.isArray(entries)) {
      return res.status(400).json({ error: 'Request body must contain an "entries" array.' });
    }

    const result = await ingestLogs(apiKey.id, entries);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET: Query logs with filters and pagination
app.get('/api/logs', requireAuth, async (req, res) => {
  try {
    const { hostname, severity, startTime, endTime, keyword } = req.query;
    const page = parseInt(req.query.page) || 1;
    const pageSize = parseInt(req.query.pageSize) || 50;

    const filters = {};
    if (hostname) filters.hostname = hostname;
    if (severity) filters.severity = severity;
    if (startTime) filters.startTime = startTime;
    if (endTime) filters.endTime = endTime;
    if (keyword) filters.keyword = keyword;

    const result = await queryLogs(filters, page, pageSize);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET: Error rate history per monitor
app.get('/api/monitors/:id/error-rate', async (req, res) => {
  try {
    const monitor = await checkMonitorOwnership(req, res, req.params.id);
    if (!monitor) return;

    const hours = parseInt(req.query.hours) || 24;
    const history = await getErrorRateHistory(parseInt(req.params.id), hours);
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET: Traceroute results per check log entry
app.get('/api/logs/:logId/traceroute', async (req, res) => {
  try {
    const db = await getDb();
    const logEntry = await db.get('SELECT * FROM logs WHERE id = ?', [req.params.logId]);
    if (!logEntry) {
      return res.status(404).json({ error: 'Log entry not found' });
    }

    // Verify ownership of the monitor associated with this log
    const monitor = await checkMonitorOwnership(req, res, logEntry.monitor_id);
    if (!monitor) return;

    const traceroute = await db.get(
      'SELECT * FROM traceroute_results WHERE log_id = ?',
      [req.params.logId]
    );
    if (!traceroute) {
      return res.status(404).json({ error: 'No traceroute result for this log entry' });
    }

    const hops = await db.all(
      'SELECT seq, ip, hostname, rtt_ms FROM traceroute_hops WHERE traceroute_id = ? ORDER BY seq ASC',
      [traceroute.id]
    );

    res.json({
      id: traceroute.id,
      log_id: traceroute.log_id,
      hostname: traceroute.hostname,
      complete: !!traceroute.complete,
      executed_at: traceroute.executed_at,
      hops
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET: Screenshot retrieval (serve file from filesystem)
app.get('/api/logs/:logId/screenshot', async (req, res) => {
  try {
    const db = await getDb();
    const logEntry = await db.get('SELECT * FROM logs WHERE id = ?', [req.params.logId]);
    if (!logEntry) {
      return res.status(404).json({ error: 'Log entry not found' });
    }

    // Verify ownership of the monitor associated with this log
    const monitor = await checkMonitorOwnership(req, res, logEntry.monitor_id);
    if (!monitor) return;

    const screenshot = await db.get(
      'SELECT * FROM screenshots WHERE log_id = ?',
      [req.params.logId]
    );
    if (!screenshot) {
      return res.status(404).json({ error: 'No screenshot for this log entry' });
    }

    if (screenshot.timeout_occurred) {
      return res.status(404).json({ error: 'Screenshot capture timed out for this check' });
    }

    // Serve the file
    const filePath = screenshot.file_path;
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Screenshot file not found on disk' });
    }

    res.sendFile(path.resolve(filePath));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET: Diff results per monitor
app.get('/api/monitors/:id/diff', async (req, res) => {
  try {
    const monitor = await checkMonitorOwnership(req, res, req.params.id);
    if (!monitor) return;

    const db = await getDb();
    const limit = parseInt(req.query.limit) || 20;

    // Get baseline info
    const baseline = await db.get(
      'SELECT * FROM diff_baselines WHERE monitor_id = ?',
      [req.params.id]
    );

    // Get recent diff results
    const results = await db.all(
      'SELECT * FROM diff_results WHERE monitor_id = ? ORDER BY id DESC LIMIT ?',
      [req.params.id, limit]
    );

    // Get exclusions
    const exclusions = await db.all(
      'SELECT * FROM diff_exclusions WHERE monitor_id = ?',
      [req.params.id]
    );

    res.json({ baseline, results, exclusions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST: Update diff baseline
app.post('/api/monitors/:id/diff/baseline', async (req, res) => {
  try {
    const monitor = await checkMonitorOwnership(req, res, req.params.id);
    if (!monitor) return;

    const { content } = req.body;
    if (!content || typeof content !== 'string') {
      return res.status(400).json({ error: 'Request body must contain a "content" string.' });
    }

    const db = await getDb();
    const hash = computeContentHash(content);
    const now = new Date().toISOString();

    // Upsert baseline
    const existing = await db.get(
      'SELECT id FROM diff_baselines WHERE monitor_id = ?',
      [req.params.id]
    );

    if (existing) {
      await db.run(
        'UPDATE diff_baselines SET content_hash = ?, content_length = ?, captured_at = ? WHERE monitor_id = ?',
        [hash, content.length, now, req.params.id]
      );
    } else {
      await db.run(
        'INSERT INTO diff_baselines (monitor_id, content_hash, content_length, captured_at) VALUES (?, ?, ?, ?)',
        [req.params.id, hash, content.length, now]
      );
    }

    res.json({ success: true, hash, length: content.length, captured_at: now });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Dashboard & Visualization APIs (Requirements 23-27) ---

// WebSocket connected clients count (for admin dashboard)
app.get('/api/ws/clients', requireAuth, async (req, res) => {
  res.json({ connected: getConnectedClientCount() });
});

// --- Custom Dashboard CRUD (Requirement 27) ---

// GET all dashboards for the current user
app.get('/api/dashboards', requireAuth, async (req, res) => {
  try {
    const db = await getDb();
    const dashboards = await db.all(
      'SELECT * FROM dashboards WHERE user_id = ? ORDER BY created_at ASC',
      [req.user.id]
    );
    res.json(dashboards);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST create a new dashboard
app.post('/api/dashboards', requireAuth, async (req, res) => {
  const { name } = req.body;
  if (!name || typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 64) {
    return res.status(400).json({ error: 'Dashboard name must be between 1 and 64 characters.' });
  }

  try {
    const db = await getDb();

    // Check max 10 dashboards per user
    const count = await db.get(
      'SELECT COUNT(*) as count FROM dashboards WHERE user_id = ?',
      [req.user.id]
    );
    if (count.count >= 10) {
      return res.status(400).json({ error: 'Maximum of 10 dashboards per user reached.' });
    }

    // Check unique name per user
    const existing = await db.get(
      'SELECT id FROM dashboards WHERE user_id = ? AND LOWER(name) = LOWER(?)',
      [req.user.id, name.trim()]
    );
    if (existing) {
      return res.status(400).json({ error: 'A dashboard with this name already exists.' });
    }

    const now = new Date().toISOString();
    const result = await db.run(
      'INSERT INTO dashboards (user_id, name, layout, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [req.user.id, name.trim(), '[]', now, now]
    );

    res.status(201).json({
      id: result.lastID,
      user_id: req.user.id,
      name: name.trim(),
      layout: '[]',
      created_at: now,
      updated_at: now
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT update a dashboard (rename)
app.put('/api/dashboards/:id', requireAuth, async (req, res) => {
  const { name } = req.body;
  if (!name || typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 64) {
    return res.status(400).json({ error: 'Dashboard name must be between 1 and 64 characters.' });
  }

  try {
    const db = await getDb();
    const dashboard = await db.get(
      'SELECT * FROM dashboards WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );
    if (!dashboard) {
      return res.status(404).json({ error: 'Dashboard not found.' });
    }

    // Check unique name per user (excluding current dashboard)
    const existing = await db.get(
      'SELECT id FROM dashboards WHERE user_id = ? AND LOWER(name) = LOWER(?) AND id != ?',
      [req.user.id, name.trim(), req.params.id]
    );
    if (existing) {
      return res.status(400).json({ error: 'A dashboard with this name already exists.' });
    }

    const now = new Date().toISOString();
    await db.run(
      'UPDATE dashboards SET name = ?, updated_at = ? WHERE id = ?',
      [name.trim(), now, req.params.id]
    );

    res.json({ success: true, name: name.trim(), updated_at: now });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT update dashboard layout (widget positions)
app.put('/api/dashboards/:id/layout', requireAuth, async (req, res) => {
  const { layout } = req.body;
  if (!layout || !Array.isArray(layout)) {
    return res.status(400).json({ error: 'Layout must be an array of widget positions.' });
  }

  try {
    const db = await getDb();
    const dashboard = await db.get(
      'SELECT * FROM dashboards WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );
    if (!dashboard) {
      return res.status(404).json({ error: 'Dashboard not found.' });
    }

    // Update each widget position
    for (const widget of layout) {
      if (!widget.id) continue;
      await db.run(
        'UPDATE dashboard_widgets SET col_start = ?, col_span = ?, row_start = ?, row_span = ? WHERE id = ? AND dashboard_id = ?',
        [widget.col_start, widget.col_span, widget.row_start, widget.row_span, widget.id, req.params.id]
      );
    }

    const now = new Date().toISOString();
    await db.run('UPDATE dashboards SET updated_at = ? WHERE id = ?', [now, req.params.id]);

    res.json({ success: true, updated_at: now });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE a dashboard
app.delete('/api/dashboards/:id', requireAuth, async (req, res) => {
  try {
    const db = await getDb();
    const dashboard = await db.get(
      'SELECT * FROM dashboards WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );
    if (!dashboard) {
      return res.status(404).json({ error: 'Dashboard not found.' });
    }

    // Delete widgets first, then dashboard
    await db.run('DELETE FROM dashboard_widgets WHERE dashboard_id = ?', [req.params.id]);
    await db.run('DELETE FROM dashboards WHERE id = ?', [req.params.id]);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Dashboard Widgets CRUD ---

// GET widgets for a dashboard
app.get('/api/dashboards/:id/widgets', requireAuth, async (req, res) => {
  try {
    const db = await getDb();
    const dashboard = await db.get(
      'SELECT * FROM dashboards WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );
    if (!dashboard) {
      return res.status(404).json({ error: 'Dashboard not found.' });
    }

    const widgets = await db.all(
      'SELECT * FROM dashboard_widgets WHERE dashboard_id = ? ORDER BY row_start ASC, col_start ASC',
      [req.params.id]
    );

    // Parse JSON config for each widget
    res.json(widgets.map(w => ({
      ...w,
      config: typeof w.config === 'string' ? JSON.parse(w.config) : w.config
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST add a widget to a dashboard
app.post('/api/dashboards/:id/widgets', requireAuth, async (req, res) => {
  const { widget_type, config, col_start, col_span, row_start, row_span } = req.body;

  const validTypes = ['monitor_status', 'response_chart', 'heatmap', 'apdex', 'sla', 'error_rate', 'comparison'];
  if (!widget_type || !validTypes.includes(widget_type)) {
    return res.status(400).json({ error: 'Invalid widget type.' });
  }
  if (col_start < 1 || col_start > 12 || col_span < 1 || col_span > 12 || row_span < 1 || row_span > 4) {
    return res.status(400).json({ error: 'Invalid widget position or size.' });
  }
  if (col_start + col_span - 1 > 12) {
    return res.status(400).json({ error: 'Widget exceeds grid boundary.' });
  }

  try {
    const db = await getDb();
    const dashboard = await db.get(
      'SELECT * FROM dashboards WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );
    if (!dashboard) {
      return res.status(404).json({ error: 'Dashboard not found.' });
    }

    // Check max 20 widgets per dashboard
    const widgetCount = await db.get(
      'SELECT COUNT(*) as count FROM dashboard_widgets WHERE dashboard_id = ?',
      [req.params.id]
    );
    if (widgetCount.count >= 20) {
      return res.status(400).json({ error: 'Maximum of 20 widgets per dashboard reached.' });
    }

    const configStr = JSON.stringify(config || {});
    const result = await db.run(
      'INSERT INTO dashboard_widgets (dashboard_id, widget_type, config, col_start, col_span, row_start, row_span) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [req.params.id, widget_type, configStr, col_start || 1, col_span || 4, row_start || 1, row_span || 1]
    );

    const now = new Date().toISOString();
    await db.run('UPDATE dashboards SET updated_at = ? WHERE id = ?', [now, req.params.id]);

    res.status(201).json({
      id: result.lastID,
      dashboard_id: parseInt(req.params.id),
      widget_type,
      config: config || {},
      col_start: col_start || 1,
      col_span: col_span || 4,
      row_start: row_start || 1,
      row_span: row_span || 1
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE a widget from a dashboard
app.delete('/api/dashboards/:dashboardId/widgets/:widgetId', requireAuth, async (req, res) => {
  try {
    const db = await getDb();
    const dashboard = await db.get(
      'SELECT * FROM dashboards WHERE id = ? AND user_id = ?',
      [req.params.dashboardId, req.user.id]
    );
    if (!dashboard) {
      return res.status(404).json({ error: 'Dashboard not found.' });
    }

    const widget = await db.get(
      'SELECT * FROM dashboard_widgets WHERE id = ? AND dashboard_id = ?',
      [req.params.widgetId, req.params.dashboardId]
    );
    if (!widget) {
      return res.status(404).json({ error: 'Widget not found.' });
    }

    await db.run('DELETE FROM dashboard_widgets WHERE id = ?', [req.params.widgetId]);

    const now = new Date().toISOString();
    await db.run('UPDATE dashboards SET updated_at = ? WHERE id = ?', [now, req.params.dashboardId]);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- SLA Calculator Routes (Requirement 26) ---

// GET SLA calculation for a monitor
app.get('/api/monitors/:id/sla', async (req, res) => {
  try {
    const monitor = await checkMonitorOwnership(req, res, req.params.id);
    if (!monitor) return;

    const db = await getDb();
    const period = req.query.period || 'monthly';
    const validPeriods = ['monthly', 'quarterly', 'yearly'];
    if (!validPeriods.includes(period)) {
      return res.status(400).json({ error: 'Invalid period. Must be monthly, quarterly, or yearly.' });
    }

    const periodSeconds = getPeriodSeconds(period);
    const since = new Date(Date.now() - periodSeconds * 1000).toISOString();

    // Get check data for the period
    const totalChecks = await db.get(
      'SELECT COUNT(*) as count FROM logs WHERE monitor_id = ? AND checked_at >= ?',
      [req.params.id, since]
    );
    const downChecks = await db.get(
      "SELECT COUNT(*) as count FROM logs WHERE monitor_id = ? AND checked_at >= ? AND status = 'DOWN'",
      [req.params.id, since]
    );

    if (totalChecks.count === 0) {
      return res.json({
        monitor_id: parseInt(req.params.id),
        period,
        uptime_percentage: null,
        no_data: true,
        error_budget: null,
        target: null
      });
    }

    // Calculate total monitored time and downtime based on check interval
    const intervalSeconds = monitor.interval || 60;
    const totalMonitoredSeconds = totalChecks.count * intervalSeconds;
    const totalDowntimeSeconds = downChecks.count * intervalSeconds;

    const uptimePercentage = computeSLA(totalMonitoredSeconds, totalDowntimeSeconds);

    // Get SLA target for this monitor
    const slaTarget = await db.get(
      'SELECT * FROM sla_targets WHERE monitor_id = ?',
      [req.params.id]
    );

    let errorBudget = null;
    let breached = false;
    if (slaTarget) {
      errorBudget = computeErrorBudget(slaTarget.target_percentage, periodSeconds, totalDowntimeSeconds);
      breached = errorBudget ? errorBudget.breached : false;
    }

    res.json({
      monitor_id: parseInt(req.params.id),
      period,
      uptime_percentage: uptimePercentage,
      total_checks: totalChecks.count,
      down_checks: downChecks.count,
      total_monitored_seconds: totalMonitoredSeconds,
      total_downtime_seconds: totalDowntimeSeconds,
      target: slaTarget ? slaTarget.target_percentage : null,
      error_budget: errorBudget,
      breached,
      no_data: false
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT configure SLA target for a monitor
app.put('/api/monitors/:id/sla/target', async (req, res) => {
  try {
    const monitor = await checkMonitorOwnership(req, res, req.params.id);
    if (!monitor) return;

    const { target } = req.body;
    if (target === undefined || target === null) {
      return res.status(400).json({ error: 'SLA target is required.' });
    }

    if (!validateSLATarget(target)) {
      return res.status(400).json({ error: 'SLA target must be between 90.0 and 99.999.' });
    }

    const db = await getDb();
    // Upsert SLA target
    const existing = await db.get(
      'SELECT id FROM sla_targets WHERE monitor_id = ?',
      [req.params.id]
    );

    if (existing) {
      await db.run(
        'UPDATE sla_targets SET target_percentage = ? WHERE monitor_id = ?',
        [target, req.params.id]
      );
    } else {
      await db.run(
        'INSERT INTO sla_targets (monitor_id, target_percentage) VALUES (?, ?)',
        [req.params.id, target]
      );
    }

    res.json({ success: true, monitor_id: parseInt(req.params.id), target });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Heatmap Data Route (Requirement 24) ---

// GET 90-day heatmap data for a monitor
app.get('/api/monitors/:id/heatmap', async (req, res) => {
  try {
    const monitor = await checkMonitorOwnership(req, res, req.params.id);
    if (!monitor) return;

    const db = await getDb();
    const days = parseInt(req.query.days) || 90;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const timezone = monitor.timezone || 'UTC';

    // Get all check logs for the period
    const logs = await db.all(
      'SELECT status, checked_at FROM logs WHERE monitor_id = ? AND checked_at >= ? ORDER BY checked_at ASC',
      [req.params.id, since]
    );

    // Group by day
    const dayMap = new Map();
    for (const log of logs) {
      // Extract date portion (YYYY-MM-DD)
      const dayStr = log.checked_at.split('T')[0];
      if (!dayMap.has(dayStr)) {
        dayMap.set(dayStr, { total: 0, failures: 0 });
      }
      const entry = dayMap.get(dayStr);
      entry.total++;
      if (log.status !== 'UP') {
        entry.failures++;
      }
    }

    // Build response array with per-day uptime
    const result = [];
    for (const [day, data] of dayMap) {
      const uptimePct = data.total > 0
        ? Math.round(((data.total - data.failures) / data.total) * 10000) / 100
        : null;
      result.push({
        date: day,
        uptime_pct: uptimePct,
        total_checks: data.total,
        failures: data.failures
      });
    }

    // Sort by date ascending
    result.sort((a, b) => a.date.localeCompare(b.date));

    res.json({
      monitor_id: parseInt(req.params.id),
      days,
      timezone,
      data: result
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create HTTP server and initialize WebSocket
const server = http.createServer(app);
initWebSocket(server);

// Start application
server.listen(PORT, async () => {
  console.log(`🚀 RxMonitor started on http://localhost:${PORT}`);
  console.log(`🔌 WebSocket server active on ws://localhost:${PORT}`);
  try {
    await initMonitoring();
    console.log('👀 Server polling active.');
    await updateCustomDomainCache();
    startDailyScheduler();
    console.log('📅 Daily summary report scheduler active.');
    // Run metrics cleanup every 6 hours
    setInterval(cleanupOldMetrics, 6 * 60 * 60 * 1000);
    cleanupOldMetrics();
    console.log('🧹 Metrics auto-cleanup scheduled (30-day retention).');

    // Purge schedulers for Logs & Diagnostics modules
    // Log ingestion: purge entries older than 30 days every 6 hours
    setInterval(() => purgeStaleLogs(30).catch(err => console.error('[purge] Log purge error:', err.message)), 6 * 60 * 60 * 1000);
    // Screenshot capture: purge screenshots older than 30 days every 6 hours
    setInterval(() => purgeOldScreenshots(30).catch(err => console.error('[purge] Screenshot purge error:', err.message)), 6 * 60 * 60 * 1000);
    // Error rate tracker: purge events older than 24h every hour
    setInterval(() => purgeOldEvents(24).catch(err => console.error('[purge] Error rate purge error:', err.message)), 60 * 60 * 1000);
    console.log('🗑️ Logs & diagnostics purge schedulers active.');
  } catch (err) {
    console.error('Failed to initialize monitoring:', err);
  }
});

process.on('SIGINT', () => {
  stopAllMonitoring();
  process.exit(0);
});
process.on('SIGTERM', () => {
  stopAllMonitoring();
  process.exit(0);
});
