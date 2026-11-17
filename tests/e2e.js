// Smoke test: node tests/e2e.js  (needs playwright; serves repo on localhost; all network mocked)
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((q, r) => { let f = path.join(root, q.url.split('?')[0] === '/' ? 'index.html' : q.url.split('?')[0]); fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); r.end(d); }); });
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails++; };

(async () => {
  await new Promise((r) => srv.listen(0, r));
  const base = 'http://localhost:' + srv.address().port + '/';
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  let syncMode = 'ok', geminiHeaders = null, geminiUrl = '';
  await page.route(/cdn\.tailwindcss|cdnjs/, (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await page.route('**/generativelanguage.googleapis.com/**', async (r) => {
    geminiHeaders = r.request().headers(); geminiUrl = r.request().url();
    const b = JSON.parse(r.request().postData());
    const isStack = b.contents[0].parts[0].text.includes('warehouse');
    const payload = isStack ? { bayTag: 'D2', items: [{ x: 200, y: 300 }, { x: 500, y: 500 }, { x: 'bad', y: 1 }, { x: 800, y: 700 }] }
      : { partNo: '<img src=x onerror=window.__xss=1>', description: 'AIR FILTER', barcode: 'CBL1', mrp: 100, mfgDate: '08/2026' };
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] }) });
  });
  await page.route('https://script.google.com/**', (r) => syncMode === 'ok' ? r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"ok":true}' })
    : r.fulfill({ status: 500, contentType: 'text/html', headers: { 'access-control-allow-origin': '*' }, body: 'boom' }));

  await page.goto(base);
  await page.evaluate(() => { localStorage.setItem('sv_gemini_key', 'KEY123'); localStorage.setItem('sv_webhook_url', 'https://script.google.com/macros/s/x/exec'); localStorage.setItem('sv_webhook_token', 'tok'); });
  await page.reload();

  // make a tiny jpeg
  const png = path.join(require('os').tmpdir(), 'sv_t.png');
  fs.writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC', 'base64'));

  await page.setInputFiles('#labelGallery', png);
  await page.waitForFunction(() => document.getElementById('partNoInput').value !== '');
  ok(geminiHeaders['x-goog-api-key'] === 'KEY123' && !geminiUrl.includes('KEY123'), 'API key sent in header, not URL');
  ok((await page.inputValue('#mrpInput')) === '100' && (await page.inputValue('#descInput')) === 'AIR FILTER' && (await page.inputValue('#mfgInput')) === '08/2026', 'label fields filled from AI');
  await page.setInputFiles('#stackGallery', png);
  await page.waitForFunction(() => document.querySelectorAll('#pinsLayer button').length > 0);
  ok((await page.locator('#pinsLayer button').count()) === 3, 'invalid AI pin dropped (3 of 4 kept)');
  ok((await page.inputValue('#zoneInput')) === 'D2', 'bay tag auto-filled');
  await page.selectOption('#depthMultSelect', '2'); await page.fill('#hiddenOffsetInput', '1');
  ok((await page.textContent('#totalQtyDisplay')).trim().startsWith('7'), 'total = 3*2+1 = 7');
  ok((await page.textContent('#totalValueDisplay')).includes('≈'), 'AI value shown as estimate');

  // pin remove + undo
  await page.locator('#pinsLayer button').first().click({ force: true });
  ok((await page.locator('#pinsLayer button').count()) === 2, 'pin removed');
  await page.click('#toastAction');
  ok((await page.locator('#pinsLayer button').count()) === 3, 'undo restores pin');

  // save + sync success
  await page.click('#saveSyncBtn');
  await page.waitForSelector('text=Synced');
  ok((await page.evaluate(() => window.__xss)) === undefined, 'XSS payload from OCR not executed');
  ok((await page.locator('#logList').innerHTML()).includes('&lt;img'), 'log escapes HTML');
  ok(await page.locator('#logList >> text=Synced').first().isVisible(), 'entry marked synced');
  ok((await page.inputValue('#partNoInput')) === '' && (await page.locator('#pinsLayer button').count()) === 0, 'form reset after save');
  ok((await page.inputValue('#zoneInput')) === 'D2', 'zone kept for next SKU');

  // failure path is NOT reported as success
  syncMode = 'fail';
  await page.fill('#partNoInput', 'SKU2'); await page.click('#pinControls', { force: true }).catch(() => {});
  await page.fill('#hiddenOffsetInput', '4'); await page.click('#saveSyncBtn');
  await page.waitForSelector('text=Sync failed');
  ok(true, 'server 500 shown as Sync failed (not success)');
  syncMode = 'ok'; await page.click('#retryAllBtn');
  await page.waitForFunction(() => !document.getElementById('retryAllBtn') || document.getElementById('retryAllBtn').classList.contains('hidden'));
  ok(true, 'retry syncs pending entries');

  // delete + undo
  const before = await page.textContent('#logCount');
  await page.locator('#logList button[data-act=delete]').first().click();
  ok((await page.textContent('#logCount')) === String(before - 1), 'delete works');
  await page.click('#toastAction'); ok((await page.textContent('#logCount')) === before, 'delete undo works');

  // corrupted storage doesn't brick the app
  await page.evaluate(() => localStorage.setItem('sv_inventory_log', '{not json'));
  await page.reload(); ok((await page.textContent('#logCount')) === '0', 'corrupt storage handled');

  ok(errors.length === 0, 'no page errors ' + errors.join('|'));
  await browser.close(); srv.close(); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
