/* Language dropdown: close on outside click or Escape. */
(() => {
  'use strict';
  const d = document.querySelector('.lang');
  if (!d) return;
  document.addEventListener('click', (e) => { if (d.open && !d.contains(e.target)) d.open = false; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && d.open) { d.open = false; d.querySelector('summary').focus(); } });
})();
