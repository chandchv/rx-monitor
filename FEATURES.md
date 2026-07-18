# RxMonitor — Feature Documentation

Complete documentation of all features implemented in the RxMonitor server uptime and metrics monitoring system.

---

## Table of Contents

1. [Core Uptime Monitoring](#core-uptime-monitoring)
2. [User Accounts & Authentication](#user-accounts--authentication)
3. [Server Agent Metrics](#server-agent-metrics)
4. [Response Time Analytics](#response-time-analytics)
5. [SSL Certificate Monitoring](#ssl-certificate-monitoring)
6. [Notification System](#notification-system)
7. [Admin Dashboard](#admin-dashboard)
8. [Payment & Subscriptions](#payment--subscriptions)
9. [Public Status Page](#public-status-page)
10. [Dark/Light Theme](#darklight-theme)
11. [API Reference](#api-reference)
12. [Deployment & Configuration](#deployment--configuration)

---

## Core Uptime Monitoring

### What it does
Continuously polls configured URLs at user-defined intervals and tracks response status, latency, and availability.

### Features
- **HTTP method support** — GET, POST, HEAD
- **Configurable intervals** — check every N seconds (default: 60s)
- **Timeout handling** — configurable per-monitor (default: 10s)
- **Retry logic** — configurable max retries before declaring DOWN (default: 3)
  - Retries happen at 5-second intervals
  - PENDING logs are recorded during retry phase
  - Alerts fire only after all retries are exhausted
- **Status tracking** — UP, DOWN, PENDING, MAINTENANCE
- **Incident timeline** — automatic incident records on status transitions
- **Downtime duration** — calculated when service recovers
- **Diagnostic suggestions** — auto-generated troubleshooting tips based on error type:
  - 500 errors → check application logs, database
  - 502/504 → verify reverse proxy, backend process
  - Timeout → check CPU/RAM, firewall
  - Connection refused → check if app is running on expected port

### Monitor Limits
| User Type | Monitor Limit |
|-----------|--------------|
| Guest (no account) | 1 monitor |
| Free tier | 5 monitors |
| Premium tier | Unlimited |

---

## User Accounts & Authentication

### Sign Up (Email + Password)
- Email + password registration
- Bcrypt password hashing (10 rounds)
- Email verification via token link
- Verification link printed to server console (fallback when SMTP not configured)
- Verification link sent via email (when SMTP is configured)
- First registered user is auto-promoted to **admin**

### Google Sign-In
- Google One-Tap integration
- Auto-creates account on first Google login
- Links Google ID to existing email accounts
- Auto-verified (no email verification needed)

### Session Management
- JWT tokens with 7-day expiry
- Token stored in localStorage
- Auto-logout on token expiration
- Visitor ID tracking for anonymous users (UUID in localStorage)

### Security
- JWT secret configurable via `JWT_SECRET` environment variable
- Passwords never stored in plain text
- API keys stored as SHA-256 hashes (original key shown once)
- XSS protection via HTML escaping and data-attribute patterns (no inline JSON in onclick handlers)
- Monitor ownership validation on all mutations

---

## Server Agent Metrics

### Overview
A lightweight bash agent installed on remote servers that pushes system metrics to the RxMonitor API every 60 seconds. The agent is outbound-only — it opens no ports and accepts no incoming connections.

### Collected Metrics
| Metric | Source | Unit |
|--------|--------|------|
| CPU usage | `top -bn1` | Percentage |
| Memory usage | `free` | Percentage |
| Disk usage | `df /` | Percentage |
| Load average | `/proc/loadavg` | 1-min float |
| Network RX | `/sys/class/net/*/statistics/rx_bytes` | Bytes |
| Network TX | `/sys/class/net/*/statistics/tx_bytes` | Bytes |
| Process count | `ps aux \| wc -l` | Count |
| System uptime | `/proc/uptime` | Seconds |

### API Key Authentication
- Each user generates unique API keys from the dashboard
- Keys use format: `rxm_` + 48 hex characters
- Keys are stored as SHA-256 hashes — original shown only once on creation
- Keys are revocable instantly from the dashboard
- Last-used timestamp tracked per key

### Agent Installation
One-command install on any Linux server:
```bash
curl -sSL https://your-domain.com/install-agent.sh | bash -s YOUR_API_KEY
```

The installer:
1. Creates `/opt/rxmonitor-agent/agent.sh`
2. Registers a systemd service `rxmonitor-agent`
3. Enables auto-start on boot
4. Starts pushing metrics immediately

### Agent Management
```bash
# Check status
sudo systemctl status rxmonitor-agent

# View logs
sudo journalctl -u rxmonitor-agent -f

# Stop agent
sudo systemctl stop rxmonitor-agent

# Uninstall completely
sudo systemctl stop rxmonitor-agent
sudo rm -rf /opt/rxmonitor-agent /etc/systemd/system/rxmonitor-agent.service
sudo systemctl daemon-reload
```

### Dashboard UI (`/servers.html`)
- **API Key Manager** — create, view (prefix only), revoke keys
- **Server Cards** — live CPU/Memory/Disk bars per server with status indicator (green = reporting, amber = stale >5 min)
- **Interactive Charts** — CPU, Memory, Disk, Load over time using Chart.js
- **Time Range Filter** — 1 hour, 6 hours, 24 hours, 7 days
- **Auto-refresh** — updates every 60 seconds
- **Click to switch** — click any server card to view its charts

### Data Retention
- Metrics older than 30 days are automatically purged
- Cleanup runs every 6 hours

---

## Response Time Analytics

### Endpoint
`GET /api/monitors/:id/analytics?hours=24`

### Percentile Metrics
- **P50** — median response time
- **P95** — 95th percentile (most users experience this or better)
- **P99** — 99th percentile (worst case for 99% of requests)
- **Min/Max** — fastest and slowest recorded times
- **Average** — arithmetic mean

### Apdex Score
Application Performance Index measuring user satisfaction:
- **Satisfied** — response ≤ 500ms
- **Tolerating** — response 500ms–2000ms
- **Frustrated** — response > 2000ms

Formula: `(satisfied + tolerating/2) / total`

Score interpretation:
- 0.9–1.0 → Excellent (green)
- 0.7–0.9 → Fair (amber)
- < 0.7 → Poor (red)

### Uptime Heatmap
- 30-day calendar grid (GitHub contribution graph style)
- Each cell represents one day
- Color coding:
  - Green (#10b981) — 99.5%+ uptime
  - Light green (#22c55e) — 95%+ uptime
  - Amber (#f59e0b) — 80%+ uptime
  - Red (#ef4444) — below 80% uptime
  - Gray — no data

### UI Location
Displayed on the **Monitor Detail Page** (`/monitor-detail.html?id=X`) in a dedicated analytics section between the charts and the incident timeline.

---

## SSL Certificate Monitoring

### Automatic Detection
- SSL certificates are checked on every successful HTTPS monitor check
- Uses TLS connection to read peer certificate
- Expiration date stored in database

### Expiry Alerts
Alerts are sent at:
- **30 days** before expiry
- **15 days** before expiry
- **1 day** before expiry

Alerts delivered via:
- Telegram (if configured)
- Email (if configured)

### Dashboard Display
- Days remaining shown on monitor detail page
- Color-coded warnings:
  - Green — >30 days remaining
  - Amber — 7–30 days remaining
  - Red — ≤7 days remaining (with "renew now!" warning)

---

## Notification System

### Channels

#### Telegram
- Bot token + Chat ID configuration
- HTML-formatted messages with emoji status icons
- Test notification button in settings

#### Email (SMTP)
- Configurable SMTP host, port, user, password
- TLS/SSL support (port 465 = implicit SSL, others = STARTTLS)
- HTML-formatted emails with branded templates
- Test email button in settings

### Alert Types
| Alert | Trigger | Channels |
|-------|---------|----------|
| Server DOWN | Monitor fails after max retries | Telegram, Email |
| Server Recovery | Monitor comes back UP | Telegram, Email |
| SSL Expiry Warning | 30/15/1 days before expiry | Telegram, Email |
| Daily Summary Report | Scheduled time (configurable) | Telegram, Email |

### Daily Summary Report
Sent at a configurable time (default 09:00), includes:
- Total active monitors count
- Average uptime percentage
- Average latency
- Incidents in last 24 hours
- Slowest monitor name and response time

---

## Admin Dashboard

### Access
- URL: `/admin.html`
- Restricted to users with `role = 'admin'`
- First registered user is auto-promoted to admin

### Stats Overview
- Total registered users
- Premium subscription count
- Total revenue (from Razorpay payments)
- Total monitors across all users

### User Management
- View all users with registration date, email, role, verification status, tier, monitor count
- **Edit user** — change role (user/admin), subscription tier (free/premium), verification status
- **Delete user** — removes user account plus all their monitors, logs, and incidents

### Settings Panel (via main dashboard)
- Telegram bot configuration
- SMTP email configuration
- Razorpay API keys
- Custom domain for status page
- Daily report schedule (enable/disable, time)

---

## Payment & Subscriptions

### Razorpay Integration
- Create payment order via `/api/payment/create-order`
- Client-side Razorpay checkout popup
- Server-side signature verification via `/api/payment/verify-payment`
- **Mock mode** — automatically activates when Razorpay keys are not configured (for development)

### Pricing
- Amount: ₹499 (configured in server code as 49900 paise)
- Upgrades user from `free` to `premium` tier

### Tier Differences
| Feature | Free | Premium |
|---------|------|---------|
| Monitors | Up to 5 | Unlimited |
| Server agent | Yes | Yes |
| Notifications | Yes | Yes |
| Analytics | Yes | Yes |

---

## Public Status Page

### URL
- `/status.html` or `/status`
- Automatically served at root (`/`) when accessed via custom domain

### Features
- Shows all monitors marked as `is_public = 1`
- Displays: name, URL, status, response time, uptime percentage
- Last 30 check history as mini status indicators
- SSL expiry date
- No authentication required
- Respects dark/light theme

### Custom Domain
- Configure via admin settings (`custom_domain`)
- When accessed via the custom domain, the homepage automatically serves the status page

---

## Dark/Light Theme

### Implementation
- Theme stored in `localStorage` as `data-theme` attribute on `<html>`
- Toggle button in header (☀️/🌙)
- `theme.js` loads before page render to prevent flash of wrong theme
- CSS custom properties for all colors, backgrounds, borders

### Supported Pages
- Dashboard (`index.html`)
- Server Metrics (`servers.html`)
- System Logs (`logs.html`)
- Monitor Detail (`monitor-detail.html`)
- Status Page (`status.html`)
- Admin Panel (`admin.html`)

---

## API Reference

### Authentication
All authenticated endpoints accept: `Authorization: Bearer <JWT_TOKEN>`

Agent endpoints accept: `Authorization: Bearer <API_KEY>` (format: `rxm_...`)

### Monitors
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/monitors` | Optional | List monitors (scoped to user/visitor) |
| POST | `/api/monitors` | Optional | Create a monitor |
| GET | `/api/monitors/:id` | Optional | Get monitor details + logs + incidents |
| PUT | `/api/monitors/:id` | Optional | Update monitor settings |
| DELETE | `/api/monitors/:id` | Optional | Delete monitor and all data |
| POST | `/api/monitors/:id/check` | Optional | Force immediate check |
| GET | `/api/monitors/:id/analytics` | Optional | Response time analytics + heatmap |

### Auth
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/signup` | Register with email + password |
| GET | `/api/auth/verify?token=X` | Verify email address |
| POST | `/api/auth/login` | Login, returns JWT |
| POST | `/api/auth/google` | Google OAuth login |

### API Keys
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/keys` | Required | Generate new API key |
| GET | `/api/keys` | Required | List keys (prefix only) |
| DELETE | `/api/keys/:id` | Required | Revoke a key |

### Server Agent
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/agent/metrics` | API Key | Push server metrics |
| GET | `/api/agent/metrics` | JWT | Get metrics history |
| GET | `/api/agent/servers` | JWT | Get latest metric per server |

### Payments
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/payment/create-order` | Required | Create Razorpay order |
| POST | `/api/payment/verify-payment` | Required | Verify and upgrade tier |

### Admin
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/admin/stats` | Admin | Dashboard statistics |
| GET | `/api/admin/users` | Admin | List all users |
| PUT | `/api/admin/users/:id` | Admin | Edit user role/tier/verified |
| DELETE | `/api/admin/users/:id` | Admin | Delete user and all data |

### Settings
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/settings` | Admin | Get all settings |
| PUT | `/api/settings` | Admin | Update settings |
| POST | `/api/settings/test-telegram` | Admin | Send test Telegram message |
| POST | `/api/settings/test-email` | Admin | Send test email |

### System
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/system-status` | Server stats (CPU, RAM, DB size) |
| GET | `/api/system-logs` | Paginated check logs |
| GET | `/api/system-logs/download` | Export logs as CSV |
| POST | `/api/system-logs/email` | Email logs as CSV attachment |
| GET | `/api/public/monitors` | Public status page data |
| GET | `/install-agent.sh` | Agent installer script |

---

## Deployment & Configuration

### Requirements
- Node.js 18+
- Linux server (Ubuntu recommended for agent)
- Nginx (reverse proxy + SSL)
- PM2 (process manager)

### Environment Variables (`.env`)
| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `4000` | Server listening port |
| `JWT_SECRET` | **Yes** | Insecure fallback | Secret for signing JWT tokens |
| `BASE_URL` | Recommended | `http://localhost:4000` | Public URL (for verification emails & agent install) |

### Database
- SQLite via `sqlite` + `sqlite3` packages
- File: `monitor.db` in project root
- Auto-migrates schema on startup (adds columns non-destructively)

### Tables
| Table | Purpose |
|-------|---------|
| `settings` | Key-value config store |
| `users` | User accounts |
| `payments` | Razorpay payment records |
| `monitors` | Monitored URLs |
| `logs` | Check results (time-series) |
| `incidents` | Status transitions |
| `api_keys` | Agent API keys (hashed) |
| `server_metrics` | Agent-reported metrics (time-series) |

### PM2 Commands
```bash
# Start
pm2 start server.js --name rx-monitor

# Restart (after git pull)
pm2 restart rx-monitor --update-env

# View logs
pm2 logs rx-monitor --lines 100

# Monitor resources
pm2 monit

# Save process list for boot persistence
pm2 save
pm2 startup
```

### Nginx Configuration
```nginx
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

### SSL Certificate
```bash
sudo apt install certbot python3-certbot-nginx -y
sudo certbot --nginx -d your-domain.com
```
Auto-renews via systemd timer.

---

## File Structure

```
rx-monitor/
├── server.js           # Express API server (all routes)
├── database.js         # SQLite schema + migrations
├── monitor.js          # Uptime check engine + SSL checker
├── notifier.js         # Telegram + Email + Daily report + SSL alerts
├── package.json        # Dependencies and scripts
├── .env.example        # Environment variable template
├── .gitignore          # Excludes .env, node_modules, *.db
├── nginx-default.conf  # Reference nginx config
└── public/
    ├── index.html      # Main dashboard
    ├── app.js          # Dashboard logic (auth, monitors, modals)
    ├── servers.html    # Server metrics dashboard
    ├── servers.js      # Server metrics logic (keys, charts)
    ├── admin.html      # Admin control panel
    ├── admin.js        # Admin logic (users, stats)
    ├── logs.html       # System logs viewer
    ├── monitor-detail.html  # Single monitor detail + analytics
    ├── status.html     # Public status page
    ├── style.css       # Global styles (dark/light themes)
    └── theme.js        # Theme initialization (prevents flash)
```
