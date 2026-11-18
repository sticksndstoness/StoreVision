// @ts-nocheck
// GENERATED FILE - do not edit. Source: tools/team-admin.handler.ts + supabase/functions/team-admin/logic.mjs (run `npm run build:fn`).
// Supabase Edge Function: create logins and reset passwords for StoreVision.
// Needs the service key, which only exists on the server (Supabase provides SUPABASE_SERVICE_ROLE_KEY to functions
// automatically). The browser never sees it. Every request is authenticated and authorised here; all rules live in logic.mjs.
import { createClient } from 'npm:@supabase/supabase-js@2';

// Pure rules for the team-admin Edge Function (no Supabase, no network) so they can be unit-tested in Node.
// "caller" and "target" look like: { isOwner: boolean, memberships: [{ branch_id, role, active }] } (profile already known to be active).

const ROLES = ['admin', 'manager', 'counter'];
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[A-Za-z]{2,}$/;

function normaliseEmail(v) { return String(v == null ? '' : v).trim().toLowerCase(); }

/** Counters (helpers) may use a 6-character PIN/password; every other role needs 8+. */
function minPasswordLength(role) { return role === 'counter' ? 6 : 8; }

function validateCreate(input) {
  const i = input && typeof input === 'object' ? input : {};
  const email = normaliseEmail(i.email);
  const full_name = String(i.full_name == null ? '' : i.full_name).trim();
  const role = String(i.role || '');
  const password = typeof i.password === 'string' ? i.password : '';
  const branch_id = String(i.branch_id || '');
  if (!full_name || full_name.length > 80 || /[\u0000-\u001f]/.test(full_name)) return { ok: false, error: 'Enter the person\'s name (up to 80 characters).' };
  if (!EMAIL_RE.test(email) || email.length > 254) return { ok: false, error: 'Enter a valid email address.' };
  if (!ROLES.includes(role)) return { ok: false, error: 'Choose a role.' };
  if (!/^[0-9a-f-]{36}$/i.test(branch_id)) return { ok: false, error: 'Choose a branch.' };
  if (password.length < minPasswordLength(role)) return { ok: false, error: `Password/PIN must be at least ${minPasswordLength(role)} characters.` };
  if (password.length > 72) return { ok: false, error: 'Password is too long (max 72).' };
  return { ok: true, value: { email, full_name, role, branch_id, password } };
}

const activeAdminOf = (caller, branchId) => (caller.memberships || []).some((m) => m.active && m.branch_id === branchId && m.role === 'admin');

/** Who may create which login. Owner: anything. Branch admin: managers and counters in their own branch. */
function authorizeCreate(caller, { branch_id, role }) {
  if (!caller) return { ok: false, error: 'Not allowed.' };
  if (caller.isOwner) return { ok: true };
  if (activeAdminOf(caller, branch_id)) {
    if (role === 'manager' || role === 'counter') return { ok: true };
    return { ok: false, error: 'Only an owner can create another admin.' };
  }
  return { ok: false, error: 'You are not an admin of that branch.' };
}

/** Password resets: owners reset anyone except other owners; branch admins reset managers/counters who work in a branch they administer. */
function authorizeReset(caller, target, callerId, targetId) {
  if (!caller || !target) return { ok: false, error: 'Not allowed.' };
  if (target.isOwner && callerId !== targetId) return { ok: false, error: 'Owners reset their own password.' };
  if (caller.isOwner) return { ok: true };
  const tm = (target.memberships || []).filter((m) => m.active);
  const shared = tm.some((m) => activeAdminOf(caller, m.branch_id));
  const onlyLow = tm.every((m) => m.role === 'manager' || m.role === 'counter');
  if (shared && onlyLow) return { ok: true };
  return { ok: false, error: 'You cannot reset this person\'s password.' };
}

/** Length rule for a reset depends on the most privileged role the target holds. */
function resetMinLength(target) {
  const roles = (target.memberships || []).filter((m) => m.active).map((m) => m.role);
  return target.isOwner || roles.some((r) => r !== 'counter') ? 8 : 6;
}

function validateReset(input, target) {
  const password = input && typeof input.password === 'string' ? input.password : '';
  const user_id = String((input && input.user_id) || '');
  if (!/^[0-9a-f-]{36}$/i.test(user_id)) return { ok: false, error: 'Unknown person.' };
  const min = resetMinLength(target || { memberships: [] });
  if (password.length < min) return { ok: false, error: `Password/PIN must be at least ${min} characters.` };
  if (password.length > 72) return { ok: false, error: 'Password is too long (max 72).' };
  return { ok: true, value: { user_id, password } };
}

const L = { ROLES, normaliseEmail, minPasswordLength, validateCreate, authorizeCreate, authorizeReset, resetMinLength, validateReset };


const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

// deno-lint-ignore no-explicit-any
async function loadPerson(admin: any, userId: string) {
  const { data: p, error: pe } = await admin.from('profiles').select('user_id, is_owner, active').eq('user_id', userId).maybeSingle();
  if (pe) throw new DbError('read profiles: ' + pe.message);          // a database/permission problem is NOT "inactive account"
  if (!p || !p.active) return null;
  const { data: m, error: me } = await admin.from('memberships').select('branch_id, role, active').eq('user_id', userId);
  if (me) throw new DbError('read memberships: ' + me.message);
  return { isOwner: !!p.is_owner, memberships: m || [] };
}
class DbError extends Error {}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  try {
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!token) return json({ error: 'Please sign in again.' }, 401);
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: u, error: uerr } = await admin.auth.getUser(token);
    if (uerr || !u?.user) return json({ error: 'Please sign in again.' }, 401);
    const callerId = u.user.id;
    const caller = await loadPerson(admin, callerId);
    if (!caller) return json({ error: 'Your account is not active.' }, 403);

    let body: Record<string, unknown>;
    try { body = await req.json(); } catch { return json({ error: 'Bad request.' }, 400); }

    if (body.action === 'create_user') {
      const v = L.validateCreate(body);
      if (!v.ok) return json({ error: v.error }, 400);
      const { email, full_name, role, branch_id, password } = v.value;
      const a = L.authorizeCreate(caller, { branch_id, role });
      if (!a.ok) return json({ error: a.error }, 403);
      const { data: branch } = await admin.from('branches').select('id, active').eq('id', branch_id).maybeSingle();
      if (!branch || !branch.active) return json({ error: 'That branch is not available.' }, 400);

      const { data: created, error: cerr } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name } });
      if (cerr || !created?.user) {
        const dup = /already|registered|exists/i.test(cerr?.message || '');
        return json({ error: dup ? 'This email already has a login. Ask an owner to add them to the branch.' : 'Could not create the login.' }, dup ? 409 : 400);
      }
      const uid = created.user.id;
      const { error: perr } = await admin.from('profiles').insert({ user_id: uid, full_name, email, is_owner: false });
      const { error: merr } = perr ? { error: perr } : await admin.from('memberships').insert({ user_id: uid, branch_id, role, created_by: callerId });
      if (perr || merr) {
        await admin.auth.admin.deleteUser(uid);                          // never leave a login without a profile
        console.error('create_user rollback', perr || merr);
        return json({ error: 'Could not finish creating the person. Nothing was saved.' }, 500);
      }
      await admin.from('audit_log').insert({ actor: callerId, branch_id, table_name: 'team_action', row_key: uid, action: 'create_user', new_data: { email, role } });
      return json({ ok: true, user_id: uid });
    }

    if (body.action === 'reset_password') {
      const targetId = String(body.user_id || '');
      const target = await loadPerson(admin, targetId);
      if (!target) return json({ error: 'Unknown or inactive person.' }, 404);
      const v = L.validateReset(body, target);
      if (!v.ok) return json({ error: v.error }, 400);
      const a = L.authorizeReset(caller, target, callerId, targetId);
      if (!a.ok) return json({ error: a.error }, 403);
      const { error } = await admin.auth.admin.updateUserById(targetId, { password: v.value.password });
      if (error) { console.error('reset_password', error); return json({ error: 'Could not change the password.' }, 400); }
      await admin.from('audit_log').insert({ actor: callerId, branch_id: null, table_name: 'team_action', row_key: targetId, action: 'reset_password' });
      return json({ ok: true });
    }

    return json({ error: 'Unknown action.' }, 400);
  } catch (e) {
    console.error(e);   // full detail goes to the function logs (Supabase > Edge Functions > team-admin > Logs)
    if (e instanceof DbError) return json({ error: 'The server could not read the team data. The database setup may be incomplete - see the function logs.' }, 500);
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
});
