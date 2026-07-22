import 'dotenv/config';
import pg from 'pg';

// Parse PostgreSQL BIGINT (INT8) as standard JavaScript numbers for SQLite compatibility
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => parseInt(value, 10));

const { Pool } = pg;

let pool = null;
let dbInstance = null;

export async function getDb() {
  if (dbInstance) return dbInstance;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is not defined');
  }

  // Force rejectUnauthorized=false for production databases like Aiven to enable SSL validation bypass easily
  const isProduction = connectionString.includes('aivencloud.com') || process.env.NODE_ENV === 'production';

  // Strip query parameters to prevent pg-connection-string from overriding SSL settings
  const cleanConnectionString = isProduction ? connectionString.split('?')[0] : connectionString;

  pool = new Pool({
    connectionString: cleanConnectionString,
    ssl: isProduction ? { rejectUnauthorized: false } : false
  });

  // Verify connection
  await pool.query('SELECT NOW()');

  dbInstance = {
    pool,

    convertSql(sql) {
      if (!sql) return '';
      let converted = sql;

      // 1. Map AUTOINCREMENT keyword out
      converted = converted.replace(/\bAUTOINCREMENT\b/gi, '');
      converted = converted.replace(/\bINTEGER PRIMARY KEY\b/gi, 'SERIAL PRIMARY KEY');

      // 2. Map SQLite specific INSERT OR IGNORE / REPLACE
      converted = converted.replace(/INSERT OR IGNORE INTO settings/gi, 'INSERT INTO settings');
      if (converted.includes('INSERT INTO settings')) {
        if (!converted.includes('ON CONFLICT')) {
          converted = converted.trim().replace(/;?$/, ' ON CONFLICT (key) DO NOTHING');
        }
      }

      // Handle unique dashboard names insertion conflict
      converted = converted.replace(/INSERT OR IGNORE INTO dashboards/gi, 'INSERT INTO dashboards');
      if (converted.includes('INSERT INTO dashboards')) {
        if (!converted.includes('ON CONFLICT')) {
          converted = converted.trim().replace(/;?$/, ' ON CONFLICT (user_id, name) DO NOTHING');
        }
      }

      // Generic INSERT OR IGNORE for tables with primary key 'id'
      if (/INSERT OR IGNORE INTO/i.test(converted)) {
        converted = converted.replace(/INSERT OR IGNORE INTO/gi, 'INSERT INTO');
        if (!converted.includes('ON CONFLICT')) {
          converted = converted.trim().replace(/;?$/, ' ON CONFLICT (id) DO NOTHING');
        }
      }

      // Convert SQLite datetime('now') to Postgres NOW()
      converted = converted.replace(/datetime\('now'\)/gi, 'NOW()');

      // 3. Map placeholer ? to $1, $2, $3, ...
      let index = 1;
      converted = converted.replace(/\?/g, () => `$${index++}`);

      return converted;
    },

    async get(sql, params = []) {
      const queryStr = this.convertSql(sql);
      const res = await this.pool.query(queryStr, params);
      return res.rows[0] || null;
    },

    async all(sql, params = []) {
      const queryStr = this.convertSql(sql);
      const res = await this.pool.query(queryStr, params);
      return res.rows;
    },

    async run(sql, params = []) {
      let queryStr = this.convertSql(sql);
      
      const isInsert = /^\s*INSERT\s+INTO/i.test(queryStr);
      if (isInsert && !/RETURNING/i.test(queryStr)) {
        queryStr = queryStr.trim().replace(/;?$/, ' RETURNING *');
      }

      const res = await this.pool.query(queryStr, params);
      
      let lastID = null;
      if (res.rows && res.rows[0]) {
        lastID = res.rows[0].id || null;
      }

      return {
        lastID,
        changes: res.rowCount
      };
    },

    async prepare(sql) {
      const self = this;
      let queryStr = this.convertSql(sql);
      
      const isInsert = /^\s*INSERT\s+INTO/i.test(queryStr);
      if (isInsert && !/RETURNING/i.test(queryStr)) {
        queryStr = queryStr.trim().replace(/;?$/, ' RETURNING *');
      }

      return {
        async run(...params) {
          const actualParams = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
          const res = await self.pool.query(queryStr, actualParams);
          let lastID = null;
          if (res.rows && res.rows[0]) {
            lastID = res.rows[0].id || null;
          }
          return {
            lastID,
            changes: res.rowCount
          };
        },
        async finalize() {
          // No-op
        }
      };
    },

    async exec(sql) {
      const queries = sql
        .split(';')
        .map((q) => q.trim())
        .filter((q) => q.length > 0);

      for (const query of queries) {
        const queryStr = this.convertSql(query);
        await this.pool.query(queryStr);
      }
    }
  };

  try {
    await initSchema();

    // Seed default records to support test suites and foreign keys
    await dbInstance.run(`
      INSERT INTO users (id, email, role, is_verified, created_at)
      VALUES (1, 'admin@rxmonitor.local', 'admin', 1, NOW())
      ON CONFLICT (id) DO NOTHING
    `);

    await dbInstance.run(`
      INSERT INTO users (id, email, role, is_verified, created_at)
      VALUES (999, 'test-user@rxmonitor.local', 'user', 1, NOW())
      ON CONFLICT (id) DO NOTHING
    `);

    await dbInstance.run(`
      INSERT INTO users (id, email, role, is_verified, created_at)
      VALUES (99999, 'load-user@rxmonitor.local', 'user', 1, NOW())
      ON CONFLICT (id) DO NOTHING
    `);

    await dbInstance.run(`
      INSERT INTO monitors (id, name, url, interval, timeout)
      VALUES (1, 'Default Seed Monitor', 'https://example.com', 60, 10)
      ON CONFLICT (id) DO NOTHING
    `);

    // Reset SERIAL sequences to prevent duplicate key violations on auto-increment inserts
    await dbInstance.pool.query("SELECT setval(pg_get_serial_sequence('users', 'id'), COALESCE(MAX(id), 1)) FROM users");
    await dbInstance.pool.query("SELECT setval(pg_get_serial_sequence('monitors', 'id'), COALESCE(MAX(id), 1)) FROM monitors");
  } catch (err) {
    dbInstance = null;
    throw err;
  }

  return dbInstance;
}

async function initSchema() {
  // Create tables using PostgreSQL compatible definitions
  await dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
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
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      order_id TEXT,
      payment_id TEXT,
      amount INTEGER,
      status TEXT,
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS monitors (
      id SERIAL PRIMARY KEY,
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
      current_fails INTEGER DEFAULT 0,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      visitor_id TEXT,
      geo_enabled INTEGER DEFAULT 0,
      diff_enabled INTEGER DEFAULT 0,
      screenshot_enabled INTEGER DEFAULT 0,
      diff_threshold REAL DEFAULT 5.0,
      apdex_threshold INTEGER DEFAULT 500,
      error_rate_threshold INTEGER DEFAULT 5,
      timezone TEXT DEFAULT 'UTC'
    );

    CREATE TABLE IF NOT EXISTS logs (
      id SERIAL PRIMARY KEY,
      monitor_id INTEGER REFERENCES monitors(id) ON DELETE CASCADE,
      status TEXT,
      response_time INTEGER,
      message TEXT,
      checked_at TEXT,
      dns_time_ms INTEGER,
      maintenance_flag INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS incidents (
      id SERIAL PRIMARY KEY,
      monitor_id INTEGER REFERENCES monitors(id) ON DELETE CASCADE,
      event_type TEXT,
      timestamp TEXT,
      message TEXT,
      downtime_duration INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      key_hash TEXT UNIQUE NOT NULL,
      key_prefix TEXT NOT NULL,
      label TEXT DEFAULT 'Default',
      created_at TEXT,
      last_used_at TEXT,
      is_active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS server_metrics (
      id SERIAL PRIMARY KEY,
      api_key_id INTEGER REFERENCES api_keys(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      hostname TEXT,
      cpu_percent REAL,
      memory_percent REAL,
      disk_percent REAL,
      load_avg REAL,
      network_rx_bytes BIGINT DEFAULT 0,
      network_tx_bytes BIGINT DEFAULT 0,
      process_count INTEGER DEFAULT 0,
      uptime_seconds INTEGER DEFAULT 0,
      collected_at TEXT
    );

    CREATE TABLE IF NOT EXISTS synthetic_transactions (
      id SERIAL PRIMARY KEY,
      monitor_id INTEGER REFERENCES monitors(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      created_at TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS synthetic_steps (
      id SERIAL PRIMARY KEY,
      transaction_id INTEGER REFERENCES synthetic_transactions(id) ON DELETE CASCADE,
      step_order INTEGER NOT NULL,
      url TEXT NOT NULL,
      method TEXT DEFAULT 'GET',
      headers TEXT,
      body TEXT,
      timeout INTEGER DEFAULT 10,
      extract_rules TEXT,
      validation_rules TEXT
    );

    CREATE TABLE IF NOT EXISTS synthetic_results (
      id SERIAL PRIMARY KEY,
      transaction_id INTEGER REFERENCES synthetic_transactions(id) ON DELETE CASCADE,
      overall_status TEXT NOT NULL,
      failed_step_index INTEGER,
      failure_reason TEXT,
      total_time_ms INTEGER,
      executed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS synthetic_step_results (
      id SERIAL PRIMARY KEY,
      result_id INTEGER REFERENCES synthetic_results(id) ON DELETE CASCADE,
      step_index INTEGER NOT NULL,
      status_code INTEGER,
      response_time_ms INTEGER,
      pass INTEGER NOT NULL,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS content_validation_rules (
      id SERIAL PRIMARY KEY,
      monitor_id INTEGER REFERENCES monitors(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      value TEXT NOT NULL,
      description TEXT
    );

    CREATE TABLE IF NOT EXISTS header_validation_rules (
      id SERIAL PRIMARY KEY,
      monitor_id INTEGER REFERENCES monitors(id) ON DELETE CASCADE,
      header_name TEXT NOT NULL,
      type TEXT NOT NULL,
      expected_value TEXT
    );

    CREATE TABLE IF NOT EXISTS cert_alert_thresholds (
      id SERIAL PRIMARY KEY,
      monitor_id INTEGER REFERENCES monitors(id) ON DELETE CASCADE,
      days_remaining INTEGER NOT NULL,
      severity TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cert_alert_log (
      id SERIAL PRIMARY KEY,
      monitor_id INTEGER REFERENCES monitors(id) ON DELETE CASCADE,
      severity TEXT NOT NULL,
      alerted_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dns_logs (
      id SERIAL PRIMARY KEY,
      log_id INTEGER REFERENCES logs(id) ON DELETE CASCADE,
      monitor_id INTEGER REFERENCES monitors(id) ON DELETE CASCADE,
      dns_time_ms INTEGER NOT NULL,
      resolver_ip TEXT,
      error_type TEXT
    );

    CREATE TABLE IF NOT EXISTS redirect_chains (
      id SERIAL PRIMARY KEY,
      log_id INTEGER REFERENCES logs(id) ON DELETE CASCADE,
      monitor_id INTEGER REFERENCES monitors(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS redirect_hops (
      id SERIAL PRIMARY KEY,
      chain_id INTEGER REFERENCES redirect_chains(id) ON DELETE CASCADE,
      hop_order INTEGER NOT NULL,
      url TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      response_time_ms INTEGER
    );

    CREATE TABLE IF NOT EXISTS load_tests (
      id SERIAL PRIMARY KEY,
      monitor_id INTEGER REFERENCES monitors(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
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
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS connection_tests (
      id SERIAL PRIMARY KEY,
      monitor_id INTEGER REFERENCES monitors(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      max_concurrency INTEGER DEFAULT 500,
      detected_limit INTEGER,
      status TEXT DEFAULT 'running',
      started_at TEXT,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS connection_test_levels (
      id SERIAL PRIMARY KEY,
      test_id INTEGER REFERENCES connection_tests(id) ON DELETE CASCADE,
      concurrency INTEGER NOT NULL,
      avg_response_ms REAL,
      error_rate_pct REAL,
      errors INTEGER,
      total INTEGER
    );

    CREATE TABLE IF NOT EXISTS geo_regions (
      id SERIAL PRIMARY KEY,
      monitor_id INTEGER REFERENCES monitors(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      endpoint_url TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS geo_results (
      id SERIAL PRIMARY KEY,
      log_id INTEGER REFERENCES logs(id) ON DELETE CASCADE,
      monitor_id INTEGER REFERENCES monitors(id) ON DELETE CASCADE,
      region_name TEXT NOT NULL,
      status TEXT NOT NULL,
      response_time_ms INTEGER
    );

    CREATE TABLE IF NOT EXISTS escalation_policies (
      id SERIAL PRIMARY KEY,
      monitor_id INTEGER REFERENCES monitors(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS escalation_tiers (
      id SERIAL PRIMARY KEY,
      policy_id INTEGER REFERENCES escalation_policies(id) ON DELETE CASCADE,
      level INTEGER NOT NULL,
      channel TEXT NOT NULL,
      contact TEXT NOT NULL,
      delay_minutes INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS escalation_states (
      id SERIAL PRIMARY KEY,
      alert_id INTEGER NOT NULL,
      policy_id INTEGER REFERENCES escalation_policies(id) ON DELETE CASCADE,
      current_tier INTEGER DEFAULT 1,
      status TEXT DEFAULT 'active',
      triggered_at TEXT,
      acknowledged_at TEXT,
      acknowledged_by INTEGER
    );

    CREATE TABLE IF NOT EXISTS maintenance_windows (
      id SERIAL PRIMARY KEY,
      monitor_id INTEGER REFERENCES monitors(id) ON DELETE CASCADE,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      timezone TEXT DEFAULT 'UTC',
      recurrence TEXT,
      active INTEGER DEFAULT 1,
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS incident_events (
      id SERIAL PRIMARY KEY,
      incident_id INTEGER REFERENCES incidents(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      data TEXT,
      response_time_ms INTEGER
    );

    CREATE TABLE IF NOT EXISTS status_incidents (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'investigating',
      created_at TEXT,
      resolved_at TEXT,
      created_by INTEGER REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS status_incident_updates (
      id SERIAL PRIMARY KEY,
      incident_id INTEGER REFERENCES status_incidents(id) ON DELETE CASCADE,
      message TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS alert_suppression (
      id SERIAL PRIMARY KEY,
      monitor_id INTEGER UNIQUE REFERENCES monitors(id) ON DELETE CASCADE,
      last_alert_at TEXT NOT NULL,
      suppression_window_min INTEGER DEFAULT 30,
      suppressed_count INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS oncall_teams (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      rotation_interval_hours INTEGER DEFAULT 168,
      rotation_start_time TEXT NOT NULL,
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS oncall_members (
      id SERIAL PRIMARY KEY,
      team_id INTEGER REFERENCES oncall_teams(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      email TEXT,
      telegram_chat_id TEXT,
      position INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oncall_overrides (
      id SERIAL PRIMARY KEY,
      team_id INTEGER REFERENCES oncall_teams(id) ON DELETE CASCADE,
      member_id INTEGER REFERENCES oncall_members(id) ON DELETE CASCADE,
      start_time TEXT NOT NULL,
      end_time TEXT
    );

    CREATE TABLE IF NOT EXISTS app_logs (
      id SERIAL PRIMARY KEY,
      api_key_id INTEGER REFERENCES api_keys(id) ON DELETE CASCADE,
      hostname TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      severity TEXT NOT NULL,
      message TEXT NOT NULL,
      ingested_at TEXT
    );

    CREATE TABLE IF NOT EXISTS error_rate_events (
      id SERIAL PRIMARY KEY,
      monitor_id INTEGER REFERENCES monitors(id) ON DELETE CASCADE,
      status_code INTEGER NOT NULL,
      recorded_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS error_rate_alerts (
      id SERIAL PRIMARY KEY,
      monitor_id INTEGER REFERENCES monitors(id) ON DELETE CASCADE,
      spike_active INTEGER DEFAULT 1,
      triggered_at TEXT,
      resolved_at TEXT
    );

    CREATE TABLE IF NOT EXISTS traceroute_results (
      id SERIAL PRIMARY KEY,
      log_id INTEGER REFERENCES logs(id) ON DELETE CASCADE,
      monitor_id INTEGER REFERENCES monitors(id) ON DELETE CASCADE,
      hostname TEXT NOT NULL,
      complete INTEGER DEFAULT 0,
      executed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS traceroute_hops (
      id SERIAL PRIMARY KEY,
      traceroute_id INTEGER REFERENCES traceroute_results(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      ip TEXT,
      hostname TEXT,
      rtt_ms REAL
    );

    CREATE TABLE IF NOT EXISTS screenshots (
      id SERIAL PRIMARY KEY,
      log_id INTEGER REFERENCES logs(id) ON DELETE CASCADE,
      monitor_id INTEGER REFERENCES monitors(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      captured_at TEXT,
      timeout_occurred INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS diff_baselines (
      id SERIAL PRIMARY KEY,
      monitor_id INTEGER UNIQUE REFERENCES monitors(id) ON DELETE CASCADE,
      content_hash TEXT NOT NULL,
      content_length INTEGER NOT NULL,
      baseline_content TEXT,
      captured_at TEXT
    );

    CREATE TABLE IF NOT EXISTS diff_results (
      id SERIAL PRIMARY KEY,
      log_id INTEGER REFERENCES logs(id) ON DELETE CASCADE,
      monitor_id INTEGER REFERENCES monitors(id) ON DELETE CASCADE,
      previous_hash TEXT,
      current_hash TEXT,
      diff_percentage REAL,
      changed_lines TEXT,
      alerted INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS diff_exclusions (
      id SERIAL PRIMARY KEY,
      monitor_id INTEGER REFERENCES monitors(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      pattern TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dashboards (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      layout TEXT NOT NULL,
      created_at TEXT,
      updated_at TEXT,
      UNIQUE(user_id, name)
    );

    CREATE TABLE IF NOT EXISTS dashboard_widgets (
      id SERIAL PRIMARY KEY,
      dashboard_id INTEGER REFERENCES dashboards(id) ON DELETE CASCADE,
      widget_type TEXT NOT NULL,
      config TEXT NOT NULL,
      col_start INTEGER NOT NULL,
      col_span INTEGER NOT NULL,
      row_start INTEGER NOT NULL,
      row_span INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sla_targets (
      id SERIAL PRIMARY KEY,
      monitor_id INTEGER UNIQUE REFERENCES monitors(id) ON DELETE CASCADE,
      target_percentage REAL NOT NULL
    );
  `);

  // Index creation (using standard PG syntax)
  await dbInstance.exec(`
    CREATE INDEX IF NOT EXISTS idx_server_metrics_user ON server_metrics(user_id, collected_at);
    CREATE INDEX IF NOT EXISTS idx_server_metrics_key ON server_metrics(api_key_id, collected_at);
    CREATE INDEX IF NOT EXISTS idx_logs_monitor_checked ON logs(monitor_id, checked_at);
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

  // Insert default settings
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
    await dbInstance.run(
      'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
      [setting.key, setting.value]
    );
  }
}
