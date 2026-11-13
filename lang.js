/* Language dropdown: close on outside click or Escape. */
(() => {
  'use strict';
  const d = document.querySelector('.lang');
  if (!d) return;
  // Remember an explicit choice so the automatic country/browser redirect on "/" stops.
  d.addEventListener('click', (e) => {
    if (e.target.closest('a[hreflang]')) {
      try { document.cookie = 'ic_lang=1; path=/; max-age=31536000; SameSite=Lax'; } catch (_) {}
    }
  });
  document.addEventListener('click', (e) => { if (d.open && !d.contains(e.target)) d.open = false; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && d.open) { d.open = false; d.querySelector('summary').focus(); } });
})();
