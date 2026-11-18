// Barcode scanner unit tests (clean generated codes, junk input, and how the Barcode box value is chosen).
const assert = require('assert');
const bwip = require('bwip-js'); const { PNG } = require('pngjs');
const SVScan = require('../js/scan.js');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };
const img = async (o) => PNG.sync.read(await bwip.toBuffer({ backgroundcolor: 'FFFFFF', paddingwidth: 14, paddingheight: 14, ...o }));
const dec = async (o) => { const p = await img(o); return SVScan.decode(p.data, p.width, p.height, { maxMs: 3000 }); };

(async () => {
  await t('reads Code 128', async () => { const r = await dec({ bcid: 'code128', text: 'CBL0NL0050', scale: 3, height: 10, includetext: false }); assert.deepStrictEqual(r.map((x) => [x.format, x.text]), [['CODE_128', 'CBL0NL0050']]); });
  await t('reads QR codes', async () => { const r = await dec({ bcid: 'qrcode', text: 'PHJ00006|CBL0NL0050', scale: 3 }); assert.strictEqual(r[0].format, 'QR_CODE'); assert.strictEqual(r[0].text, 'PHJ00006|CBL0NL0050'); });
  await t('reads EAN-13 and Code 39', async () => {
    assert.strictEqual((await dec({ bcid: 'ean13', text: '4006381333931', scale: 3, height: 12, includetext: false }))[0].text, '4006381333931');
    assert.strictEqual((await dec({ bcid: 'code39', text: 'AB-123', scale: 3, height: 12, includetext: false }))[0].text, 'AB-123');
  });
  await t('an image with no code returns an empty list quickly', async () => {
    const w = 600, h = 400, px = new Uint8ClampedArray(w * h * 4).fill(200); const t0 = Date.now();
    assert.deepStrictEqual(await SVScan.decode(px, w, h, { maxMs: 1500 }), []); assert.ok(Date.now() - t0 < 4000);
  });
  await t('junk input never throws', async () => {
    for (const a of [[null, 0, 0], [new Uint8ClampedArray(4), 1, 1], [undefined, 10, 10], [new Uint8ClampedArray(0), 0, 0]]) assert.deepStrictEqual(await SVScan.decode(...a), []);
  });
  await t('the time limit is respected', async () => {
    const w = 3000, h = 3000, px = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < px.length; i += 4) { const v = (Math.random() * 255) | 0; px[i] = px[i + 1] = px[i + 2] = v; px[i + 3] = 255; }
    const t0 = Date.now(); await SVScan.decode(px, w, h, { maxMs: 1500 }); assert.ok(Date.now() - t0 < 9000, 'took ' + (Date.now() - t0) + ' ms');
  });
  await t('pickBarcode prefers 1-D, falls back to a short QR, ignores long/spaced QR text', () => {
    assert.strictEqual(SVScan.pickBarcode([{ format: 'QR_CODE', text: 'Q1' }, { format: 'CODE_128', text: 'C128' }]), 'C128');
    assert.strictEqual(SVScan.pickBarcode([{ format: 'QR_CODE', text: ' SHORT-QR ' }]), 'SHORT-QR');
    assert.strictEqual(SVScan.pickBarcode([{ format: 'QR_CODE', text: 'has spaces in it' }]), '');
    assert.strictEqual(SVScan.pickBarcode([{ format: 'QR_CODE', text: 'x'.repeat(61) }]), '');
    assert.strictEqual(SVScan.pickBarcode([]), ''); assert.strictEqual(SVScan.pickBarcode(null), '');
  });
  console.log(`\n${n} scanner tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
