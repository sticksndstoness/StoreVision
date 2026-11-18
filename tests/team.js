// Sign-in, Team and Branches screens against an in-memory fake of Supabase (auth + REST + the team-admin function).
// The REAL permission rules are tested in tests/db (database) and tests/team-logic.test.mjs (function); this checks the app uses them sensibly.
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path'), { pathToFileURL } = require('url');
const root = path.join(__dirname, '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((q, r) => { const f = path.join(root, q.url.split('?')[0] === '/' ? 'index.html' : q.url.split('?')[0]); fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); r.end(d); }); });
const READY = () => document.documentElement.dataset.ready === '1';
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) fails++; };
const uuid = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (sub) => b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ sub, role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 }) + '.sig';

(async () => {
  const L = await import(pathToFileURL(path.join(root, 'supabase/functions/team-admin/logic.mjs')).href);
  await new Promise((r) => srv.listen(0, r));
  const base = 'http://localhost:' + srv.address().port + '/';

  /* ---------- fake backend ---------- */
  const BIL = uuid(901), O = uuid(1), A = uuid(2), H = uuid(3), N = uuid(4);
  const users = { 'owner@ex.com': { id: O, pw: 'ownerpass123' }, 'admin@ex.com': { id: A, pw: 'adminpass123' }, 'helper@ex.com': { id: H, pw: '123456' }, 'none@ex.com': { id: N, pw: 'nobody12345' } };
  const profiles = [
    { user_id: O, full_name: 'Olivia Owner', email: 'owner@ex.com', is_owner: true, active: true }, { user_id: A, full_name: 'Amit Admin', email: 'admin@ex.com', is_owner: false, active: true },
    { user_id: H, full_name: 'Hari Helper', email: 'helper@ex.com', is_owner: false, active: true }, { user_id: N, full_name: 'Nina Nobranch', email: 'none@ex.com', is_owner: false, active: true }];
  const memberships = [{ user_id: A, branch_id: BIL, role: 'admin', active: true }, { user_id: H, branch_id: BIL, role: 'counter', active: true }];
  const branches = [{ id: BIL, code: '6696', name: 'Bilaspur', active: true }];
  const fnCalls = [], restCalls = [];
  let nextId = 100;
  const callerOf = (req) => { const t = (req.headers()['authorization'] || '').replace(/^Bearer /, ''); try { return JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()).sub; } catch (e) { return null; } };
  const ctxOf = (id) => { const p = profiles.find((x) => x.user_id === id && x.active); return p ? { isOwner: p.is_owner, memberships: memberships.filter((m) => m.user_id === id) } : null; };
  const adminOfBranch = (id, b) => { const c = ctxOf(id); return !!c && (c.memberships.some((m) => m.active && m.branch_id === b && m.role === 'admin')); };

  const net = { offline: false };   // route.fulfill bypasses Playwright's own offline switch, so the fake server drops connections itself
  const handler = async (route) => {
    if (net.offline) return route.abort('connectionfailed');
    const req = route.request(), url = new URL(req.url()), p = url.pathname, method = req.method();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS', 'access-control-expose-headers': '*' };
    const send = (status, body, extra = {}) => route.fulfill({ status, headers: { ...cors, 'content-type': 'application/json', ...extra }, body: body === undefined ? '' : JSON.stringify(body) });
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (p === '/auth/v1/token') {
      const b = JSON.parse(req.postData() || '{}'); const u = users[String(b.email || '').toLowerCase()];
      if (!u || u.pw !== b.password) return send(400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials', error: 'invalid_grant', error_description: 'Invalid login credentials' });
      return send(200, { access_token: jwt(u.id), token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'rt-' + u.id, user: { id: u.id, aud: 'authenticated', role: 'authenticated', email: b.email, app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' } });
    }
    if (p === '/auth/v1/logout') return route.fulfill({ status: 204, headers: cors });
    if (p === '/auth/v1/user') { const id = callerOf(req); const pr = profiles.find((x) => x.user_id === id); return send(200, { id, aud: 'authenticated', role: 'authenticated', email: pr && pr.email, app_metadata: {}, user_metadata: {} }); }

    if (p === '/functions/v1/team-admin') {
      const caller = callerOf(req); const body = JSON.parse(req.postData() || '{}'); fnCalls.push(body);
      const me = ctxOf(caller); if (!me) return send(403, { error: 'Your account is not active.' });
      if (body.action === 'create_user') {
        const v = L.validateCreate(body); if (!v.ok) return send(400, { error: v.error });
        const a = L.authorizeCreate(me, v.value); if (!a.ok) return send(403, { error: a.error });
        if (profiles.some((x) => x.email === v.value.email)) return send(409, { error: 'This email already has a login. Ask an owner to add them to the branch.' });
        const id = uuid(nextId++); users[v.value.email] = { id, pw: v.value.password };
        profiles.push({ user_id: id, full_name: v.value.full_name, email: v.value.email, is_owner: false, active: true });
        memberships.push({ user_id: id, branch_id: v.value.branch_id, role: v.value.role, active: true }); return send(200, { ok: true, user_id: id });
      }
      if (body.action === 'reset_password') {
        const target = ctxOf(body.user_id); if (!target) return send(404, { error: 'Unknown or inactive person.' });
        const v = L.validateReset(body, target); if (!v.ok) return send(400, { error: v.error });
        const a = L.authorizeReset(me, target, caller, body.user_id); if (!a.ok) return send(403, { error: a.error });
        return send(200, { ok: true });
      }
      return send(400, { error: 'Unknown action.' });
    }

    if (p.startsWith('/rest/v1/')) {
      const table = p.split('/')[3], caller = callerOf(req), sel = url.searchParams.get('select') || '*'; restCalls.push(method + ' ' + table);
      const filters = [...url.searchParams.entries()].filter(([k]) => !['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'].includes(k)).map(([k, v]) => [k, String(v).replace(/^eq\./, '')]);
      const data = { profiles, memberships, branches }[table]; if (!data) return send(404, { message: 'no such table' });
      const match = (row) => filters.every(([k, v]) => String(row[k]) === v);
      const embed = (row) => { const o = { ...row }; if (/branches\(/.test(sel) && table === 'memberships') o.branches = branches.find((b) => b.id === row.branch_id) || null; if (/profiles\(/.test(sel) && table === 'memberships') o.profiles = profiles.find((x) => x.user_id === row.user_id) || null; return o; };
      const wantRep = /return=representation/.test(req.headers()['prefer'] || '');
      if (method === 'GET') return send(200, data.filter(match).map(embed));
      if (method === 'POST') {
        const row = JSON.parse(req.postData());
        if (table === 'branches') {
          if (!(ctxOf(caller) || {}).isOwner) return send(403, { code: '42501', message: 'new row violates row-level security policy for table "branches"' });
          if (branches.some((b) => b.code === row.code)) return send(409, { code: '23505', message: 'duplicate key value violates unique constraint "branches_code_key"' });
          const nr = { id: uuid(nextId++), active: true, ...row }; branches.push(nr); return wantRep ? send(201, [nr]) : send(201);
        }
        return send(403, { code: '42501', message: 'permission denied' });
      }
      if (method === 'PATCH') {
        const patch = JSON.parse(req.postData()); const rows = data.filter(match); const me = ctxOf(caller);
        const allowed = rows.filter((r) => {
          if (table === 'branches') return !!(me && me.isOwner);
          if (table === 'memberships') return !!me && (me.isOwner || (adminOfBranch(caller, r.branch_id) && ['manager', 'counter'].includes(r.role) && (patch.role === undefined || ['manager', 'counter'].includes(patch.role))));
          return false;
        });
        allowed.forEach((r) => Object.assign(r, patch)); return wantRep ? send(200, allowed) : send(204);
      }
    }
    return send(404, { message: 'not handled: ' + method + ' ' + p });
  };

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
