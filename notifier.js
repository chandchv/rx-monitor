import nodemailer from 'nodemailer';
import { getDb } from './database.js';

export async function sendNotification(monitorName, url, oldStatus, newStatus, errorMsg = '', downtimeSeconds = 0) {
  const db = await getDb();
  
  // Load settings
  const rows = await db.all('SELECT key, value FROM settings');
  const settings = {};
  rows.forEach(r => {
    settings[r.key] = r.value;
  });

  const timestamp = new Date().toLocaleString();
  const isDown = newStatus === 'DOWN';
  const subject = `[RxMonitor] Server ${monitorName} is ${newStatus}`;
  
  let textMessage = '';
  if (isDown) {
    textMessage = `🚨 ALERT: Monitor "${monitorName}" (${url}) is DOWN!\n\nTime: ${timestamp}\nDetails: ${errorMsg || 'No response / Connection timed out'}`;
  } else {
    const downtimeStr = downtimeSeconds > 0 
      ? `${Math.floor(downtimeSeconds / 60)}m ${downtimeSeconds % 60}s` 
      : 'N/A';
    textMessage = `✅ RECOVERY: Monitor "${monitorName}" (${url}) is UP.\n\nTime: ${timestamp}\nTotal Downtime: ${downtimeStr}`;
  }

  // 1. Telegram Notification
  if (settings.telegram_enabled === 'true' && settings.telegram_bot_token && settings.telegram_chat_id) {
    try {
      const telegramUrl = `https://api.telegram.org/bot${settings.telegram_bot_token}/sendMessage`;
      const htmlText = isDown 
        ? `🚨 <b>ALERT: Monitor "${monitorName}" is DOWN!</b>\n\n` +
          `🔗 <b>URL:</b> ${url}\n` +
          `⏰ <b>Time:</b> ${timestamp}\n\n` +
          `❌ <b>Error:</b> <code>${errorMsg}</code>`
        : `✅ <b>RECOVERY: Monitor "${monitorName}" is UP!</b>\n\n` +
          `🔗 <b>URL:</b> ${url}\n` +
          `⏰ <b>Time:</b> ${timestamp}\n` +
          `⏱️ <b>Downtime:</b> <code>${downtimeSeconds > 0 ? Math.floor(downtimeSeconds / 60) + 'm ' + (downtimeSeconds % 60) + 's' : 'N/A'}</code>`;

      const response = await fetch(telegramUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: settings.telegram_chat_id,
          text: htmlText,
          parse_mode: 'HTML'
        })
      });
      if (!response.ok) {
        console.error('Failed to send Telegram notification:', await response.text());
      }
    } catch (err) {
      if (err.code === 'ENOTFOUND' || err.cause?.code === 'ENOTFOUND') {
        console.warn(`[Telegram] Unable to resolve api.telegram.org (${err.cause?.message || err.message}). Telegram notification skipped.`);
      } else {
        console.error('Telegram notification error:', err.message || err);
      }
    }
  }

  // 2. Email Notification
  if (settings.email_enabled === 'true' && settings.email_smtp_host && settings.email_recipient) {
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

      const emailHtml = isDown 
        ? `<div style="font-family: sans-serif; padding: 25px; border-radius: 12px; border: 1px solid #f5c6cb; background-color: #f8d7da; color: #721c24; max-width: 600px;">
            <h2 style="margin-top: 0; color: #721c24;">🚨 Service DOWN Alert</h2>
            <p><strong>Monitor Name:</strong> ${monitorName}</p>
            <p><strong>Target URL:</strong> <a href="${url}" style="color: #721c24; font-weight: bold;">${url}</a></p>
            <p><strong>Status Changed:</strong> From ${oldStatus} ➡️ <strong>${newStatus}</strong></p>
            <div style="background: rgba(0, 0, 0, 0.05); padding: 15px; border-radius: 6px; font-family: monospace; white-space: pre-wrap; margin: 15px 0;">${errorMsg}</div>
            <p style="font-size: 0.85em; margin-bottom: 0; color: #555;">Logged at: ${timestamp}</p>
          </div>`
        : `<div style="font-family: sans-serif; padding: 25px; border-radius: 12px; border: 1px solid #c3e6cb; background-color: #d4edda; color: #155724; max-width: 600px;">
            <h2 style="margin-top: 0; color: #155724;">✅ Service Recovered</h2>
            <p><strong>Monitor Name:</strong> ${monitorName}</p>
            <p><strong>Target URL:</strong> <a href="${url}" style="color: #155724; font-weight: bold;">${url}</a></p>
            <p><strong>Status Changed:</strong> From DOWN ➡️ <strong>UP</strong></p>
            <p><strong>Total Downtime:</strong> <code>${downtimeSeconds > 0 ? Math.floor(downtimeSeconds / 60) + 'm ' + (downtimeSeconds % 60) + 's' : 'N/A'}</code></p>
            <p style="font-size: 0.85em; margin-bottom: 0; color: #555;">Logged at: ${timestamp}</p>
          </div>`;

      await transporter.sendMail({
        from: settings.email_sender || '"RxMonitor" <noreply@rxmonitor.local>',
        to: settings.email_recipient,
        subject: subject,
        text: textMessage,
        html: emailHtml
      });
    } catch (err) {
      console.error('Email notification error:', err);
    }
  }
}

// Daily Morning Summary Report Compiler
export async function sendDailyReport() {
  const db = await getDb();
  
  // Load settings
  const rows = await db.all('SELECT key, value FROM settings');
  const settings = {};
  rows.forEach(r => { settings[r.key] = r.value; });

  const monitors = await db.all('SELECT * FROM monitors WHERE active = 1');
  if (monitors.length === 0) return;

  let totalUptime = 0;
  let totalResponseTime = 0;
  let responseTimeCount = 0;
  let slowestMonitorName = 'N/A';
  let slowestResponseTime = 0;

  for (const m of monitors) {
    const totalLogs = await db.get('SELECT COUNT(*) as count FROM logs WHERE monitor_id = ?', [m.id]);
    const upLogs = await db.get("SELECT COUNT(*) as count FROM logs WHERE monitor_id = ? AND status = 'UP'", [m.id]);
    const uptimePct = totalLogs.count > 0 ? (upLogs.count / totalLogs.count) * 100 : 100;
    totalUptime += uptimePct;

    const avgLatencyRow = await db.get('SELECT AVG(response_time) as avg_res, MAX(response_time) as max_res FROM logs WHERE monitor_id = ?', [m.id]);
    if (avgLatencyRow && avgLatencyRow.avg_res) {
      totalResponseTime += avgLatencyRow.avg_res;
      responseTimeCount++;
      if (avgLatencyRow.max_res > slowestResponseTime) {
        slowestResponseTime = Math.round(avgLatencyRow.max_res);
        slowestMonitorName = m.name;
      }
    }
  }

  const avgUptime = Math.round((totalUptime / monitors.length) * 100) / 100;
  const avgLatency = responseTimeCount > 0 ? Math.round(totalResponseTime / responseTimeCount) : 0;

  const timestamp24hAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const incidents = await db.get(
    "SELECT COUNT(*) as count FROM incidents WHERE timestamp >= ? AND event_type = 'DOWN'",
    [timestamp24hAgo]
  );

  const reportTitle = `☀️ Good Morning! RxMonitor Daily Report`;
  const reportText = `☀️ <b>Good Morning! RxMonitor Summary</b>\n\n` +
                     `📊 <b>Active Monitors:</b> ${monitors.length}\n` +
                     `📈 <b>Average Uptime:</b> ${avgUptime}%\n` +
                     `⚡ <b>Average Latency:</b> ${avgLatency} ms\n` +
                     `🚨 <b>Downtime Incidents (24h):</b> ${incidents.count}\n` +
                     `🐢 <b>Slowest Monitor:</b> ${slowestMonitorName} (${slowestResponseTime} ms)\n\n` +
                     `All systems are running continuously. Have a productive day!`;

  // 1. Send via Telegram
  if (settings.telegram_enabled === 'true' && settings.telegram_bot_token && settings.telegram_chat_id) {
    try {
      const telegramUrl = `https://api.telegram.org/bot${settings.telegram_bot_token}/sendMessage`;
      await fetch(telegramUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: settings.telegram_chat_id,
          text: reportText,
          parse_mode: 'HTML'
        })
      });
    } catch (err) {
      console.error('Failed to send daily Telegram report:', err);
    }
  }

  // 2. Send via Email
  if (settings.email_enabled === 'true' && settings.email_smtp_host && settings.email_recipient) {
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
        to: settings.email_recipient,
        subject: reportTitle,
        html: `<div style="font-family: sans-serif; padding: 25px; border-radius: 12px; border: 1px solid #bee5eb; background-color: #d1ecf1; color: #0c5460; max-width: 600px;">
                <h2 style="margin-top: 0; color: #0c5460;">☀️ Good Morning Summary</h2>
                <p>Here are your uptime statistics for the last 24 hours:</p>
                <hr style="border: 0; border-top: 1px solid rgba(0,0,0,0.1); margin: 15px 0;">
                <table style="width: 100%; font-size: 14px;">
                  <tr><td><strong>Active Monitors:</strong></td><td>${monitors.length}</td></tr>
                  <tr><td><strong>Average Uptime:</strong></td><td>${avgUptime}%</td></tr>
                  <tr><td><strong>Average Latency:</strong></td><td>${avgLatency} ms</td></tr>
                  <tr><td><strong>Incidents (Last 24h):</strong></td><td>${incidents.count}</td></tr>
                  <tr><td><strong>Slowest Response:</strong></td><td>${slowestMonitorName} (${slowestResponseTime} ms)</td></tr>
                </table>
                <hr style="border: 0; border-top: 1px solid rgba(0,0,0,0.1); margin: 15px 0;">
                <p style="font-size: 0.85em; margin-bottom: 0; color: #555;">Sent at: ${new Date().toLocaleString()}</p>
              </div>`
      });
    } catch (err) {
      console.error('Failed to send daily email report:', err);
    }
  }
}

// SSL Expirations Daily Alert Checker
export async function checkAllSSLExpirations() {
  const db = await getDb();
  
  // Load settings
  const rows = await db.all('SELECT key, value FROM settings');
  const settings = {};
  rows.forEach(r => { settings[r.key] = r.value; });

  const monitors = await db.all("SELECT * FROM monitors WHERE active = 1 AND ssl_expiry IS NOT NULL");
  
  for (const m of monitors) {
    const daysLeft = Math.ceil((new Date(m.ssl_expiry) - new Date()) / (1000 * 60 * 60 * 24));
    
    if (daysLeft === 30 || daysLeft === 15 || daysLeft === 1) {
      const subject = `[SSL Warning] Certificate for ${m.name} expires in ${daysLeft} days`;
      const alertText = `⚠️ <b>SSL Certificate Expiration Warning</b>\n\n` +
                        `Monitor: <b>${m.name}</b>\n` +
                        `Domain: ${m.url}\n` +
                        `Days Remaining: <b>${daysLeft} day(s)</b>\n` +
                        `Expiration Date: ${new Date(m.ssl_expiry).toLocaleDateString()}\n\n` +
                        `Please renew the certificate before expiration to avoid service interruption.`;

      // 1. Telegram Alert
      if (settings.telegram_enabled === 'true' && settings.telegram_bot_token && settings.telegram_chat_id) {
        try {
          const telegramUrl = `https://api.telegram.org/bot${settings.telegram_bot_token}/sendMessage`;
          await fetch(telegramUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: settings.telegram_chat_id,
              text: alertText,
              parse_mode: 'HTML'
            })
          });
        } catch (err) {
          console.error('SSL Telegram notification error:', err);
        }
      }

      // 2. Email Alert
      if (settings.email_enabled === 'true' && settings.email_smtp_host && settings.email_recipient) {
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
            to: settings.email_recipient,
            subject: subject,
            text: `SSL Certificate for ${m.name} (${m.url}) expires in ${daysLeft} days on ${new Date(m.ssl_expiry).toLocaleDateString()}.`,
            html: `<div style="font-family: sans-serif; padding: 25px; border-radius: 12px; border: 1px solid #ffeeba; background-color: #fff3cd; color: #856404; max-width: 600px;">
                    <h2 style="margin-top: 0; color: #856404;">⚠️ SSL Expiration Alert</h2>
                    <p><strong>Monitor Name:</strong> ${m.name}</p>
                    <p><strong>Target URL:</strong> <a href="${m.url}" style="color: #856404; font-weight: bold;">${m.url}</a></p>
                    <p><strong>Expiration Date:</strong> <strong>${new Date(m.ssl_expiry).toLocaleDateString()}</strong></p>
                    <p><strong>Time Left:</strong> <span style="font-size: 1.2em; font-weight: bold; color: #721c24;">${daysLeft} days remaining</span></p>
                    <p style="font-size: 0.85em; margin-bottom: 0; color: #555;">Checked at: ${new Date().toLocaleString()}</p>
                  </div>`
          });
        } catch (err) {
          console.error('SSL Email notification error:', err);
        }
      }
    }
  }
}

// Start Daily Morning Summary scheduler
let lastReportDate = '';
export function startDailyScheduler() {
  setInterval(async () => {
    try {
      const db = await getDb();
      const dailyEnabled = await db.get("SELECT value FROM settings WHERE key = 'daily_report_enabled'");
      if (!dailyEnabled || dailyEnabled.value !== 'true') return;

      const reportTime = await db.get("SELECT value FROM settings WHERE key = 'daily_report_time'");
      const timeStr = reportTime ? reportTime.value : '09:00';

      const now = new Date();
      const currentHHMM = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      const currentDateStr = now.toDateString();

      if (currentHHMM === timeStr && lastReportDate !== currentDateStr) {
        lastReportDate = currentDateStr;
        console.log('Sending scheduled daily morning report and running SSL checks...');
        await sendDailyReport();
        await checkAllSSLExpirations();
      }
    } catch (err) {
      console.error('Daily scheduler execution error:', err);
    }
  }, 60000); // Check every minute
}

export async function testTelegram(token, chatId) {
  const telegramUrl = `https://api.telegram.org/bot${token}/sendMessage`;
  const response = await fetch(telegramUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: `🔔 <b>RxMonitor Test</b>\n\nThis is a test notification from your server uptime monitoring system. Telegram notifications are working correctly!`,
      parse_mode: 'HTML'
    })
  });
  if (!response.ok) {
    const errorDetails = await response.text();
    throw new Error(errorDetails);
  }
  return true;
}

export async function testEmail(host, port, user, pass, sender, recipient) {
  const transporter = nodemailer.createTransport({
    host: host,
    port: parseInt(port) || 587,
    secure: parseInt(port) === 465,
    auth: { user, pass }
  });

  await transporter.sendMail({
    from: sender || '"RxMonitor" <noreply@rxmonitor.local>',
    to: recipient,
    subject: '[RxMonitor] Test Notification',
    text: 'This is a test email notification from your RxMonitor system. Email notifications are working correctly!',
    html: `<div style="font-family: sans-serif; padding: 20px; border-radius: 8px; border: 1px solid #bee5eb; background-color: #d1ecf1; color: #0c5460;">
            <h2 style="margin-top: 0;">🔔 RxMonitor Email Test</h2>
            <p>This is a test notification from your server uptime monitoring system. Email notifications are working correctly!</p>
            <p style="font-size: 0.85em; margin-bottom: 0; color: #555;">Logged at: ${new Date().toLocaleString()}</p>
          </div>`
  });
  return true;
}
