// SAP stock upload screen, driven through the real vendored Excel reader against an in-memory fake of Supabase.
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path'), { pathToFileURL } = require('url');
const root = path.join(__dirname, '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((q, r) => { const f = path.join(root, q.url.split('?')[0] === '/' ? 'index.html' : q.url.split('?')[0]); fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); r.end(d); }); });
const READY = () => document.documentElement.dataset.ready === '1';
const fx = (n) => path.join(__dirname, 'fixtures', n);
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails++; };
const isoDaysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

(async () => {
  const L = await import(pathToFileURL(path.join(root, 'supabase/functions/team-admin/logic.mjs')).href);
  const { createFake } = require('./helpers/fake-supabase.js');
  const fake = createFake(L); const { state, net, restCalls } = fake; const { BIL } = fake.ids;
  const JHA = fake.uuid(902); state.branches.push({ id: JHA, code: '7001', name: 'Jhajjar', active: true, sensitive_threshold: 10000 });
  await new Promise((r) => srv.listen(0, r)); const base = 'http://localhost:' + srv.address().port + '/';
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' }); const pg = await ctx.newPage();
  const errs = [], csp = []; let confirmText = '';
  pg.on('pageerror', (e) => errs.push(e.message)); pg.on('console', (m) => { if (/Content Security Policy|violates the following/i.test(m.text())) csp.push(m.text()); });
  pg.on('dialog', (d) => { confirmText = d.message(); d.accept(); });
  await ctx.route('**/nobfqrutkoumhuakptje.supabase.co/**', fake.handler);
  const text = (s) => pg.locator(s).innerText(); const visible = (s) => pg.locator(s).isVisible();
  const login = async (email, pw) => { await pg.click('#accountBtn'); await pg.fill('#loginEmail', email); await pg.fill('#loginPassword', pw); await pg.click('#loginBtn'); await pg.waitForSelector('#acctSignedIn:not(.hidden)'); };
  const openStock = async () => { await pg.click('#openStockBtn'); await pg.waitForSelector('#stockModal:not(.hidden)'); await pg.waitForFunction(() => !document.getElementById('stockCurrent').textContent.startsWith('Checking')); };
  const choose = async (file) => { await pg.setInputFiles('#stockFile', file); await pg.waitForSelector('#stockPreview:not(.hidden)'); };
  const errorsText = () => text('#spErrors'); const uploadDisabled = () => pg.locator('#stockUploadBtn').isDisabled();

  await pg.goto(base); await pg.waitForFunction(READY);

  /* helper: no SAP button */
  await login('helper@ex.com', '123456'); ok(!(await visible('#openStockBtn')), 'a helper has no SAP stock button'); await pg.click('#signOutBtn');

  /* owner */
  await login('owner@ex.com', 'ownerpass123'); ok(await visible('#openStockBtn'), 'owner sees the SAP stock button');
  await openStock();
  ok((await pg.locator('#stockBranchSelect option').count()) === 2, 'owner can pick any branch (Bilaspur, Jhajjar)');
  ok((await text('#stockCurrent')).includes('No SAP stock uploaded yet'), 'it says when nothing has been uploaded');
  await pg.selectOption('#stockBranchSelect', BIL);

  /* good file, no date in the file name */
  await choose(fx('sap_good.xlsx'));
  ok((await text('#spParts')) === '11' && (await text('#spLines')) === '12' && (await text('#spBins')) === '6', 'the real Excel reader found 11 parts, 12 part/bin lines, 6 bays');
  ok((await text('#spSens')).startsWith('2') && (await text('#spSens')).includes('10,000'), 'it reports 2 sensitive parts above ₹10,000');
  ok((await text('#spBranch')).includes('Bilaspur') && (await text('#spBranch')).includes('6696'), 'it confirms the file is for Bilaspur');
  ok((await uploadDisabled()) && (await errorsText()).includes('date of the SAP report'), 'upload is blocked until a report date is entered');
  await pg.fill('#spDate', isoDaysAgo(10));
  ok((await text('#spWarnings')).includes('10 days old') && !(await uploadDisabled()), 'an old report is warned about but allowed');
  await pg.fill('#spDate', isoDaysAgo(-3)); ok((await uploadDisabled()) && (await errorsText()).includes('future'), 'a future date is refused');
  await pg.fill('#spDate', isoDaysAgo(0)); ok(!(await uploadDisabled()) && !(await text('#spWarnings')).includes('days old'), "today's report has no age warning");
  await pg.click('#stockUploadBtn'); await pg.waitForFunction(() => document.getElementById('stockMsg').textContent.startsWith('Uploaded'));
  ok(confirmText.includes('11 parts') && confirmText.includes('Bilaspur') && confirmText.includes('kept in history'), 'the confirmation says what will happen');
  ok(state.snapshots.length === 1 && state.stock.length === 12 && state.snapshots[0].is_current, 'the server received the snapshot with 12 lines');
  ok(state.stock.every((r) => r.part_code && r.bin) && state.stock.some((r) => r.part_code === '0000123' && r.bin === 'NO BIN'), 'part codes with leading zeros reached the server intact');
  ok(!('sensitive' in state.stock[0]) && !('value' in state.stock[0]), 'only the needed fields are sent (the server decides what is sensitive)');
  await pg.waitForFunction(() => document.getElementById('stockCurrent').textContent.includes('sap_good.xlsx'));
  ok((await text('#stockCurrent')).includes('sap_good.xlsx') && (await text('#stockCurrent')).includes('11 parts') && (await text('#stockCurrent')).includes('today'), 'the screen now shows the current SAP stock');
  ok(!(await visible('#stockPreview')), 'the preview closes after a successful upload');

  /* problem files */
  await choose(fx('sap_truncated.xlsx')); ok((await uploadDisabled()) && (await errorsText()).includes('cut off'), 'a cut-off export is blocked with a clear reason');
  await choose(fx('sap_wrong_branch.xlsx')); ok((await uploadDisabled()) && (await errorsText()).includes('mixes several branches'), 'a file mixing branches is blocked');
  await choose(fx('sap_bad_number.xlsx')); ok((await uploadDisabled()) && (await errorsText()).includes('not a number'), 'unreadable numbers are blocked');
  const txt = path.join(os.tmpdir(), 'notes.txt'); fs.writeFileSync(txt, 'hello');
  await choose(txt); ok((await uploadDisabled()) && (await errorsText()).includes('Excel (.xlsx) or CSV'), 'a wrong file type is explained');
  const junk = path.join(os.tmpdir(), 'junk.xlsx'); fs.writeFileSync(junk, 'this is not a zip');
  await choose(junk); ok((await uploadDisabled()) && (await errorsText()).includes('could not be read'), 'a corrupt Excel file is explained, nothing crashes');
  ok(state.snapshots.length === 1, 'no problem file reached the server');

  /* wrong branch chosen */
  await pg.selectOption('#stockBranchSelect', JHA); await pg.waitForFunction(() => !document.getElementById('stockCurrent').textContent.startsWith('Checking'));
  await choose(fx('sap_good.xlsx')); await pg.fill('#spDate', isoDaysAgo(0));
  ok((await uploadDisabled()) && (await errorsText()).includes('branch code 6696') && (await errorsText()).includes('Jhajjar'), 'a Bilaspur file cannot be uploaded to Jhajjar (blocked on screen)');
  ok(state.snapshots.length === 1, 'and nothing was sent');
  await pg.selectOption('#stockBranchSelect', BIL); await pg.waitForFunction(() => document.getElementById('stockCurrent').textContent.includes('sap_good.xlsx'));

  /* CSV, a second upload, history */
  await choose(fx('sap_good.csv')); await pg.fill('#spDate', isoDaysAgo(0)); ok(!(await uploadDisabled()), 'a CSV of the same data is accepted');
  await pg.click('#stockUploadBtn'); await pg.waitForFunction(() => document.getElementById('stockMsg').textContent.startsWith('Uploaded'));
  ok(state.snapshots.length === 2 && state.snapshots.filter((s) => s.is_current).length === 1 && state.snapshots[1].is_current, 'a second upload becomes current and the first is kept as history');

  /* network failure */
  await choose(fx('sap_good.xlsx')); await pg.fill('#spDate', isoDaysAgo(0)); net.offline = true; await ctx.setOffline(true);
  await pg.click('#stockUploadBtn'); await pg.waitForFunction(() => document.getElementById('stockMsg').textContent.length > 0 && !document.getElementById('stockMsg').textContent.startsWith('Uploaded'));
  ok((await text('#stockMsg')).includes('Cannot reach the server') && state.snapshots.length === 2, 'offline: a plain message and nothing saved');
  net.offline = false; await ctx.setOffline(false); await pg.click('#closeStockX'); await pg.click('#accountBtn'); await pg.click('#signOutBtn');

  /* branch admin */
  await login('admin@ex.com', 'adminpass123'); await openStock();
  ok((await pg.locator('#stockBranchSelect option').count()) === 1 && (await text('#stockBranchSelect')).includes('Bilaspur'), 'a branch admin can only choose their own branch');
  await pg.click('#closeStockX');

  ok(csp.length === 0, 'no Content-Security-Policy violations' + (csp.length ? ': ' + csp[0] : ''));
  ok(errs.length === 0, 'no page errors ' + errs.join('|'));
  await b.close(); srv.close(); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
