// Runs before first paint so the page never flashes the wrong theme.
(function () {
  var t = null;
  try { t = localStorage.getItem('memvault-theme'); } catch (e) { /* storage blocked */ }
  if (t !== 'light' && t !== 'dark') {
    t = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.setAttribute('data-theme', t);
})();
