/* Article pages: reading-progress bar and highlight of the current section in the contents list. */
(() => {
  'use strict';
  if (!document.querySelector('.article-layout')) return;

  const bar = document.createElement('div');
  bar.className = 'read-progress';
  bar.setAttribute('aria-hidden', 'true');
  const fill = document.createElement('i');
  bar.append(fill);
  document.body.append(bar);

  const article = document.querySelector('.article-layout article');
  let ticking = false;
  const update = () => {
    ticking = false;
    const r = article.getBoundingClientRect();
    const total = r.height - window.innerHeight * 0.6;
    const done = Math.min(Math.max(-r.top / Math.max(total, 1), 0), 1);
    fill.style.transform = 'scaleX(' + done.toFixed(4) + ')';
  };
  window.addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
  update();

  const links = [...document.querySelectorAll('.side .toc a')];
  const map = new Map(links.map((a) => [a.getAttribute('href').slice(1), a]));
  const heads = [...map.keys()].map((id) => document.getElementById(id)).filter(Boolean);
  if (!heads.length || !('IntersectionObserver' in window)) return;
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting) {
        links.forEach((l) => l.classList.remove('on'));
        const l = map.get(e.target.id);
        if (l) l.classList.add('on');
      }
    });
  }, { rootMargin: '-90px 0px -70% 0px' });
  heads.forEach((h) => io.observe(h));
})();
