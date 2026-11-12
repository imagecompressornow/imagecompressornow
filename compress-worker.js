/* Image Compressor Now — compression worker.
   Decodes, resizes and encodes one image off the main thread so the page never freezes.
   Encoders: MozJPEG, libwebp (sharp YUV), OxiPNG and AVIF, all WebAssembly, all self-hosted.
   Files stay on the device: this worker only talks to the page that created it. */
const MAX_PIXELS = 100_000_000;
const MAX_AVIF_PIXELS = 40_000_000;
const MAX_WEBP_SIDE = 16383;
const MAX_OXIPNG_PIXELS = 16_000_000;

const SIMD = WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));

let avifP, mozP, webpP, oxiP;
const getAvif = () => (avifP ||= import('/vendor/avif/avif_enc.js').then((m) => m.default({ noInitialRun: true })));
const getMoz = () => (mozP ||= import('/vendor/codecs/mozjpeg_enc.js').then((m) => m.default({ noInitialRun: true })));
const getWebp = () =>
  (webpP ||= import(SIMD ? '/vendor/codecs/webp_enc_simd.js' : '/vendor/codecs/webp_enc.js').then((m) => m.default({ noInitialRun: true })));
const getOxi = () =>
  (oxiP ||= import('/vendor/codecs/squoosh_oxipng.js').then(async (m) => { await m.default(); return m.optimise; }));

/* High-quality downscale: halve repeatedly (true area averaging), then one smooth final step.
   A single big jump with the browser's default resampling skips pixels and creates jagged,
   aliased edges, which is what made resized photos look bad. */
function resize(source, w, h) {
  let cur = source, cw = source.width, ch = source.height, own = false;
  while (cw / 2 >= w && ch / 2 >= h) {
    const nw = Math.max(w, Math.round(cw / 2)), nh = Math.max(h, Math.round(ch / 2));
    const c = new OffscreenCanvas(nw, nh);
    const x = c.getContext('2d');
    x.imageSmoothingEnabled = true;
    x.imageSmoothingQuality = 'high';
    x.drawImage(cur, 0, 0, nw, nh);
    if (own) { cur.width = 0; cur.height = 0; }
    cur = c; cw = nw; ch = nh; own = true;
  }
  return { img: cur, own };
}

async function thumbOf(canvas) {
  const s = Math.min(1, 160 / Math.max(canvas.width, canvas.height));
  const tw = Math.max(1, Math.round(canvas.width * s));
  const th = Math.max(1, Math.round(canvas.height * s));
  const t = new OffscreenCanvas(tw, th);
  const x = t.getContext('2d');
  x.imageSmoothingQuality = 'high';
  x.drawImage(canvas, 0, 0, tw, th);
  return t.convertToBlob({ type: 'image/png' });
}

const MOZ = (q) => ({
  quality: q, baseline: false, arithmetic: false, progressive: true, optimize_coding: true, smoothing: 0,
  color_space: 3, quant_table: 3, trellis_multipass: false, trellis_opt_zero: false, trellis_opt_table: false,
  trellis_loops: 1, auto_subsample: true, chroma_subsample: 2, separate_chroma_quality: false, chroma_quality: 75,
});
const WEBP = (q, method) => ({
  quality: q, target_size: 0, target_PSNR: 0, method, sns_strength: 50, filter_strength: 60, filter_sharpness: 0,
  filter_type: 1, partitions: 0, segments: 4, pass: 1, show_compressed: 0, preprocessing: 0, autofilter: 0,
  partition_limit: 0, alpha_compression: 1, alpha_filtering: 1, alpha_quality: 100, lossless: 0, exact: 0,
  image_hint: 0, emulate_jpeg_size: 0, thread_level: 0, low_memory: 0, near_lossless: 100,
  use_delta_palette: 0, use_sharp_yuv: 1,
});

async function encode(id, type, canvas, w, h, quality, avifQ, nativeAvif) {
  const q = Math.max(1, Math.min(100, Math.round(quality * 100)));

  if (type === 'image/avif' && !nativeAvif) {
    if (w * h > MAX_AVIF_PIXELS) throw new Error('Too large for AVIF in the browser. Try WebP or set a smaller max width.');
    if (!avifP) self.postMessage({ id, status: 'Loading AVIF encoder…' });
    const mod = await getAvif();
    self.postMessage({ id, status: 'Compressing…' });
    const px = canvas.getContext('2d').getImageData(0, 0, w, h);
    const out = mod.encode(new Uint8Array(px.data.buffer), w, h, {
      quality: avifQ, qualityAlpha: -1, denoiseLevel: 0, tileColsLog2: 0, tileRowsLog2: 0,
      speed: 7, subsample: 1, chromaDeltaQ: false, sharpness: 0, tune: 0, enableSharpYUV: false, bitDepth: 8,
    });
    if (!out) throw new Error('AVIF encoding failed');
    return new Blob([out.slice()], { type: 'image/avif' });
  }

  try {
    if (type === 'image/jpeg') {
      const mod = await getMoz();
      const px = canvas.getContext('2d').getImageData(0, 0, w, h);
      const out = mod.encode(px.data, w, h, MOZ(q));
      if (out && out.length) return new Blob([out.slice()], { type: 'image/jpeg' });
    } else if (type === 'image/webp' && w <= MAX_WEBP_SIDE && h <= MAX_WEBP_SIDE) {
      const mod = await getWebp();
      const px = canvas.getContext('2d').getImageData(0, 0, w, h);
      const out = mod.encode(px.data, w, h, WEBP(q, w * h > 12_000_000 ? 3 : 5));
      if (out && out.length) return new Blob([out.slice()], { type: 'image/webp' });
    } else if (type === 'image/png') {
      const plain = await canvas.convertToBlob({ type: 'image/png' });
      if (w * h <= MAX_OXIPNG_PIXELS) {
        const optimise = await getOxi();
        const out = optimise(new Uint8Array(await plain.arrayBuffer()), 3, false, false);
        if (out && out.length && out.length < plain.size) return new Blob([out.slice()], { type: 'image/png' });
      }
      return plain;
    }
  } catch (e) {
    /* encoder could not load or run: fall back to the browser's built-in encoder below */
  }
  return canvas.convertToBlob({ type, quality });
}

self.onmessage = async (e) => {
  const { id, file, type, quality, maxWidth, avifQ, nativeAvif } = e.data;
  try {
    const bmp = await createImageBitmap(file);
    const w0 = bmp.width, h0 = bmp.height;
    if (w0 * h0 > MAX_PIXELS) { bmp.close(); throw new Error('Image is too large to process in the browser'); }

    let w = w0, h = h0;
    if (maxWidth > 0 && w0 > maxWidth) {
      w = maxWidth;
      h = Math.max(1, Math.round(h0 * (w / w0)));
    }
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    if (type === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); } // JPEG has no alpha
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (w === w0 && h === h0) {
      ctx.drawImage(bmp, 0, 0);
    } else {
      const r = resize(bmp, w, h);
      ctx.drawImage(r.img, 0, 0, w, h);
      if (r.own) { r.img.width = 0; r.img.height = 0; }
    }
    bmp.close();

    const thumb = await thumbOf(canvas);
    const blob = await encode(id, type, canvas, w, h, quality, avifQ, nativeAvif);
    self.postMessage({ id, blob, thumb, w0, h0, w, h });
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
