// Pure rules for the team-admin Edge Function (no Supabase, no network) so they can be unit-tested in Node.
// "caller" and "target" look like: { isOwner: boolean, memberships: [{ branch_id, role, active }] } (profile already known to be active).

export const ROLES = ['admin', 'manager', 'counter'];
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[A-Za-z]{2,}$/;

export function normaliseEmail(v) { return String(v == null ? '' : v).trim().toLowerCase(); }

/** Counters (helpers) may use a 6-character PIN/password; every other role needs 8+. */
export function minPasswordLength(role) { return role === 'counter' ? 6 : 8; }

export function validateCreate(input) {
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
export function authorizeCreate(caller, { branch_id, role }) {
  if (!caller) return { ok: false, error: 'Not allowed.' };
  if (caller.isOwner) return { ok: true };
  if (activeAdminOf(caller, branch_id)) {
    if (role === 'manager' || role === 'counter') return { ok: true };
    return { ok: false, error: 'Only an owner can create another admin.' };
  }
  return { ok: false, error: 'You are not an admin of that branch.' };
}

/** Password resets: owners reset anyone except other owners; branch admins reset managers/counters who work in a branch they administer. */
export function authorizeReset(caller, target, callerId, targetId) {
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
export function resetMinLength(target) {
  const roles = (target.memberships || []).filter((m) => m.active).map((m) => m.role);
  return target.isOwner || roles.some((r) => r !== 'counter') ? 8 : 6;
}

export function validateReset(input, target) {
  const password = input && typeof input.password === 'string' ? input.password : '';
  const user_id = String((input && input.user_id) || '');
  if (!/^[0-9a-f-]{36}$/i.test(user_id)) return { ok: false, error: 'Unknown person.' };
  const min = resetMinLength(target || { memberships: [] });
  if (password.length < min) return { ok: false, error: `Password/PIN must be at least ${min} characters.` };
  if (password.length > 72) return { ok: false, error: 'Password is too long (max 72).' };
  return { ok: true, value: { user_id, password } };
}
