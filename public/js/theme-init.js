// =============================================================================
// theme-init.js  -  applies your look BEFORE the page is drawn (no flash).
// -----------------------------------------------------------------------------
// Two independent choices (both changeable in ⚙ Settings):
//   STYLE: "pro"   = clean charting-platform look (DEFAULT)
//          "cyber" = full neon cyberpunk look
//   MODE:  "dark" | "light" | "auto" (auto = follow your computer's setting)
// Result: <html data-style="pro|cyber" data-theme="dark|light">; style.css does the rest.
// Plain old-style JS on purpose: it runs before everything else.
// =============================================================================
(function () {
  function read(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; } // storage blocked
  }
  var style = read('mknb.style');
  if (style !== 'pro' && style !== 'cyber') style = 'pro';
  var mode = read('mknb.theme');
  if (mode !== 'light' && mode !== 'dark') {
    mode = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  document.documentElement.setAttribute('data-style', style);
  document.documentElement.setAttribute('data-theme', mode);
})();
