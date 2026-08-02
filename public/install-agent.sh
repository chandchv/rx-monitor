#!/bin/bash
# =============================================================================
# UptimeBunny Server Agent - Installer
# Installs a lightweight monitoring agent that pushes system metrics & service logs
# to your UptimeBunny dashboard every 60 seconds.
#
# Usage:
#   curl -sSL https://uptimebunny.com/install-agent.sh | bash -s YOUR_API_KEY
#   curl -sSL https://uptimebunny.com/install-agent.sh | bash -s -- --key YOUR_API_KEY --services nginx,apache2,pm2,gunicorn,postgres,mysql,redis,docker
# =============================================================================

set -e

API_KEY=""
SERVICES_ARG=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --key|-k)
      API_KEY="$2"
      shift 2
      ;;
    --services|-s)
      SERVICES_ARG="$2"
      shift 2
      ;;
    *)
      if [ -z "$API_KEY" ]; then
        API_KEY="$1"
      fi
      shift
      ;;
  esac
done

if [ -z "$API_KEY" ]; then
  echo "❌ Error: API key is required."
  echo "Usage: curl -sSL https://uptimebunny.com/install-agent.sh | bash -s YOUR_API_KEY"
  exit 1
fi

SERVER_URL="${RXM_SERVER_URL:-__SERVER_URL__}"

echo "🚀 Installing UptimeBunny Agent..."
echo "   Server: $SERVER_URL"
echo ""

AGENT_DIR="/opt/rxmonitor"
sudo mkdir -p "$AGENT_DIR"

# Auto-detect common installed services if none explicitly specified
if [ -z "$SERVICES_ARG" ]; then
  DETECTED=""
  CANDIDATES=("nginx" "apache2" "httpd" "pm2" "gunicorn" "uvicorn" "postgresql" "postgres" "mysql" "mariadb" "redis" "redis-server" "mongod" "docker" "caddy" "ssh" "sshd" "ufw")
  for svc in "${CANDIDATES[@]}"; do
    if systemctl list-unit-files "$svc.service" &>/dev/null || pgrep -x "$svc" &>/dev/null || pgrep -f "$svc" &>/dev/null; then
      if [ -z "$DETECTED" ]; then
        DETECTED="$svc"
      else
        DETECTED="$DETECTED,$svc"
      fi
    fi
  done
  if [ -z "$DETECTED" ]; then
    DETECTED="nginx,pm2,gunicorn,postgres,mysql,redis"
  fi
  SERVICES_ARG="$DETECTED"
fi

echo "🔍 Monitoring services: $SERVICES_ARG"

# Save services.conf
sudo tee "$AGENT_DIR/services.conf" > /dev/null << EOF
SERVICES="$SERVICES_ARG"
EOF
sudo chmod 644 "$AGENT_DIR/services.conf"

# Write agent collection script
sudo tee "$AGENT_DIR/agent.sh" > /dev/null << 'AGENT_SCRIPT'
#!/bin/bash
# UptimeBunny Agent - Collects system metrics & service logs every 60 seconds

API_KEY="__API_KEY__"
SERVER_URL="__SERVER_URL__"

HOSTNAME=$(hostname)

# CPU usage (percentage)
CPU=$(top -bn1 2>/dev/null | grep "Cpu(s)" | awk '{print $2 + $4}' || echo "0")
if [ -z "$CPU" ] || [ "$CPU" = "0" ]; then
  CPU=$(cat /proc/stat 2>/dev/null | head -1 | awk '{idle=$5; total=0; for(i=2;i<=NF;i++) total+=$i; printf "%.1f", (1-(idle/total))*100}' || echo "0")
fi

# Memory usage
MEMORY=$(free 2>/dev/null | awk '/Mem:/ {printf "%.1f", ($3/$2)*100}' || echo "0")
MEM_USED_MB=$(free -m 2>/dev/null | awk '/Mem:/ {print $3}' || echo "0")
MEM_TOTAL_MB=$(free -m 2>/dev/null | awk '/Mem:/ {print $2}' || echo "0")

# Disk usage (root partition)
DISK=$(df / 2>/dev/null | awk 'NR==2 {gsub(/%/,""); print $5}' || echo "0")
DISK_USED_GB=$(df -BG / 2>/dev/null | awk 'NR==2 {gsub(/G/,""); print $3}' || echo "0")
DISK_TOTAL_GB=$(df -BG / 2>/dev/null | awk 'NR==2 {gsub(/G/,""); print $2}' || echo "0")

# Load average (1, 5, 15 min)
LOAD_1M=$(cat /proc/loadavg 2>/dev/null | awk '{print $1}' || echo "0")
LOAD_5M=$(cat /proc/loadavg 2>/dev/null | awk '{print $2}' || echo "0")
LOAD_15M=$(cat /proc/loadavg 2>/dev/null | awk '{print $3}' || echo "0")

# Network RX/TX bytes
NETWORK_RX=$(cat /proc/net/dev 2>/dev/null | awk 'NR>2 && $1 !~ /lo:/ {gsub(/:/, "", $1); rx+=$2} END {print rx+0}' || echo "0")
NETWORK_TX=$(cat /proc/net/dev 2>/dev/null | awk 'NR>2 && $1 !~ /lo:/ {gsub(/:/, "", $1); tx+=$10} END {print tx+0}' || echo "0")

PROCESSES=$(ps aux 2>/dev/null | wc -l || echo "0")
UPTIME=$(cat /proc/uptime 2>/dev/null | awk '{printf "%d", $1}' || echo "0")

# --- Service Status & Log Extraction ---
SERVICES_CONF="/opt/rxmonitor/services.conf"
SERVICES="nginx,apache2,pm2,gunicorn,postgres,mysql,redis"
if [ -f "$SERVICES_CONF" ]; then
  CONF_SVC=$(grep -E '^\s*SERVICES=' "$SERVICES_CONF" | cut -d'=' -f2 | tr -d '"' | tr -d "'")
  if [ -n "$CONF_SVC" ]; then
    SERVICES="$CONF_SVC"
  fi
fi

json_escape() {
  printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null || printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\n/\\n/g')"
}

CUSTOM_SERVICES_JSON="{"
FIRST=1
SERVICES_LIST_JSON="["
FIRST_SVC=1

IFS=',' read -r -a array <<< "$SERVICES"
for service in "${array[@]}"; do
  service=$(echo "$service" | xargs)
  if [ -n "$service" ]; then
    if systemctl is-active --quiet "$service" 2>/dev/null; then
      S_STATUS="running"
    elif pgrep -x "$service" >/dev/null 2>&1 || pgrep -f "$service" >/dev/null 2>&1; then
      S_STATUS="running"
    else
      S_STATUS="stopped"
    fi

    S_LOGS=""
    if journalctl -u "$service" --no-pager -n 30 &>/dev/null; then
      S_LOGS=$(journalctl -u "$service" --no-pager -n 30 2>/dev/null || echo "")
    elif [ "$service" = "pm2" ] && command -v pm2 &>/dev/null; then
      S_LOGS=$(pm2 logs --nostream --lines 30 2>/dev/null | head -60 || echo "")
    elif [ -f "/var/log/$service/error.log" ]; then
      S_LOGS=$(tail -30 "/var/log/$service/error.log" 2>/dev/null || echo "")
    elif [ -f "/var/log/$service.log" ]; then
      S_LOGS=$(tail -30 "/var/log/$service.log" 2>/dev/null || echo "")
    fi

    S_LOGS_JSON=$(json_escape "$S_LOGS")

    if [ $FIRST -eq 1 ]; then
      FIRST=0
    else
      CUSTOM_SERVICES_JSON="$CUSTOM_SERVICES_JSON,"
    fi
    CUSTOM_SERVICES_JSON="$CUSTOM_SERVICES_JSON\"$service\": {\"status\": \"$S_STATUS\", \"logs\": $S_LOGS_JSON}"

    if [ $FIRST_SVC -eq 1 ]; then
      FIRST_SVC=0
    else
      SERVICES_LIST_JSON="$SERVICES_LIST_JSON,"
    fi
    SERVICES_LIST_JSON="$SERVICES_LIST_JSON{\"name\": \"$service\", \"status\": \"$S_STATUS\"}"
  fi
done
CUSTOM_SERVICES_JSON="$CUSTOM_SERVICES_JSON}"
SERVICES_LIST_JSON="$SERVICES_LIST_JSON]"

PAYLOAD=$(cat <<EOF
{
  "hostname": "$HOSTNAME",
  "cpu": $CPU,
  "memory": $MEMORY,
  "memory_used_mb": $MEM_USED_MB,
  "memory_total_mb": $MEM_TOTAL_MB,
  "disk": $DISK,
  "disk_used_gb": $DISK_USED_GB,
  "disk_total_gb": $DISK_TOTAL_GB,
  "load": $LOAD_1M,
  "load_5m": $LOAD_5M,
  "load_15m": $LOAD_15M,
  "network_rx": $NETWORK_RX,
  "network_tx": $NETWORK_TX,
  "processes": $PROCESSES,
  "uptime": $UPTIME,
  "services": $SERVICES_LIST_JSON,
  "custom_services": $CUSTOM_SERVICES_JSON
}
EOF
)

curl -sS -X POST "$SERVER_URL/api/agent/metrics" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d "$PAYLOAD" > /dev/null 2>&1 || true
AGENT_SCRIPT

# Replace placeholders
sudo sed -i "s|__API_KEY__|$API_KEY|g" "$AGENT_DIR/agent.sh"
sudo sed -i "s|__SERVER_URL__|$SERVER_URL|g" "$AGENT_DIR/agent.sh"
sudo chmod +x "$AGENT_DIR/agent.sh"

# Set up systemd service and timer
sudo tee /etc/systemd/system/rxmonitor-agent.service > /dev/null << EOF
[Unit]
Description=UptimeBunny Agent - System Metrics Collector
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
Description=Run UptimeBunny Agent every 60 seconds

[Timer]
OnBootSec=10
OnUnitActiveSec=60
AccuracySec=5

[Install]
WantedBy=timers.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable rxmonitor-agent.timer
sudo systemctl start rxmonitor-agent.timer

echo "🔄 Running initial metric collection..."
sudo bash "$AGENT_DIR/agent.sh" && echo "✅ Initial metrics & logs pushed successfully!" || echo "⚠️ First push completed with warnings."

echo ""
echo "============================================="
echo "  ✅ UptimeBunny Agent Installed Successfully!"
echo "============================================="
echo ""
echo "  📊 Metrics & Logs pushed every 60 seconds"
echo "  📁 Agent Dir: $AGENT_DIR"
echo "  ⚙️  Services File: $AGENT_DIR/services.conf"
echo "  ⏱️  Timer: rxmonitor-agent.timer"
echo ""
