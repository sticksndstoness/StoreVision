// Part identification in the browser: SAP part list on the phone (paged, cached, offline), label -> exact SAP part, suggestions, type-ahead.
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path'), { pathToFileURL } = require('url');
const root = path.join(__dirname, '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((q, r) => { const f = path.join(root, q.url.split('?')[0] === '/' ? 'index.html' : q.url.split('?')[0]); fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); r.end(d); }); });
const READY = () => document.documentElement.dataset.ready === '1';
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails++; };
const { photoFile } = require('./helpers/label-photo.js');

(async () => {
  const L = await import(pathToFileURL(path.join(root, 'supabase/functions/team-admin/logic.mjs')).href);
  const { createFake } = require('./helpers/fake-supabase.js');
  const fake = createFake(L); const { state, net, partListCalls } = fake; const { BIL } = fake.ids;

  /* a current SAP snapshot for Bilaspur: 4 real parts + 2,600 filler lines (so the list needs 3 pages of at most 1000) */
  const sid = fake.uuid(800);
  state.snapshots.push({ id: sid, branch_id: BIL, file_name: 'sap.xlsx', report_date: '2026-11-18', is_current: true, part_count: 0, row_count: 0, line_count: 0, uploaded_at: new Date().toISOString() });
  const add = (part_code, bin, description, book_qty = 7, unit_cost = 12345) => state.stock.push({ snapshot_id: sid, branch_id: BIL, part_code, bin, description, uom: 'EA', book_qty, available_qty: book_qty, blocked_qty: 0, unit_cost, mrp: unit_cost * 1.3, is_sensitive: true });
  add('PHJ00006', 'C01-E4', 'FUEL WATER SEPARATOR SPIN ON (SAP)'); add('PHJ00006', 'D02-C2', 'FUEL WATER SEPARATOR SPIN ON (SAP)'); add('PHJ00007', 'C01-E4', 'FUEL FILTER ELEMENT');
  add('F7B00100', 'PLAT', 'FF CUM WATER SEPARATOR SPIN-ON N4'); add('53XW001(L)', '18_C', 'LUBE OIL');
  for (let i = 0; i < 2600; i++) add('ZZ' + String(i).padStart(5, '0'), 'BIN' + (i % 40), 'FILLER PART ' + i);
  const TOTAL_LINES = state.stock.length, TOTAL_PARTS = 4 + 2600;           // 4 real parts (PHJ00006 sits in two bays) + 2,600 filler parts

  const big = await photoFile('p_big.png', 3000, 4000, 0.30), qrOnly = await photoFile('p_qr.png', 3000, 4000, 0.30, { oneD: false }), blank = await photoFile('p_blank.png', 1200, 1600, 0.30, { oneD: false, qr: false });
  await new Promise((r) => srv.listen(0, r)); const base = 'http://localhost:' + srv.address().port + '/';
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', acceptDownloads: true }); const pg = await ctx.newPage();
  const errs = [], csp = []; pg.on('pageerror', (e) => errs.push(e.message)); pg.on('console', (m) => { if (/Content Security Policy|violates the following/i.test(m.text())) csp.push(m.text()); });
  pg.on('dialog', (d) => d.accept());
  await ctx.route('**/nobfqrutkoumhuakptje.supabase.co/**', fake.handler);
  let aiPart = 'PHJ00006', aiDesc = 'AI DESCRIPTION';
  await ctx.route('**/generativelanguage.googleapis.com/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ partNo: aiPart, description: aiPart ? aiDesc : '', barcode: '', mrp: aiPart ? 3470 : 0, mfgDate: aiPart ? '11/2026' : '' }) }] } }] }) }));
  const text = (s) => pg.locator(s).innerText(); const visible = (s) => pg.locator(s).isVisible(); const val = (id) => pg.inputValue('#' + id);
  const READYWAIT = async () => { await pg.waitForFunction(READY); };
  const login = async (email, pw) => { await pg.click('#accountBtn'); await pg.fill('#loginEmail', email); await pg.fill('#loginPassword', pw); await pg.click('#loginBtn'); await pg.waitForSelector('#acctSignedIn:not(.hidden)'); await pg.click('#closeAccountX'); };
  const clean = async () => { await pg.evaluate(async () => { localStorage.removeItem('sv_ai_count'); await SVDB.clearDraft(); }); await pg.reload(); await READYWAIT(); await pg.waitForTimeout(1100); };
  const scan = async (file) => { await pg.setInputFiles('#labelGallery', file); await pg.waitForFunction(() => { const t = document.getElementById('labelStatus').textContent; return !t.startsWith('Reading the label') && !t.startsWith('Tip') && !t.includes('in the background'); }, null, { timeout: 60000 }); };

  await pg.goto(base); await READYWAIT(); await pg.evaluate(() => localStorage.setItem('sv_gemini_key', 'K')); await pg.reload(); await READYWAIT();
  ok(!(await visible('#partFinder')) && !(await visible('#partMatch')), 'signed out: no SAP part list, the label flow works as before');

  /* 1. sign in as a helper: the list arrives (paged), without quantities or prices */
  await login('helper@ex.com', '123456'); await pg.waitForSelector('#partFinder:not(.hidden)', { timeout: 20000 });
  await pg.waitForFunction((n) => document.getElementById('partListInfo').textContent.includes(n), TOTAL_PARTS.toLocaleString('en-IN'));
  ok(true, 'a helper gets the SAP part list: ' + (await text('#partListInfo')));
  ok(partListCalls.length === 3 && partListCalls.map((c) => c.offset).join() === '0,1000,2000' && partListCalls.reduce((a, c) => a + c.returned, 0) === TOTAL_LINES, 'the list needed 3 pages of at most 1000 rows and all ' + TOTAL_LINES + ' lines arrived');
  ok(partListCalls[0].keys.join() === 'snapshot_id,part_code,description,uom,bin,total_rows', 'the response has only snapshot, code, description, unit, bin, total: no quantity, cost or price');
  ok((await pg.evaluate((id) => SVDB.getMeta('parts:' + id), BIL)).rows.length === TOTAL_LINES && !JSON.stringify(await pg.evaluate((id) => SVDB.getMeta('parts:' + id), BIL)).includes('book_qty'), 'the phone cached the list (and the cache holds no quantities)');

  /* 2. label read by the AI -> the exact SAP part; SAP is the authority for the description */
  await clean(); aiPart = 'PHJ00006'; await scan(blank);
  ok((await val('partNoInput')) === 'PHJ00006' && (await val('descInput')) === 'FUEL WATER SEPARATOR SPIN ON (SAP)', 'the description comes from SAP, not from the AI');
  ok((await text('#partMatch')).includes('SAP part PHJ00006') && (await text('#partMatch')).includes('found by part number'), 'a green box confirms the SAP part and how it was found');
  const bins = await pg.locator('#partMatch button[data-act=bin]').allTextContents(); ok(bins.join() === 'C01-E4,D02-C2', 'the bays where SAP says this part lives are offered: ' + bins.join(' '));
  await pg.click('#partMatch button[data-act=bin][data-bin="D02-C2"]'); ok((await val('zoneInput')) === 'D02-C2', 'tapping a bay fills the Bay box');

  /* 3. a misread code (letter O for zero) is suggested, never silently accepted */
  await clean(); aiPart = 'PHJ0O006'; await scan(blank);
  ok((await val('partNoInput')) === 'PHJ0O006' && (await text('#partMatch')).includes('is not in the SAP list') && (await text('#partMatch')).includes('Did you mean'), 'a misread code is flagged and NOT replaced automatically');
  await pg.click('#partMatch button[data-act=pick][data-code="PHJ00006"]');
  ok((await val('partNoInput')) === 'PHJ00006' && (await text('#partMatch')).includes('SAP part PHJ00006'), 'tapping the suggestion corrects it');

  /* 4. a part that is not in SAP: allowed, marked, and flagged in the log */
  await clean(); aiPart = 'ZZZ999'; await scan(blank);
  ok((await text('#partMatch')).includes('not in the SAP list'), 'an unknown part gets a clear warning');
  await pg.fill('#hiddenOffsetInput', '3'); await pg.click('#saveSyncBtn'); await pg.waitForFunction(() => document.getElementById('logList').innerText.includes('ZZZ999'));
  ok((await text('#logList')).includes('not in SAP list'), 'the log shows "not in SAP list" for it');
  await pg.waitForTimeout(1100); aiPart = 'PHJ00006'; await clean(); await scan(blank); await pg.fill('#hiddenOffsetInput', '2'); await pg.click('#saveSyncBtn'); await pg.waitForFunction(() => document.getElementById('logCount').textContent === '2');
  const saved = await pg.evaluate(async () => (await SVDB.loadEntries()).entries.map((e) => [e.partNo, e.sapStatus]));
  ok(saved.some((e) => e[0] === 'ZZZ999' && e[1] === 'unmatched') && saved.some((e) => e[0] === 'PHJ00006' && e[1] === 'matched'), 'each saved entry remembers whether the part was in SAP: ' + JSON.stringify(saved));
  const [dl] = await Promise.all([pg.waitForEvent('download'), pg.click('#exportCsvBtn')]); const csv = fs.readFileSync(await dl.path(), 'utf8');
  ok(csv.split('\r\n')[0].includes('"In SAP list"') && csv.includes('"NO"') && csv.includes('"yes"'), 'the CSV export has an "In SAP list" column');

  /* 5. AI reads nothing, the QR code names the part */
  await clean(); aiPart = ''; await scan(qrOnly);
  ok((await val('partNoInput')) === 'PHJ00006' && (await text('#partMatch')).includes('found by QR / barcode'), 'AI blank, but the QR code on the label identified the exact SAP part');

  /* 6. type-ahead search */
  await clean(); aiPart = '';
  await pg.fill('#partSearch', 'water sep'); const res = await pg.locator('#partResults button').allTextContents();
  ok(res.length >= 2 && res.some((r) => r.includes('PHJ00006')) && res.some((r) => r.includes('F7B00100')), 'typing "water sep" lists the matching SAP parts');
  await pg.click('#partResults button[data-code="F7B00100"]'); ok((await val('partNoInput')) === 'F7B00100' && (await val('descInput')).includes('WATER SEPARATOR') && (await val('partSearch')) === '', 'picking a result fills the part and clears the search');

  /* 7. typing the code by hand is checked as well */
  await clean(); await pg.fill('#partNoInput', 'PHJ0007'); await pg.waitForSelector('#partMatch button[data-act=pick]');
  ok((await text('#partMatch')).includes('Did you mean') && (await pg.locator('#partMatch button[data-code="PHJ00007"]').count()) === 1, 'a code typed with one digit missing gets a suggestion');
  await pg.fill('#partNoInput', 'phj00007'); await pg.waitForFunction(() => document.getElementById('partMatch').textContent.includes('SAP part PHJ00007'));
  ok((await val('descInput')) === 'FUEL FILTER ELEMENT', 'a correct code typed in lower case is recognised and the description is filled');

  /* 8. offline: the cached list still works */
  await clean(); net.offline = true; await pg.reload(); await READYWAIT();      // the Supabase connection is down (the page itself still loads; offline page loads are tested in hardening.js)
  ok(await visible('#partFinder') && (await text('#partListInfo')).includes(TOTAL_PARTS.toLocaleString('en-IN')), 'offline after a reload: the cached SAP part list is still there');
  await pg.fill('#partNoInput', 'PHJ00006'); await pg.waitForFunction(() => document.getElementById('partMatch').textContent.includes('SAP part PHJ00006')); ok(true, 'and parts are still identified with no network');
  net.offline = false;

  /* 9. a cut-off list is never kept */
  await pg.reload(); await READYWAIT(); await pg.waitForFunction(() => document.getElementById('partListInfo').textContent.includes('updated'));
  const before = await text('#partListInfo'); net.shortPartList = true; partListCalls.length = 0;
  await pg.evaluate(() => window.dispatchEvent(new Event('online'))); await pg.waitForFunction(() => document.getElementById('partListInfo').textContent.includes('could not refresh'), null, { timeout: 20000 });
  ok((await pg.evaluate((id) => SVDB.getMeta('parts:' + id), BIL)).rows.length === TOTAL_LINES, 'a list that arrived incomplete was rejected; the previous complete list is kept');
  net.shortPartList = false;

  /* 10. signing out removes the list from the phone */
  await pg.click('#accountBtn'); await pg.click('#signOutBtn');
  await pg.waitForFunction(() => document.getElementById('partFinder').classList.contains('hidden'));
  ok((await pg.evaluate((id) => SVDB.getMeta('parts:' + id), BIL)) === null && !(await visible('#partMatch')), 'after signing out the SAP part list is deleted from the phone');
  await pg.reload(); await READYWAIT(); ok(!(await visible('#partFinder')), 'and stays gone after a reload');

  /* 11. owners (and anyone in several branches) choose which branch they are counting in */
  const JHA = fake.uuid(902), sid2 = fake.uuid(801);
  state.branches.push({ id: JHA, code: '7001', name: 'Jhajjar', active: true, sensitive_threshold: 10000 });
  state.snapshots.push({ id: sid2, branch_id: JHA, file_name: 'jha.xlsx', report_date: '2026-11-18', is_current: true, part_count: 2, row_count: 2, line_count: 2, uploaded_at: new Date().toISOString() });
  state.stock.push({ snapshot_id: sid2, branch_id: JHA, part_code: 'JH-0001', bin: 'A1', description: 'JHAJJAR PART ONE', uom: 'EA', book_qty: 1, unit_cost: 1 }, { snapshot_id: sid2, branch_id: JHA, part_code: 'JH-0002', bin: 'A2', description: 'JHAJJAR PART TWO', uom: 'EA', book_qty: 1, unit_cost: 1 });
  await login('owner@ex.com', 'ownerpass123'); await pg.click('#accountBtn');
  await pg.waitForFunction(() => !document.getElementById('countBranchWrap').classList.contains('hidden'));
  ok((await pg.locator('#countBranchSelect option').count()) === 2, 'an owner is offered a choice of branch to count in');
  await pg.selectOption('#countBranchSelect', JHA); await pg.waitForFunction(() => document.getElementById('partListInfo').textContent.includes('(2 parts'), null, { timeout: 20000 });
  ok(true, 'choosing Jhajjar loads Jhajjar\'s own part list (2 parts)'); await pg.click('#closeAccountX');
  await pg.fill('#partSearch', 'jhajjar part'); const jr = await pg.locator('#partResults button').allTextContents();
  ok(jr.length === 2 && jr.every((r) => r.includes('JH-')), 'and only Jhajjar parts are searchable now (no Bilaspur parts mixed in)');
  await pg.click('#accountBtn'); await pg.click('#signOutBtn');

  ok(csp.length === 0, 'no Content-Security-Policy violations' + (csp.length ? ': ' + csp[0] : ''));
  ok(errs.length === 0, 'no page errors ' + errs.join('|'));
  await b.close(); srv.close(); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
