// =============================================================================
// theme-init.js  -  picks LIGHT or NIGHT mode before the page is drawn.
// -----------------------------------------------------------------------------
// Order of preference: 1) what you chose last time (saved in localStorage)
//                      2) your operating system's light/dark setting
// It only sets <html data-theme="light|dark">; style.css does the rest.
// =============================================================================
(function () {
  var theme = null;
  try { theme = JSON.parse(localStorage.getItem('mknb.theme')); } catch (e) { /* storage blocked */ }
  if (theme !== 'light' && theme !== 'dark') {
    theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  document.documentElement.setAttribute('data-theme', theme);
})();
