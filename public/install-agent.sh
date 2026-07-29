#!/bin/bash
# =============================================================================
# RxMonitor Server Agent - Installer
# Installs a lightweight monitoring agent that pushes system metrics
# to your RxMonitor dashboard every 60 seconds.
#
# Usage: curl -sSL https://YOUR_DOMAIN/install-agent.sh | bash -s YOUR_API_KEY
# =============================================================================

set -e

API_KEY="${1}"
if [ -z "$API_KEY" ]; then
  echo "❌ Error: API key is required."
  echo "Usage: curl -sSL https://YOUR_DOMAIN/install-agent.sh | bash -s YOUR_API_KEY"
  exit 1
fi

# Detect the server URL from the script source or use the default
SERVER_URL="${RXM_SERVER_URL:-__SERVER_URL__}"

echo "🚀 Installing RxMonitor Agent..."
echo "   Server: $SERVER_URL"
echo ""

# Create the agent directory
AGENT_DIR="/opt/rxmonitor"
sudo mkdir -p "$AGENT_DIR"

# Write the agent script
sudo tee "$AGENT_DIR/agent.sh" > /dev/null << 'AGENT_SCRIPT'
#!/bin/bash
# RxMonitor Agent - Collects and pushes system metrics
# This script runs every 60 seconds via systemd timer

API_KEY="__API_KEY__"
SERVER_URL="__SERVER_URL__"

# --- Collect Metrics ---

HOSTNAME=$(hostname)

# CPU usage (average across all cores)
CPU=$(top -bn1 2>/dev/null | grep "Cpu(s)" | awk '{print $2 + $4}' || echo "0")
if [ -z "$CPU" ] || [ "$CPU" = "0" ]; then
  CPU=$(cat /proc/stat 2>/dev/null | head -1 | awk '{idle=$5; total=0; for(i=2;i<=NF;i++) total+=$i; printf "%.1f", (1-(idle/total))*100}' || echo "0")
fi

# Memory usage
MEMORY=$(free 2>/dev/null | awk '/Mem:/ {printf "%.1f", ($3/$2)*100}' || echo "0")

# Disk usage (root partition)
DISK=$(df / 2>/dev/null | awk 'NR==2 {gsub(/%/,""); print $5}' || echo "0")

# Load average (1 min)
LOAD=$(cat /proc/loadavg 2>/dev/null | awk '{print $1}' || echo "0")

# Network RX/TX bytes (sum all non-lo interfaces)
NETWORK_RX=$(cat /proc/net/dev 2>/dev/null | awk 'NR>2 && $1 !~ /lo:/ {gsub(/:/, "", $1); rx+=$2} END {print rx+0}' || echo "0")
NETWORK_TX=$(cat /proc/net/dev 2>/dev/null | awk 'NR>2 && $1 !~ /lo:/ {gsub(/:/, "", $1); tx+=$10} END {print tx+0}' || echo "0")

# Process count
PROCESSES=$(ps aux 2>/dev/null | wc -l || echo "0")

# Uptime in seconds
UPTIME=$(cat /proc/uptime 2>/dev/null | awk '{printf "%d", $1}' || echo "0")

# --- Service Statuses ---

# Nginx status
if systemctl is-active --quiet nginx 2>/dev/null; then
  NGINX_STATUS="active"
else
  NGINX_STATUS="inactive"
fi

# Gunicorn status
if systemctl is-active --quiet gunicorn 2>/dev/null; then
  GUNICORN_STATUS="active"
elif pgrep -x gunicorn > /dev/null 2>&1; then
  GUNICORN_STATUS="active"
else
  GUNICORN_STATUS="inactive"
fi

# PM2 status
if command -v pm2 &>/dev/null && pm2 list 2>/dev/null | grep -q "online"; then
  PM2_STATUS="active"
elif pgrep -f "PM2" > /dev/null 2>&1; then
  PM2_STATUS="active"
else
  PM2_STATUS="inactive"
fi

# --- Service Logs (last 20 lines) ---

# Gunicorn logs
GUNICORN_LOGS=""
if [ -f /var/log/gunicorn/error.log ]; then
  GUNICORN_LOGS=$(tail -20 /var/log/gunicorn/error.log 2>/dev/null || echo "")
elif [ -f /var/log/gunicorn/access.log ]; then
  GUNICORN_LOGS=$(tail -20 /var/log/gunicorn/access.log 2>/dev/null || echo "")
elif journalctl -u gunicorn --no-pager -n 1 &>/dev/null; then
  GUNICORN_LOGS=$(journalctl -u gunicorn --no-pager -n 20 2>/dev/null || echo "")
fi

# PM2 logs
PM2_LOGS=""
if command -v pm2 &>/dev/null; then
  # Get the first PM2 app's log file
  PM2_LOG_FILE=$(pm2 jlist 2>/dev/null | python3 -c "import sys,json; apps=json.load(sys.stdin); print(apps[0].get('pm2_env',{}).get('pm_err_log_path',''))" 2>/dev/null || echo "")
  if [ -n "$PM2_LOG_FILE" ] && [ -f "$PM2_LOG_FILE" ]; then
    PM2_LOGS=$(tail -20 "$PM2_LOG_FILE" 2>/dev/null || echo "")
  fi
  # Fallback: use pm2 logs directly
  if [ -z "$PM2_LOGS" ]; then
    PM2_LOGS=$(pm2 logs --nostream --lines 20 2>/dev/null | head -40 || echo "")
  fi
fi

# --- Push to server ---

# Escape special chars for JSON
json_escape() {
  printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null || printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\n/\\n/g')"
}

GUNICORN_LOGS_JSON=$(json_escape "$GUNICORN_LOGS")
PM2_LOGS_JSON=$(json_escape "$PM2_LOGS")

PAYLOAD=$(cat <<EOF
{
  "hostname": "$HOSTNAME",
  "cpu": $CPU,
  "memory": $MEMORY,
  "disk": $DISK,
  "load": $LOAD,
  "network_rx": $NETWORK_RX,
  "network_tx": $NETWORK_TX,
  "processes": $PROCESSES,
  "uptime": $UPTIME,
  "nginx_status": "$NGINX_STATUS",
  "gunicorn_status": "$GUNICORN_STATUS",
  "pm2_status": "$PM2_STATUS",
  "gunicorn_logs": $GUNICORN_LOGS_JSON,
  "pm2_logs": $PM2_LOGS_JSON
}
EOF
)

curl -sS -X POST "$SERVER_URL/api/agent/metrics" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d "$PAYLOAD" > /dev/null 2>&1 || true
AGENT_SCRIPT

# Replace placeholders in the agent script
sudo sed -i "s|__API_KEY__|$API_KEY|g" "$AGENT_DIR/agent.sh"
sudo sed -i "s|__SERVER_URL__|$SERVER_URL|g" "$AGENT_DIR/agent.sh"
sudo chmod +x "$AGENT_DIR/agent.sh"

echo "✅ Agent script created at $AGENT_DIR/agent.sh"

# --- Set up systemd service and timer ---

sudo tee /etc/systemd/system/rxmonitor-agent.service > /dev/null << EOF
[Unit]
Description=RxMonitor Agent - System Metrics Collector
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=$AGENT_DIR/agent.sh
StandardOutput=journal
StandardError=journal
EOF

sudo tee /etc/systemd/system/rxmonitor-agent.timer > /dev/null << EOF
[Unit]
Description=Run RxMonitor Agent every 60 seconds

[Timer]
OnBootSec=10
OnUnitActiveSec=60
AccuracySec=5

[Install]
WantedBy=timers.target
EOF

# Enable and start the timer
sudo systemctl daemon-reload
sudo systemctl enable rxmonitor-agent.timer
sudo systemctl start rxmonitor-agent.timer

# Run once immediately
echo "🔄 Running first collection..."
sudo bash "$AGENT_DIR/agent.sh" && echo "✅ First metrics push successful!" || echo "⚠️  First push had issues, but the timer is set up."

echo ""
echo "============================================="
echo "  ✅ RxMonitor Agent Installed Successfully!"
echo "============================================="
echo ""
echo "  📊 Metrics will be pushed every 60 seconds"
echo "  📁 Agent location: $AGENT_DIR/agent.sh"
echo "  ⏱️  Timer: rxmonitor-agent.timer"
echo ""
echo "  Useful commands:"
echo "    systemctl status rxmonitor-agent.timer   # Check timer status"
echo "    journalctl -u rxmonitor-agent.service    # View agent logs"
echo "    systemctl stop rxmonitor-agent.timer     # Stop monitoring"
echo "    systemctl start rxmonitor-agent.timer    # Resume monitoring"
echo ""
