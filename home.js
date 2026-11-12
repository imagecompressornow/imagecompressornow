/* Home page motion: floating demo cards, scroll reveals, count-up numbers, tool-card spotlight. */
(() => {
  'use strict';
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) return; // everything stays static and fully visible

  // spotlight that follows the pointer
  const card = document.querySelector('.tool-card');
  if (card) {
    card.addEventListener('pointermove', (e) => {
      const r = card.getBoundingClientRect();
      card.style.setProperty('--mx', e.clientX - r.left + 'px');
      card.style.setProperty('--my', e.clientY - r.top + 'px');
    });
  }

  // hero demo card: the file "shrinks" in a loop
  const sizeEl = document.getElementById('fc-size');
  const badgeEl = document.getElementById('fc-badge');
  const FROM = 4.2, TO = 0.6, DUR = 1900;
  const fmt = (v) => (v >= 1 ? v.toFixed(1) + ' MB' : Math.round(v * 100) * 10 + ' KB');
  const paint = (v) => {
    sizeEl.textContent = fmt(v);
    badgeEl.textContent = '\u2212' + Math.round((1 - v / FROM) * 100) + '%';
  };
  const shrink = () => {
    if (!sizeEl.offsetParent) { setTimeout(shrink, 4000); return; } // hidden on small screens
    const t0 = performance.now();
    const tick = (now) => {
      const p = Math.min((now - t0) / DUR, 1);
      paint(FROM - (FROM - TO) * (1 - Math.pow(1 - p, 3)));
      if (p < 1) requestAnimationFrame(tick);
      else setTimeout(() => { paint(FROM); setTimeout(shrink, 700); }, 3600);
    };
    paint(FROM);
    setTimeout(() => requestAnimationFrame(tick), 600);
  };
  if (sizeEl && badgeEl) shrink();

  // scroll reveal
  if (!('IntersectionObserver' in window)) return;
  document.documentElement.classList.add('js');
  const sel = '.trust li, .stats li, section.block > .eyebrow, section.block > h2, section.block > .sub, .steps li, .features li, .table-wrap, .bars-card, .faq details, .guide-grid a, .cta';
  const targets = [...document.querySelectorAll(sel)];
  const counts = new Map();
  targets.forEach((el) => {
    el.classList.add('reveal');
    const sibs = [...el.parentElement.children].filter((x) => x.classList.contains('reveal') || targets.includes(x));
    el.style.transitionDelay = Math.min(sibs.indexOf(el), 5) * 80 + 'ms';
  });

  const countUp = (el) => {
    const txt = el.textContent;
    const nums = txt.match(/\d+/g);
    if (!nums) return;
    const goal = nums.map(Number);
    const t0 = performance.now();
    const tick = (now) => {
      const p = Math.min((now - t0) / 1300, 1);
      const e = 1 - Math.pow(1 - p, 3);
      let i = 0;
      el.textContent = txt.replace(/\d+/g, () => Math.round(goal[i++] * e));
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  const bars = document.querySelector('.bars');
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      const el = e.target;
      el.classList.add('in');
      io.unobserve(el);
      // hand the element back to its normal hover transitions once the entrance is done
      setTimeout(() => { el.classList.remove('reveal', 'in'); el.style.transitionDelay = ''; }, 1300);
      if (el.matches('.stats li')) countUp(el.querySelector('b'));
      if (el.matches('.bars-card') && bars) setTimeout(() => bars.classList.add('in'), 250);
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
  targets.forEach((el) => io.observe(el));
})();
