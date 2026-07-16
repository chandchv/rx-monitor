import express from 'express';
import cors from 'cors';
import path from 'path';
import os from 'os';
import fs from 'fs';
import nodemailer from 'nodemailer';
import { fileURLToPath } from 'url';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import Razorpay from 'razorpay';
import crypto from 'crypto';
import { getDb } from './database.js';
import { initMonitoring, syncMonitors, runSingleCheck, stopAllMonitoring } from './monitor.js';
import { testTelegram, testEmail, startDailyScheduler } from './notifier.js';

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

    res.json({ ...monitor, logs, incidents, uptimePct });
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

    const verificationLink = `http://localhost:${PORT}/api/auth/verify?token=${verificationToken}`;
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

// Start application
app.listen(PORT, async () => {
  console.log(`🚀 RxMonitor started on http://localhost:${PORT}`);
  try {
    await initMonitoring();
    console.log('👀 Server polling active.');
    await updateCustomDomainCache();
    startDailyScheduler();
    console.log('📅 Daily summary report scheduler active.');
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
