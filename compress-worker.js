/* Image Compressor Now — compression worker.
   Decodes, resizes and encodes one image off the main thread so the page never freezes.
   Files stay on the device: this worker only talks to the page that created it. */
const MAX_PIXELS = 100_000_000;
const MAX_AVIF_PIXELS = 40_000_000;

let avifModule = null;
const loadAvif = () =>
  (avifModule ||= import('/vendor/avif/avif_enc.js').then((m) => m.default({ noInitialRun: true })));

async function thumbOf(canvas) {
  const s = Math.min(1, 160 / Math.max(canvas.width, canvas.height));
  const tw = Math.max(1, Math.round(canvas.width * s));
  const th = Math.max(1, Math.round(canvas.height * s));
  const t = new OffscreenCanvas(tw, th);
  t.getContext('2d').drawImage(canvas, 0, 0, tw, th);
  return t.convertToBlob({ type: 'image/png' });
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
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close();

    const thumb = await thumbOf(canvas);

    let blob;
    if (type === 'image/avif' && !nativeAvif) {
      if (w * h > MAX_AVIF_PIXELS) throw new Error('Too large for AVIF in the browser. Try WebP or set a smaller max width.');
      if (!avifModule) self.postMessage({ id, status: 'Loading AVIF encoder…' });
      const mod = await loadAvif();
      self.postMessage({ id, status: 'Compressing…' });
      const px = ctx.getImageData(0, 0, w, h);
      const out = mod.encode(new Uint8Array(px.data.buffer), w, h, {
        quality: avifQ, qualityAlpha: -1, denoiseLevel: 0, tileColsLog2: 0, tileRowsLog2: 0,
        speed: 7, subsample: 1, chromaDeltaQ: false, sharpness: 0, tune: 0, enableSharpYUV: false, bitDepth: 8,
      });
      if (!out) throw new Error('AVIF encoding failed');
      blob = new Blob([out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength)], { type: 'image/avif' });
    } else {
      blob = await canvas.convertToBlob({ type, quality });
    }
    self.postMessage({ id, blob, thumb, w0, h0, w, h });
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
