import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, 'monitor.db');

let db = null;

export async function getDb() {
  if (db) return db;

  db = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });

  await initSchema();
  return db;
}

async function initSchema() {
  // Create tables if they do not exist
  await db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS monitors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      method TEXT DEFAULT 'GET',
      interval INTEGER DEFAULT 60,
      timeout INTEGER DEFAULT 10,
      status TEXT DEFAULT 'PENDING',
      last_checked TEXT,
      last_status_change TEXT,
      active INTEGER DEFAULT 1,
      ssl_expiry TEXT,
      is_public INTEGER DEFAULT 0,
      is_maintenance INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 3,
      current_fails INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_id INTEGER,
      status TEXT,
      response_time INTEGER,
      message TEXT,
      checked_at TEXT,
      FOREIGN KEY(monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS incidents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_id INTEGER,
      event_type TEXT,
      timestamp TEXT,
      message TEXT,
      downtime_duration INTEGER DEFAULT 0,
      FOREIGN KEY(monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
    );
  `);

  // Dynamically add columns to monitors if they do not exist (migration support)
  const columns = [
    { name: 'ssl_expiry', type: 'TEXT' },
    { name: 'is_public', type: 'INTEGER DEFAULT 0' },
    { name: 'is_maintenance', type: 'INTEGER DEFAULT 0' },
    { name: 'max_retries', type: 'INTEGER DEFAULT 3' },
    { name: 'current_fails', type: 'INTEGER DEFAULT 0' }
  ];

  for (const col of columns) {
    try {
      await db.exec(`ALTER TABLE monitors ADD COLUMN ${col.name} ${col.type}`);
    } catch (e) {
      // Column already exists, ignore
    }
  }

  // Insert default settings if they are not present
  const defaultSettings = [
    { key: 'telegram_enabled', value: 'false' },
    { key: 'telegram_bot_token', value: '' },
    { key: 'telegram_chat_id', value: '' },
    { key: 'email_enabled', value: 'false' },
    { key: 'email_smtp_host', value: '' },
    { key: 'email_smtp_port', value: '587' },
    { key: 'email_smtp_user', value: '' },
    { key: 'email_smtp_pass', value: '' },
    { key: 'email_sender', value: '' },
    { key: 'email_recipient', value: '' },
    { key: 'custom_domain', value: '' },
    { key: 'daily_report_enabled', value: 'false' },
    { key: 'daily_report_time', value: '09:00' }
  ];

  for (const setting of defaultSettings) {
    await db.run(
      'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)',
      [setting.key, setting.value]
    );
  }
}
