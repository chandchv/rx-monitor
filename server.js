import express from 'express';
import cors from 'cors';
import path from 'path';
import os from 'os';
import fs from 'fs';
import nodemailer from 'nodemailer';
import { fileURLToPath } from 'url';
import { getDb } from './database.js';
import { initMonitoring, syncMonitors, runSingleCheck, stopAllMonitoring } from './monitor.js';
import { testTelegram, testEmail, startDailyScheduler } from './notifier.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

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
    const monitors = await db.all('SELECT * FROM monitors');
    
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
  try {
    const db = await getDb();
    const result = await db.run(
      `INSERT INTO monitors 
        (name, url, method, interval, timeout, max_retries, is_public, status) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [name, url, method || 'GET', interval || 60, timeout || 10, max_retries || 3, is_public || 0, 'PENDING']
    );
    await syncMonitors();
    res.status(201).json({ id: result.lastID });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/monitors/:id', async (req, res) => {
  try {
    const db = await getDb();
    const monitor = await db.get('SELECT * FROM monitors WHERE id = ?', [req.params.id]);
    if (!monitor) return res.status(404).json({ error: 'Monitor not found' });

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
    await runSingleCheck(req.params.id);
    const db = await getDb();
    const monitor = await db.get('SELECT * FROM monitors WHERE id = ?', [req.params.id]);
    res.json(monitor);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Settings APIs ---

app.get('/api/settings', async (req, res) => {
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

app.put('/api/settings', async (req, res) => {
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

app.post('/api/settings/test-telegram', async (req, res) => {
  const { token, chatId } = req.body;
  try {
    await testTelegram(token, chatId);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/settings/test-email', async (req, res) => {
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
    const monitorsCount = await db.get('SELECT COUNT(*) as count FROM monitors');
    const logsCount = await db.get('SELECT COUNT(*) as count FROM logs');
    const incidentsCount = await db.get('SELECT COUNT(*) as count FROM incidents');

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
    
    const logs = await db.all(
      `SELECT l.*, m.name as monitor_name 
       FROM logs l 
       JOIN monitors m ON l.monitor_id = m.id 
       ORDER BY l.checked_at DESC 
       LIMIT ? OFFSET ?`,
      [limit, offset]
    );
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/system-logs/download', async (req, res) => {
  try {
    const db = await getDb();
    const logs = await db.all(
      `SELECT l.id, m.name as monitor_name, m.url, l.status, l.response_time, l.message, l.checked_at 
       FROM logs l 
       JOIN monitors m ON l.monitor_id = m.id 
       ORDER BY l.checked_at DESC`
    );

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

    const logs = await db.all(
      `SELECT l.id, m.name as monitor_name, m.url, l.status, l.response_time, l.message, l.checked_at 
       FROM logs l 
       JOIN monitors m ON l.monitor_id = m.id 
       ORDER BY l.checked_at DESC LIMIT 500`
    );

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
      to: settings.email_recipient,
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
