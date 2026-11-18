// Checks the Setup button is on-screen, tappable (not covered), and opens the modal — also after scrolling and with a simulated 59px notch.
const { chromium, devices } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const srv = http.createServer((q, r) => { const f = path.join(root, q.url.split('?')[0] === '/' ? 'index.html' : q.url.split('?')[0]); fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); r.end(d); }); });
const READY = () => document.documentElement.dataset.ready === '1';
(async () => {
  await new Promise((r) => srv.listen(0, r));
  const b = await chromium.launch(); let fail = 0;
  for (const notch of [0, 59]) {
    const ctx = await b.newContext({ ...devices['iPhone 14'], serviceWorkers: 'block' });
    const p = await ctx.newPage();
    await p.route(/cdn\.tailwindcss|cdnjs/, (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
    await p.goto('http://localhost:' + srv.address().port + '/'); await p.waitForFunction(READY);
    if (notch) await p.evaluate((n) => document.getElementById('appHeader').style.setProperty('padding-top', (n + 12) + 'px', 'important'), notch); // what env(safe-area-inset-top) resolves to on a notched iPhone
    await p.mouse.wheel(0, 600); await p.waitForTimeout(150);
    const box = await p.locator('#openSettingsBtn').boundingBox();
    const hit = await p.evaluate(() => { const r = document.getElementById('openSettingsBtn').getBoundingClientRect(); const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !!el.closest('#openSettingsBtn'); });
    await p.tap('#openSettingsBtn');
    const open = await p.locator('#settingsModal').isVisible();
    const good = box.y >= notch && box.height >= 40 && hit && open;
    console.log((good ? 'PASS' : 'FAIL') + ` notch=${notch}px y=${Math.round(box.y)} h=${Math.round(box.height)} tappable=${hit} modalOpens=${open}`);
    if (!good) fail++;
    if (notch) await p.screenshot({ path: process.env.SHOT || '/tmp/header.png' });
    await ctx.close();
  }
  await b.close(); srv.close(); process.exit(fail ? 1 : 0);
})();
