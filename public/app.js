const API_URL = ''; // Same origin

// Visitor ID generation
let visitorId = localStorage.getItem('rx-monitor-visitor-id');
if (!visitorId) {
  visitorId = 'visitor_' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  localStorage.setItem('rx-monitor-visitor-id', visitorId);
}

// API Fetch Helper
async function apiFetch(url, options = {}) {
  const token = localStorage.getItem('rx-monitor-token');
  options.headers = options.headers || {};
  options.headers['Content-Type'] = 'application/json';
  options.headers['x-visitor-id'] = visitorId;
  
  if (token) {
    options.headers['Authorization'] = `Bearer ${token}`;
  }
  
  const response = await fetch(url, options);
  if (response.status === 401) {
    localStorage.removeItem('rx-monitor-token');
    localStorage.removeItem('rx-monitor-user');
    updateAuthUI();
  }
  return response;
}

// DOM Elements
const monitorsList = document.getElementById('monitors-list');
const btnRefresh = document.getElementById('btn-refresh');
const btnAddMonitor = document.getElementById('btn-add-monitor');
const btnSettings = document.getElementById('btn-settings');
const toastEl = document.getElementById('toast');

// Auth DOM Elements
const btnLoginTrigger = document.getElementById('btn-login-trigger');
const btnLogout = document.getElementById('btn-logout');
const btnUpgrade = document.getElementById('btn-upgrade');
const userMenu = document.getElementById('user-menu');
const userAvatarBtn = document.getElementById('user-avatar-btn');
const userDropdown = document.getElementById('user-dropdown');
const userGreeting = document.getElementById('user-greeting');
const dropdownEmail = document.getElementById('dropdown-email');
const dropdownTier = document.getElementById('dropdown-tier');
const dropdownAdmin = document.getElementById('dropdown-admin');
const navAdmin = document.getElementById('nav-admin');
const modalAuth = document.getElementById('modal-auth');
const signinForm = document.getElementById('signin-form');
const signupForm = document.getElementById('signup-form');
const authTabBtns = document.querySelectorAll('[data-auth-tab]');
const authTabPanes = document.querySelectorAll('.auth-tab-pane');

// Dropdown toggle
if (userAvatarBtn) {
  userAvatarBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = userDropdown.classList.contains('open');
    userDropdown.classList.toggle('open', !isOpen);
    userAvatarBtn.setAttribute('aria-expanded', String(!isOpen));
  });
  document.addEventListener('click', () => {
    userDropdown.classList.remove('open');
    userAvatarBtn.setAttribute('aria-expanded', 'false');
  });
}

// Mobile Drawer Elements
const btnHamburger   = document.getElementById('btn-hamburger');
const mobileDrawer   = document.getElementById('mobile-drawer');
const mobileOverlay  = document.getElementById('mobile-overlay');
const btnDrawerClose = document.getElementById('btn-drawer-close');
const drawerUserStrip  = document.getElementById('drawer-user-strip');
const drawerUsername   = document.getElementById('drawer-username');
const drawerUsertier   = document.getElementById('drawer-usertier');
const drawerAdminLink  = document.getElementById('drawer-admin-link');
const drawerBtnAdd     = document.getElementById('drawer-btn-add');
const drawerBtnUpgrade = document.getElementById('drawer-btn-upgrade');
const drawerBtnSettings= document.getElementById('drawer-btn-settings');
const drawerBtnLogin   = document.getElementById('drawer-btn-login');
const drawerBtnLogout  = document.getElementById('drawer-btn-logout');

function openDrawer() {
  mobileDrawer.classList.add('is-open');
  mobileDrawer.setAttribute('aria-hidden', 'false');
  mobileOverlay.classList.add('active');
  btnHamburger.classList.add('is-open');
  btnHamburger.setAttribute('aria-expanded', 'true');
  document.body.style.overflow = 'hidden';
}

function closeDrawer() {
  mobileDrawer.classList.remove('is-open');
  mobileDrawer.setAttribute('aria-hidden', 'true');
  mobileOverlay.classList.remove('active');
  btnHamburger.classList.remove('is-open');
  btnHamburger.setAttribute('aria-expanded', 'false');
  document.body.style.overflow = '';
}

if (btnHamburger)   btnHamburger.addEventListener('click', openDrawer);
if (btnDrawerClose) btnDrawerClose.addEventListener('click', closeDrawer);
if (mobileOverlay)  mobileOverlay.addEventListener('click', closeDrawer);

// Proxy drawer buttons to main actions
if (drawerBtnAdd) {
  drawerBtnAdd.addEventListener('click', () => {
    closeDrawer();
    document.getElementById('btn-add-monitor').click();
  });
}
if (drawerBtnSettings) {
  drawerBtnSettings.addEventListener('click', () => {
    closeDrawer();
    document.getElementById('btn-settings').click();
  });
}
if (drawerBtnLogin) {
  drawerBtnLogin.addEventListener('click', () => {
    closeDrawer();
    openModal(modalAuth);
  });
}
if (drawerBtnLogout) {
  drawerBtnLogout.addEventListener('click', () => {
    closeDrawer();
    localStorage.removeItem('rx-monitor-token');
    localStorage.removeItem('rx-monitor-user');
    showToast('Logged out successfully.');
    updateAuthUI();
    fetchMonitors();
  });
}
if (drawerBtnUpgrade) {
  drawerBtnUpgrade.addEventListener('click', () => {
    closeDrawer();
    startRazorpayUpgrade();
  });
}


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

// Cache of fetched monitor objects keyed by id (used for safe edit lookups)
const monitorsCache = new Map();

// Initialize immediately since the script runs at the bottom of the body
function init() {
  updateAuthUI();
  initGoogleSignIn();
  fetchMonitors();
  // Set up auto-refresh every 20 seconds
  setInterval(fetchMonitors, 20000);
  setupEventListeners();
}

function updateAuthUI() {
  const token = localStorage.getItem('rx-monitor-token');
  const userStr = localStorage.getItem('rx-monitor-user');
  
  if (token && userStr) {
    try {
      const user = JSON.parse(userStr);
      const isPremium = user.subscription_tier === 'premium' || user.tier === 'premium';
      const isAdmin = user.role === 'admin';
      const displayName = user.email.split('@')[0];

      // ---- Desktop header ----
      userMenu.style.display = 'block';
      btnLoginTrigger.style.display = 'none';
      userGreeting.textContent = displayName;

      if (dropdownEmail) dropdownEmail.textContent = user.email;
      if (dropdownTier) {
        dropdownTier.textContent = isPremium ? '⭐ Premium' : 'Free Plan';
        dropdownTier.className = 'dropdown-tier-badge' + (isPremium ? '' : ' free');
      }
      if (dropdownAdmin) dropdownAdmin.style.display = isAdmin ? 'flex' : 'none';
      if (navAdmin) navAdmin.style.display = isAdmin ? 'inline-flex' : 'none';
      if (btnUpgrade) btnUpgrade.style.display = isPremium ? 'none' : 'inline-flex';

      // ---- Mobile drawer ----
      if (drawerUserStrip) drawerUserStrip.style.display = 'flex';
      if (drawerUsername)  drawerUsername.textContent = user.email;
      if (drawerUsertier)  drawerUsertier.textContent = isPremium ? '⭐ Premium' : 'Free Plan';
      if (drawerAdminLink) drawerAdminLink.style.display = isAdmin ? 'flex' : 'none';
      if (drawerBtnUpgrade) drawerBtnUpgrade.style.display = isPremium ? 'none' : 'flex';
      if (drawerBtnLogin)  drawerBtnLogin.style.display  = 'none';
      if (drawerBtnLogout) drawerBtnLogout.style.display = 'flex';

    } catch (e) {
      localStorage.removeItem('rx-monitor-token');
      localStorage.removeItem('rx-monitor-user');
      updateAuthUI();
    }
  } else {
    // ---- Guest — desktop ----
    if (userMenu) userMenu.style.display = 'none';
    btnLoginTrigger.style.display = 'inline-flex';
    if (btnUpgrade) btnUpgrade.style.display = 'none';
    if (navAdmin) navAdmin.style.display = 'none';

    // ---- Guest — drawer ----
    if (drawerUserStrip)  drawerUserStrip.style.display  = 'none';
    if (drawerAdminLink)  drawerAdminLink.style.display  = 'none';
    if (drawerBtnUpgrade) drawerBtnUpgrade.style.display = 'none';
    if (drawerBtnLogin)   drawerBtnLogin.style.display   = 'flex';
    if (drawerBtnLogout)  drawerBtnLogout.style.display  = 'none';
  }
}



function initGoogleSignIn() {
  if (typeof google === 'undefined') {
    setTimeout(initGoogleSignIn, 500);
    return;
  }
  google.accounts.id.initialize({
    client_id: "mock-client-id-12345.apps.googleusercontent.com",
    callback: handleGoogleCredentialResponse
  });
  google.accounts.id.renderButton(
    document.getElementById("google-signin-btn"),
    { theme: "outline", size: "large", width: 250 }
  );
}

async function handleGoogleCredentialResponse(response) {
  try {
    const res = await fetch('/api/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: response.credential })
    });
    const data = await res.json();
    if (res.ok) {
      localStorage.setItem('rx-monitor-token', data.token);
      localStorage.setItem('rx-monitor-user', JSON.stringify(data.user));
      closeModal(modalAuth);
      showToast('Logged in successfully via Google!');
      updateAuthUI();
      fetchMonitors();
    } else {
      showToast(data.error || 'Google login failed.', 'error');
    }
  } catch (err) {
    showToast('Network error during Google sign-in.', 'error');
  }
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

  // Delegated handler for all monitor action buttons (safe - no inline onclick)
  monitorsList.addEventListener('click', (e) => {
    const btn = e.target.closest('.action-btn');
    if (!btn) return;
    e.stopPropagation();
    const id = parseInt(btn.dataset.id, 10);
    const action = btn.dataset.action;
    if (action === 'check')  checkMonitor(id, e);
    if (action === 'view')   viewMonitorDetail(id, e);
    if (action === 'edit')   editMonitor(id, e);
    if (action === 'toggle') toggleMonitor(id, parseInt(btn.dataset.active, 10), e);
    if (action === 'delete') deleteMonitor(id, e);
  });

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
      const res = await apiFetch('/api/settings/test-telegram', {
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
      const res = await apiFetch('/api/settings/test-email', {
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

  // Auth Button actions
  btnLoginTrigger.addEventListener('click', () => {
    openModal(modalAuth);
  });

  btnLogout.addEventListener('click', () => {
    localStorage.removeItem('rx-monitor-token');
    localStorage.removeItem('rx-monitor-user');
    showToast('Logged out successfully.');
    updateAuthUI();
    fetchMonitors();
  });

  btnUpgrade.addEventListener('click', () => {
    startRazorpayUpgrade();
  });

  // Auth Tabs toggling
  authTabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      authTabBtns.forEach(b => {
        b.classList.remove('active');
        b.style.borderBottom = 'none';
      });
      btn.classList.add('active');
      btn.style.borderBottom = '2px solid var(--color-primary)';
      
      authTabPanes.forEach(pane => {
        pane.style.display = pane.id === btn.dataset.authTab ? 'block' : 'none';
      });
    });
  });

  // Sign In Form Submission
  signinForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('signin-email').value.trim();
    const password = document.getElementById('signin-password').value;

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const data = await res.json();
      if (res.ok) {
        localStorage.setItem('rx-monitor-token', data.token);
        localStorage.setItem('rx-monitor-user', JSON.stringify(data.user));
        closeModal(modalAuth);
        showToast('Welcome back! Signed in successfully.');
        signinForm.reset();
        updateAuthUI();
        fetchMonitors();
      } else {
        showToast(data.error || 'Sign in failed.', 'error');
      }
    } catch (err) {
      showToast('Network error during sign in.', 'error');
    }
  });

  // Sign Up Form Submission
  signupForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('signup-email').value.trim();
    const password = document.getElementById('signup-password').value;
    const confirmPassword = document.getElementById('signup-confirm-password').value;

    if (password !== confirmPassword) {
      showToast('Passwords do not match.', 'error');
      return;
    }

    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const data = await res.json();
      if (res.ok) {
        showToast('Registration successful! Please check your email or server console logs for the verification link.', 'success');
        signupForm.reset();
        closeModal(modalAuth);
      } else {
        showToast(data.error || 'Sign up failed.', 'error');
      }
    } catch (err) {
      showToast('Network error during sign up.', 'error');
    }
  });
}

// Razorpay checkout initiator
async function startRazorpayUpgrade() {
  try {
    const res = await apiFetch('/api/payment/create-order', { method: 'POST' });
    if (!res.ok) {
      const errData = await res.json();
      showToast(errData.error || 'Failed to initiate upgrade order.', 'error');
      return;
    }
    const order = await res.json();
    
    if (order.mock) {
      if (confirm(`[Razorpay Simulation Mode]\nThis will simulate a Razorpay payment of ₹499 for premium upgrade.\nDo you want to proceed?`)) {
        const verifyRes = await apiFetch('/api/payment/verify-payment', {
          method: 'POST',
          body: JSON.stringify({
            razorpay_order_id: order.id,
            mock: true
          })
        });
        if (verifyRes.ok) {
          showToast('Payment successful! Account upgraded to Premium.');
          const userStr = localStorage.getItem('rx-monitor-user');
          if (userStr) {
            const user = JSON.parse(userStr);
            user.subscription_tier = 'premium';
            localStorage.setItem('rx-monitor-user', JSON.stringify(user));
          }
          updateAuthUI();
          fetchMonitors();
        } else {
          showToast('Upgrade verification failed.', 'error');
        }
      }
    } else {
      const options = {
        key: order.key,
        amount: order.amount,
        currency: order.currency,
        name: 'RxMonitor Premium',
        description: 'Upgrade for unlimited server monitors',
        order_id: order.id,
        handler: async function (response) {
          const verifyRes = await apiFetch('/api/payment/verify-payment', {
            method: 'POST',
            body: JSON.stringify({
              razorpay_order_id: response.razorpay_order_id,
              razorpay_payment_id: response.razorpay_payment_id,
              razorpay_signature: response.razorpay_signature,
              mock: false
            })
          });
          if (verifyRes.ok) {
            showToast('Payment successful! Account upgraded to Premium.');
            const userStr = localStorage.getItem('rx-monitor-user');
            if (userStr) {
              const user = JSON.parse(userStr);
              user.subscription_tier = 'premium';
              localStorage.setItem('rx-monitor-user', JSON.stringify(user));
            }
            updateAuthUI();
            fetchMonitors();
          } else {
            showToast('Upgrade verification failed.', 'error');
          }
        },
        theme: { color: '#6366f1' }
      };
      const rzp1 = new Razorpay(options);
      rzp1.open();
    }
  } catch (err) {
    showToast('Failed to start Razorpay payment flow.', 'error');
  }
}


// Fetch and Render Monitors
async function fetchMonitors() {
  try {
    const response = await apiFetch('/api/monitors');
    if (!response.ok) throw new Error('Failed to load monitors');
    
    const monitors = await response.json();
    // Refresh cache
    monitorsCache.clear();
    monitors.forEach(m => monitorsCache.set(m.id, m));
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
          <button class="btn btn-icon action-btn" data-action="check" data-id="${monitor.id}" title="Check Status Now">⚡</button>
          <button class="btn btn-icon action-btn" data-action="view" data-id="${monitor.id}" title="View Details">👁️</button>
          <button class="btn btn-icon action-btn" data-action="edit" data-id="${monitor.id}" title="Edit">✏️</button>
          <button class="btn btn-icon action-btn" data-action="toggle" data-id="${monitor.id}" data-active="${monitor.active}" title="${isActive ? 'Pause' : 'Resume'}">
            ${isActive ? '⏸️' : '▶️'}
          </button>
          <button class="btn btn-icon action-btn" data-action="delete" data-id="${monitor.id}" title="Delete">🗑️</button>
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
      response = await apiFetch(`/api/monitors/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } else {
      response = await apiFetch('/api/monitors', {
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
    const res = await apiFetch(`/api/monitors/${id}/check`, { method: 'POST' });
    if (!res.ok) throw new Error('Force check failed.');
    showToast('Check completed.');
    fetchMonitors();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    if (item) item.style.opacity = '1';
  }
};

window.viewMonitorDetail = function(id, event) {
  if (event) event.stopPropagation();
  window.location.href = `/monitor-detail.html?id=${id}`;
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

window.editMonitor = function(id, event) {
  if (event) event.stopPropagation();
  const monitor = monitorsCache.get(parseInt(id, 10));
  if (!monitor) {
    showToast('Monitor not found. Refresh the page.', 'error');
    return;
  }
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
    const res = await apiFetch(`/api/monitors/${id}`, {
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
    const res = await apiFetch(`/api/monitors/${id}`, { method: 'DELETE' });
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
    const res = await apiFetch('/api/settings');
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
    const res = await apiFetch('/api/settings', {
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
