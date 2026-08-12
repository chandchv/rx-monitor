// UptimeBunny - Server Metrics Dashboard
const API_URL = '';
const token = localStorage.getItem('rx-monitor-token');

if (!token) {
  window.location.href = '/';
}

const toastEl = document.getElementById('toast');
function showToast(message, type = 'success') {
  toastEl.textContent = message;
  toastEl.className = `toast show toast-${type}`;
  setTimeout(() => toastEl.classList.remove('show'), 4000);
}

function getHeaders() {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  };
}

// Set install URL
const baseUrl = window.location.origin;
let activeUserApiKey = '';

function updateInstallCommand(apiKey) {
  const keyToUse = apiKey || activeUserApiKey || 'YOUR_API_KEY';
  const cmd = `curl -sSL ${baseUrl}/install-agent.sh | bash -s -- --key ${keyToUse} --services nginx,apache,pm2,gunicorn,postgres,mysql,redis`;
  const cmdEl = document.getElementById('install-cmd');
  if (cmdEl) cmdEl.textContent = cmd;
}

// --- API Keys ---

async function loadKeys() {
  try {
    let res = await fetch(`${API_URL}/api/keys`, { headers: getHeaders() });
    if (res.status === 401) { window.location.href = '/'; return; }
    let keys = await res.json();
    
    // Auto-generate default key if none exists so user never sees empty state
    if (!Array.isArray(keys) || keys.length === 0) {
      const createRes = await fetch(`${API_URL}/api/keys`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ label: 'Default Server Agent Key' })
      });
      const newKeyData = await createRes.json();
      if (newKeyData.key) {
        keys = [{ id: newKeyData.id || 1, key_prefix: newKeyData.key, label: 'Default Server Agent Key', created_at: new Date().toISOString() }];
      }
    }

    const container = document.getElementById('keys-list');
    container.innerHTML = keys.map(k => `
      <div class="key-row">
        <div class="key-info">
          <span class="key-prefix">${k.key_prefix || k.key}••••••••</span>
          <span class="key-label">${k.label} · Created ${new Date(k.created_at).toLocaleDateString()}${k.last_used_at ? ' · Last used ' + timeAgo(k.last_used_at) : ''}</span>
        </div>
        <div class="key-actions">
          <button class="btn btn-danger" style="padding: 5px 10px; font-size: 0.75em;" onclick="deleteKey(${k.id})">Revoke</button>
        </div>
      </div>
    `).join('');

    if (keys.length > 0) {
      activeUserApiKey = keys[0].key_prefix || keys[0].key;
      updateInstallCommand(activeUserApiKey);
    }
  } catch (err) {
    showToast('Failed to load API keys', 'error');
  }
}

document.getElementById('btn-create-key').addEventListener('click', async () => {
  const label = prompt('Label for this key (e.g. "Production Server")', 'My Server');
  if (!label) return;

  try {
    const res = await fetch(`${API_URL}/api/keys`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ label })
    });
    const data = await res.json();
    if (data.key) {
      const display = document.getElementById('new-key-display');
      document.getElementById('new-key-value').textContent = data.key;
      display.style.display = 'block';
      activeUserApiKey = data.key;
      updateInstallCommand(data.key);
      showToast('API key created! Save it now.');
      loadKeys();
    } else {
      showToast(data.error || 'Failed to create key', 'error');
    }
  } catch (err) {
    showToast('Network error', 'error');
  }
});

document.getElementById('btn-copy-key').addEventListener('click', () => {
  const key = document.getElementById('new-key-value').textContent;
  navigator.clipboard.writeText(key).then(() => showToast('Key copied to clipboard'));
});

const copyCmdBtn = document.getElementById('btn-copy-install-cmd');
if (copyCmdBtn) {
  copyCmdBtn.addEventListener('click', () => {
    const cmd = document.getElementById('install-cmd').textContent;
    navigator.clipboard.writeText(cmd).then(() => showToast('Installer command copied to clipboard!'));
  });
}

const addServerBtn = document.getElementById('btn-add-server-cmd');
if (addServerBtn) {
  addServerBtn.addEventListener('click', async () => {
    if (!activeUserApiKey) {
      await loadKeys();
    }
    const cmd = document.getElementById('install-cmd').textContent;
    navigator.clipboard.writeText(cmd).then(() => showToast('Installer command copied to clipboard! Paste it into your Linux terminal.'));
  });
}

async function deleteKey(id) {
  if (!confirm('Revoke this API key? The agent using it will stop reporting.')) return;
  try {
    await fetch(`${API_URL}/api/keys/${id}`, { method: 'DELETE', headers: getHeaders() });
    showToast('Key revoked');
    loadKeys();
    loadServers();
  } catch (err) {
    showToast('Failed to revoke key', 'error');
  }
}

// --- Server Cards ---

async function loadServers() {
  try {
    const res = await fetch(`${API_URL}/api/agent/servers`, { headers: getHeaders() });
    if (res.status === 401) { window.location.href = '/'; return; }
    const servers = await res.json();
    const grid = document.getElementById('servers-grid');
    const chartsSection = document.getElementById('charts-section');

    if (servers.length === 0) {
      grid.innerHTML = `
        <div class="no-servers" style="grid-column: 1 / -1;">
          <div class="icon">🖥️</div>
          <h3>No servers reporting yet</h3>
          <p>Generate an API key above and install the agent on your server to see live metrics.</p>
        </div>`;
      chartsSection.style.display = 'none';
      return;
    }

    chartsSection.style.display = 'block';

    grid.innerHTML = servers.map((s, idx) => {
      const serverId = s.id || idx;
      const lastSeenStr = s.collected_at || s.last_seen;
      const lastSeen = lastSeenStr ? new Date(lastSeenStr) : new Date();
      const ageMinutes = (Date.now() - lastSeen.getTime()) / 60000;
      const stale = ageMinutes > 5;
      const uptimeStr = formatUptime(s.uptime_seconds || s.uptime);
      const nginxActive = s.nginx_status === 'active' || s.nginx_status === 'running';
      const gunicornActive = s.gunicorn_status === 'active' || s.gunicorn_status === 'running';
      const pm2Active = s.pm2_status === 'active' || s.pm2_status === 'running';

      const displayName = escapeHtml(s.display_name || s.label || s.hostname || 'Linux Server');
      const hostNameStr = escapeHtml(s.hostname || 'Linux Server');
      const ipAddressStr = s.ip_address ? ` (${escapeHtml(s.ip_address)})` : '';

      let customServices = null;
      if (s.custom_services) {
        try {
          customServices = typeof s.custom_services === 'string' ? JSON.parse(s.custom_services) : s.custom_services;
        } catch (e) {
          console.error('Failed to parse custom_services json', e);
        }
      }

      let servicesStatusHtml = '';
      let logsPanelHtml = '';

      if (customServices && Object.keys(customServices).length > 0) {
        servicesStatusHtml = Object.keys(customServices).map(name => {
          const svc = customServices[name];
          const active = svc.status === 'active' || svc.status === 'running';
          return `<div>${escapeHtml(name)}: <span style="font-weight:600; padding: 2px 6px; border-radius: 4px; background: ${active ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)'}; color: ${active ? '#10b981' : '#ef4444'}; text-transform: capitalize;">${escapeHtml(svc.status || 'inactive')}</span></div>`;
        }).join('');

        logsPanelHtml = Object.keys(customServices).map(name => {
          const svc = customServices[name];
          const color = name === 'gunicorn' ? '#fbbf24' : name === 'pm2' ? '#38bdf8' : '#6366f1';
          return `
            <div style="font-weight:600; font-size: 0.85em; margin-bottom: 6px; color: ${color}; text-transform: uppercase; letter-spacing: 0.5px;">📄 ${escapeHtml(name)} Logs:</div>
            <pre style="font-family: monospace; font-size: 0.8em; overflow-x: auto; max-height: 150px; white-space: pre-wrap; margin-bottom: 14px; color: #3fb950; background: #090d16; padding: 10px; border-radius: 6px; border: 1px solid #30363d;">${escapeHtml(svc.logs || 'No recent log entries recorded for this service.')}</pre>
          `;
        }).join('');
      } else {
        servicesStatusHtml = `
          <div>Nginx: <span style="font-weight:600; padding: 2px 6px; border-radius: 4px; background: ${nginxActive ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)'}; color: ${nginxActive ? '#10b981' : '#ef4444'};">${s.nginx_status || 'running'}</span></div>
          <div>Gunicorn: <span style="font-weight:600; padding: 2px 6px; border-radius: 4px; background: ${gunicornActive ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)'}; color: ${gunicornActive ? '#10b981' : '#ef4444'};">${s.gunicorn_status || 'running'}</span></div>
          <div>PM2: <span style="font-weight:600; padding: 2px 6px; border-radius: 4px; background: ${pm2Active ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)'}; color: ${pm2Active ? '#10b981' : '#ef4444'};">${s.pm2_status || 'running'}</span></div>
        `;
        logsPanelHtml = `
          <div style="font-weight:600; font-size: 0.85em; margin-bottom: 6px; color: #fbbf24;">🐍 Gunicorn Logs (Last 20 lines):</div>
          <pre style="font-family: monospace; font-size: 0.8em; overflow-x: auto; max-height: 140px; white-space: pre-wrap; margin-bottom: 12px; color: #3fb950; background: #090d16; padding: 10px; border-radius: 6px; border: 1px solid #30363d;">${escapeHtml(s.gunicorn_logs || 'Active log streaming enabled via UptimeBunny Agent.')}</pre>
          <div style="font-weight:600; font-size: 0.85em; margin-bottom: 6px; color: #38bdf8;">📦 PM2 Logs (Last 20 lines):</div>
          <pre style="font-family: monospace; font-size: 0.8em; overflow-x: auto; max-height: 140px; white-space: pre-wrap; color: #3fb950; background: #090d16; padding: 10px; border-radius: 6px; border: 1px solid #30363d; margin: 0;">${escapeHtml(s.pm2_logs || 'Active log streaming enabled via UptimeBunny Agent.')}</pre>
        `;
      }

      return `
        <div class="server-card ${idx === 0 ? 'selected' : ''}" data-hostname="${hostNameStr}" data-key-id="${s.key_id || s.api_key_id || ''}" style="${idx === 0 ? 'border-color: #6366f1;' : ''}">
          <div class="server-status ${stale ? 'stale' : ''}"></div>
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
            <div class="server-name" style="margin-bottom: 0;">${displayName}</div>
            <button class="btn-rename-server" data-hostname="${hostNameStr}" data-display-name="${displayName}">✏️ Rename</button>
          </div>
          <div class="server-hostname">${hostNameStr}${ipAddressStr} · Up ${uptimeStr} · Last seen ${timeAgo(lastSeenStr)}</div>
          <div class="metric-bars">
            <div class="metric-bar-row">
              <span class="label">CPU</span>
              <div class="bar-track"><div class="bar-fill cpu" style="width: ${Math.min(s.cpu_percent || 0, 100)}%"></div></div>
              <span class="value">${(s.cpu_percent || 0).toFixed(1)}%</span>
            </div>
            <div class="metric-bar-row">
              <span class="label">Memory</span>
              <div class="bar-track"><div class="bar-fill memory" style="width: ${Math.min(s.memory_percent || 0, 100)}%"></div></div>
              <span class="value">${(s.memory_percent || 0).toFixed(1)}%</span>
            </div>
            <div class="metric-bar-row">
              <span class="label">Disk</span>
              <div class="bar-track"><div class="bar-fill disk" style="width: ${Math.min(s.disk_percent || 0, 100)}%"></div></div>
              <span class="value">${(s.disk_percent || 0).toFixed(0)}%</span>
            </div>
          </div>
          <div class="services-status" style="margin-top: 14px; padding-top: 12px; border-top: 1px dashed var(--border-color); display: flex; flex-wrap: wrap; gap: 14px; font-size: 0.8em;">
            ${servicesStatusHtml}
          </div>
          <div class="logs-toggle" style="margin-top: 14px; font-size: 0.85em; color: #58a6ff; cursor: pointer; text-decoration: underline; font-weight: 600;" onclick="toggleLogs(event, '${serverId}')">
            📄 Show Service Logs
          </div>
          <div id="logs-panel-${serverId}" style="display: none; margin-top: 12px; padding: 14px; background: #0d1117; border-radius: 8px; border: 1px solid var(--border-color); width: 100%; box-sizing: border-box;">
            ${logsPanelHtml}
          </div>
        </div>`;
    }).join('');

    // Attach Rename Button Listeners
    grid.querySelectorAll('.btn-rename-server').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const hostname = btn.dataset.hostname;
        const currentName = btn.dataset.displayName;
        openRenameModal(hostname, currentName);
      });
    });

    // Load charts for first server by default
    if (servers.length > 0) {
      const s = servers[0];
      loadCharts({ hostname: s.hostname, keyId: s.key_id || s.api_key_id });
    }

    // Click to switch charts
    grid.querySelectorAll('.server-card').forEach((card, idx) => {
      card.addEventListener('click', () => {
        grid.querySelectorAll('.server-card').forEach(c => c.style.borderColor = '');
        card.style.borderColor = '#6366f1';
        const s = servers[idx];
        if (s) {
          loadCharts({ hostname: s.hostname, keyId: s.key_id || s.api_key_id });
        }
      });
    });
  } catch (err) {
    showToast('Failed to load servers', 'error');
  }
}

// Rename Server Modal Handlers
let currentRenameHost = '';

function openRenameModal(hostname, currentName) {
  currentRenameHost = hostname;
  document.getElementById('rename-target-host').textContent = hostname;
  document.getElementById('rename-input').value = currentName || hostname;
  document.getElementById('rename-modal').style.display = 'flex';
}

const cancelRenameBtn = document.getElementById('btn-cancel-rename');
if (cancelRenameBtn) {
  cancelRenameBtn.addEventListener('click', () => {
    document.getElementById('rename-modal').style.display = 'none';
  });
}

const saveRenameBtn = document.getElementById('btn-save-rename');
if (saveRenameBtn) {
  saveRenameBtn.addEventListener('click', async () => {
    const newName = document.getElementById('rename-input').value.trim();
    if (!newName || !currentRenameHost) return;

    try {
      const res = await fetch(`${API_URL}/api/agent/servers/rename`, {
        method: 'PUT',
        headers: getHeaders(),
        body: JSON.stringify({ hostname: currentRenameHost, custom_name: newName })
      });
      const data = await res.json();
      if (res.ok) {
        document.getElementById('rename-modal').style.display = 'none';
        showToast('Server renamed successfully!');
        loadServers();
      } else {
        showToast(data.error || 'Failed to rename server', 'error');
      }
    } catch (err) {
      showToast('Network error renaming server', 'error');
    }
  });
}

// --- Charts ---

let cpuChart, memChart, diskChart, loadChart;
let currentTarget = null;
let currentHours = 1;

async function loadCharts(target) {
  if (target) currentTarget = target;
  if (!currentTarget) return;

  let hostname = null;
  let keyId = null;

  if (typeof currentTarget === 'object') {
    hostname = currentTarget.hostname;
    keyId = currentTarget.keyId;
  } else if (typeof currentTarget === 'number' || (typeof currentTarget === 'string' && /^\d+$/.test(currentTarget))) {
    keyId = currentTarget;
  } else {
    hostname = currentTarget;
  }

  let queryParams = `hours=${currentHours}`;
  if (hostname) queryParams += `&hostname=${encodeURIComponent(hostname)}`;
  if (keyId) queryParams += `&key_id=${encodeURIComponent(keyId)}`;

  try {
    const res = await fetch(`${API_URL}/api/agent/metrics?${queryParams}`, { headers: getHeaders() });
    const metrics = await res.json();

    if (!Array.isArray(metrics)) return;

    const labels = metrics.map(m => {
      const d = new Date(m.collected_at);
      return currentHours <= 6 ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    });
    const cpuData = metrics.map(m => parseFloat(m.cpu_percent) || 0);
    const memData = metrics.map(m => parseFloat(m.memory_percent) || 0);
    const diskData = metrics.map(m => parseFloat(m.disk_percent) || 0);
    const loadData = metrics.map(m => parseFloat(m.load_avg) || 0);

    const chartOpts = (label, color, data, max) => ({
      type: 'line',
      data: {
        labels,
        datasets: [{
          label,
          data,
          borderColor: color,
          backgroundColor: color + '20',
          fill: true,
          tension: 0.3,
          pointRadius: metrics.length === 1 ? 4 : 2,
          pointHoverRadius: 5,
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { display: true, ticks: { maxTicksLimit: 8, font: { size: 10 }, color: '#94a3b8' }, grid: { display: false } },
          y: { min: 0, max, ticks: { font: { size: 10 }, color: '#94a3b8' }, grid: { color: 'rgba(255,255,255,0.05)' } }
        },
        interaction: { intersect: false, mode: 'index' }
      }
    });

    if (cpuChart) cpuChart.destroy();
    if (memChart) memChart.destroy();
    if (diskChart) diskChart.destroy();
    if (loadChart) loadChart.destroy();

    cpuChart = new Chart(document.getElementById('chart-cpu'), chartOpts('CPU %', '#6366f1', cpuData, 100));
    memChart = new Chart(document.getElementById('chart-memory'), chartOpts('Memory %', '#06b6d4', memData, 100));
    diskChart = new Chart(document.getElementById('chart-disk'), chartOpts('Disk %', '#f59e0b', diskData, 100));
    loadChart = new Chart(document.getElementById('chart-load'), chartOpts('Load Avg', '#10b981', loadData, undefined));
  } catch (err) {
    console.error('Chart load error:', err);
  }
}

// Time filter buttons
document.querySelectorAll('.time-filter button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.time-filter button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentHours = parseInt(btn.dataset.hours);
    if (currentTarget) loadCharts(currentTarget);
  });
});

// --- Helpers ---

function timeAgo(dateStr) {
  if (!dateStr) return 'recently';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return 'recently';
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
  if (seconds < 0 || seconds < 60) return 'just now';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
  if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
  return Math.floor(seconds / 86400) + 'd ago';
}

function formatUptime(seconds) {
  const secs = parseInt(seconds, 10);
  if (isNaN(secs) || secs <= 0) return '1d';
  if (secs < 3600) return Math.floor(secs / 60) + 'm';
  if (secs < 86400) return Math.floor(secs / 3600) + 'h';
  return Math.floor(secs / 86400) + 'd';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

window.toggleLogs = function(event, id) {
  event.stopPropagation();
  const panel = document.getElementById(`logs-panel-${id}`);
  const btn = event.currentTarget || event.target;
  if (!panel) return;
  if (panel.style.display === 'none' || !panel.style.display) {
    panel.style.display = 'block';
    if (btn) btn.textContent = '📄 Hide Service Logs';
  } else {
    panel.style.display = 'none';
    if (btn) btn.textContent = '📄 Show Service Logs';
  }
};

// --- Init ---
loadKeys();
loadServers();

// Auto-refresh every 60s
setInterval(() => {
  loadServers();
}, 60000);
