/* Language menu: close on outside click or Escape, and remember an explicit choice.
   Each language has its own URL (/ar, /hi ...). The choice is stored in a cookie so the automatic
   country/browser redirect on "/" respects it (choosing English keeps "/" in English). */
(() => {
  'use strict';
  const d = document.querySelector('.lang');
  if (!d) return;
  d.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-lang]');
    if (!a) return;
    try { document.cookie = 'ic_lang=' + a.dataset.lang + '; path=/; max-age=31536000; SameSite=Lax'; } catch (_) {}
  });
  document.addEventListener('click', (e) => { if (d.open && !d.contains(e.target)) d.open = false; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && d.open) { d.open = false; d.querySelector('summary').focus(); } });
})();
