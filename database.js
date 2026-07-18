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

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password TEXT,
      role TEXT DEFAULT 'user',
      is_verified INTEGER DEFAULT 0,
      verification_token TEXT,
      google_id TEXT,
      subscription_tier TEXT DEFAULT 'free',
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      order_id TEXT,
      payment_id TEXT,
      amount INTEGER,
      status TEXT,
      created_at TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
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

    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      key_hash TEXT UNIQUE NOT NULL,
      key_prefix TEXT NOT NULL,
      label TEXT DEFAULT 'Default',
      created_at TEXT,
      last_used_at TEXT,
      is_active INTEGER DEFAULT 1,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS server_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      api_key_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      hostname TEXT,
      cpu_percent REAL,
      memory_percent REAL,
      disk_percent REAL,
      load_avg REAL,
      network_rx_bytes INTEGER DEFAULT 0,
      network_tx_bytes INTEGER DEFAULT 0,
      process_count INTEGER DEFAULT 0,
      uptime_seconds INTEGER DEFAULT 0,
      collected_at TEXT,
      FOREIGN KEY(api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_server_metrics_user ON server_metrics(user_id, collected_at);
    CREATE INDEX IF NOT EXISTS idx_server_metrics_key ON server_metrics(api_key_id, collected_at);
    CREATE INDEX IF NOT EXISTS idx_logs_monitor_checked ON logs(monitor_id, checked_at);

    -- Multi-step synthetic transactions
    CREATE TABLE IF NOT EXISTS synthetic_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT,
      updated_at TEXT,
      FOREIGN KEY(monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS synthetic_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id INTEGER NOT NULL,
      step_order INTEGER NOT NULL,
      url TEXT NOT NULL,
      method TEXT DEFAULT 'GET',
      headers TEXT,
      body TEXT,
      timeout INTEGER DEFAULT 10,
      extract_rules TEXT,
      validation_rules TEXT,
      FOREIGN KEY(transaction_id) REFERENCES synthetic_transactions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS synthetic_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id INTEGER NOT NULL,
      overall_status TEXT NOT NULL,
      failed_step_index INTEGER,
      failure_reason TEXT,
      total_time_ms INTEGER,
      executed_at TEXT,
      FOREIGN KEY(transaction_id) REFERENCES synthetic_transactions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS synthetic_step_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      result_id INTEGER NOT NULL,
      step_index INTEGER NOT NULL,
      status_code INTEGER,
      response_time_ms INTEGER,
      pass INTEGER NOT NULL,
      error TEXT,
      FOREIGN KEY(result_id) REFERENCES synthetic_results(id) ON DELETE CASCADE
    );

    -- Content and header validation rules
    CREATE TABLE IF NOT EXISTS content_validation_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      value TEXT NOT NULL,
      description TEXT,
      FOREIGN KEY(monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS header_validation_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_id INTEGER NOT NULL,
      header_name TEXT NOT NULL,
      type TEXT NOT NULL,
      expected_value TEXT,
      FOREIGN KEY(monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
    );

    -- Certificate alert thresholds
    CREATE TABLE IF NOT EXISTS cert_alert_thresholds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_id INTEGER NOT NULL,
      days_remaining INTEGER NOT NULL,
      severity TEXT NOT NULL,
      FOREIGN KEY(monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS cert_alert_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_id INTEGER NOT NULL,
      severity TEXT NOT NULL,
      alerted_at TEXT NOT NULL,
      FOREIGN KEY(monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
    );

    -- DNS resolution logs
    CREATE TABLE IF NOT EXISTS dns_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      log_id INTEGER NOT NULL,
      monitor_id INTEGER NOT NULL,
      dns_time_ms INTEGER NOT NULL,
      resolver_ip TEXT,
      error_type TEXT,
      FOREIGN KEY(log_id) REFERENCES logs(id) ON DELETE CASCADE,
      FOREIGN KEY(monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
    );

    -- Redirect chain tracking
    CREATE TABLE IF NOT EXISTS redirect_chains (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      log_id INTEGER NOT NULL,
      monitor_id INTEGER NOT NULL,
      FOREIGN KEY(log_id) REFERENCES logs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS redirect_hops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chain_id INTEGER NOT NULL,
      hop_order INTEGER NOT NULL,
      url TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      response_time_ms INTEGER,
      FOREIGN KEY(chain_id) REFERENCES redirect_chains(id) ON DELETE CASCADE
    );

    -- Load test results
    CREATE TABLE IF NOT EXISTS load_tests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      concurrency INTEGER NOT NULL,
      status TEXT DEFAULT 'running',
      total_requests INTEGER,
      successful INTEGER,
      failed INTEGER,
      avg_response_ms REAL,
      p95_response_ms REAL,
      error_rate_pct REAL,
      requests_per_second REAL,
      result_status TEXT,
      started_at TEXT,
      completed_at TEXT,
      FOREIGN KEY(monitor_id) REFERENCES monitors(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- Connection limit test results
    CREATE TABLE IF NOT EXISTS connection_tests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      max_concurrency INTEGER DEFAULT 500,
      detected_limit INTEGER,
      status TEXT DEFAULT 'running',
      started_at TEXT,
      completed_at TEXT,
      FOREIGN KEY(monitor_id) REFERENCES monitors(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS connection_test_levels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      test_id INTEGER NOT NULL,
      concurrency INTEGER NOT NULL,
      avg_response_ms REAL,
      error_rate_pct REAL,
      errors INTEGER,
      total INTEGER,
      FOREIGN KEY(test_id) REFERENCES connection_tests(id) ON DELETE CASCADE
    );

    -- Geographic check configuration and results
    CREATE TABLE IF NOT EXISTS geo_regions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      endpoint_url TEXT NOT NULL,
      FOREIGN KEY(monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS geo_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      log_id INTEGER NOT NULL,
      monitor_id INTEGER NOT NULL,
      region_name TEXT NOT NULL,
      status TEXT NOT NULL,
      response_time_ms INTEGER,
      FOREIGN KEY(log_id) REFERENCES logs(id) ON DELETE CASCADE
    );

    -- Escalation policies
    CREATE TABLE IF NOT EXISTS escalation_policies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT,
      FOREIGN KEY(monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS escalation_tiers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      policy_id INTEGER NOT NULL,
      level INTEGER NOT NULL,
      channel TEXT NOT NULL,
      contact TEXT NOT NULL,
      delay_minutes INTEGER NOT NULL,
      FOREIGN KEY(policy_id) REFERENCES escalation_policies(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS escalation_states (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_id INTEGER NOT NULL,
      policy_id INTEGER NOT NULL,
      current_tier INTEGER DEFAULT 1,
      status TEXT DEFAULT 'active',
      triggered_at TEXT,
      acknowledged_at TEXT,
      acknowledged_by INTEGER,
      FOREIGN KEY(policy_id) REFERENCES escalation_policies(id) ON DELETE CASCADE
    );

    -- Maintenance windows
    CREATE TABLE IF NOT EXISTS maintenance_windows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_id INTEGER NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      timezone TEXT DEFAULT 'UTC',
      recurrence TEXT,
      active INTEGER DEFAULT 1,
      created_at TEXT,
      FOREIGN KEY(monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
    );

    -- Incident timeline events
    CREATE TABLE IF NOT EXISTS incident_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      incident_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      data TEXT,
      response_time_ms INTEGER,
      FOREIGN KEY(incident_id) REFERENCES incidents(id) ON DELETE CASCADE
    );

    -- Status page incidents
    CREATE TABLE IF NOT EXISTS status_incidents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'investigating',
      created_at TEXT,
      resolved_at TEXT,
      created_by INTEGER,
      FOREIGN KEY(created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS status_incident_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      incident_id INTEGER NOT NULL,
      message TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT,
      FOREIGN KEY(incident_id) REFERENCES status_incidents(id) ON DELETE CASCADE
    );

    -- Alert deduplication state
    CREATE TABLE IF NOT EXISTS alert_suppression (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_id INTEGER NOT NULL UNIQUE,
      last_alert_at TEXT NOT NULL,
      suppression_window_min INTEGER DEFAULT 30,
      suppressed_count INTEGER DEFAULT 0,
      FOREIGN KEY(monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
    );

    -- On-call rotation
    CREATE TABLE IF NOT EXISTS oncall_teams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      rotation_interval_hours INTEGER DEFAULT 168,
      rotation_start_time TEXT NOT NULL,
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS oncall_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      email TEXT,
      telegram_chat_id TEXT,
      position INTEGER NOT NULL,
      FOREIGN KEY(team_id) REFERENCES oncall_teams(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS oncall_overrides (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id INTEGER NOT NULL,
      member_id INTEGER NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT,
      FOREIGN KEY(team_id) REFERENCES oncall_teams(id) ON DELETE CASCADE,
      FOREIGN KEY(member_id) REFERENCES oncall_members(id) ON DELETE CASCADE
    );

    -- Centralized log ingestion
    CREATE TABLE IF NOT EXISTS app_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      api_key_id INTEGER NOT NULL,
      hostname TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      severity TEXT NOT NULL,
      message TEXT NOT NULL,
      ingested_at TEXT,
      FOREIGN KEY(api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE
    );

    -- Error rate tracking
    CREATE TABLE IF NOT EXISTS error_rate_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_id INTEGER NOT NULL,
      status_code INTEGER NOT NULL,
      recorded_at TEXT NOT NULL,
      FOREIGN KEY(monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS error_rate_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_id INTEGER NOT NULL,
      spike_active INTEGER DEFAULT 1,
      triggered_at TEXT,
      resolved_at TEXT,
      FOREIGN KEY(monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
    );

    -- Traceroute results
    CREATE TABLE IF NOT EXISTS traceroute_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      log_id INTEGER NOT NULL,
      monitor_id INTEGER NOT NULL,
      hostname TEXT NOT NULL,
      complete INTEGER DEFAULT 0,
      executed_at TEXT,
      FOREIGN KEY(log_id) REFERENCES logs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS traceroute_hops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      traceroute_id INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      ip TEXT,
      hostname TEXT,
      rtt_ms REAL,
      FOREIGN KEY(traceroute_id) REFERENCES traceroute_results(id) ON DELETE CASCADE
    );

    -- Screenshot metadata
    CREATE TABLE IF NOT EXISTS screenshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      log_id INTEGER NOT NULL,
      monitor_id INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      captured_at TEXT,
      timeout_occurred INTEGER DEFAULT 0,
      FOREIGN KEY(log_id) REFERENCES logs(id) ON DELETE CASCADE
    );

    -- Content diff detection
    CREATE TABLE IF NOT EXISTS diff_baselines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_id INTEGER NOT NULL UNIQUE,
      content_hash TEXT NOT NULL,
      content_length INTEGER NOT NULL,
      captured_at TEXT,
      FOREIGN KEY(monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS diff_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      log_id INTEGER NOT NULL,
      monitor_id INTEGER NOT NULL,
      previous_hash TEXT,
      current_hash TEXT,
      diff_percentage REAL,
      changed_lines TEXT,
      alerted INTEGER DEFAULT 0,
      FOREIGN KEY(log_id) REFERENCES logs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS diff_exclusions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      pattern TEXT NOT NULL,
      FOREIGN KEY(monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
    );

    -- Custom dashboards
    CREATE TABLE IF NOT EXISTS dashboards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      layout TEXT NOT NULL,
      created_at TEXT,
      updated_at TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(user_id, name)
    );

    CREATE TABLE IF NOT EXISTS dashboard_widgets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dashboard_id INTEGER NOT NULL,
      widget_type TEXT NOT NULL,
      config TEXT NOT NULL,
      col_start INTEGER NOT NULL,
      col_span INTEGER NOT NULL,
      row_start INTEGER NOT NULL,
      row_span INTEGER NOT NULL,
      FOREIGN KEY(dashboard_id) REFERENCES dashboards(id) ON DELETE CASCADE
    );

    -- SLA targets
    CREATE TABLE IF NOT EXISTS sla_targets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_id INTEGER NOT NULL UNIQUE,
      target_percentage REAL NOT NULL,
      FOREIGN KEY(monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
    );

    -- New indexes for advanced monitoring suite
    CREATE INDEX IF NOT EXISTS idx_synthetic_results_tx ON synthetic_results(transaction_id, executed_at);
    CREATE INDEX IF NOT EXISTS idx_dns_logs_monitor ON dns_logs(monitor_id, log_id);
    CREATE INDEX IF NOT EXISTS idx_app_logs_hostname ON app_logs(hostname, timestamp);
    CREATE INDEX IF NOT EXISTS idx_app_logs_severity ON app_logs(severity, timestamp);
    CREATE INDEX IF NOT EXISTS idx_app_logs_timestamp ON app_logs(timestamp);
    CREATE INDEX IF NOT EXISTS idx_error_rate_monitor ON error_rate_events(monitor_id, recorded_at);
    CREATE INDEX IF NOT EXISTS idx_redirect_hops_chain ON redirect_hops(chain_id, hop_order);
    CREATE INDEX IF NOT EXISTS idx_load_tests_user ON load_tests(user_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_connection_tests_user ON connection_tests(user_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_geo_results_log ON geo_results(log_id);
    CREATE INDEX IF NOT EXISTS idx_escalation_states_alert ON escalation_states(alert_id, status);
    CREATE INDEX IF NOT EXISTS idx_maintenance_windows_monitor ON maintenance_windows(monitor_id, active);
    CREATE INDEX IF NOT EXISTS idx_incident_events_incident ON incident_events(incident_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_status_incidents_status ON status_incidents(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_screenshots_monitor ON screenshots(monitor_id, captured_at);
    CREATE INDEX IF NOT EXISTS idx_diff_results_monitor ON diff_results(monitor_id, log_id);
    CREATE INDEX IF NOT EXISTS idx_dashboards_user ON dashboards(user_id);
  `);

  // Dynamically add columns to monitors if they do not exist (migration support)
  const monitorColumns = [
    { name: 'ssl_expiry', type: 'TEXT' },
    { name: 'is_public', type: 'INTEGER DEFAULT 0' },
    { name: 'is_maintenance', type: 'INTEGER DEFAULT 0' },
    { name: 'max_retries', type: 'INTEGER DEFAULT 3' },
    { name: 'current_fails', type: 'INTEGER DEFAULT 0' },
    { name: 'user_id', type: 'INTEGER REFERENCES users(id) ON DELETE CASCADE' },
    { name: 'visitor_id', type: 'TEXT' },
    { name: 'geo_enabled', type: 'INTEGER DEFAULT 0' },
    { name: 'diff_enabled', type: 'INTEGER DEFAULT 0' },
    { name: 'screenshot_enabled', type: 'INTEGER DEFAULT 0' },
    { name: 'diff_threshold', type: 'REAL DEFAULT 5.0' },
    { name: 'apdex_threshold', type: 'INTEGER DEFAULT 500' },
    { name: 'error_rate_threshold', type: 'INTEGER DEFAULT 5' },
    { name: 'timezone', type: "TEXT DEFAULT 'UTC'" }
  ];

  for (const col of monitorColumns) {
    try {
      await db.exec(`ALTER TABLE monitors ADD COLUMN ${col.name} ${col.type}`);
    } catch (e) {
      // Column already exists, ignore
    }
  }

  // Dynamically add columns to logs if they do not exist (migration support)
  const logColumns = [
    { name: 'dns_time_ms', type: 'INTEGER' },
    { name: 'maintenance_flag', type: 'INTEGER DEFAULT 0' }
  ];

  for (const col of logColumns) {
    try {
      await db.exec(`ALTER TABLE logs ADD COLUMN ${col.name} ${col.type}`);
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
    { key: 'daily_report_time', value: '09:00' },
    { key: 'razorpay_key_id', value: '' },
    { key: 'razorpay_key_secret', value: '' }
  ];

  for (const setting of defaultSettings) {
    await db.run(
      'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)',
      [setting.key, setting.value]
    );
  }
}
