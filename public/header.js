// Shared Header Component — injected into all pages
// Usage: Include <script src="header.js"></script> and add <div id="app-header"></div> where the header should go
// Or call RxHeader.init() to auto-inject at top of .container

const RxHeader = (() => {
  const currentPath = window.location.pathname;

  function isActive(href) {
    if (href === '/' && currentPath === '/') return true;
    if (href === '/' && currentPath === '/index.html') return true;
    if (href !== '/' && currentPath.includes(href)) return true;
    return false;
  }

  function activeClass(href) {
    return isActive(href) ? 'active' : '';
  }

  function getHeaderHTML() {
    return `
    <header class="app-header">
      <div class="logo-area">
        <a href="/" style="display:flex;align-items:center;gap:10px;text-decoration:none;">
          <span class="logo-icon">📡</span>
          <h1>RxMonitor</h1>
        </a>
      </div>

      <nav class="header-nav">
        <a href="/" class="nav-link ${activeClass('/')}">
          <span class="nav-icon">🖥️</span> Dashboard
        </a>
        <a href="/servers.html" class="nav-link ${activeClass('/servers.html')}">
          <span class="nav-icon">📊</span> Servers
        </a>

        <div class="nav-dropdown">
          <button class="nav-link nav-dropdown-trigger">
            <span class="nav-icon">🔍</span> Monitoring <span class="dropdown-caret">▾</span>
          </button>
          <div class="nav-dropdown-menu">
            <a href="/alerting.html" class="nav-dropdown-item ${activeClass('/alerting.html')}">🔔 Alerting</a>
            <a href="/incidents.html" class="nav-dropdown-item ${activeClass('/incidents.html')}">⚠️ Incidents</a>
            <a href="/status.html" class="nav-dropdown-item ${activeClass('/status.html')}">🌐 Status Page</a>
          </div>
        </div>

        <div class="nav-dropdown">
          <button class="nav-link nav-dropdown-trigger">
            <span class="nav-icon">📋</span> Logs <span class="dropdown-caret">▾</span>
          </button>
          <div class="nav-dropdown-menu">
            <a href="/logs.html" class="nav-dropdown-item ${activeClass('/logs.html')}">📋 System Logs</a>
            <a href="/app-logs.html" class="nav-dropdown-item ${activeClass('/app-logs.html')}">📜 App Logs</a>
          </div>
        </div>

        <div class="nav-dropdown">
          <button class="nav-link nav-dropdown-trigger">
            <span class="nav-icon">📈</span> Analytics <span class="dropdown-caret">▾</span>
          </button>
          <div class="nav-dropdown-menu">
            <a href="/dashboards.html" class="nav-dropdown-item ${activeClass('/dashboards.html')}">📈 Dashboards</a>
            <a href="/comparison.html" class="nav-dropdown-item ${activeClass('/comparison.html')}">⚖️ Compare</a>
          </div>
        </div>

        <a id="nav-admin" href="/admin.html" class="nav-link ${activeClass('/admin.html')}" style="display:none;">
          <span class="nav-icon">🛡️</span> Admin
        </a>
      </nav>

      <div class="header-actions">
        <button id="btn-add-monitor" class="btn btn-primary" style="font-size:12px;padding:8px 12px;">
          <span class="icon">➕</span> <span class="btn-add-text">Add Monitor</span>
        </button>
        <button id="theme-toggle" class="btn btn-icon-round" title="Toggle theme">
          <span class="icon">☀️</span>
        </button>
        <button id="btn-upgrade" class="btn btn-upgrade" style="display:none;" title="Upgrade to Premium">
          <span>⭐</span> Upgrade
        </button>
        <div class="user-menu" id="user-menu" style="display:none;">
          <button class="user-avatar-btn" id="user-avatar-btn" aria-haspopup="true" aria-expanded="false">
            <span class="user-avatar-icon" id="user-avatar-icon">👤</span>
            <span class="user-avatar-email" id="user-greeting"></span>
            <span class="dropdown-caret">▾</span>
          </button>
          <div class="user-dropdown" id="user-dropdown">
            <div class="dropdown-header">
              <span id="dropdown-email" class="dropdown-email"></span>
              <span id="dropdown-tier" class="dropdown-tier-badge"></span>
            </div>
            <hr class="dropdown-divider">
            <button id="btn-settings" class="dropdown-item">
              <span>⚙️</span> Settings
            </button>
            <a id="dropdown-admin" href="/admin.html" class="dropdown-item" style="display:none;">
              <span>🛡️</span> Admin Panel
            </a>
            <hr class="dropdown-divider">
            <button id="btn-logout" class="dropdown-item dropdown-item-danger">
              <span>🚪</span> Sign Out
            </button>
          </div>
        </div>
        <button id="btn-login-trigger" class="btn btn-secondary" style="font-size:12px;padding:8px 12px;">
          <span class="icon">🔑</span> Sign In
        </button>
        <button id="btn-hamburger" class="btn btn-icon-round hamburger-btn" title="Menu" aria-label="Open navigation menu" aria-expanded="false">
          <span class="hamburger-icon">
            <span></span><span></span><span></span>
          </span>
        </button>
      </div>
    </header>

    <!-- Mobile Drawer Overlay -->
    <div id="mobile-overlay" class="mobile-overlay"></div>

    <!-- Mobile Drawer -->
    <div id="mobile-drawer" class="mobile-drawer" aria-hidden="true">
      <div class="mobile-drawer-header">
        <div class="logo-area" style="gap:8px;">
          <span class="logo-icon" style="font-size:22px;">📡</span>
          <span style="font-weight:700; font-size:18px;">RxMonitor</span>
        </div>
        <button id="btn-drawer-close" class="btn btn-icon-round" aria-label="Close menu">✕</button>
      </div>

      <div id="drawer-user-strip" class="drawer-user-strip" style="display:none;">
        <div class="drawer-user-avatar">👤</div>
        <div class="drawer-user-info">
          <span id="drawer-username" class="drawer-username"></span>
          <span id="drawer-usertier" class="drawer-usertier"></span>
        </div>
      </div>

      <nav class="drawer-nav">
        <a href="/" class="drawer-nav-link ${activeClass('/')}">
          <span>🖥️</span> Dashboard
        </a>
        <a href="/servers.html" class="drawer-nav-link ${activeClass('/servers.html')}">
          <span>📊</span> Servers
        </a>
        <a href="/alerting.html" class="drawer-nav-link ${activeClass('/alerting.html')}">
          <span>🔔</span> Alerting
        </a>
        <a href="/incidents.html" class="drawer-nav-link ${activeClass('/incidents.html')}">
          <span>⚠️</span> Incidents
        </a>
        <a href="/status.html" class="drawer-nav-link ${activeClass('/status.html')}">
          <span>🌐</span> Status Page
        </a>
        <a href="/logs.html" class="drawer-nav-link ${activeClass('/logs.html')}">
          <span>📋</span> System Logs
        </a>
        <a href="/app-logs.html" class="drawer-nav-link ${activeClass('/app-logs.html')}">
          <span>📜</span> App Logs
        </a>
        <a href="/dashboards.html" class="drawer-nav-link ${activeClass('/dashboards.html')}">
          <span>📈</span> Dashboards
        </a>
        <a href="/comparison.html" class="drawer-nav-link ${activeClass('/comparison.html')}">
          <span>⚖️</span> Compare
        </a>
        <a id="drawer-admin-link" href="/admin.html" class="drawer-nav-link ${activeClass('/admin.html')}" style="display:none;">
          <span>🛡️</span> Admin Panel
        </a>
      </nav>

      <div class="drawer-divider"></div>

      <div class="drawer-actions">
        <button id="drawer-btn-add" class="btn btn-primary" style="width:100%; justify-content:center;">
          <span>➕</span> Add Monitor
        </button>
        <button id="drawer-btn-upgrade" class="drawer-upgrade-btn" style="display:none;">
          <span>⭐</span> Upgrade to Premium
        </button>
        <button id="drawer-btn-settings" class="drawer-nav-link" style="width:100%;border:none;cursor:pointer;">
          <span>⚙️</span> Settings
        </button>
        <button id="drawer-btn-login" class="drawer-nav-link" style="width:100%;border:none;cursor:pointer;display:none;">
          <span>🔑</span> Sign In
        </button>
        <button id="drawer-btn-logout" class="drawer-nav-link drawer-logout" style="width:100%;border:none;cursor:pointer;display:none;">
          <span>🚪</span> Sign Out
        </button>
      </div>
    </div>`;
  }

  function initDropdowns() {
    document.querySelectorAll('.nav-dropdown-trigger').forEach(trigger => {
      trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        const dropdown = trigger.closest('.nav-dropdown');
        const menu = dropdown.querySelector('.nav-dropdown-menu');
        document.querySelectorAll('.nav-dropdown-menu.is-open').forEach(m => {
          if (m !== menu) m.classList.remove('is-open');
        });
        menu.classList.toggle('is-open');
      });
    });
    document.addEventListener('click', () => {
      document.querySelectorAll('.nav-dropdown-menu.is-open').forEach(m => m.classList.remove('is-open'));
    });
  }

  function initDrawer() {
    const btnHamburger = document.getElementById('btn-hamburger');
    const mobileDrawer = document.getElementById('mobile-drawer');
    const mobileOverlay = document.getElementById('mobile-overlay');
    const btnDrawerClose = document.getElementById('btn-drawer-close');

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

    if (btnHamburger) btnHamburger.addEventListener('click', openDrawer);
    if (btnDrawerClose) btnDrawerClose.addEventListener('click', closeDrawer);
    if (mobileOverlay) mobileOverlay.addEventListener('click', closeDrawer);

    // Drawer action proxies
    const drawerBtnAdd = document.getElementById('drawer-btn-add');
    const drawerBtnSettings = document.getElementById('drawer-btn-settings');
    const drawerBtnLogin = document.getElementById('drawer-btn-login');
    const drawerBtnLogout = document.getElementById('drawer-btn-logout');

    if (drawerBtnAdd) drawerBtnAdd.addEventListener('click', () => {
      closeDrawer();
      const btn = document.getElementById('btn-add-monitor');
      if (btn) btn.click();
    });
    if (drawerBtnSettings) drawerBtnSettings.addEventListener('click', () => {
      closeDrawer();
      const btn = document.getElementById('btn-settings');
      if (btn) btn.click();
    });
    if (drawerBtnLogin) drawerBtnLogin.addEventListener('click', () => {
      closeDrawer();
      const btn = document.getElementById('btn-login-trigger');
      if (btn) btn.click();
    });
    if (drawerBtnLogout) drawerBtnLogout.addEventListener('click', () => {
      closeDrawer();
      localStorage.removeItem('rx-monitor-token');
      localStorage.removeItem('rx-monitor-user');
      window.location.reload();
    });
  }

  function init() {
    // Skip injection if a header already exists (e.g., index.html has its own)
    if (document.querySelector('.app-header')) {
      // Just init dropdowns and drawer for existing header
      initDropdowns();
      initDrawer();
      return;
    }

    // Find the target container — either #app-header placeholder or insert at start of .container
    let target = document.getElementById('app-header');
    if (target) {
      target.innerHTML = getHeaderHTML();
    } else {
      const container = document.querySelector('.container');
      if (container) {
        container.insertAdjacentHTML('afterbegin', getHeaderHTML());
      }
    }
    initDropdowns();
    initDrawer();
  }

  return { init, getHeaderHTML };
})();

// Auto-init when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', RxHeader.init);
} else {
  RxHeader.init();
}
