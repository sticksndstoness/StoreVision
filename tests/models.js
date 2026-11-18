// Model picker: default present, "Check available models" lists + selects, choice is saved and used for API calls, custom ID works.
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const srv = http.createServer((q, r) => { const f = path.join(root, q.url.split('?')[0] === '/' ? 'index.html' : q.url.split('?')[0]); fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); r.end(d); }); });
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails++; };
(async () => {
  await new Promise((r) => srv.listen(0, r));
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' }); const p = await ctx.newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  let listKey = null, genUrl = null;
  await p.route(/cdn\.tailwindcss|cdnjs/, (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await p.route('**/generativelanguage.googleapis.com/v1beta/models?**', (r) => { listKey = r.request().headers()['x-goog-api-key']; r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ models: [
    { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] }, { name: 'models/gemini-3.1-pro', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] }, { name: 'models/embed-1', supportedGenerationMethods: ['embedContent'] }] }) }); });
  await p.route('**/generativelanguage.googleapis.com/v1beta/models/*:generateContent', (r) => { genUrl = r.request().url(); r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"partNo":"P1","description":"d","barcode":"","mrp":0,"mfgDate":""}' }] } }] }) }); });
  await p.goto('http://localhost:' + srv.address().port + '/');
  await p.evaluate(() => localStorage.setItem('sv_model', 'gemini-2.5-flash')); // retired value from older version
  await p.reload();
  await p.click('#openSettingsBtn');
  ok((await p.inputValue('#modelSelect')) === 'gemini-3.8-flash', 'retired stored model -> default selected');
  ok((await p.locator('#modelSelect option').allTextContents()).some((t) => t.includes('(default)')), 'default model is labelled');
  await p.fill('#apiKeyInput', 'KEY9'); await p.click('#checkModelsBtn');
  await p.waitForFunction(() => document.getElementById('modelStatus').textContent.startsWith('Found'));
  ok(listKey === 'KEY9', 'list call used the key from the form (header)');
  const opts = await p.locator('#modelSelect option').evaluateAll((o) => o.map((x) => x.value));
  ok(opts.includes('gemini-3.1-pro') && opts.includes('gemini-3.5-flash-lite') && !opts.includes('embed-1'), 'lists generateContent models only: ' + opts.join(','));
  await p.selectOption('#modelSelect', 'gemini-3.1-pro'); await p.click('#saveSettingsBtn');
  ok((await p.evaluate(() => localStorage.getItem('sv_model'))) === 'gemini-3.1-pro', 'chosen model saved');
  const png = path.join(require('os').tmpdir(), 'sv_m.png');
  fs.writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC', 'base64'));
  await p.setInputFiles('#labelGallery', png); await p.waitForFunction(() => document.getElementById('partNoInput').value === 'P1');
  ok(genUrl.includes('models/gemini-3.1-pro:'), 'scan uses the chosen model');
  await p.click('#openSettingsBtn'); ok((await p.inputValue('#modelSelect')) === 'gemini-3.1-pro', 'choice persists after reopening Setup');
  await p.selectOption('#modelSelect', '__custom__'); ok(await p.locator('#modelCustomInput').isVisible(), 'custom ID box appears');
  await p.fill('#modelCustomInput', 'gemini-9-test'); await p.click('#saveSettingsBtn');
  ok((await p.evaluate(() => localStorage.getItem('sv_model'))) === 'gemini-9-test', 'custom model ID saved');
  ok(errs.length === 0, 'no page errors ' + errs.join('|'));
  await b.close(); srv.close(); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
