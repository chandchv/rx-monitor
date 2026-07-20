// Auth Guard — redirects unauthenticated users to the landing page
// Include this script on any page that requires sign-in
(function() {
  const token = localStorage.getItem('rx-monitor-token');
  if (!token) {
    // Redirect to landing page if not signed in
    window.location.replace('/');
    // Prevent page content from rendering while redirecting
    document.documentElement.style.display = 'none';
  }
})();
