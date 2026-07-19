// RxMonitor - Server Metrics Dashboard
const API_URL = '';
const token = localStorage.getItem('rx-monitor-token');

// Auth check disabled for testing
// if (!token) {
//   window.location.href = '/';
// }

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
document.getElementById('install-url').textContent = baseUrl;
document.getElementById('install-cmd').querySelector('pre') || 
  (document.getElementById('install-cmd').textContent = `curl -sSL ${baseUrl}/install-agent.sh | bash -s YOUR_API_KEY`);

// --- API Keys ---

async function loadKeys() {
  try {
    const res = await fetch(`${API_URL}/api/keys`, { headers: getHeaders() });
    if (res.status === 401) { /* redirect disabled for testing */ return; }
    const keys = await res.json();
    const container = document.getElementById('keys-list');
    
    if (keys.length === 0) {
      container.innerHTML = '<p style="color: var(--color-muted); font-size: 0.9em;">No API keys yet. Generate one to start monitoring servers.</p>';
      return;
    }

    container.innerHTML = keys.map(k => `
      <div class="key-row">
        <div class="key-info">
          <span class="key-prefix">${k.key_prefix}••••••••</span>
          <span class="key-label">${k.label} · Created ${new Date(k.created_at).toLocaleDateString()}${k.last_used_at ? ' · Last used ' + timeAgo(k.last_used_at) : ''}</span>
        </div>
        <div class="key-actions">
          <button class="btn btn-danger" style="padding: 5px 10px; font-size: 0.75em;" onclick="deleteKey(${k.id})">Revoke</button>
        </div>
      </div>
    `).join('');
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
    if (res.status === 401) { /* redirect disabled for testing */ return; }
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

    grid.innerHTML = servers.map(s => {
      const lastSeen = new Date(s.collected_at);
      const ageMinutes = (Date.now() - lastSeen.getTime()) / 60000;
      const stale = ageMinutes > 5;
      const uptimeStr = formatUptime(s.uptime_seconds);

      return `
        <div class="server-card" data-key-id="${s.key_id}">
          <div class="server-status ${stale ? 'stale' : ''}"></div>
          <div class="server-name">${escapeHtml(s.label)}</div>
          <div class="server-hostname">${escapeHtml(s.hostname)} · Up ${uptimeStr} · Last seen ${timeAgo(s.collected_at)}</div>
          <div class="metric-bars">
            <div class="metric-bar-row">
              <span class="label">CPU</span>
              <div class="bar-track"><div class="bar-fill cpu" style="width: ${Math.min(s.cpu_percent, 100)}%"></div></div>
              <span class="value">${s.cpu_percent.toFixed(1)}%</span>
            </div>
            <div class="metric-bar-row">
              <span class="label">Memory</span>
              <div class="bar-track"><div class="bar-fill memory" style="width: ${Math.min(s.memory_percent, 100)}%"></div></div>
              <span class="value">${s.memory_percent.toFixed(1)}%</span>
            </div>
            <div class="metric-bar-row">
              <span class="label">Disk</span>
              <div class="bar-track"><div class="bar-fill disk" style="width: ${Math.min(s.disk_percent, 100)}%"></div></div>
              <span class="value">${s.disk_percent.toFixed(0)}%</span>
            </div>
          </div>
        </div>`;
    }).join('');

    // Load charts for first server by default
    loadCharts(servers[0].key_id);

    // Click to switch charts
    grid.querySelectorAll('.server-card').forEach(card => {
      card.addEventListener('click', () => {
        grid.querySelectorAll('.server-card').forEach(c => c.style.borderColor = '');
        card.style.borderColor = '#6366f1';
        loadCharts(card.dataset.keyId);
      });
    });
  } catch (err) {
    showToast('Failed to load servers', 'error');
  }
}

// --- Charts ---

let cpuChart, memChart, diskChart, loadChart;
let currentKeyId = null;
let currentHours = 1;

async function loadCharts(keyId) {
  currentKeyId = keyId;
  try {
    const res = await fetch(`${API_URL}/api/agent/metrics?key_id=${keyId}&hours=${currentHours}`, { headers: getHeaders() });
    const metrics = await res.json();

    if (metrics.length === 0) return;

    const labels = metrics.map(m => {
      const d = new Date(m.collected_at);
      return currentHours <= 6 ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    });
    const cpuData = metrics.map(m => m.cpu_percent);
    const memData = metrics.map(m => m.memory_percent);
    const diskData = metrics.map(m => m.disk_percent);
    const loadData = metrics.map(m => m.load_avg);

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
          pointRadius: 0,
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
    if (currentKeyId) loadCharts(currentKeyId);
  });
});

// --- Helpers ---

function timeAgo(dateStr) {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
  if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
  return Math.floor(seconds / 86400) + 'd ago';
}

function formatUptime(seconds) {
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm';
  if (seconds < 86400) return Math.floor(seconds / 3600) + 'h';
  return Math.floor(seconds / 86400) + 'd';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

// --- Init ---
loadKeys();
loadServers();

// Auto-refresh every 60s
setInterval(() => {
  loadServers();
}, 60000);
