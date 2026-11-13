/* Image Compressor Now — in-browser compression engine.
   Everything runs on the visitor's device; files are never sent to a server.
   Heavy work (decode, resize, encode) happens in Web Workers through a small job queue,
   so the page stays responsive even with many large photos. */
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
  const MAX_AVIF_PIXELS = 40_000_000; // the WebAssembly AVIF encoder needs a lot of memory

  // ---------- interface language (strings come from the page, English is the fallback) ----------
  const I18N = window.IC_I18N || {};
  const tr = (k, d, vars) => {
    let s = I18N[k] || d;
    if (vars) for (const x in vars) s = s.split('{' + x + '}').join(vars[x]);
    return s;
  };
  const HINTS = {
    'image/webp': tr('hint_webp', 'WebP gives the smallest files for most photos.'),
    'image/jpeg': tr('hint_jpeg', 'JPEG opens everywhere, ideal for forms and email.'),
    'image/png': tr('hint_png', 'PNG is lossless, so the quality slider has no effect. Choose WebP or JPEG for bigger savings.'),
    'image/avif': tr('hint_avif', 'AVIF is often the smallest. The first use loads a small encoder, and large images take longer.'),
    original: tr('hint_original', 'Keeps each file in its own format.'),
  };
  // worker / browser errors arrive in English: map the known ones to the page language
  const localizeError = (e) => {
    const m = (e && e.message) || '';
    if (/too large for avif/i.test(m)) return tr('u_err_avif_large', 'Too large for AVIF in the browser. Try WebP or set a smaller max width.');
    if (/too large to process/i.test(m)) return tr('u_err_large', 'Image is too large to process in the browser');
    if (/could not be decoded|decode/i.test(m)) return tr('u_err_decode', 'This file could not be read as an image.');
    if (/could not encode|encoding failed/i.test(m)) return tr('u_err_encode', 'This browser could not encode the image');
    if (/avif encoder/i.test(m)) return tr('u_err_avif_load', 'Could not load the AVIF encoder');
    return tr('u_err_generic', 'Could not process this file');
  };
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
  const avifQuality = (q01) => {
    const slider = Math.round(q01 * 100);
    return Math.round(slider <= 90 ? slider * 0.78 : 70 + (slider - 90) * 2); // AVIF scale runs lower than JPEG
  };

  // Detect which output encoders this browser really has.
  function canEncode(type) {
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 1;
      return c.toDataURL(type).startsWith('data:' + type);
    } catch { return false; }
  }
  // Browsers rarely encode AVIF from a canvas, so fall back to a self-hosted WebAssembly encoder.
  const nativeAvif = canEncode('image/avif');
  const wasmAvif = typeof Worker !== 'undefined' && typeof WebAssembly === 'object';
  document.querySelectorAll('input[name="format"]').forEach((r) => {
    const ok = r.value === 'original' || canEncode(r.value) || (r.value === 'image/avif' && wasmAvif);
    if (!ok) {
      r.disabled = true;
      r.closest('.chip').title = tr('u_cant_create', 'Your browser cannot create this format');
      if (r.checked) { $('input[name="format"][value="image/webp"]').checked = true; }
    }
  });

  // ---------- worker pool ----------
  let useWorkers = typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined' &&
    typeof createImageBitmap === 'function' && 'convertToBlob' in OffscreenCanvas.prototype;
  const MAX_PAR = useWorkers
    ? Math.max(1, Math.min(2, Math.floor((navigator.hardwareConcurrency || 4) / 2)))
    : 1;
  const pool = { all: [], idle: [] };
  const pending = new Map(); // job id -> { res, rej, worker, item }
  let jobSeq = 0;

  function spawnWorker() {
    const w = new Worker('/compress-worker.js', { type: 'module' });
    w.onmessage = (e) => {
      const m = e.data;
      const p = pending.get(m.id);
      if (!p) return;
      if (m.status) { setStatus(p.item, /avif/i.test(m.status) ? tr('u_avif_loading', 'Loading AVIF encoder…') : tr('u_compressing', 'Compressing…')); return; }
      pending.delete(m.id);
      pool.idle.push(w);
      m.error ? p.rej(new Error(m.error)) : p.res(m);
    };
    w.onerror = () => {
      // the worker could not start (old browser): fall back to the main-thread engine
      useWorkers = false;
      pool.all = pool.all.filter((x) => x !== w);
      pool.idle = pool.idle.filter((x) => x !== w);
      pending.forEach((p, id) => {
        if (p.worker === w) { pending.delete(id); p.rej(Object.assign(new Error('worker failed'), { fallback: true })); }
      });
      w.terminate();
    };
    pool.all.push(w);
    return w;
  }
  const takeWorker = () => pool.idle.pop() || (pool.all.length < MAX_PAR ? spawnWorker() : null);

  function viaWorker(item, source, type, opts) {
    return new Promise((res, rej) => {
      const worker = takeWorker();
      if (!worker) { rej(Object.assign(new Error('no worker'), { fallback: true })); return; }
      const id = ++jobSeq;
      pending.set(id, { res, rej, worker, item });
      worker.postMessage({
        id, file: source, type, quality: opts.quality, maxWidth: opts.maxWidth,
        avifQ: avifQuality(opts.quality), nativeAvif,
      });
    });
  }

  // ---------- main-thread fallback engine ----------
  let avifWorker, avifSeq = 0, avifLoaded = false;
  const avifPending = new Map();
  function getAvifWorker() {
    if (avifWorker) return avifWorker;
    avifWorker = new Worker('/vendor/avif/avif-worker.js', { type: 'module' });
    avifWorker.onmessage = (e) => {
      const { id, buf, error } = e.data;
      const p = avifPending.get(id);
      if (!p) return;
      avifPending.delete(id);
      avifLoaded = true;
      error ? p.rej(new Error(error)) : p.res(new Blob([buf], { type: 'image/avif' }));
    };
    avifWorker.onerror = () => {
      avifPending.forEach((p) => p.rej(new Error('Could not load the AVIF encoder')));
      avifPending.clear();
      avifWorker = null;
    };
    return avifWorker;
  }
  function encodeAvifMain(imageData, quality01) {
    return new Promise((res, rej) => {
      const id = ++avifSeq;
      avifPending.set(id, { res, rej });
      const buf = imageData.data.buffer;
      getAvifWorker().postMessage({ id, data: buf, width: imageData.width, height: imageData.height, quality: avifQuality(quality01), speed: 7 }, [buf]);
    });
  }
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
  async function viaMain(item, source, type, opts) {
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
    if (type === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (w === w0 && h === h0) {
      ctx.drawImage(bmp, 0, 0);
    } else {
      // halve repeatedly (area averaging), then one smooth final step: avoids jagged, aliased edges
      let cur = bmp, cw = w0, ch = h0;
      while (cw / 2 >= w && ch / 2 >= h) {
        const nw = Math.max(w, Math.round(cw / 2)), nh = Math.max(h, Math.round(ch / 2));
        const c = el('canvas', { width: nw, height: nh });
        const x = c.getContext('2d');
        x.imageSmoothingQuality = 'high';
        x.drawImage(cur, 0, 0, nw, nh);
        if (cur !== bmp) { cur.width = 0; cur.height = 0; }
        cur = c; cw = nw; ch = nh;
      }
      ctx.drawImage(cur, 0, 0, w, h);
      if (cur !== bmp) { cur.width = 0; cur.height = 0; }
    }
    if (bmp.close) bmp.close();

    const s = Math.min(1, 160 / Math.max(w, h));
    const tc = el('canvas', { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) });
    tc.getContext('2d').drawImage(canvas, 0, 0, tc.width, tc.height);
    const thumb = await new Promise((r) => tc.toBlob(r, 'image/png'));

    let blob;
    if (type === 'image/avif' && !nativeAvif) {
      if (w * h > MAX_AVIF_PIXELS) throw new Error('Too large for AVIF in the browser. Try WebP or set a smaller max width.');
      if (!avifLoaded) setStatus(item, tr('u_avif_loading', 'Loading AVIF encoder…'));
      blob = await encodeAvifMain(ctx.getImageData(0, 0, w, h), opts.quality);
    } else {
      blob = await new Promise((res) => canvas.toBlob(res, type, opts.quality));
    }
    if (!blob) throw new Error('This browser could not encode the image');
    return { blob, thumb, w0, h0, w, h };
  }

  // ---------- job queue ----------
  const queue = [];
  let active = 0;
  let heicLock = Promise.resolve(); // HEIC conversion runs on the main thread: one at a time

  const isStale = (job) => !items.has(job.item.id) || job.item.token !== job.token;

  function pump() {
    while (active < MAX_PAR && queue.length) {
      const job = queue.shift();
      if (isStale(job)) continue; // superseded by newer settings, or removed
      active++;
      document.body.classList.add('busy');
      execute(job).finally(() => {
        active--;
        if (!active && !queue.length) document.body.classList.remove('busy');
        pump();
      });
    }
  }

  function convertHeic(item) {
    const task = heicLock.then(async () => {
      await loadScript(CDN.heic);
      const out = await window.heic2any({ blob: item.file, toType: 'image/jpeg', quality: 0.95 });
      item.source = Array.isArray(out) ? out[0] : out;
    });
    heicLock = task.catch(() => {});
    return task;
  }

  async function execute(job) {
    const { item, opts } = job;
    try {
      if (isHeic(item.file) && !item.source) {
        setStatus(item, tr('u_heic', 'Converting HEIC…'));
        await convertHeic(item);
        if (isStale(job)) return;
      }
      setStatus(item, tr('u_compressing', 'Compressing…'));
      const source = item.source || item.file;
      const sourceType = source.type || item.file.type;
      let type = opts.format === 'original' ? sourceType : opts.format;
      if (!EXT[type]) type = 'image/jpeg';

      let out;
      if (useWorkers) {
        try { out = await viaWorker(item, source, type, opts); }
        catch (e) { if (!e.fallback) throw e; out = await viaMain(item, source, type, opts); }
      } else {
        out = await viaMain(item, source, type, opts);
      }
      if (isStale(job)) return;
      item.result = await finish(item, out, type);
    } catch (e) {
      if (isStale(job)) return;
      item.error = localizeError(e);
    }
    render(item);
    updateSummary();
  }

  // ---------- metadata removal for files that are handed back without re-encoding ----------
  // Rotation lives in the EXIF Orientation tag, so it is kept as a tiny EXIF block (or we fall back to re-encoding).
  function exifOrientation(b, start, end) {
    if (end - start < 14) return 1;
    try {
      const le = b[start] === 0x49;
      const dv = new DataView(b.buffer, b.byteOffset + start, end - start);
      if (dv.getUint16(2, le) !== 42) return 1;
      const ifd = dv.getUint32(4, le);
      const n = dv.getUint16(ifd, le);
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12;
        if (dv.getUint16(e, le) === 0x0112) { const v = dv.getUint16(e + 8, le); return v >= 1 && v <= 8 ? v : 1; }
      }
    } catch (_) { /* malformed EXIF: treat as upright */ }
    return 1;
  }

  function stripJpeg(b) {
    if (b[0] !== 0xff || b[1] !== 0xd8) return null;
    const out = [b.subarray(0, 2)];
    let i = 2, orient = 1, insertAt = 1;
    while (i + 4 <= b.length) {
      if (b[i] !== 0xff) return null;
      const m = b[i + 1];
      if (m === 0xff) { i++; continue; }
      if (m === 0xda || m === 0xd9) break; // start of scan: the rest is image data
      if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) { out.push(b.subarray(i, i + 2)); i += 2; continue; }
      const len = (b[i + 2] << 8) | b[i + 3];
      if (len < 2 || i + 2 + len > b.length) return null;
      if (m === 0xe1 || m === 0xe3 || m === 0xed || m === 0xfe) { // EXIF/XMP, Kodak meta, Photoshop/IPTC, comments
        if (m === 0xe1 && b[i + 4] === 0x45 && b[i + 5] === 0x78 && b[i + 6] === 0x69 && b[i + 7] === 0x66 && orient === 1) {
          orient = exifOrientation(b, i + 10, i + 2 + len);
        }
      } else {
        out.push(b.subarray(i, i + 2 + len));
        if (m === 0xe0 && out.length === 2) insertAt = 2; // keep JFIF first
      }
      i += 2 + len;
    }
    if (orient > 1) {
      out.splice(insertAt, 0, Uint8Array.of(0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0, 0,
        0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orient, 0, 0, 0, 0, 0, 0));
    }
    out.push(b.subarray(i));
    return out;
  }

  function stripPng(b) {
    const sig = [137, 80, 78, 71, 13, 10, 26, 10];
    for (let k = 0; k < 8; k++) if (b[k] !== sig[k]) return null;
    const dv = new DataView(b.buffer, b.byteOffset, b.length);
    const out = [b.subarray(0, 8)];
    let i = 8;
    while (i + 12 <= b.length) {
      const len = dv.getUint32(i);
      const type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
      const end = i + 12 + len;
      if (end > b.length) return null;
      if (type === 'eXIf') { if (exifOrientation(b, i + 8, i + 8 + len) > 1) return null; }
      else if (type !== 'tEXt' && type !== 'zTXt' && type !== 'iTXt' && type !== 'tIME') out.push(b.subarray(i, end));
      i = end;
      if (type === 'IEND') break;
    }
    return out;
  }

  function stripWebp(b) {
    const tag = (o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
    if (b.length < 20 || tag(0) !== 'RIFF' || tag(8) !== 'WEBP') return null;
    const dv = new DataView(b.buffer, b.byteOffset, b.length);
    const parts = [];
    let i = 12, size = 4;
    while (i + 8 <= b.length) {
      const t = tag(i), len = dv.getUint32(i + 4, true);
      const end = i + 8 + len + (len & 1);
      if (i + 8 + len > b.length) return null;
      const stop = Math.min(end, b.length);
      if (t === 'EXIF') {
        const s = i + 8, off = (b[s] === 0x45 && b[s + 1] === 0x78) ? s + 6 : s;
        if (exifOrientation(b, off, i + 8 + len) > 1) return null;
      } else if (t !== 'XMP ') {
        const chunk = t === 'VP8X' ? b.slice(i, stop) : b.subarray(i, stop);
        if (t === 'VP8X') chunk[8] &= ~0x0c; // clear the EXIF and XMP flags
        parts.push(chunk);
        size += chunk.length;
      }
      i = end;
    }
    const head = new Uint8Array(12);
    head.set([0x52, 0x49, 0x46, 0x46], 0);
    new DataView(head.buffer).setUint32(4, size, true);
    head.set([0x57, 0x45, 0x42, 0x50], 8);
    return [head, ...parts];
  }

  async function stripMeta(file) {
    try {
      const b = new Uint8Array(await file.arrayBuffer());
      let parts = null;
      if (file.type === 'image/jpeg') parts = stripJpeg(b);
      else if (file.type === 'image/png') parts = stripPng(b);
      else if (file.type === 'image/webp') parts = stripWebp(b);
      return parts ? new Blob(parts, { type: file.type }) : null;
    } catch (_) { return null; }
  }

  // Never hand back a bigger file when nothing was changed on purpose. The original is returned only after its
  // metadata (camera, GPS, comments) has been removed without re-encoding; if that is not possible, the
  // re-encoded (metadata-free) output is used instead.
  async function finish(item, out, type) {
    let blob = out.blob;
    if (!blob) throw new Error('This browser could not encode the image');
    if (blob.type && blob.type !== type) type = blob.type; // browser fell back to another format
    const untouched = !item.source && type === item.file.type && out.w === out.w0 && out.h === out.h0;
    let note = '';
    if (untouched && blob.size >= item.file.size) {
      const clean = await stripMeta(item.file);
      if (clean && clean.size <= item.file.size) { blob = clean; note = 'optimized'; }
    }
    const base = item.file.name.replace(/\.[^.]+$/, '');
    return { blob, thumb: out.thumb, name: `${base}.${EXT[type] || 'jpg'}`, note };
  }

  // ---------- UI ----------
  function setStatus(item, text) {
    item.status = text;
    if (!item.result && !item.error && items.has(item.id)) render(item);
  }

  function freeUrls(it) {
    if (it.resultUrl) URL.revokeObjectURL(it.resultUrl);
    if (it.thumbUrl) URL.revokeObjectURL(it.thumbUrl);
    it.resultUrl = it.thumbUrl = null;
  }

  function render(item) {
    const row = item.row || (item.row = el('div', { className: 'row' }));
    row.className = 'row' + (item.error ? ' err' : '');
    row.replaceChildren();

    const thumb = el('img', { className: 'thumb', alt: '', decoding: 'async' });
    if (item.result) {
      item.resultUrl ||= URL.createObjectURL(item.result.blob);
      if (item.result.thumb) thumb.src = item.thumbUrl ||= URL.createObjectURL(item.result.thumb);
    }
    const name = el('div', { className: 'name' }, item.result ? item.result.name : item.file.name);
    row.append(thumb, name);

    if (item.error) {
      row.append(el('div', { className: 'meta' }, item.error), el('div', { className: 'actions' }, removeBtn(item)));
      return;
    }
    if (!item.result) {
      row.append(
        el('div', { className: 'state' }, el('span', { className: 'spinner' }), item.status || tr('u_waiting', 'Waiting…')),
        el('div', { className: 'actions' }, removeBtn(item))
      );
      return;
    }
    const before = item.file.size, after = item.result.blob.size;
    const pct = Math.round(((before - after) / before) * 100);
    const meta = el('div', { className: 'meta' },
      el('s', {}, fmtBytes(before)), document.documentElement.dir === 'rtl' ? '←' : '→', el('b', {}, fmtBytes(after)),
      el('span', { className: 'badge' + (pct > 0 ? '' : ' none') }, pct > 0 ? `−${pct}%` : tr('u_nogain', 'No gain')));
    if (item.result.note) meta.append(el('span', {}, tr('u_optimized', 'Already well optimized')));
    const dl = el('a', { className: 'btn small', href: item.resultUrl, download: item.result.name }, tr('u_download', 'Download'));
    const cmp = el('button', { className: 'btn small ghost', type: 'button', onclick: () => openCompare(item) }, tr('u_compare', 'Compare'));
    thumb.classList.add('zoomable');
    thumb.title = tr('u_compare_title', 'Compare before and after');
    thumb.onclick = () => openCompare(item);
    row.append(meta, el('div', { className: 'actions' }, cmp, dl, removeBtn(item)));
  }

  function openCompare(item) {
    if (!item.result) return;
    document.dispatchEvent(new CustomEvent('ic:compare', {
      detail: {
        name: item.result.name,
        original: item.source || item.file, // HEIC photos use their converted JPEG so the browser can show them
        result: item.result.blob,
        before: item.file.size,
        after: item.result.blob.size,
      },
    }));
  }

  function removeBtn(item) {
    return el('button', {
      className: 'x', type: 'button', title: tr('u_remove', 'Remove'), ariaLabel: tr('u_remove', 'Remove') + ' ' + item.file.name,
      onclick: () => remove(item.id),
    }, '×');
  }

  function remove(id) {
    const it = items.get(id);
    if (!it) return;
    freeUrls(it);
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
    const waiting = all.filter((i) => !i.result && !i.error).length;
    $('#summary-text').replaceChildren(
      done.length > 1 ? tr('u_sum_many', '{n} images · saved ', { n: done.length }) : tr('u_sum_one', '1 image · saved '),
      el('b', {}, `${fmtBytes(saved)} (${pct}%)`),
      waiting > 0 ? tr('u_more', ' · {n} more in progress', { n: waiting }) : '');
    zipBtn.hidden = done.length < 2;
  }

  function run(item) {
    const token = ++item.token;
    item.error = null;
    item.status = tr('u_waiting', 'Waiting…');
    freeUrls(item);
    item.result = null;
    render(item);
    queue.push({ item, token, opts: { ...settings } });
    pump();
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
        el('div', { className: 'name' }, tr('u_skipped', 'Skipped (unsupported type): ') + skipped.join(', ')));
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
      formatHint.textContent = HINTS[r.value] || '';
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
  // preset buttons keep the slider / width box in sync
  const qBtns = [...document.querySelectorAll('[data-q]')];
  const wBtns = [...document.querySelectorAll('[data-w]')];
  const syncPresets = () => {
    const w = parseInt(widthInput.value, 10) || 0;
    qBtns.forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.q === +qualityInput.value)));
    wBtns.forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.w === w)));
  };
  qBtns.forEach((b) => b.addEventListener('click', () => {
    qualityInput.value = b.dataset.q;
    qualityInput.dispatchEvent(new Event('input'));
  }));
  wBtns.forEach((b) => b.addEventListener('click', () => {
    widthInput.value = b.dataset.w === '0' ? '' : b.dataset.w;
    widthInput.dispatchEvent(new Event('input'));
  }));
  qualityInput.addEventListener('input', syncPresets);
  widthInput.addEventListener('input', syncPresets);
  syncPresets();

  clearBtn.addEventListener('click', () => [...items.keys()].forEach(remove));

  zipBtn.addEventListener('click', async () => {
    const done = [...items.values()].filter((i) => i.result);
    if (!done.length) return;
    const label = zipBtn.textContent;
    zipBtn.disabled = true;
    zipBtn.textContent = tr('u_zipping', 'Zipping…');
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
      alert(tr('u_zip_fail', 'Could not create the ZIP. Please download the images one by one.'));
    } finally {
      zipBtn.disabled = false;
      zipBtn.textContent = label;
    }
  });
})();
