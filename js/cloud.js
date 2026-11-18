/* StoreVision cloud client (window.SVCloud): sign-in, who-am-I, team and branches.
 * All permissions are enforced by the database (Row Level Security) and the team-admin Edge Function; this file
 * only talks to them and turns errors into plain language. */
(function (root) {
  'use strict';
  const cfg = root.SV_CONFIG || {};
  const SVCloud = {};
  let client = null, ctx = null;
  const listeners = [];
  const TEAM_FN_TIMEOUT_MS = 25000;

  function init() {
    if (client) return client;
    if (!root.supabase || !cfg.supabaseUrl || !cfg.supabaseKey) return null;
    client = root.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });
    // keep this callback synchronous: calling supabase methods inside it can deadlock
    client.auth.onAuthStateChange((event) => { if (event === 'SIGNED_OUT') { ctx = null; emit(); } });
    return client;
  }
  function emit() { listeners.slice().forEach((fn) => { try { fn(ctx); } catch (e) { /* a broken listener must not break others */ } }); }

  /** Turn any error into one short sentence a store worker understands. */
  function friendly(err) {
    const msg = String((err && (err.message || err.error_description || err.error)) || err || '');
    const code = err && err.code;
    if (/Invalid login credentials/i.test(msg)) return 'Wrong email or password.';
    if (/Failed to fetch|NetworkError|Load failed|network/i.test(msg) || (typeof navigator !== 'undefined' && navigator.onLine === false)) return 'Cannot reach the server. Check the internet connection.';
    if (code === '42501' || /row-level security|permission denied/i.test(msg)) return 'You are not allowed to do that.';
    if (code === '23505' || /duplicate key|already exists/i.test(msg)) return 'That already exists.';
    if (/Email not confirmed/i.test(msg)) return 'This login is not confirmed yet. Ask an admin.';
    if (/rate limit|too many/i.test(msg)) return 'Too many tries. Wait a minute and try again.';
    return msg && msg.length < 140 ? msg : 'Something went wrong. Please try again.';
  }
  const fail = (err) => { throw new Error(friendly(err)); };

  SVCloud.available = () => !!init();
  SVCloud.friendly = friendly;
  SVCloud.context = () => ctx;
  SVCloud.onChange = (fn) => { listeners.push(fn); };

  SVCloud.signIn = async function (email, password) {
    if (!init()) throw new Error('The cloud connection is not set up.');
    const { error } = await client.auth.signInWithPassword({ email: String(email || '').trim().toLowerCase(), password: String(password || '') }).catch((e) => ({ error: e }));
    if (error) fail(error);
    return SVCloud.loadContext();
  };

  SVCloud.signOut = async function () {
    if (!init()) return;
    try { await client.auth.signOut(); } catch (e) { /* offline: clear locally below */ }
    ctx = null; emit();
  };

  /** Called on page load: resume a saved session if there is one. Never throws (the app must work signed out and offline). */
  SVCloud.restore = async function () {
    if (!init()) return null;
    try {
      const { data } = await client.auth.getSession();
      if (!data || !data.session) return null;
      return await SVCloud.loadContext();
    } catch (e) { return null; }
  };

  SVCloud.loadContext = async function () {
    if (!init()) return null;
    const { data: s } = await client.auth.getSession();
    const user = s && s.session && s.session.user;
    if (!user) { ctx = null; emit(); return null; }
    const [p, m] = await Promise.all([
      client.from('profiles').select('user_id, full_name, email, is_owner, active').eq('user_id', user.id).maybeSingle(),
      client.from('memberships').select('branch_id, role, active, branches(id, code, name, active)').eq('user_id', user.id)
    ]);
    if (p.error) fail(p.error);
    if (m.error) fail(m.error);
    ctx = {
      userId: user.id, email: user.email,
      profile: p.data || null,
      memberships: (m.data || []).map((r) => ({ branch_id: r.branch_id, role: r.role, active: r.active, branch: r.branches || null }))
    };
    emit();
    return ctx;
  };

  SVCloud.listBranches = async function () {
    init(); const { data, error } = await client.from('branches').select('id, code, name, active, sensitive_threshold').order('name');
    if (error) fail(error); return data || [];
  };
  SVCloud.addBranch = async function (name, code) {
    init(); const { data, error } = await client.from('branches').insert({ name, code }).select();
    if (error) { if (error.code === '23505') throw new Error('A branch with that SAP code already exists.'); fail(error); }
    return data && data[0];
  };
  SVCloud.setBranchActive = async function (id, active) {
    init(); const { data, error } = await client.from('branches').update({ active }).eq('id', id).select();
    if (error) fail(error); if (!data || !data.length) throw new Error('You are not allowed to do that.');
  };

  SVCloud.listTeam = async function (branchId) {
    init();
    const { data, error } = await client.from('memberships').select('user_id, branch_id, role, active, profiles(user_id, full_name, email, active)').eq('branch_id', branchId);
    if (error) fail(error);
    return (data || []).map((r) => ({ user_id: r.user_id, branch_id: r.branch_id, role: r.role, active: r.active, name: r.profiles ? r.profiles.full_name : '(unknown)', email: r.profiles ? r.profiles.email : '', profile_active: r.profiles ? r.profiles.active : true }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  };
  async function updateMembership(userId, branchId, patch) {
    init(); const { data, error } = await client.from('memberships').update(patch).eq('user_id', userId).eq('branch_id', branchId).select();
    if (error) fail(error);
    if (!data || !data.length) throw new Error('You are not allowed to change that person.');   // RLS hides rows silently
  }
  SVCloud.setRole = (u, b, role) => updateMembership(u, b, { role });
  SVCloud.setMemberActive = (u, b, active) => updateMembership(u, b, { active });

  /* ---------- SAP stock snapshots ---------- */
  SVCloud.currentSnapshot = async function (branchId) {
    init();
    const { data, error } = await client.from('sap_snapshots').select('id, file_name, report_date, line_count, part_count, row_count, uploaded_at, sensitive_threshold').eq('branch_id', branchId).eq('is_current', true).limit(1);
    if (error) fail(error);
    return data && data[0] ? data[0] : null;
  };
  /** Upload parsed rows. The server re-checks the branch code, the caller's role and every row, and stores it all-or-nothing. */
  SVCloud.importSap = async function ({ branchId, fileName, reportDate, branchCode, lineCount, rows }) {
    init();
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 90000);
    try {
      const payload = rows.map((r) => ({ part_code: r.part_code, bin: r.bin, description: r.description, uom: r.uom, book_qty: r.book_qty, available_qty: r.available_qty, blocked_qty: r.blocked_qty, unit_cost: r.unit_cost, mrp: r.mrp }));
      const { data, error } = await client.rpc('import_sap_snapshot', { p_branch: branchId, p_file_name: fileName, p_report_date: reportDate || null, p_branch_code: branchCode, p_line_count: lineCount, p_rows: payload }).abortSignal(ctl.signal);
      if (error) {
        if (error.code === '22023') throw new Error(error.message);              // our own plain-language refusals (wrong branch, bad data)
        fail(error);
      }
      return data;
    } catch (e) {
      if (e && (e.name === 'AbortError' || /abort/i.test(e.message || ''))) throw new Error('The upload took too long. Check the internet and try again; nothing was saved.');
      if (e instanceof Error && !/^[A-Z]?[a-z]+Error$/.test(e.name || '') && e.message) throw e;
      throw new Error(friendly(e));
    } finally { clearTimeout(timer); }
  };

  async function callTeam(action, payload) {
    init();
    const { data } = await client.auth.getSession();
    if (!data || !data.session) throw new Error('Please sign in again.');
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), TEAM_FN_TIMEOUT_MS);
    try {
      const res = await fetch(cfg.supabaseUrl + '/functions/v1/team-admin', {
        method: 'POST', signal: ctl.signal,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + data.session.access_token, apikey: cfg.supabaseKey },
        body: JSON.stringify({ action, ...payload })
      });
      let body = {}; try { body = await res.json(); } catch (e) { /* non-JSON error page */ }
      if (!res.ok || body.error) throw new Error(body.error || (res.status === 404 ? 'The team service is not installed yet. Ask the developer to deploy it.' : 'Could not complete that. Please try again.'));
      return body;
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error('That took too long. Check the internet and try again.');
      throw new Error(friendly(e));
    } finally { clearTimeout(timer); }
  }
  SVCloud.createPerson = (p) => callTeam('create_user', p);
  SVCloud.resetPassword = (userId, password) => callTeam('reset_password', { user_id: userId, password });

  root.SVCloud = SVCloud;
})(typeof self !== 'undefined' ? self : this);
