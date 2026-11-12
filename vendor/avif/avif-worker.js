/* Module worker: encodes RGBA pixels to AVIF with the self-hosted WebAssembly encoder. */
let mod;
const ready = import('./avif_enc.js')
  .then((m) => m.default({ noInitialRun: true }))
  .then((m) => (mod = m));

self.onmessage = async (e) => {
  const { id, data, width, height, quality, speed } = e.data;
  try {
    await ready;
    const out = mod.encode(new Uint8Array(data), width, height, {
      quality, qualityAlpha: -1, denoiseLevel: 0, tileColsLog2: 0, tileRowsLog2: 0,
      speed, subsample: 1, chromaDeltaQ: false, sharpness: 0, tune: 0,
      enableSharpYUV: false, bitDepth: 8,
    });
    if (!out) throw new Error('AVIF encoding failed');
    const buf = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
    self.postMessage({ id, buf }, [buf]);
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
