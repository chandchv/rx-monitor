const API_URL = ''; // Same origin

// DOM Elements
const monitorsList = document.getElementById('monitors-list');
const btnRefresh = document.getElementById('btn-refresh');
const btnAddMonitor = document.getElementById('btn-add-monitor');
const btnSettings = document.getElementById('btn-settings');
const toastEl = document.getElementById('toast');

// Modal Elements
const modalMonitor = document.getElementById('modal-monitor');
const modalSettings = document.getElementById('modal-settings');
const modalDetail = document.getElementById('modal-detail');

// Monitor Form Elements
const monitorForm = document.getElementById('monitor-form');
const monitorModalTitle = document.getElementById('monitor-modal-title');
const monitorIdInput = document.getElementById('monitor-id');
const monitorNameInput = document.getElementById('monitor-name');
const monitorUrlInput = document.getElementById('monitor-url');
const monitorMethodInput = document.getElementById('monitor-method');
const monitorIntervalInput = document.getElementById('monitor-interval');
const monitorTimeoutInput = document.getElementById('monitor-timeout');
const monitorMaxRetriesInput = document.getElementById('monitor-max-retries');
const monitorIsPublicInput = document.getElementById('monitor-is-public');
const monitorIsMaintenanceInput = document.getElementById('monitor-is-maintenance');

// Settings Elements
const settingsForm = document.getElementById('settings-form');
const tabButtons = document.querySelectorAll('.tab-btn');
const tabPanes = document.querySelectorAll('.tab-pane');
const btnTestTelegram = document.getElementById('btn-test-telegram');
const btnTestEmail = document.getElementById('btn-test-email');

// Detail Modal Elements
const detailTitle = document.getElementById('detail-title');
const detailUrl = document.getElementById('detail-url');
const detailMethod = document.getElementById('detail-method');
const detailInterval = document.getElementById('detail-interval');
const detailUptime = document.getElementById('detail-uptime');
const detailLogsTbody = document.getElementById('detail-logs-tbody');

const detailAvgLatency = document.getElementById('detail-avg-latency');
const detailFastestLatency = document.getElementById('detail-fastest-latency');
const detailSlowestLatency = document.getElementById('detail-slowest-latency');
const detailP95Latency = document.getElementById('detail-p95-latency');
const detailSslExpiry = document.getElementById('detail-ssl-expiry');
const detailTimelineList = document.getElementById('detail-timeline-list');

// Chart Instances
let latencyChartInstance = null;
let uptimeChartInstance = null;

// Initialize immediately since the script runs at the bottom of the body
function init() {
  fetchMonitors();
  // Set up auto-refresh every 20 seconds
  setInterval(fetchMonitors, 20000);
  setupEventListeners();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Toast Helper
function showToast(message, type = 'success') {
  toastEl.textContent = message;
  toastEl.className = `toast show toast-${type}`;
  setTimeout(() => {
    toastEl.classList.remove('show');
  }, 4000);
}

// Modal Helper Functions
function openModal(modal) {
  modal.classList.add('active');
}

function closeModal(modal) {
  modal.classList.remove('active');
}

// Tab Switching Helper
function switchTab(targetId) {
  tabButtons.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === targetId);
  });
  tabPanes.forEach(pane => {
    pane.classList.toggle('active', pane.id === targetId);
  });
}

function setupEventListeners() {
  // Modal close buttons
  document.querySelectorAll('.close-modal').forEach(btn => {
    btn.addEventListener('click', (e) => {
      closeModal(e.target.closest('.modal'));
    });
  });

  // Close modal when clicking background
  window.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal')) {
      closeModal(e.target);
    }
  });

  // Action Buttons
  btnRefresh.addEventListener('click', fetchMonitors);
  
  btnAddMonitor.addEventListener('click', () => {
    monitorForm.reset();
    monitorIdInput.value = '';
    monitorModalTitle.textContent = 'Add New Monitor';
    openModal(modalMonitor);
  });

  btnSettings.addEventListener('click', openSettingsModal);

  // Form Submissions
  monitorForm.addEventListener('submit', handleMonitorSubmit);
  settingsForm.addEventListener('submit', handleSettingsSubmit);

  // Settings Tabs
  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      switchTab(btn.dataset.tab);
    });
  });

  // Test notification actions
  btnTestTelegram.addEventListener('click', async () => {
    const token = document.getElementById('telegram_bot_token').value;
    const chatId = document.getElementById('telegram_chat_id').value;

    if (!token || !chatId) {
      showToast('Token and Chat ID are required for test.', 'error');
      return;
    }

    btnTestTelegram.disabled = true;
    btnTestTelegram.textContent = 'Sending...';

    try {
      const res = await fetch('/api/settings/test-telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, chatId })
      });
      const data = await res.json();
      if (res.ok) {
        showToast('Telegram test message sent successfully!');
      } else {
        showToast(`Failed: ${data.error}`, 'error');
      }
    } catch (err) {
      showToast(`Error: ${err.message}`, 'error');
    } finally {
      btnTestTelegram.disabled = false;
      btnTestTelegram.textContent = 'Send Test Telegram Notification';
    }
  });

  btnTestEmail.addEventListener('click', async () => {
    const host = document.getElementById('email_smtp_host').value;
    const port = document.getElementById('email_smtp_port').value;
    const user = document.getElementById('email_smtp_user').value;
    const pass = document.getElementById('email_smtp_pass').value;
    const sender = document.getElementById('email_sender').value;
    const recipient = document.getElementById('email_recipient').value;

    if (!host || !user || !pass || !recipient) {
      showToast('Host, User, Pass, and Recipient are required.', 'error');
      return;
    }

    btnTestEmail.disabled = true;
    btnTestEmail.textContent = 'Sending...';

    try {
      const res = await fetch('/api/settings/test-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host, port, user, pass, sender, recipient })
      });
      const data = await res.json();
      if (res.ok) {
        showToast('Test email sent successfully!');
      } else {
        showToast(`Failed: ${data.error}`, 'error');
      }
    } catch (err) {
      showToast(`Error: ${err.message}`, 'error');
    } finally {
      btnTestEmail.disabled = false;
      btnTestEmail.textContent = 'Send Test Email Alert';
    }
  });
}

// Fetch and Render Monitors
async function fetchMonitors() {
  try {
    const response = await fetch('/api/monitors');
    if (!response.ok) throw new Error('Failed to load monitors');
    
    const monitors = await response.json();
    renderMonitors(monitors);
    updateStats(monitors);
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function updateStats(monitors) {
  const total = monitors.length;
  const up = monitors.filter(m => m.status === 'UP').length;
  const down = monitors.filter(m => m.status === 'DOWN').length;

  document.getElementById('stat-total').textContent = total;
  document.getElementById('stat-up').textContent = up;
  document.getElementById('stat-down').textContent = down;
}

function renderMonitors(monitors) {
  if (monitors.length === 0) {
    monitorsList.innerHTML = `
      <div class="empty-state">
        <p>No monitors found. Click "Add Monitor" to get started!</p>
      </div>
    `;
    return;
  }

  monitorsList.innerHTML = monitors.map(monitor => {
    // Generate Uptime History Bars (last 30 ticks)
    const ticksCount = 30;
    const ticks = [];
    const recent = monitor.recentLogs || [];
    
    // Fill background empty ticks
    const emptyCount = Math.max(0, ticksCount - recent.length);
    for (let i = 0; i < emptyCount; i++) {
      ticks.push('<div class="history-tick tick-empty" title="No data"></div>');
    }
    
    // Fill actual status ticks
    recent.forEach(log => {
      const timeStr = new Date(log.checked_at).toLocaleTimeString();
      const tooltip = `[${timeStr}] Status: ${log.status} | Response: ${log.response_time}ms`;
      if (log.status === 'UP') {
        ticks.push(`<div class="history-tick tick-up" title="${tooltip}"></div>`);
      } else if (log.status === 'PENDING') {
        ticks.push(`<div class="history-tick tick-empty" style="background-color: var(--color-warning);" title="${tooltip}"></div>`);
      } else {
        ticks.push(`<div class="history-tick tick-down" title="${tooltip}"></div>`);
      }
    });

    const statusLower = monitor.status.toLowerCase();
    const isActive = monitor.active === 1;

    // Render badge overlays
    const publicBadge = monitor.is_public === 1 ? `<span class="badge" style="background: rgba(99,102,241,0.15); color: #818cf8; border-color: rgba(99,102,241,0.2); margin-left: 6px;">Public</span>` : '';
    const maintenanceBadge = monitor.is_maintenance === 1 ? `<span class="badge" style="background: rgba(245,158,11,0.15); color: #fbbf24; border-color: rgba(245,158,11,0.2); margin-left: 6px;">Maintenance</span>` : '';

    return `
      <div class="monitor-item" data-id="${monitor.id}">
        <div class="status-dot-container">
          <div class="status-pulse ${statusLower}"></div>
          <div class="status-dot ${statusLower}"></div>
        </div>
        <div class="monitor-info">
          <h4 style="display: flex; align-items: center;">${escapeHTML(monitor.name)} ${publicBadge} ${maintenanceBadge}</h4>
          <span class="url">${escapeHTML(monitor.url)}</span>
        </div>
        <div class="monitor-perf">
          <div class="resp-time">${recent.length ? recent[recent.length - 1].response_time + ' ms' : '-- ms'}</div>
          <div class="uptime-pct">${monitor.uptimePct}% uptime</div>
        </div>
        <div class="uptime-history">
          ${ticks.join('')}
        </div>
        <div class="item-actions">
          <button class="btn btn-icon" onclick="checkMonitor(${monitor.id}, event)" title="Check Status Now">⚡</button>
          <button class="btn btn-icon" onclick="viewMonitorDetail(${monitor.id}, event)" title="View Details">👁️</button>
          <button class="btn btn-icon" onclick="editMonitor(${JSON.stringify(monitor).replace(/"/g, '&quot;')}, event)" title="Edit">✏️</button>
          <button class="btn btn-icon" onclick="toggleMonitor(${monitor.id}, ${monitor.active}, event)" title="${isActive ? 'Pause' : 'Resume'}">
            ${isActive ? '⏸️' : '▶️'}
          </button>
          <button class="btn btn-icon" onclick="deleteMonitor(${monitor.id}, event)" title="Delete">🗑️</button>
        </div>
      </div>
    `;
  }).join('');
}

// Handle Add/Edit Form
async function handleMonitorSubmit(e) {
  e.preventDefault();
  const id = monitorIdInput.value;
  const payload = {
    name: monitorNameInput.value,
    url: monitorUrlInput.value,
    method: monitorMethodInput.value,
    interval: parseInt(monitorIntervalInput.value),
    timeout: parseInt(monitorTimeoutInput.value),
    max_retries: parseInt(monitorMaxRetriesInput.value),
    is_public: monitorIsPublicInput.checked ? 1 : 0,
    is_maintenance: monitorIsMaintenanceInput.checked ? 1 : 0
  };

  try {
    let response;
    if (id) {
      response = await fetch(`/api/monitors/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } else {
      response = await fetch('/api/monitors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }

    if (!response.ok) throw new Error('Save monitor failed.');
    
    closeModal(modalMonitor);
    showToast(id ? 'Monitor updated successfully.' : 'New monitor added.');
    fetchMonitors();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

// Action Functions
window.checkMonitor = async function(id, event) {
  if (event) event.stopPropagation();
  const item = document.querySelector(`.monitor-item[data-id="${id}"]`);
  if (item) item.style.opacity = '0.6';
  
  try {
    const res = await fetch(`/api/monitors/${id}/check`, { method: 'POST' });
    if (!res.ok) throw new Error('Force check failed.');
    showToast('Check completed.');
    fetchMonitors();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    if (item) item.style.opacity = '1';
  }
};

window.viewMonitorDetail = async function(id, event) {
  if (event) event.stopPropagation();
  openModal(modalDetail);

  detailTitle.textContent = 'Loading...';
  detailUrl.textContent = '';
  detailMethod.textContent = '';
  detailInterval.textContent = '';
  detailUptime.textContent = '';
  
  detailAvgLatency.textContent = '-';
  detailFastestLatency.textContent = '-';
  detailSlowestLatency.textContent = '-';
  detailP95Latency.textContent = '-';
  detailSslExpiry.textContent = '-';
  detailTimelineList.innerHTML = `<div style="text-align: center; color: var(--color-muted); font-size: 13px;">Loading timeline...</div>`;
  detailLogsTbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--color-muted);">Loading logs...</td></tr>`;

  try {
    const res = await fetch(`/api/monitors/${id}`);
    if (!res.ok) throw new Error('Failed to load monitor details');
    const data = await res.json();

    detailTitle.textContent = data.name;
    detailUrl.textContent = data.url;
    detailMethod.textContent = data.method;
    detailInterval.textContent = `${data.interval}s (timeout: ${data.timeout}s)`;
    detailUptime.textContent = `${data.uptimePct}%`;

    // Latency Metrics calculations
    const logs = data.logs || [];
    const validLatencies = logs.filter(l => l.status === 'UP').map(l => l.response_time);
    
    if (validLatencies.length > 0) {
      const avg = Math.round(validLatencies.reduce((a, b) => a + b, 0) / validLatencies.length);
      const min = Math.min(...validLatencies);
      const max = Math.max(...validLatencies);

      // 95th Percentile
      const sorted = [...validLatencies].sort((a, b) => a - b);
      const p95Idx = Math.floor(sorted.length * 0.95);
      const p95 = sorted[p95Idx];

      detailAvgLatency.textContent = `${avg} ms`;
      detailFastestLatency.textContent = `${min} ms`;
      detailSlowestLatency.textContent = `${max} ms`;
      detailP95Latency.textContent = `${p95} ms`;
    }

    // SSL expiry
    if (data.ssl_expiry) {
      const expiryDate = new Date(data.ssl_expiry);
      const daysLeft = Math.ceil((expiryDate - new Date()) / (1000 * 60 * 60 * 24));
      detailSslExpiry.innerHTML = `${expiryDate.toLocaleDateString()} <span style="font-size: 11px; color: ${daysLeft <= 15 ? 'var(--color-error)' : 'var(--color-muted)'}">(${daysLeft}d left)</span>`;
    } else {
      detailSslExpiry.textContent = 'N/A';
    }

    // Render Charts
    renderCharts(logs, data.uptimePct);

    // Render Incidents
    const incidents = data.incidents || [];
    if (incidents.length === 0) {
      detailTimelineList.innerHTML = `<div style="text-align: center; color: var(--color-muted); font-size: 12px; padding: 10px;">No incidents logged.</div>`;
    } else {
      detailTimelineList.innerHTML = incidents.map(inc => {
        const timeStr = new Date(inc.timestamp).toLocaleString();
        const icon = inc.event_type === 'DOWN' ? '🔴' : '🟢';
        const durationStr = inc.event_type === 'UP' && inc.downtime_duration > 0
          ? `<span style="font-size:11px; color: var(--color-muted); margin-left: 10px;">Downtime: ${Math.floor(inc.downtime_duration/60)}m ${inc.downtime_duration%60}s</span>`
          : '';
        return `
          <div style="font-size: 13px; display: flex; align-items: flex-start; gap: 8px; border-bottom: 1px solid rgba(255,255,255,0.03); padding-bottom: 6px;">
            <span>${icon}</span>
            <div style="flex: 1;">
              <strong>${inc.event_type}</strong> - ${escapeHTML(inc.message || '')}
              ${durationStr}
              <div style="font-size: 10px; color: var(--color-muted);">${timeStr}</div>
            </div>
          </div>
        `;
      }).join('');
    }

    // Render Logs Table
    if (logs.length === 0) {
      detailLogsTbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--color-muted);">No check logs recorded yet.</td></tr>`;
    } else {
      detailLogsTbody.innerHTML = logs.map(log => {
        const timeStr = new Date(log.checked_at).toLocaleString();
        const statusSpan = log.status === 'UP' 
          ? `<span class="badge" style="background: var(--color-success-bg); color: var(--color-success); border-color: rgba(16, 185, 129, 0.2);">UP</span>`
          : log.status === 'PENDING'
          ? `<span class="badge" style="background: var(--color-warning-bg); color: var(--color-warning); border-color: rgba(245, 158, 11, 0.2);">RETRY</span>`
          : `<span class="badge" style="background: var(--color-error-bg); color: var(--color-error); border-color: rgba(239, 68, 68, 0.2);">DOWN</span>`;
        return `
          <tr>
            <td>${timeStr}</td>
            <td>${statusSpan}</td>
            <td>${log.response_time} ms</td>
            <td><code>${escapeHTML(log.message || '')}</code></td>
          </tr>
        `;
      }).join('');
    }
  } catch (err) {
    detailLogsTbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--color-error);">${err.message}</td></tr>`;
  }
};

function renderCharts(logs, uptimePct) {
  if (latencyChartInstance) latencyChartInstance.destroy();
  if (uptimeChartInstance) uptimeChartInstance.destroy();

  const ctxLatency = document.getElementById('latencyChart').getContext('2d');
  const ctxUptime = document.getElementById('uptimeChart').getContext('2d');

  // Limit line chart to last 30 logs for readability
  const recentLogs = [...logs].reverse().slice(-30);
  const labels = recentLogs.map(log => new Date(log.checked_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  const latencies = recentLogs.map(log => log.response_time);
  const borderColors = recentLogs.map(log => log.status === 'UP' ? '#6366f1' : '#ef4444');

  latencyChartInstance = new Chart(ctxLatency, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: 'Latency (ms)',
        data: latencies,
        borderColor: '#6366f1',
        backgroundColor: 'rgba(99, 102, 241, 0.1)',
        borderWidth: 2,
        tension: 0.3,
        fill: true,
        pointBackgroundColor: borderColors,
        pointBorderColor: borderColors,
        pointRadius: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { display: false },
        y: {
          grid: { color: 'rgba(255, 255, 255, 0.05)' },
          ticks: { color: '#94a3b8', font: { family: 'Outfit', size: 10 } }
        }
      }
    }
  });

  uptimeChartInstance = new Chart(ctxUptime, {
    type: 'doughnut',
    data: {
      labels: ['Uptime %', 'Downtime %'],
      datasets: [{
        data: [uptimePct, Math.max(0, 100 - uptimePct)],
        backgroundColor: ['#10b981', '#ef4444'],
        borderWidth: 0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'bottom',
          labels: { color: '#e2e8f0', font: { family: 'Outfit', size: 11 } }
        }
      },
      cutout: '70%'
    }
  });
}

window.editMonitor = function(monitor, event) {
  if (event) event.stopPropagation();
  monitorIdInput.value = monitor.id;
  monitorNameInput.value = monitor.name;
  monitorUrlInput.value = monitor.url;
  monitorMethodInput.value = monitor.method;
  monitorIntervalInput.value = monitor.interval;
  monitorTimeoutInput.value = monitor.timeout;
  monitorMaxRetriesInput.value = monitor.max_retries || 3;
  monitorIsPublicInput.checked = monitor.is_public === 1;
  monitorIsMaintenanceInput.checked = monitor.is_maintenance === 1;
  
  monitorModalTitle.textContent = 'Edit Monitor';
  openModal(modalMonitor);
};

window.toggleMonitor = async function(id, currentActive, event) {
  if (event) event.stopPropagation();
  try {
    const res = await fetch(`/api/monitors/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: currentActive === 1 ? 0 : 1 })
    });
    if (!res.ok) throw new Error('Toggle status failed.');
    showToast(currentActive === 1 ? 'Monitor paused.' : 'Monitor active.');
    fetchMonitors();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window.deleteMonitor = async function(id, event) {
  if (event) event.stopPropagation();
  if (!confirm('Are you sure you want to delete this monitor? All historical logs will be deleted.')) return;

  try {
    const res = await fetch(`/api/monitors/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to delete monitor.');
    showToast('Monitor deleted.');
    fetchMonitors();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

// Settings Action
async function openSettingsModal() {
  openModal(modalSettings);
  switchTab('tab-telegram');

  try {
    const res = await fetch('/api/settings');
    const settings = await res.json();
    
    document.getElementById('telegram_enabled').checked = settings.telegram_enabled === 'true';
    document.getElementById('telegram_bot_token').value = settings.telegram_bot_token || '';
    document.getElementById('telegram_chat_id').value = settings.telegram_chat_id || '';
    
    document.getElementById('email_enabled').checked = settings.email_enabled === 'true';
    document.getElementById('email_smtp_host').value = settings.email_smtp_host || '';
    document.getElementById('email_smtp_port').value = settings.email_smtp_port || '';
    document.getElementById('email_smtp_user').value = settings.email_smtp_user || '';
    document.getElementById('email_smtp_pass').value = settings.email_smtp_pass || '';
    document.getElementById('email_sender').value = settings.email_sender || '';
    document.getElementById('email_recipient').value = settings.email_recipient || '';

    document.getElementById('custom_domain').value = settings.custom_domain || '';
    document.getElementById('daily_report_enabled').checked = settings.daily_report_enabled === 'true';
    document.getElementById('daily_report_time').value = settings.daily_report_time || '09:00';
  } catch (err) {
    showToast('Failed to load settings.', 'error');
  }
}

async function handleSettingsSubmit(e) {
  e.preventDefault();

  const payload = {
    telegram_enabled: document.getElementById('telegram_enabled').checked,
    telegram_bot_token: document.getElementById('telegram_bot_token').value.trim(),
    telegram_chat_id: document.getElementById('telegram_chat_id').value.trim(),
    
    email_enabled: document.getElementById('email_enabled').checked,
    email_smtp_host: document.getElementById('email_smtp_host').value.trim(),
    email_smtp_port: document.getElementById('email_smtp_port').value.trim(),
    email_smtp_user: document.getElementById('email_smtp_user').value.trim(),
    email_smtp_pass: document.getElementById('email_smtp_pass').value,
    email_sender: document.getElementById('email_sender').value.trim(),
    email_recipient: document.getElementById('email_recipient').value.trim(),

    custom_domain: document.getElementById('custom_domain').value.trim(),
    daily_report_enabled: document.getElementById('daily_report_enabled').checked,
    daily_report_time: document.getElementById('daily_report_time').value
  };

  try {
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error('Save settings failed.');
    closeModal(modalSettings);
    showToast('Settings saved successfully.');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// Helpers
function escapeHTML(str) {
  return str.replace(/[&<>'"]/g, 
    tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag)
  );
}
