// Crash-resistance tests: persistence, migration, drafts, global error handling, backup/restore, audit trail,
// double-tap protection, storage-failure handling, multi-tab refresh, AI guard, CSP, and offline start.
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const root = path.join(__dirname, '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((q, r) => { const f = path.join(root, q.url.split('?')[0] === '/' ? 'index.html' : q.url.split('?')[0]); fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); r.end(d); }); });
const READY = () => document.documentElement.dataset.ready === '1';
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails++; };
const tmp = (n, c) => { const f = path.join(os.tmpdir(), n); fs.writeFileSync(f, c); return f; };
const png = tmp('sv_h.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC', 'base64'));

(async () => {
  await new Promise((r) => srv.listen(0, r));
  const base = 'http://localhost:' + srv.address().port + '/';
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true, serviceWorkers: 'block' });
  const p = await ctx.newPage();
  const cspViolations = [], pageErrors = [];
  const watch = (pg) => { pg.on('console', (m) => { if (/Content Security Policy|violates the following/i.test(m.text())) cspViolations.push(m.text()); }); pg.on('pageerror', (e) => pageErrors.push(e.message)); pg.on('dialog', (d) => d.accept()); };
  watch(p);
  await ctx.route('**/generativelanguage.googleapis.com/**', (r) => {
    const b = JSON.parse(r.request().postData()); const isStack = b.contents[0].parts[0].text.includes('warehouse');
    const payload = isStack ? { bayTag: 'D2', items: [{ x: 200, y: 300 }, { x: 500, y: 500 }] } : { partNo: 'P1', description: 'd', barcode: '', mrp: 0, mfgDate: '' };
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] }) });
  });
  await ctx.route('https://script.google.com/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"ok":true}' }));
  const go = async (pg = p) => { await pg.goto(base); await pg.waitForFunction(READY); };
  const reload = async (pg = p) => { await pg.reload(); await pg.waitForFunction(READY); };
  const count = async (pg = p) => Number(await pg.textContent('#logCount'));
  const quickSave = async (pg, part, qty) => { await pg.fill('#partNoInput', part); await pg.fill('#hiddenOffsetInput', String(qty)); await pg.click('#saveSyncBtn'); await pg.waitForFunction((n) => document.getElementById('partNoInput').value === '' && document.getElementById('logList').innerText.includes(n), part); };

  /* 1. v2 localStorage data (with junk rows) migrates into IndexedDB; old copy kept as backup */
  await go(); await p.evaluate(() => localStorage.setItem('sv_gemini_key', 'K'));
  const legacy = [{ id: 'old1', isoTime: new Date().toISOString(), zone: 'D1', partNo: 'OLD-1', totalQty: 4, mrp: 10, totalValue: 40, syncStatus: 'synced' }, null, 7, 'junk', { id: 'old1', partNo: 'dup' }, { zone: 'D2', partNo: 'V1-ROW', timestamp: '17/11/2026, 10:00:00', totalQty: 2, visibleCount: 2 }];
  await p.evaluate((d) => localStorage.setItem('sv_inventory_log', JSON.stringify(d)), legacy);
  await reload();
  ok((await count()) === 2, 'legacy rows migrated; junk and duplicate id dropped (2 valid of 6)');
  ok((await p.evaluate(() => localStorage.getItem('sv_inventory_log'))) === null && (await p.evaluate(() => localStorage.getItem('sv_inventory_log_migrated'))) !== null, 'old copy kept under a backup key, live key cleared');
  ok((await p.evaluate(() => SVDB.mode())) === 'idb', 'running on IndexedDB');
  await reload(); ok((await count()) === 2, 'no duplicate import on next load');

  /* 2. persistence across reload, double-tap protection */
  await p.fill('#partNoInput', 'DBL'); await p.fill('#hiddenOffsetInput', '3');
  await p.evaluate(() => { const b = document.getElementById('saveSyncBtn'); b.click(); b.click(); b.click(); });
  await p.waitForFunction(() => document.getElementById('partNoInput').value === '');
  ok((await count()) === 3, 'triple-tap on Save created exactly one entry');
  await reload(); ok((await count()) === 3 && (await p.locator('#logList').innerText()).includes('DBL'), 'saved entry survives reload');

  /* 3. draft autosave + restore + discard */
  await p.fill('#partNoInput', 'DRAFT-1'); await p.fill('#mrpInput', '250'); await p.fill('#hiddenOffsetInput', '5');
  await p.setInputFiles('#stackGallery', png); await p.waitForFunction(() => document.querySelectorAll('#pinsLayer button').length === 2);
  await p.waitForTimeout(900);
  await reload();
  ok((await p.inputValue('#partNoInput')) === 'DRAFT-1' && (await p.inputValue('#mrpInput')) === '250' && (await p.inputValue('#hiddenOffsetInput')) === '5', 'typed fields restored after reload');
  ok((await p.locator('#pinsLayer button').count()) === 2 && !(await p.locator('#stackImg').getAttribute('class')).includes('hidden'), 'photo and both pins restored');
  ok((await p.textContent('#toastMsg')).includes('Restored'), 'user is told a draft was restored');
  await p.click('#toastAction');
  ok((await p.inputValue('#partNoInput')) === '' && (await p.locator('#pinsLayer button').count()) === 0, 'Discard clears the draft');
  await p.waitForTimeout(900); await reload(); ok((await p.inputValue('#partNoInput')) === '', 'discarded draft does not come back');
  await p.fill('#partNoInput', 'HIDE-ME'); await p.evaluate(() => window.dispatchEvent(new Event('pagehide'))); await p.waitForTimeout(150);
  await reload(); ok((await p.inputValue('#partNoInput')) === 'HIDE-ME', 'draft is flushed immediately on pagehide (iOS tab kill)');
  await p.fill('#partNoInput', ''); await p.evaluate(() => window.dispatchEvent(new Event('pagehide')));

  /* 4. global error safety net */
  await p.evaluate(() => { document.getElementById('stackScanningOverlay').classList.remove('hidden'); setTimeout(() => { throw new Error('boom-sync'); }, 0); });
  await p.waitForSelector('#errorBanner:not(.hidden)');
  ok(await p.locator('#stackScanningOverlay').evaluate((e) => e.classList.contains('hidden')), 'stuck scanning overlay cleared after a crash');
  await p.click('#errorDismissBtn'); await p.evaluate(() => { Promise.reject(new Error('boom-promise')); });
  await p.waitForTimeout(100);
  await p.click('#openSettingsBtn'); await p.waitForFunction(() => Number(document.getElementById('errorCount').textContent) >= 2);
  ok(true, 'both a thrown error and a rejected promise are in the crash log');
  ok((await p.textContent('#storageInfo')).includes('IndexedDB'), 'diagnostics show storage mode');
  await p.click('#cancelSettingsBtn');
  ok(pageErrors.some((m) => m.includes('boom-sync')) && (await count()) === 3, 'app still usable and data intact after errors');

  /* 5. backup, wipe, restore (existing data never overwritten), audit trail */
  await quickSave(p, 'AUDIT-1', 7);
  await p.locator('#logList button[data-act=edit]').first().click();   // prompt auto-accepted with default value -> edit event
  await p.evaluate(() => { window.prompt = () => '11'; }); await p.locator('#logList button[data-act=edit]').first().click();
  await p.locator('#logList button[data-act=delete]').nth(1).click();
  await p.waitForTimeout(300);
  await p.click('#openSettingsBtn');
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#downloadBackupBtn')]);
  const bk = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
  ok(bk.format === 'storevision-backup' && bk.entries.length === (await count()), 'backup contains every current entry (' + bk.entries.length + ')');
  const types2 = new Set(bk.events.map((e) => e.type)); ok(['create', 'update', 'delete'].every((t) => types2.has(t)), 'audit trail has create/update/delete events: ' + [...types2].join(','));
  ok(bk.events.some((e) => e.type === 'delete' && e.before && e.before.partNo), 'deleted entry is fully recoverable from the audit event');
  ok(bk.events.some((e) => e.type === 'update' && e.before.totalQty !== e.after.totalQty), 'edit keeps the previous quantity in the audit event');
  await p.click('#cancelSettingsBtn');
  const total = await count();
  await p.click('#clearLogBtn'); await p.waitForFunction(() => document.getElementById('logCount').textContent === '0');
  await reload(); ok((await count()) === 0, 'log cleared (and stays cleared after reload)');
  const bkFile = tmp('sv_backup.json', JSON.stringify(bk));
  await p.click('#openSettingsBtn'); await p.setInputFiles('#restoreBackupInput', bkFile); await p.waitForFunction((n) => document.getElementById('logCount').textContent === String(n), total);
  ok((await count()) === total, 'restore brought back all ' + total + ' entries');
  await p.setInputFiles('#restoreBackupInput', bkFile); await p.waitForTimeout(300);
  ok((await count()) === total && (await p.textContent('#toastMsg')).includes('Nothing to restore'), 'restoring twice adds nothing');
  await p.setInputFiles('#restoreBackupInput', tmp('sv_bad.json', '{"hello":1}')); await p.waitForTimeout(300);
  ok((await p.textContent('#toastMsg')).includes('not a StoreVision backup'), 'invalid file rejected with a clear message');
  await p.setInputFiles('#restoreBackupInput', tmp('sv_bad2.json', 'not json at all')); await p.waitForTimeout(300);
  ok((await count()) === total, 'unparseable file does not damage data');
  await p.click('#cancelSettingsBtn');

  /* 6. storage failure: nothing is lost and nothing is faked */
  await p.fill('#partNoInput', 'FAIL-1'); await p.fill('#hiddenOffsetInput', '2');
  await p.evaluate(() => { window.__orig = SVDB.saveDiff; SVDB.saveDiff = () => Promise.reject(new Error('disk full')); });
  const before = await count(); await p.click('#saveSyncBtn'); await p.waitForTimeout(400);
  ok((await count()) === before && (await p.inputValue('#partNoInput')) === 'FAIL-1', 'failed write: entry not shown as saved, form content kept');
  ok((await p.textContent('#toastMsg')).includes('Could not save'), 'user is told the save failed');
  await p.evaluate(() => { SVDB.saveDiff = window.__orig; }); await p.click('#saveSyncBtn');
  await p.waitForFunction(() => document.getElementById('partNoInput').value === ''); ok((await count()) === before + 1, 'retry after the failure succeeds');

  /* 7. second tab: changes show up without reload */
  const p2 = await ctx.newPage(); watch(p2); await go(p2);
  await quickSave(p2, 'TAB2-ENTRY', 1);
  await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await p.waitForFunction(() => document.getElementById('logList').innerText.includes('TAB2-ENTRY'));
  ok(true, 'entry added in another tab appears when this tab is shown again');
  const n1 = await count(); await quickSave(p, 'TAB1-AFTER', 1);
  await reload(p2); ok((await count(p2)) === n1 + 1 && (await p2.locator('#logList').innerText()).includes('TAB1-AFTER') && (await p2.locator('#logList').innerText()).includes('TAB2-ENTRY'), 'two tabs do not overwrite each other');
  await p2.close();

  /* 8. AI guard */
  await p.evaluate(() => localStorage.setItem('sv_gemini_key', 'K')); await reload();
  await p.setInputFiles('#labelGallery', png); await p.waitForFunction(() => document.getElementById('partNoInput').value === 'P1');
  await p.setInputFiles('#labelGallery', png); await p.waitForFunction(() => document.getElementById('toastMsg').textContent.includes('wait a moment'));
  ok(true, 'rapid second AI request is blocked');
  await p.evaluate(() => localStorage.setItem('sv_ai_count', JSON.stringify({ day: new Date().toISOString().slice(0, 10), n: 400 })));
  await p.waitForTimeout(1100); await p.setInputFiles('#labelGallery', png); await p.waitForFunction(() => document.getElementById('toastMsg').textContent.includes('Daily AI limit'));
  ok(true, 'daily AI cap enforced');

  ok(cspViolations.length === 0, 'no Content-Security-Policy violations in any flow' + (cspViolations.length ? ': ' + cspViolations[0] : ''));
  await ctx.close();

  /* 9. offline start (service worker) */
  const ctx2 = await b.newContext({ viewport: { width: 390, height: 844 } }); const q = await ctx2.newPage(); watch(q);
  await go(q); await q.evaluate(() => navigator.serviceWorker.ready); await q.waitForFunction(() => !!navigator.serviceWorker.controller || true);
  await quickSave(q, 'OFFLINE-1', 2); await q.reload(); await q.waitForFunction(READY); await q.waitForTimeout(500);   // second load populates the cache
  await ctx2.setOffline(true); await q.reload(); await q.waitForFunction(READY, null, { timeout: 15000 });
  ok((await q.locator('#logList').innerText()).includes('OFFLINE-1'), 'app opens with no network and shows saved entries');
  ok(await q.locator('#offlineBadge').isVisible(), 'offline badge shown');
  await ctx2.setOffline(false); await b.close(); srv.close();
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
