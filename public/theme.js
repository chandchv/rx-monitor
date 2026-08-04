(function () {
  // Apply the theme immediately to avoid flash of wrong theme
  const savedTheme = localStorage.getItem('rx-monitor-theme') || 'dark';
  document.documentElement.setAttribute('data-theme', savedTheme);
})();

// Helper to update toggle button icons
window.updateThemeIcon = function(btn, theme) {
  if (!btn) return;
  btn.innerHTML = theme === 'light' ? '<span class="icon">🌙</span>' : '<span class="icon">☀️</span>';
};

// Global toggle helper called by header or page scripts
window.toggleTheme = function(btn) {
  const activeTheme = document.documentElement.getAttribute('data-theme') || 'dark';
  const newTheme = activeTheme === 'light' ? 'dark' : 'light';
  
  document.documentElement.setAttribute('data-theme', newTheme);
  localStorage.setItem('rx-monitor-theme', newTheme);
  
  if (btn) {
    window.updateThemeIcon(btn, newTheme);
  }
  
  // Emit a custom event if charts need to update their grid/text colors
  window.dispatchEvent(new CustomEvent('themechanged', { detail: { theme: newTheme } }));
};

document.addEventListener('DOMContentLoaded', () => {
  const themeToggleBtn = document.getElementById('theme-toggle');
  if (themeToggleBtn) {
    const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
    window.updateThemeIcon(themeToggleBtn, currentTheme);

    themeToggleBtn.addEventListener('click', () => {
      window.toggleTheme(themeToggleBtn);
    });
  }
});
