/* Language menu. One URL per page: picking a language stores a cookie and reloads the same address,
   and the server (vercel.json rewrites) returns that language. */
(() => {
  'use strict';
  const d = document.querySelector('.lang');
  if (!d) return;
  const PREFIX = /^\/(zh|hi|es|fr|ar|bn|pt|ru|ur)(\/.*)?$/;
  d.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-lang]');
    if (!a) return;
    e.preventDefault();
    try { document.cookie = 'ic_lang=' + a.dataset.lang + '; path=/; max-age=31536000; SameSite=Lax'; } catch (_) {}
    const m = location.pathname.match(PREFIX);
    const path = m ? (m[2] || '/') : location.pathname;
    if (path === location.pathname) location.reload();
    else location.assign(path + location.search + location.hash);
  });
  document.addEventListener('click', (e) => { if (d.open && !d.contains(e.target)) d.open = false; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && d.open) { d.open = false; d.querySelector('summary').focus(); } });
})();
