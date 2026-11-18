// Sign-in, Team and Branches screens against an in-memory fake of Supabase (auth + REST + the team-admin function).
// The REAL permission rules are tested in tests/db (database) and tests/team-logic.test.mjs (function); this checks the app uses them sensibly.
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path'), { pathToFileURL } = require('url');
const root = path.join(__dirname, '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((q, r) => { const f = path.join(root, q.url.split('?')[0] === '/' ? 'index.html' : q.url.split('?')[0]); fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); r.end(d); }); });
const READY = () => document.documentElement.dataset.ready === '1';
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails++; };

(async () => {
  const L = await import(pathToFileURL(path.join(root, 'supabase/functions/team-admin/logic.mjs')).href);
  await new Promise((r) => srv.listen(0, r));
  const base = 'http://localhost:' + srv.address().port + '/';

  const { createFake } = require('./helpers/fake-supabase.js');
  const fake = createFake(L);
  const { handler, net, fnCalls, restCalls, uuid } = fake;
  const { users, profiles, memberships, branches } = fake.state;
  const { BIL, O, A, H, N } = fake.ids;

  /* ---------- browser ---------- */
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' }); const pg = await ctx.newPage();
  const errs = [], csp = []; let promptValue = '12345678';
  pg.on('pageerror', (e) => errs.push(e.message)); pg.on('console', (m) => { if (/Content Security Policy|violates the following/i.test(m.text())) csp.push(m.text()); });
  pg.on('dialog', (d) => (d.type() === 'prompt' ? d.accept(promptValue) : d.accept()));
  await ctx.route('**/nobfqrutkoumhuakptje.supabase.co/**', handler);
  const login = async (email, pw) => { await pg.click('#accountBtn'); await pg.fill('#loginEmail', email); await pg.fill('#loginPassword', pw); await pg.click('#loginBtn'); };
  const visible = (sel) => pg.locator(sel).isVisible();
  const text = (sel) => pg.locator(sel).innerText();

  await pg.goto(base); await pg.waitForFunction(READY);
  ok(await visible('#accountBtn'), 'account button is in the header');
  await login('helper@ex.com', 'wrong-password'); await pg.waitForFunction(() => document.getElementById('loginMsg').textContent.length > 0);
  ok((await text('#loginMsg')).includes('Wrong email or password'), 'wrong password gives a plain-language message');

  /* helper */
  await pg.fill('#loginPassword', '123456'); await pg.click('#loginBtn'); await pg.waitForSelector('#acctSignedIn:not(.hidden)');
  ok((await text('#acctName')).includes('Hari Helper') && (await text('#acctRoles')).includes('Bilaspur') && (await text('#acctRoles')).includes('Helper'), 'helper sees their name, branch and role');
  ok(!(await visible('#openTeamBtn')) && !(await visible('#openBranchesBtn')), 'helper has no Team or Branches buttons');
  ok((await text('#accountBtnLabel')) === 'HH', 'header shows the initials of the signed-in person');
  await pg.click('#signOutBtn'); await pg.click('#accountBtn'); ok(await visible('#loginEmail'), 'sign out returns to the sign-in form');
  await pg.click('#closeAccountX');

  /* a login with no branch */
  await login('none@ex.com', 'nobody12345'); await pg.waitForSelector('#acctSignedIn:not(.hidden)');
  ok((await text('#acctNote')).includes('not set up for any branch'), 'a person with no branch is told to ask an admin');
  await pg.click('#signOutBtn');

  /* owner: branches */
  await login('owner@ex.com', 'ownerpass123'); await pg.waitForSelector('#acctSignedIn:not(.hidden)');
  ok((await text('#acctName')).includes('(Owner)') && (await visible('#openTeamBtn')) && (await visible('#openBranchesBtn')), 'owner sees Team and Branches');
  await pg.click('#openBranchesBtn'); await pg.waitForFunction(() => document.getElementById('branchList').innerText.includes('Bilaspur'));
  ok((await text('#branchList')).includes('SAP 6696'), 'Bilaspur is listed with its SAP code');
  await pg.fill('#newBranchName', 'Jhajjar'); await pg.fill('#newBranchCode', '!'); await pg.click('#addBranchBtn');
  ok((await text('#branchMsg')).includes('letters/numbers'), 'an invalid SAP code is rejected before contacting the server');
  await pg.fill('#newBranchCode', '7001'); await pg.click('#addBranchBtn'); await pg.waitForFunction(() => document.getElementById('branchList').innerText.includes('Jhajjar'));
  ok(branches.some((x) => x.code === '7001' && x.name === 'Jhajjar'), 'Jhajjar added from the app (no code change needed)');
  await pg.fill('#newBranchName', 'Copy'); await pg.fill('#newBranchCode', '6696'); await pg.click('#addBranchBtn'); await pg.waitForFunction(() => document.getElementById('branchMsg').textContent.includes('already exists'));
  ok(true, 'a duplicate SAP code gives a clear message');
  await pg.fill('#newBranchName', 'Jharli'); await pg.fill('#newBranchCode', '7002'); await pg.click('#addBranchBtn'); await pg.waitForFunction(() => document.getElementById('branchList').innerText.includes('Jharli'));
  ok(branches.length === 3, 'Jharli added too: 3 branches');
  await pg.click('#closeBranchesX');

  /* owner: team */
  await pg.click('#accountBtn'); await pg.click('#openTeamBtn'); await pg.waitForFunction(() => document.getElementById('teamList').innerText.includes('Hari Helper'));
  ok((await pg.locator('#teamBranchSelect option').count()) === 3, 'owner can pick any of the 3 branches');
  const roleOpts = await pg.locator('#newRole option').allTextContents(); ok(roleOpts.includes('Admin') && roleOpts.includes('Manager') && roleOpts.includes('Helper'), 'owner can assign every role');
  await pg.fill('#newName', 'Ravi Kumar'); await pg.fill('#newEmail', 'ravi@example.com'); await pg.selectOption('#newRole', 'counter'); await pg.fill('#newPassword', '12345'); await pg.click('#addPersonBtn');
  ok((await text('#teamMsg')).includes('at least 6'), 'a 5-character PIN is refused for a helper (rule shown before sending)');
  ok(fnCalls.length === 0, 'nothing was sent to the server for invalid input');
  await pg.fill('#newPassword', '123456'); await pg.click('#addPersonBtn'); await pg.waitForFunction(() => document.getElementById('teamList').innerText.includes('Ravi Kumar'));
  ok(fnCalls.length === 1 && fnCalls[0].action === 'create_user' && fnCalls[0].email === 'ravi@example.com' && fnCalls[0].role === 'counter' && fnCalls[0].branch_id === BIL, 'person created through the server function with the right data');
  ok((await text('#teamMsg')).includes('ravi@example.com'), 'the screen tells the admin what to give the new person');
  await pg.fill('#newName', 'Ravi Again'); await pg.fill('#newEmail', 'ravi@example.com'); await pg.selectOption('#newRole', 'counter'); await pg.fill('#newPassword', '123456'); await pg.click('#addPersonBtn');
  await pg.waitForFunction(() => document.getElementById('teamMsg').textContent.includes('already has a login'));
  ok(true, 'an email that already has a login is explained');
  const raviRow = pg.locator('#teamList > div', { hasText: 'Ravi Kumar' });
  await raviRow.locator('select[data-act=role]').selectOption('manager'); await pg.waitForFunction(() => document.getElementById('teamMsg').textContent.includes('Role changed'));
  ok(memberships.find((m) => m.user_id === users['ravi@example.com'].id).role === 'manager', 'role changed to manager');
  promptValue = '123'; await pg.locator('#teamList > div', { hasText: 'Ravi Kumar' }).locator('button[data-act=reset]').click(); await pg.waitForFunction(() => document.getElementById('teamMsg').textContent.includes('at least 8'));
  ok(true, 'a manager password shorter than 8 is refused by the server and explained');
  promptValue = 'longenough1'; await pg.locator('#teamList > div', { hasText: 'Ravi Kumar' }).locator('button[data-act=reset]').click(); await pg.waitForFunction(() => document.getElementById('teamMsg').textContent.includes('Password changed'));
  ok(fnCalls.some((c) => c.action === 'reset_password' && c.password === 'longenough1'), 'password reset goes through the server function');
  await pg.locator('#teamList > div', { hasText: 'Ravi Kumar' }).locator('button[data-act=toggle]').click(); await pg.waitForFunction(() => document.getElementById('teamList').innerText.includes('inactive'));
  ok(memberships.find((m) => m.user_id === users['ravi@example.com'].id).active === false, 'deactivate works and the row is shown as inactive');
  await pg.locator('#teamList > div', { hasText: 'Ravi Kumar' }).locator('button[data-act=toggle]').click(); await pg.waitForFunction(() => !document.getElementById('teamList').innerText.includes('inactive'));
  ok(true, 'reactivate works');
  ok((await pg.locator('#teamList > div', { hasText: 'Amit Admin' }).locator('select[data-act=role]').count()) === 1, 'owner has controls on an admin (branch admins do not)');
  await pg.click('#closeTeamX');

  /* session survives a reload */
  await pg.reload(); await pg.waitForFunction(READY); await pg.waitForFunction(() => document.getElementById('accountBtnLabel').textContent === 'OO');
  ok(true, 'the signed-in session is remembered after a reload');
  await pg.click('#accountBtn'); await pg.click('#signOutBtn');

  /* branch admin */
  await login('admin@ex.com', 'adminpass123'); await pg.waitForSelector('#acctSignedIn:not(.hidden)');
  ok((await visible('#openTeamBtn')) && !(await visible('#openBranchesBtn')), 'branch admin sees Team but not Branches');
  await pg.click('#openTeamBtn'); await pg.waitForFunction(() => document.getElementById('teamList').innerText.includes('Hari Helper'));
  ok((await pg.locator('#teamBranchSelect option').count()) === 1, 'branch admin can only pick their own branch');
  const aRoles = await pg.locator('#newRole option').allTextContents(); ok(!aRoles.includes('Admin') && aRoles.includes('Helper') && aRoles.includes('Manager'), 'branch admin cannot create another admin');
  ok((await pg.locator('#teamList > div', { hasText: 'Amit Admin' }).locator('button, select').count()) === 0, 'branch admin has no controls on their own row');
  await pg.click('#closeTeamX');
  await pg.click('#accountBtn'); await pg.click('#signOutBtn');

  /* offline */
  net.offline = true; await ctx.setOffline(true); await login('owner@ex.com', 'ownerpass123'); await pg.waitForFunction(() => document.getElementById('loginMsg').textContent.length > 0);
  ok((await text('#loginMsg')).includes('Cannot reach the server'), 'signing in while offline says so in plain words');
  net.offline = false; await ctx.setOffline(false);

  ok(csp.length === 0, 'no Content-Security-Policy violations' + (csp.length ? ': ' + csp[0] : ''));
  ok(errs.length === 0, 'no page errors ' + errs.join('|'));
  await b.close(); srv.close(); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
