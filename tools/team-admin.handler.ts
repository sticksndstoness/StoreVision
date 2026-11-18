// Supabase Edge Function: create logins and reset passwords for StoreVision.
// Needs the service key, which only exists on the server (Supabase provides SUPABASE_SERVICE_ROLE_KEY to functions
// automatically). The browser never sees it. Every request is authenticated and authorised here; all rules live in logic.mjs.
import { createClient } from 'npm:@supabase/supabase-js@2';

// @@LOGIC@@

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

// deno-lint-ignore no-explicit-any
async function loadPerson(admin: any, userId: string) {
  const { data: p } = await admin.from('profiles').select('user_id, is_owner, active').eq('user_id', userId).maybeSingle();
  if (!p || !p.active) return null;
  const { data: m } = await admin.from('memberships').select('branch_id, role, active').eq('user_id', userId);
  return { isOwner: !!p.is_owner, memberships: m || [] };
}

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
    console.error(e);
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
});
