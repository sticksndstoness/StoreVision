// Synthetic phone-photo generator: a small label (Code128 + QR) on a noisy background, like a picture of a box.
const fs = require('fs'), os = require('os'), path = require('path');
const bwip = require('bwip-js'); const { PNG } = require('pngjs');
async function photoFile(name, W, H, labelFrac, { oneD = true, qr = true } = {}) {
  const mk = async (o) => PNG.sync.read(await bwip.toBuffer({ backgroundcolor: 'FFFFFF', paddingwidth: 12, paddingheight: 12, ...o }));
  const bg = new PNG({ width: W, height: H });
  for (let i = 0; i < W * H; i++) { const v = 40 + ((Math.random() * 50) | 0); bg.data[i * 4] = 25; bg.data[i * 4 + 1] = v + 40; bg.data[i * 4 + 2] = v + 100; bg.data[i * 4 + 3] = 255; }
  const lw = Math.floor(W * labelFrac), lh = Math.floor(lw * 1.3), lx = Math.floor((W - lw) / 2), ly = Math.floor(H * 0.1);
  for (let y = ly; y < Math.min(H, ly + lh); y++) for (let x = lx; x < lx + lw; x++) { const p = (y * W + x) * 4; bg.data[p] = bg.data[p + 1] = bg.data[p + 2] = 240; }
  const place = (src, dx, dy, tw0) => { const f = tw0 / src.width, tw = Math.floor(src.width * f), th = Math.floor(src.height * f);
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) { const sx0 = Math.floor(x / f), sx1 = Math.max(sx0 + 1, Math.floor((x + 1) / f)), sy0 = Math.floor(y / f), sy1 = Math.max(sy0 + 1, Math.floor((y + 1) / f)); let a = 0, n = 0;
      for (let yy = sy0; yy < Math.min(src.height, sy1); yy++) for (let xx = sx0; xx < Math.min(src.width, sx1); xx++) { a += src.data[(yy * src.width + xx) * 4]; n++; }
      const dp = ((dy + y) * W + (dx + x) * 1) * 4; if (dy + y < H && dx + x < W) bg.data[dp] = bg.data[dp + 1] = bg.data[dp + 2] = a / Math.max(1, n); } };
  if (oneD) place(await mk({ bcid: 'code128', text: 'CBL0NL0050', scale: 3, height: 10, includetext: false }), lx + Math.floor(lw * 0.05), ly + Math.floor(lh * 0.55), Math.floor(lw * 0.58));
  if (qr) place(await mk({ bcid: 'qrcode', text: 'PHJ00006|CBL0NL0050', scale: 3 }), lx + Math.floor(lw * 0.68), ly + Math.floor(lh * 0.30), Math.floor(lw * 0.26));
  const f = path.join(os.tmpdir(), name); fs.writeFileSync(f, PNG.sync.write(bg)); return f;
}

module.exports = { photoFile };
