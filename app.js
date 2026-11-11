/* ImageCompressorNow — in-browser compression engine.
   Everything runs locally through <canvas>; files are never sent to a server. */
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const drop = $('#drop');
  const fileInput = $('#file-input');
  const list = $('#results');
  const summary = $('#summary');
  const qualityInput = $('#quality');
  const qualityOut = $('#quality-out');
  const widthInput = $('#max-width');
  const formatHint = $('#format-hint');
  const zipBtn = $('#zip-btn');
  const clearBtn = $('#clear-btn');

  const CDN = {
    jszip: 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
    heic: 'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js',
  };
  const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/avif': 'avif' };
  const MAX_PIXELS = 100_000_000; // keep canvas allocations sane on phones

  const settings = { format: 'image/webp', quality: 0.8, maxWidth: 0 };
  const items = new Map(); // id -> item
  let seq = 0;
  let timer;

  // ---------- helpers ----------
  const fmtBytes = (n) => {
    if (!n) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1);
    const v = n / Math.pow(1024, i);
    return (v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)) + ' ' + u[i];
  };
  const el = (tag, props = {}, ...kids) => {
    const node = Object.assign(document.createElement(tag), props);
    kids.forEach((k) => node.append(k));
    return node;
  };
  const loaded = {};
  const loadScript = (src) =>
    (loaded[src] ||= new Promise((res, rej) => {
      const s = el('script', { src, async: true });
      s.onload = res;
      s.onerror = () => { delete loaded[src]; rej(new Error('Could not load ' + src)); };
      document.head.append(s);
    }));
  const isHeic = (f) => /\.(heic|heif)$/i.test(f.name) || /hei[cf]/i.test(f.type);
  const isSupported = (f) => /^image\/(jpeg|png|webp|avif)$/.test(f.type) || isHeic(f);

  // Detect which output encoders this browser really has.
  function canEncode(type) {
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 1;
      return c.toDataURL(type).startsWith('data:' + type);
    } catch { return false; }
  }
  document.querySelectorAll('input[name="format"]').forEach((r) => {
    if (r.value !== 'original' && !canEncode(r.value)) {
      r.disabled = true;
      r.closest('.chip').title = 'Your browser cannot create this format';
      if (r.checked) { $('input[name="format"][value="image/webp"]').checked = true; }
    }
  });

  // ---------- core engine ----------
  async function toBitmap(blob) {
    if ('createImageBitmap' in window) {
      try { return await createImageBitmap(blob); } catch { /* fall through */ }
    }
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally { URL.revokeObjectURL(url); }
  }

  async function compress(item, opts) {
    // HEIC/HEIF: convert once to a JPEG source, then compress as usual.
    if (isHeic(item.file) && !item.source) {
      await loadScript(CDN.heic);
      const out = await window.heic2any({ blob: item.file, toType: 'image/jpeg', quality: 0.95 });
      item.source = Array.isArray(out) ? out[0] : out;
    }
    const source = item.source || item.file;
    const sourceType = source.type || item.file.type;

    let type = opts.format === 'original' ? sourceType : opts.format;
    if (!EXT[type]) type = 'image/jpeg';

    const bmp = await toBitmap(source);
    const w0 = bmp.width, h0 = bmp.height;
    if (w0 * h0 > MAX_PIXELS) throw new Error('Image is too large to process in the browser');

    let w = w0, h = h0;
    if (opts.maxWidth > 0 && w0 > opts.maxWidth) {
      w = opts.maxWidth;
      h = Math.max(1, Math.round(h0 * (w / w0)));
    }
    const canvas = el('canvas', { width: w, height: h });
    const ctx = canvas.getContext('2d');
    if (type === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); } // JPEG has no alpha
    ctx.drawImage(bmp, 0, 0, w, h);
    if (bmp.close) bmp.close();

    let blob = await new Promise((res) => canvas.toBlob(res, type, opts.quality));
    if (!blob) throw new Error('This browser could not encode the image');
    if (blob.type && blob.type !== type) type = blob.type; // browser fell back to another format

    // Never hand back a bigger file when nothing was changed on purpose.
    const untouched = !item.source && type === item.file.type && w === w0 && h === h0;
    let note = '';
    if (untouched && blob.size >= item.file.size) {
      blob = item.file;
      note = 'Already well optimized';
    }
    const base = item.file.name.replace(/\.[^.]+$/, '');
    return { blob, name: `${base}.${EXT[type] || 'jpg'}`, note };
  }

  // ---------- UI ----------
  function render(item) {
    const row = item.row || (item.row = el('div', { className: 'row' }));
    row.className = 'row' + (item.error ? ' err' : '');
    row.replaceChildren();

    const thumb = el('img', { className: 'thumb', alt: '', loading: 'lazy' });
    if (item.result) thumb.src = item.resultUrl || (item.resultUrl = URL.createObjectURL(item.result.blob));
    const name = el('div', { className: 'name' }, item.result ? item.result.name : item.file.name);
    row.append(thumb, name);

    if (item.error) {
      row.append(el('div', { className: 'meta' }, item.error), el('div', { className: 'actions' }, removeBtn(item)));
      return;
    }
    if (!item.result) {
      row.append(
        el('div', { className: 'state' }, el('span', { className: 'spinner' }), item.status || 'Compressing…'),
        el('div', { className: 'actions' }, removeBtn(item))
      );
      return;
    }
    const before = item.file.size, after = item.result.blob.size;
    const pct = Math.round(((before - after) / before) * 100);
    const meta = el('div', { className: 'meta' },
      el('s', {}, fmtBytes(before)), '→', el('b', {}, fmtBytes(after)),
      el('span', { className: 'badge' + (pct > 0 ? '' : ' none') }, pct > 0 ? `−${pct}%` : 'No gain'));
    if (item.result.note) meta.append(el('span', {}, item.result.note));
    const dl = el('a', { className: 'btn small', href: item.resultUrl, download: item.result.name }, 'Download');
    row.append(meta, el('div', { className: 'actions' }, dl, removeBtn(item)));
  }

  function removeBtn(item) {
    return el('button', {
      className: 'x', type: 'button', title: 'Remove', ariaLabel: 'Remove ' + item.file.name,
      onclick: () => remove(item.id),
    }, '×');
  }

  function remove(id) {
    const it = items.get(id);
    if (!it) return;
    if (it.resultUrl) URL.revokeObjectURL(it.resultUrl);
    it.row?.remove();
    items.delete(id);
    updateSummary();
  }

  function updateSummary() {
    const all = [...items.values()];
    list.hidden = all.length === 0;
    const done = all.filter((i) => i.result);
    summary.hidden = done.length === 0;
    if (!done.length) return;
    const before = done.reduce((s, i) => s + i.file.size, 0);
    const after = done.reduce((s, i) => s + i.result.blob.size, 0);
    const saved = Math.max(before - after, 0);
    const pct = before ? Math.round((saved / before) * 100) : 0;
    $('#summary-text').replaceChildren(
      `${done.length} image${done.length > 1 ? 's' : ''} · saved `, el('b', {}, `${fmtBytes(saved)} (${pct}%)`));
    zipBtn.hidden = done.length < 2;
  }

  async function run(item) {
    const token = ++item.token;
    item.error = null;
    item.status = isHeic(item.file) && !item.source ? 'Converting HEIC…' : 'Compressing…';
    if (item.resultUrl) { URL.revokeObjectURL(item.resultUrl); item.resultUrl = null; }
    item.result = null;
    render(item);
    try {
      const result = await compress(item, { ...settings });
      if (token !== item.token || !items.has(item.id)) return; // superseded
      item.result = result;
    } catch (e) {
      if (token !== item.token) return;
      item.error = e && e.message ? e.message : 'Could not process this file';
    }
    render(item);
    updateSummary();
  }

  function addFiles(fileList) {
    const files = [...fileList];
    const skipped = [];
    for (const file of files) {
      if (!isSupported(file)) { skipped.push(file.name); continue; }
      const item = { id: ++seq, file, token: 0, result: null, source: null };
      items.set(item.id, item);
      list.append((item.row = el('div', { className: 'row' })));
      run(item);
    }
    list.hidden = items.size === 0;
    if (skipped.length) {
      const msg = el('div', { className: 'row err' },
        el('div', { className: 'name' }, 'Skipped (unsupported type): ' + skipped.join(', ')));
      msg.style.gridTemplateColumns = '1fr';
      list.prepend(msg);
      setTimeout(() => msg.remove(), 6000);
      list.hidden = false;
    }
  }

  function rerunAll() {
    clearTimeout(timer);
    timer = setTimeout(() => items.forEach((it) => run(it)), 250);
  }

  // ---------- events ----------
  drop.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });
  ['dragenter', 'dragover'].forEach((t) =>
    drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) =>
    drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));
  document.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) addFiles(files);
  });

  document.querySelectorAll('input[name="format"]').forEach((r) =>
    r.addEventListener('change', () => {
      settings.format = r.value;
      formatHint.textContent = r.value === 'image/png'
        ? 'PNG is lossless, so the quality slider has no effect. Choose WebP or JPEG for bigger savings.'
        : '';
      rerunAll();
    }));
  const paintSlider = () => {
    const pct = ((qualityInput.value - qualityInput.min) / (qualityInput.max - qualityInput.min)) * 100;
    qualityInput.style.setProperty('--pct', pct + '%');
  };
  paintSlider();
  qualityInput.addEventListener('input', () => {
    paintSlider();
    settings.quality = qualityInput.value / 100;
    qualityOut.textContent = qualityInput.value + '%';
    rerunAll();
  });
  widthInput.addEventListener('input', () => {
    settings.maxWidth = Math.max(0, parseInt(widthInput.value, 10) || 0);
    rerunAll();
  });
  clearBtn.addEventListener('click', () => [...items.keys()].forEach(remove));

  zipBtn.addEventListener('click', async () => {
    const done = [...items.values()].filter((i) => i.result);
    if (!done.length) return;
    const label = zipBtn.textContent;
    zipBtn.disabled = true;
    zipBtn.textContent = 'Zipping…';
    try {
      await loadScript(CDN.jszip);
      const zip = new window.JSZip();
      const used = new Set();
      for (const { result } of done) {
        let n = result.name, k = 1;
        while (used.has(n)) n = result.name.replace(/(\.[^.]+)$/, `-${++k}$1`);
        used.add(n);
        zip.file(n, result.blob);
      }
      const blob = await zip.generateAsync({ type: 'blob' });
      const a = el('a', { href: URL.createObjectURL(blob), download: 'compressed-images.zip' });
      document.body.append(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    } catch {
      alert('Could not create the ZIP. Please download the images one by one.');
    } finally {
      zipBtn.disabled = false;
      zipBtn.textContent = label;
    }
  });
})();
