/* Before / after comparison viewer.
   app.js dispatches `ic:compare` with { name, original: Blob, result: Blob, before, after }.
   Everything stays local: the images are shown from in-memory blob URLs. */
(() => {
  'use strict';

  const fmt = (n) => {
    const u = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(Math.floor(Math.log(n || 1) / Math.log(1024)), 3);
    const v = n / Math.pow(1024, i);
    return (v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)) + ' ' + u[i];
  };
  const h = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  let open = null; // currently open viewer

  function close() {
    if (!open) return;
    const { root, urls, prevFocus, onKey } = open;
    document.removeEventListener('keydown', onKey, true);
    urls.forEach((u) => URL.revokeObjectURL(u));
    root.remove();
    document.documentElement.classList.remove('cmp-open');
    open = null;
    if (prevFocus && prevFocus.focus) prevFocus.focus();
  }

  function show(d) {
    close();
    const urls = [URL.createObjectURL(d.original), URL.createObjectURL(d.result)];
    const prevFocus = document.activeElement;

    const root = h('div', 'cmp');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Compare before and after: ' + d.name);

    const panel = h('div', 'cmp-panel');

    // ---- header ----
    const head = h('div', 'cmp-head');
    const title = h('div', 'cmp-title', d.name);
    const pct = d.before > 0 ? Math.round(((d.before - d.after) / d.before) * 100) : 0;
    const stats = h('div', 'cmp-stats');
    const s1 = h('span', 'cmp-chip'); s1.append('Original ', Object.assign(h('b'), { textContent: fmt(d.before) }));
    const s2 = h('span', 'cmp-chip hot'); s2.append('Compressed ', Object.assign(h('b'), { textContent: fmt(d.after) }));
    stats.append(s1, s2, h('span', 'cmp-badge' + (pct > 0 ? '' : ' none'), pct > 0 ? '−' + pct + '%' : 'No gain'));

    const zoom = h('div', 'cmp-zoom');
    zoom.setAttribute('role', 'group');
    zoom.setAttribute('aria-label', 'Zoom');
    const bFit = h('button', null, 'Fit'); bFit.type = 'button'; bFit.setAttribute('aria-pressed', 'true');
    const b100 = h('button', null, '100%'); b100.type = 'button'; b100.setAttribute('aria-pressed', 'false');
    zoom.append(bFit, b100);
    const x = h('button', 'cmp-x', '×'); x.type = 'button'; x.setAttribute('aria-label', 'Close comparison');
    const right = h('div', 'cmp-right'); right.append(zoom, x);
    head.append(title, stats, right);

    // ---- stage ----
    const view = h('div', 'cmp-view');
    const stage = h('div', 'cmp-stage');
    stage.style.setProperty('--p', '50%');
    const after = h('img', 'cmp-after'); after.alt = 'Compressed version'; after.decoding = 'async'; after.draggable = false; after.src = urls[1];
    const before = h('img', 'cmp-before'); before.alt = 'Original version'; before.decoding = 'async'; before.draggable = false; before.src = urls[0];
    const lab1 = h('span', 'cmp-label l', 'Original');
    const lab2 = h('span', 'cmp-label r', 'Compressed');
    const handle = h('div', 'cmp-handle');
    handle.tabIndex = 0;
    handle.setAttribute('role', 'slider');
    handle.setAttribute('aria-label', 'Reveal original or compressed');
    handle.setAttribute('aria-valuemin', '0');
    handle.setAttribute('aria-valuemax', '100');
    handle.setAttribute('aria-valuenow', '50');
    handle.innerHTML = '<span class="cmp-knob"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l-6 6 6 6M15 6l6 6-6 6"/></svg></span>';
    stage.append(after, before, lab1, lab2, handle);
    view.append(stage);

    const foot = h('div', 'cmp-foot', 'Drag the handle or use the ← → keys. Choose 100% to inspect individual pixels.');

    panel.append(head, view, foot);
    root.append(panel);
    document.body.append(root);
    document.documentElement.classList.add('cmp-open');

    // ---- behaviour ----
    let pos = 50;
    const setPos = (p) => {
      pos = Math.max(0, Math.min(100, p));
      stage.style.setProperty('--p', pos + '%');
      handle.setAttribute('aria-valuenow', String(Math.round(pos)));
    };
    const fromEvent = (e) => {
      const r = stage.getBoundingClientRect();
      setPos(((e.clientX - r.left) / r.width) * 100);
    };

    let dragging = false;
    const startDrag = (e) => { dragging = true; stage.setPointerCapture(e.pointerId); fromEvent(e); e.preventDefault(); };
    stage.addEventListener('pointerdown', (e) => {
      const full = root.classList.contains('full');
      if (full && !e.target.closest('.cmp-handle')) return; // in 100% mode only the handle drags, so the page can be panned
      startDrag(e);
    });
    stage.addEventListener('pointermove', (e) => { if (dragging) fromEvent(e); });
    const stop = () => { dragging = false; };
    stage.addEventListener('pointerup', stop);
    stage.addEventListener('pointercancel', stop);

    handle.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 10 : 2;
      if (e.key === 'ArrowLeft') { setPos(pos - step); e.preventDefault(); }
      else if (e.key === 'ArrowRight') { setPos(pos + step); e.preventDefault(); }
      else if (e.key === 'Home') { setPos(0); e.preventDefault(); }
      else if (e.key === 'End') { setPos(100); e.preventDefault(); }
    });

    const setZoom = (full) => {
      root.classList.toggle('full', full);
      bFit.setAttribute('aria-pressed', String(!full));
      b100.setAttribute('aria-pressed', String(full));
      view.scrollLeft = 0; view.scrollTop = 0;
    };
    bFit.addEventListener('click', () => setZoom(false));
    b100.addEventListener('click', () => setZoom(true));

    x.addEventListener('click', close);
    root.addEventListener('pointerdown', (e) => { if (e.target === root) close(); });

    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key === 'Tab') { // keep focus inside the dialog
        const f = [...root.querySelectorAll('button, [tabindex="0"]')];
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
        else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
      } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && document.activeElement !== handle) {
        setPos(pos + (e.key === 'ArrowRight' ? 2 : -2));
      }
    };
    document.addEventListener('keydown', onKey, true);

    // fade the pictures in once both are decoded (no flash of the checkerboard)
    stage.classList.add('loading');
    let pendingImgs = 2;
    const ready = () => { if (--pendingImgs <= 0) stage.classList.remove('loading'); };
    [after, before].forEach((im) => { if (im.complete && im.naturalWidth) ready(); else { im.addEventListener('load', ready, { once: true }); im.addEventListener('error', ready, { once: true }); } });
    setTimeout(() => stage.classList.remove('loading'), 4000); // never leave the viewer blank

    open = { root, urls, prevFocus, onKey };
    handle.focus({ preventScroll: true });
  }

  document.addEventListener('ic:compare', (e) => show(e.detail));
})();
