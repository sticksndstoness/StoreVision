// Label scanning: the on-device barcode reader and the AI work together; every failure is visible and honest.
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const root = path.join(__dirname, '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((q, r) => { const f = path.join(root, q.url.split('?')[0] === '/' ? 'index.html' : q.url.split('?')[0]); fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); r.end(d); }); });
const READY = () => document.documentElement.dataset.ready === '1';
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails++; };

const { photoFile } = require('./helpers/label-photo.js');
const jpegLongSide = (b64) => { const b = Buffer.from(b64, 'base64'); let i = 2; while (i < b.length) { if (b[i] !== 0xff) { i++; continue; } const m = b[i + 1]; const len = b.readUInt16BE(i + 2); if (m >= 0xc0 && m <= 0xc3) return Math.max(b.readUInt16BE(i + 5), b.readUInt16BE(i + 7)); i += 2 + len; } return 0; };

(async () => {
  const big = await photoFile('lbl_big.png', 3000, 4000, 0.30);
  const qrOnly = await photoFile('lbl_qr.png', 3000, 4000, 0.30, { oneD: false });
  const blank = await photoFile('lbl_blank.png', 1200, 1600, 0.30, { oneD: false, qr: false });
  await new Promise((r) => srv.listen(0, r)); const base = 'http://localhost:' + srv.address().port + '/';
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' }); const pg = await ctx.newPage();
  const errs = [], csp = []; pg.on('pageerror', (e) => errs.push(e.message)); pg.on('console', (m) => { if (/Content Security Policy|violates the following/i.test(m.text())) csp.push(m.text()); });
  let mode = 'good', sentWidth = 0, lastReq = null, aiDelayMs = 0, busyCalls = 0; const reqUrls = [];
  const GOOD = { partNo: 'PHJ00006', description: 'FUEL WATER SEPARATOR SPIN ON', barcode: '', mrp: 3470, mfgDate: '11/2026' };
  await ctx.route('**/generativelanguage.googleapis.com/**', (r) => {
    const body = JSON.parse(r.request().postData()); lastReq = body; reqUrls.push(r.request().url());
    const BUSY = { status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.' } }) };
    if (mode === 'busy-once' && busyCalls++ === 0) return r.fulfill(BUSY);
    if (mode === 'busy-primary' && r.request().url().includes('gemini-3.8-flash')) return r.fulfill(BUSY); sentWidth = jpegLongSide(body.contents[0].parts[1].inline_data.data);
    if (mode === 'error') return r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Request payload is invalid' } }) });
    const payload = mode === 'empty' ? { partNo: '', description: '', barcode: '', mrp: 0, mfgDate: '' } : GOOD;
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] }) });
  });
  const fresh = async (key = true) => { await pg.goto(base); await pg.waitForFunction(READY); await pg.evaluate(async (k) => { k ? localStorage.setItem('sv_gemini_key', 'K') : localStorage.removeItem('sv_gemini_key'); localStorage.removeItem('sv_scanner'); localStorage.removeItem('sv_ai_count'); localStorage.removeItem('sv_model_list'); await SVDB.clearDraft(); }, key); await pg.reload(); await pg.waitForFunction(READY); await pg.waitForTimeout(1100); /* the AI rate guard needs >=1 s between calls */ };
  const scan = async (file) => { await pg.setInputFiles('#labelGallery', file); await pg.waitForFunction(() => { const t = document.getElementById('labelStatus').textContent; return !t.startsWith('Reading the label') && !t.startsWith('Tip') && !t.includes('in the background'); }, null, { timeout: 60000 }); };
  const val = (id) => pg.inputValue('#' + id); const status = () => pg.locator('#labelStatus').innerText();

  /* 1. everything works: small label in a big photo */
  await fresh(); mode = 'good'; await scan(big);
  ok((await val('barcodeInput')) === 'CBL0NL0050', 'the 1-D barcode was read ON THE PHONE (no AI needed): CBL0NL0050');
  ok((await val('partNoInput')) === 'PHJ00006' && (await val('mrpInput')) === '3470' && (await val('mfgInput')) === '11/2026' && (await val('descInput')).includes('FUEL WATER'), 'the AI filled part no, description, MRP and mfg date');
  ok(sentWidth === 1600, 'the photo sent to the AI is 1600 px on its longest side (' + sentWidth + '): sharper than the first version, far smaller than 2560');
  const gc = lastReq.generationConfig, prompt = lastReq.contents[0].parts[0].text;
  ok(!('responseSchema' in gc) && !('maxOutputTokens' in gc) && gc.responseMimeType === 'application/json', "the label request has the first version's simple shape (no rigid schema)");
  ok(prompt.startsWith('Extract spare part or product label details') && !prompt.includes('Do NOT guess'), "the first version's prompt is back and the restrictive 'do NOT guess' is gone");
  ok(/AI \d+\.\ds/.test(await status()) && (await status()).includes('scan ') && (await status()).includes('gemini-3.8-flash'), 'the status shows how long the AI and the scanner took, and which model');
  ok((await status()).includes('Barcode (scanned)') && (await status()).includes('Codes seen') && (await pg.locator('#labelStatus').getAttribute('class')).includes('emerald'), 'a green message lists what was read and which codes were seen');
  ok((await pg.locator('#labelPreviewImg').evaluate((i) => i.naturalWidth)) <= 900, 'the on-screen preview is a small copy (memory-friendly)');

  /* 1b. the AI answer appears first; the scanner works in the background and never blocks */
  await fresh(); mode = 'good'; await pg.setInputFiles('#labelGallery', big);
  await pg.waitForFunction(() => document.getElementById('partNoInput').value === 'PHJ00006', null, { timeout: 30000 });
  const early = await status(); const overlayGone = !(await pg.locator('#labelScanningOverlay').isVisible());
  ok(early.includes('in the background') && overlayGone && (await val('barcodeInput')) === '', 'AI fields appear first, the busy screen is gone, and the barcode is still being read in the background');
  await pg.waitForFunction(() => document.getElementById('barcodeInput').value === 'CBL0NL0050', null, { timeout: 30000 });
  ok(!(await status()).includes('in the background'), 'then the scanner fills the Barcode box and the message is updated');

  /* 1c. whatever the person types is never overwritten by a late scan */
  await fresh(); mode = 'good'; await pg.setInputFiles('#labelGallery', big);
  await pg.waitForFunction(() => document.getElementById('partNoInput').value === 'PHJ00006', null, { timeout: 30000 });
  await pg.fill('#barcodeInput', 'TYPED-BY-HAND');
  await pg.waitForFunction(() => !document.getElementById('labelStatus').textContent.includes('in the background'), null, { timeout: 30000 });
  ok((await val('barcodeInput')) === 'TYPED-BY-HAND', 'a barcode typed by hand is not replaced by the late scan');

  /* 1d. the scanner can be switched off in Setup */
  await fresh(); await pg.evaluate(() => localStorage.setItem('sv_scanner', '0')); await pg.reload(); await pg.waitForFunction(READY);
  mode = 'good'; await scan(big);
  ok(!(await status()).includes('scan ') && !(await status()).includes('background') && (await val('partNoInput')) === 'PHJ00006', 'scanner off: only the AI runs, nothing in the background');
  await pg.click('#openSettingsBtn'); ok(!(await pg.isChecked('#scannerToggle')), 'the Setup checkbox shows the scanner is off'); await pg.click('#cancelSettingsBtn');

  /* 2. AI fails, scanner still works */
  await fresh(); mode = 'error'; await scan(big);
  ok((await val('barcodeInput')) === 'CBL0NL0050', 'AI down: the barcode is still read');
  ok((await status()).includes('AI could not read the rest') && (await status()).includes('Request payload is invalid') && (await pg.locator('#labelStatus').getAttribute('class')).includes('amber'), 'AI down: a lasting amber message says exactly what happened');

  /* 3. AI says nothing and there is nothing to scan: must NOT claim success */
  await fresh(); mode = 'empty'; await scan(blank);
  ok((await status()).startsWith('Nothing could be read') && (await pg.locator('#labelStatus').getAttribute('class')).includes('rose'), 'unreadable photo: a red "nothing could be read" message with advice');
  ok(!(await pg.locator('#toastMsg').innerText()).includes('Label read'), 'and no false "label read" toast');
  ok((await val('partNoInput')) === '' && (await val('barcodeInput')) === '', 'no fields were filled with guesses');

  /* 4. no API key: scanner still works and the reason is shown */
  await fresh(false); mode = 'good'; await scan(big);
  ok((await val('barcodeInput')) === 'CBL0NL0050' && (await status()).includes('API Key'), 'no AI key: the barcode is read and the status explains the key is missing');

  /* 5. QR code only */
  await fresh(); mode = 'empty'; await scan(qrOnly);
  ok((await val('barcodeInput')) === 'PHJ00006|CBL0NL0050', 'a QR code alone is read and used');

  /* 6. scanner finds nothing, AI reads it */
  await fresh(); mode = 'good'; await scan(blank);
  ok((await val('partNoInput')) === 'PHJ00006' && !(await status()).includes('Codes seen'), 'no code in the photo: the AI result is used and no codes are claimed');
  ok((await status()).includes('Not found: Barcode'), 'the message lists what is still missing (Barcode)');

  /* 7. "this model is being used by a lot of people": retry once, then fall back to another model */
  await fresh(); mode = 'busy-once'; busyCalls = 0; reqUrls.length = 0; await scan(blank);
  ok(reqUrls.length === 2 && reqUrls.every((u) => u.includes('gemini-3.8-flash')) && (await val('partNoInput')) === 'PHJ00006', 'a one-off "high demand" answer is retried automatically and the label is read');
  await fresh(); await pg.evaluate(() => localStorage.setItem('sv_model_list', JSON.stringify([{ id: 'gemini-3.8-flash' }, { id: 'gemini-3.5-flash-lite' }]))); await pg.reload(); await pg.waitForFunction(READY); await pg.waitForTimeout(1100);
  mode = 'busy-primary'; reqUrls.length = 0; await scan(blank);
  ok(reqUrls.length === 3 && reqUrls[2].includes('gemini-3.5-flash-lite') && (await val('partNoInput')) === 'PHJ00006', 'a model that stays busy: after one retry the next model on your list is used');
  ok((await status()).includes('gemini-3.5-flash-lite') && (await status()).includes('was busy'), 'the status says which model answered and why');
  await fresh(); mode = 'busy-primary'; reqUrls.length = 0; await scan(blank);
  ok(reqUrls.length === 2 && (await status()).includes('busy right now') && (await status()).includes('pick another model'), 'no other model known: a clear "AI is busy" message with what to do (no crash, no false success)');

  ok(csp.length === 0, 'no Content-Security-Policy violations' + (csp.length ? ': ' + csp[0] : ''));
  ok(errs.length === 0, 'no page errors ' + errs.join('|'));
  await b.close(); srv.close(); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
