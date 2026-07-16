(function () {
  // Apply the theme immediately to avoid flash of wrong theme
  const savedTheme = localStorage.getItem('rx-monitor-theme') || 'dark';
  document.documentElement.setAttribute('data-theme', savedTheme);
})();

document.addEventListener('DOMContentLoaded', () => {
  const themeToggleBtn = document.getElementById('theme-toggle');
  if (themeToggleBtn) {
    const updateIcon = (theme) => {
      // Use clean icons (sun/moon emoji or text) for toggle
      themeToggleBtn.innerHTML = theme === 'light' ? '<span class="icon">🌙</span>' : '<span class="icon">☀️</span>';
    };

    // Set initial state
    const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
    updateIcon(currentTheme);

    themeToggleBtn.addEventListener('click', () => {
      const activeTheme = document.documentElement.getAttribute('data-theme') || 'dark';
      const newTheme = activeTheme === 'light' ? 'dark' : 'light';
      
      document.documentElement.setAttribute('data-theme', newTheme);
      localStorage.setItem('rx-monitor-theme', newTheme);
      updateIcon(newTheme);
      
      // Emit a custom event if charts need to update their grid/text colors
      window.dispatchEvent(new CustomEvent('themechanged', { detail: { theme: newTheme } }));
    });
  }
});
