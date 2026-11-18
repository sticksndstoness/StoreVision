// In-memory fake of the Supabase pieces the app talks to (auth, REST tables, RPC, the team-admin function).
// The REAL rules are tested in tests/db and tests/team-logic.test.mjs; this lets browser tests drive the UI realistically.
const path = require('path');
const uuid = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (sub) => b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ sub, role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 }) + '.sig';

function createFake(L) {
  const BIL = uuid(901), O = uuid(1), A = uuid(2), H = uuid(3), N = uuid(4);
  const users = { 'owner@ex.com': { id: O, pw: 'ownerpass123' }, 'admin@ex.com': { id: A, pw: 'adminpass123' }, 'helper@ex.com': { id: H, pw: '123456' }, 'none@ex.com': { id: N, pw: 'nobody12345' } };
  const profiles = [
    { user_id: O, full_name: 'Olivia Owner', email: 'owner@ex.com', is_owner: true, active: true }, { user_id: A, full_name: 'Amit Admin', email: 'admin@ex.com', is_owner: false, active: true },
    { user_id: H, full_name: 'Hari Helper', email: 'helper@ex.com', is_owner: false, active: true }, { user_id: N, full_name: 'Nina Nobranch', email: 'none@ex.com', is_owner: false, active: true }];
  const memberships = [{ user_id: A, branch_id: BIL, role: 'admin', active: true }, { user_id: H, branch_id: BIL, role: 'counter', active: true }];
  const branches = [{ id: BIL, code: '6696', name: 'Bilaspur', active: true, sensitive_threshold: 10000 }];
  const snapshots = [], stock = [];
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


    if (p === '/rest/v1/rpc/import_sap_snapshot') {
      const caller = callerOf(req), a = JSON.parse(req.postData() || '{}'), me = ctxOf(caller); restCalls.push('RPC import_sap_snapshot');
      if (!me || !(me.isOwner || adminOfBranch(caller, a.p_branch))) return send(403, { code: '42501', message: 'You are not allowed to upload SAP stock for this branch.' });
      const br = branches.find((x) => x.id === a.p_branch && x.active); if (!br) return send(400, { code: '22023', message: 'That branch is not available.' });
      if (String(a.p_branch_code || '').trim() !== br.code) return send(400, { code: '22023', message: 'This file is for SAP branch code "' + a.p_branch_code + '" but you chose ' + br.name + ' (code "' + br.code + '"). Nothing was uploaded.' });
      if (!Array.isArray(a.p_rows) || a.p_rows.length < 1) return send(400, { code: '22023', message: 'The file must contain between 1 and 60000 stock lines.' });
      snapshots.filter((s) => s.branch_id === br.id).forEach((s) => { s.is_current = false; });
      const sid = uuid(nextId++);
      snapshots.push({ id: sid, branch_id: br.id, file_name: a.p_file_name, report_date: a.p_report_date, line_count: a.p_line_count, part_count: new Set(a.p_rows.map((r) => r.part_code)).size, row_count: a.p_rows.length, uploaded_at: new Date().toISOString(), is_current: true, sensitive_threshold: br.sensitive_threshold });
      a.p_rows.forEach((r) => stock.push({ snapshot_id: sid, branch_id: br.id, ...r }));
      return send(200, sid);
    }

    if (p.startsWith('/rest/v1/')) {
      const table = p.split('/')[3], caller = callerOf(req), sel = url.searchParams.get('select') || '*'; restCalls.push(method + ' ' + table);
      const filters = [...url.searchParams.entries()].filter(([k]) => !['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'].includes(k)).map(([k, v]) => [k, String(v).replace(/^eq\./, '')]);
      const data = { profiles, memberships, branches, sap_snapshots: snapshots, sap_stock: stock }[table]; if (!data) return send(404, { message: 'no such table' });
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


  return { handler, net, state: { users, profiles, memberships, branches, snapshots, stock }, ids: { BIL, O, A, H, N }, fnCalls, restCalls, uuid, jwt, nextId: () => nextId++ };
}
module.exports = { createFake, uuid, jwt };
