// Unit tests for the Edge Function's permission rules (pure code; no Supabase needed).
import assert from 'node:assert/strict';
import * as L from '../supabase/functions/team-admin/logic.mjs';
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok -', name); };
const B1 = '11111111-1111-1111-1111-111111111111', B2 = '22222222-2222-2222-2222-222222222222';
const owner = { isOwner: true, memberships: [] };
const adminB1 = { isOwner: false, memberships: [{ branch_id: B1, role: 'admin', active: true }] };
const adminB1inactive = { isOwner: false, memberships: [{ branch_id: B1, role: 'admin', active: false }] };
const managerB1 = { isOwner: false, memberships: [{ branch_id: B1, role: 'manager', active: true }] };
const counterB1 = { isOwner: false, memberships: [{ branch_id: B1, role: 'counter', active: true }] };
const goodInput = { full_name: ' Ravi Kumar ', email: ' Ravi@Example.COM ', role: 'counter', branch_id: B1, password: '123456' };

t('validateCreate normalises and accepts a good counter with a 6-digit PIN', () => {
  const v = L.validateCreate(goodInput); assert.ok(v.ok); assert.equal(v.value.email, 'ravi@example.com'); assert.equal(v.value.full_name, 'Ravi Kumar');
});
t('non-counters need 8+ characters', () => {
  assert.equal(L.validateCreate({ ...goodInput, role: 'manager', password: '123456' }).ok, false);
  assert.equal(L.validateCreate({ ...goodInput, role: 'manager', password: '12345678' }).ok, true);
  assert.equal(L.validateCreate({ ...goodInput, password: '12345' }).ok, false);
});
t('validateCreate rejects junk', () => {
  for (const bad of [null, {}, { ...goodInput, email: 'nope' }, { ...goodInput, email: 'a@b' }, { ...goodInput, full_name: '  ' }, { ...goodInput, full_name: 'x'.repeat(81) },
    { ...goodInput, role: 'owner' }, { ...goodInput, role: 'root' }, { ...goodInput, branch_id: 'abc' }, { ...goodInput, password: 'x'.repeat(73) }, { ...goodInput, password: 123456 }, { ...goodInput, full_name: 'a\u0000b' }])
    assert.equal(L.validateCreate(bad).ok, false, JSON.stringify(bad));
});
t('owner may create any role in any branch', () => { for (const role of L.ROLES) assert.ok(L.authorizeCreate(owner, { branch_id: B2, role }).ok); });
t('branch admin may create managers/counters in own branch only', () => {
  assert.ok(L.authorizeCreate(adminB1, { branch_id: B1, role: 'manager' }).ok); assert.ok(L.authorizeCreate(adminB1, { branch_id: B1, role: 'counter' }).ok);
  assert.equal(L.authorizeCreate(adminB1, { branch_id: B1, role: 'admin' }).ok, false, 'no new admins');
  assert.equal(L.authorizeCreate(adminB1, { branch_id: B2, role: 'counter' }).ok, false, 'not another branch');
});
t('managers, counters, deactivated admins and nobody cannot create people', () => {
  for (const c of [managerB1, counterB1, adminB1inactive, null, undefined]) assert.equal(L.authorizeCreate(c, { branch_id: B1, role: 'counter' }).ok, false);
});
t('password reset: owner can reset others but not other owners', () => {
  assert.ok(L.authorizeReset(owner, adminB1, 'o', 'a').ok);
  assert.equal(L.authorizeReset(owner, { isOwner: true, memberships: [] }, 'o', 'o2').ok, false);
  assert.ok(L.authorizeReset(owner, { isOwner: true, memberships: [] }, 'o', 'o').ok, 'an owner may reset themselves');
});
t('password reset: branch admin only for managers/counters of their branch', () => {
  assert.ok(L.authorizeReset(adminB1, counterB1, 'a', 'c').ok); assert.ok(L.authorizeReset(adminB1, managerB1, 'a', 'm').ok);
  assert.equal(L.authorizeReset(adminB1, adminB1, 'a', 'a2').ok, false, 'not another admin');
  const counterB2 = { isOwner: false, memberships: [{ branch_id: B2, role: 'counter', active: true }] };
  assert.equal(L.authorizeReset(adminB1, counterB2, 'a', 'c').ok, false, 'not another branch');
  const adminElsewhere = { isOwner: false, memberships: [{ branch_id: B1, role: 'counter', active: true }, { branch_id: B2, role: 'admin', active: true }] };
  assert.equal(L.authorizeReset(adminB1, adminElsewhere, 'a', 'x').ok, false, 'not someone who is an admin elsewhere');
  for (const c of [managerB1, counterB1]) assert.equal(L.authorizeReset(c, counterB1, 'x', 'y').ok, false);
});
t('reset length depends on the target role', () => {
  assert.equal(L.validateReset({ user_id: B1, password: '123456' }, counterB1).ok, true);
  assert.equal(L.validateReset({ user_id: B1, password: '123456' }, managerB1).ok, false);
  assert.equal(L.validateReset({ user_id: 'x', password: '12345678' }, managerB1).ok, false);
});
console.log(`\n${n} team-logic tests passed`);
