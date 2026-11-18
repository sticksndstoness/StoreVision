/* On-device barcode / QR reader (window.SVScan). Deterministic, free, works offline: no AI involved.
 * A barcode on a label photo is often small compared with the whole picture, and ZXing finds small codes badly when it looks at the
 * whole image at once. So we look at the whole image first, then at overlapping tiles, until something is found or time runs out. */
(function (root) {
  'use strict';
  const SVScan = {};
  const Z = () => root.ZXing || (typeof require === 'function' ? require('@zxing/library') : null);

  function toLuma(rgba, w, h) {                          // 8-bit grey from RGBA
    const g = new Uint8ClampedArray(w * h);
    for (let i = 0, p = 0; i < g.length; i++, p += 4) g[i] = (rgba[p] * 299 + rgba[p + 1] * 587 + rgba[p + 2] * 114) / 1000;
    return g;
  }
  function crop(luma, w, x, y, cw, ch) {
    const out = new Uint8ClampedArray(cw * ch);
    for (let r = 0; r < ch; r++) out.set(luma.subarray((y + r) * w + x, (y + r) * w + x + cw), r * cw);
    return out;
  }

  function makeReader(zx) {
    const hints = new Map();
    hints.set(zx.DecodeHintType.TRY_HARDER, true);
    hints.set(zx.DecodeHintType.POSSIBLE_FORMATS, [zx.BarcodeFormat.CODE_128, zx.BarcodeFormat.CODE_39, zx.BarcodeFormat.CODE_93, zx.BarcodeFormat.EAN_13, zx.BarcodeFormat.EAN_8,
      zx.BarcodeFormat.UPC_A, zx.BarcodeFormat.ITF, zx.BarcodeFormat.QR_CODE, zx.BarcodeFormat.DATA_MATRIX]);
    const reader = new zx.MultiFormatReader(); reader.setHints(hints);
    return reader;
  }
  function tryDecode(zx, reader, luma, w, h) {
    try {
      const src = new zx.RGBLuminanceSource(luma, w, h);
      for (const bin of [new zx.HybridBinarizer(src), new zx.GlobalHistogramBinarizer(src)]) {     // two binarisers: glare / uneven light
        try { const r = reader.decode(new zx.BinaryBitmap(bin)); if (r && r.getText()) return { text: r.getText(), format: zx.BarcodeFormat[r.getBarcodeFormat()] }; } catch (e) { /* not found with this one */ }
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  /**
   * Find barcodes / QR codes in raw RGBA pixels. Returns [{text, format}] (unique). Never throws.
   * opts.maxMs bounds the work (default 3000 ms); opts.yield is awaited between passes so the page stays responsive.
   */
  SVScan.decode = async function (rgba, width, height, opts) {
    opts = opts || {};
    const zx = Z(); if (!zx || !rgba || !width || !height) return [];
    const maxMs = opts.maxMs == null ? 3000 : opts.maxMs, t0 = Date.now(), found = new Map();
    const reader = makeReader(zx), luma = toLuma(rgba, width, height);
    const add = (r) => { if (r && !found.has(r.text)) found.set(r.text, r); };
    const timeUp = () => Date.now() - t0 > maxMs;
    const pause = async () => { if (opts.yield) await opts.yield(); };

    add(tryDecode(zx, reader, luma, width, height));                                     // pass 1: whole picture
    const has1D = () => [...found.values()].some((r) => r.format !== 'QR_CODE' && r.format !== 'DATA_MATRIX');
    const grids = [[2, 2], [3, 3], [4, 4]];                                              // pass 2..: overlapping tiles, finer each time
    for (const [gx, gy] of grids) {
      if (has1D() && found.size >= 2) break;
      const tw = Math.ceil(width / gx), th = Math.ceil(height / gy), ox = Math.floor(tw * 0.3), oy = Math.floor(th * 0.3);
      for (let j = 0; j < gy; j++) for (let i = 0; i < gx; i++) {
        if (timeUp()) return [...found.values()];
        const x = Math.max(0, Math.min(width - tw, i * tw - ox)), y = Math.max(0, Math.min(height - th, j * th - oy));
        const cw = Math.min(width - x, tw + ox * 2), ch = Math.min(height - y, th + oy * 2);
        add(tryDecode(zx, reader, crop(luma, width, x, y, cw, ch), cw, ch));
        await pause();
      }
    }
    return [...found.values()];
  };

  /** Pick what to put in the "Barcode / Serial" field: a 1-D barcode beats a QR code; QR text is only used when short. */
  SVScan.pickBarcode = function (results) {
    const list = results || [];
    const oneD = list.find((r) => r.format !== 'QR_CODE' && r.format !== 'DATA_MATRIX');
    if (oneD) return oneD.text.trim();
    const qr = list.find((r) => r.text.length <= 60 && !/\s/.test(r.text.trim()));
    return qr ? qr.text.trim() : '';
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = SVScan; else root.SVScan = SVScan;
})(typeof self !== 'undefined' ? self : this);
