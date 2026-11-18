/* StoreVision account / team / branches screens. Pure rules are in core.js (SVCore); data access is in cloud.js (SVCloud).
 * Everything here is optional: the counting app keeps working when nobody is signed in or the phone is offline. */
(function () {
  'use strict';
  const C = window.SVCore, Cloud = window.SVCloud;
  const $ = (id) => document.getElementById(id);
  const E = C.escapeHtml;
  const open = (id) => $(id).classList.remove('hidden');
  const close = (id) => $(id).classList.add('hidden');

  let teamBranchId = '';
  let busy = false;

  function say(id, msg, good) {
    const el = $(id); el.textContent = msg || '';
    el.className = 'text-xs min-h-[1rem] ' + (good ? 'text-emerald-300' : 'text-rose-300');
  }
  async function guarded(btnId, msgId, fn) {            // one tap = one action, errors shown as a sentence
    if (busy) return; busy = true;
    const btn = $(btnId); const label = btn.textContent; btn.disabled = true; say(msgId, '');
    try { await fn(); } catch (e) { say(msgId, e && e.message ? e.message : 'Something went wrong.'); }
    finally { busy = false; btn.disabled = false; btn.textContent = label; }
  }

  /* ---------------- account ---------------- */
  function renderAccount(ctx) {
    const signedIn = !!ctx;
    $('acctSignedOut').classList.toggle('hidden', signedIn);
    $('acctSignedIn').classList.toggle('hidden', !signedIn);
    $('accountBtnLabel').innerHTML = signedIn && ctx.profile ? E(C.initials(ctx.profile.full_name)) : '<i class="fa-solid fa-user" aria-hidden="true"></i>';
    if (!signedIn) return;
    const p = ctx.profile;
    $('acctName').textContent = p ? p.full_name + (p.is_owner ? ' (Owner)' : '') : ctx.email;
    $('acctEmail').textContent = ctx.email || '';
    const rows = (ctx.memberships || []).filter((m) => m.active).map((m) =>
      `<li class="flex items-center justify-between bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs"><span class="text-slate-200">${E(m.branch ? m.branch.name : '')}</span><span class="px-2 py-0.5 rounded bg-sky-500/15 text-sky-300 font-semibold">${E(C.ROLE_LABEL[m.role] || m.role)}</span></li>`);
    $('acctRoles').innerHTML = rows.join('');
    const noAccess = !p || !p.active || (!p.is_owner && !rows.length);
    $('acctNote').textContent = noAccess ? 'This login is not set up for any branch yet. Ask an admin to add you.' : '';
    $('openTeamBtn').classList.toggle('hidden', !C.canOpenTeam(ctx));
    $('openBranchesBtn').classList.toggle('hidden', !C.canOpenBranches(ctx));
    $('openStockBtn').classList.toggle('hidden', !C.canUploadSap(ctx));
  }

  async function doLogin() {
    await guarded('loginBtn', 'loginMsg', async () => {
      const email = $('loginEmail').value.trim(), pw = $('loginPassword').value;
      if (!email || !pw) throw new Error('Enter your email and password.');
      $('loginBtn').textContent = 'Signing in…';
      await Cloud.signIn(email, pw);
      $('loginPassword').value = '';
    });
  }

  /* ---------------- team ---------------- */
  function branchesForTeam(ctx) {
    if (C.isOwner(ctx)) return null;                                   // owner: loaded from the database
    return C.adminBranches(ctx).map((m) => ({ id: m.branch_id, name: m.branch.name, code: m.branch.code }));
  }

  async function openTeam() {
    const ctx = Cloud.context(); if (!C.canOpenTeam(ctx)) return;
    say('teamMsg', '');
    let branches = branchesForTeam(ctx);
    try { if (!branches) branches = (await Cloud.listBranches()).filter((b) => b.active); } catch (e) { branches = []; say('teamMsg', e.message); }
    $('teamBranchSelect').innerHTML = branches.map((b) => `<option value="${E(b.id)}">${E(b.name)} (${E(b.code)})</option>`).join('');
    teamBranchId = branches.length ? (branches.find((b) => b.id === teamBranchId) || branches[0]).id : '';
    $('teamBranchSelect').value = teamBranchId;
    open('teamModal'); close('accountModal');
    await refreshTeam();
  }

  function fillRoleSelect() {
    const roles = C.rolesAssignable(Cloud.context(), teamBranchId);
    $('newRole').innerHTML = '<option value="">Role…</option>' + roles.map((r) => `<option value="${r}">${E(C.ROLE_LABEL[r])}</option>`).join('');
    updatePwHint();
  }
  function updatePwHint() {
    const r = $('newRole').value;
    $('pwHint').textContent = r ? `At least ${C.minPasswordLength(r)} characters${r === 'counter' ? ' (a 6-digit PIN is fine for helpers)' : ''}.` : 'Choose a role first.';
  }

  async function refreshTeam() {
    const list = $('teamList');
    if (!teamBranchId) { list.innerHTML = '<p class="text-xs text-slate-500">No branch available.</p>'; fillRoleSelect(); return; }
    list.innerHTML = '<p class="text-xs text-slate-500">Loading…</p>';
    fillRoleSelect();
    let people;
    try { people = await Cloud.listTeam(teamBranchId); } catch (e) { list.innerHTML = ''; say('teamMsg', e.message); return; }
    const ctx = Cloud.context(); const me = ctx.userId; const assignable = C.rolesAssignable(ctx, teamBranchId);
    if (!people.length) { list.innerHTML = '<p class="text-xs text-slate-500">Nobody yet. Add the first person below.</p>'; return; }
    list.innerHTML = people.map((m) => {
      const mine = m.user_id === me;
      const canEdit = !mine && assignable.includes(m.role);            // the same rule the database enforces
      const roleCtl = canEdit
        ? `<select data-act="role" data-user="${E(m.user_id)}" aria-label="Role of ${E(m.name)}" class="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-sky-300">${assignable.map((r) => `<option value="${r}"${r === m.role ? ' selected' : ''}>${E(C.ROLE_LABEL[r])}</option>`).join('')}</select>`
        : `<span class="px-2 py-1 rounded bg-sky-500/15 text-sky-300 text-xs font-semibold">${E(C.ROLE_LABEL[m.role] || m.role)}</span>`;
      const actions = canEdit ? `
        <button type="button" data-act="toggle" data-user="${E(m.user_id)}" data-active="${m.active ? '1' : '0'}" class="px-2.5 py-1.5 rounded bg-slate-800 border border-slate-700 text-[11px] ${m.active ? 'text-rose-300' : 'text-emerald-300'}">${m.active ? 'Deactivate' : 'Reactivate'}</button>
        <button type="button" data-act="reset" data-user="${E(m.user_id)}" data-name="${E(m.name)}" class="px-2.5 py-1.5 rounded bg-slate-800 border border-slate-700 text-[11px] text-amber-300">New password</button>` : '';
      return `<div class="bg-slate-950 border ${m.active ? 'border-slate-800' : 'border-slate-800 opacity-60'} rounded-xl p-3 space-y-2">
        <div class="flex items-center justify-between gap-2"><div class="min-w-0"><p class="text-sm font-semibold text-white truncate">${E(m.name)}${mine ? ' <span class="text-[10px] text-slate-500">(you)</span>' : ''}</p><p class="text-[11px] text-slate-400 truncate">${E(m.email || '')}${m.active ? '' : ' • inactive'}</p></div>${roleCtl}</div>
        ${actions ? `<div class="flex gap-1.5 justify-end">${actions}</div>` : ''}</div>`;
    }).join('');
  }

  async function onTeamClick(ev) {
    const btn = ev.target.closest('button[data-act]'); if (!btn || busy) return;
    const user = btn.dataset.user;
    busy = true; say('teamMsg', '');
    try {
      if (btn.dataset.act === 'toggle') {
        const makeActive = btn.dataset.active !== '1';
        if (!makeActive && !confirm('Deactivate this person? They will lose access straight away. Their past counts are kept.')) return;
        await Cloud.setMemberActive(user, teamBranchId, makeActive); say('teamMsg', makeActive ? 'Reactivated.' : 'Deactivated.', true);
      } else if (btn.dataset.act === 'reset') {
        const pw = prompt(`New password or PIN for ${btn.dataset.name}:`);
        if (pw === null) return;
        await Cloud.resetPassword(user, pw.trim()); say('teamMsg', 'Password changed. Tell them the new one.', true);
      }
      busy = false; await refreshTeam();
    } catch (e) { say('teamMsg', e.message); } finally { busy = false; }
  }
  async function onTeamChange(ev) {
    const sel = ev.target.closest('select[data-act="role"]'); if (!sel || busy) return;
    busy = true; say('teamMsg', '');
    try { await Cloud.setRole(sel.dataset.user, teamBranchId, sel.value); say('teamMsg', 'Role changed.', true); }
    catch (e) { say('teamMsg', e.message); }
    finally { busy = false; await refreshTeam(); }
  }

  async function addPerson() {
    await guarded('addPersonBtn', 'teamMsg', async () => {
      const v = C.validateNewPerson({ full_name: $('newName').value, email: $('newEmail').value, role: $('newRole').value, branch_id: teamBranchId, password: $('newPassword').value });
      if (!v.ok) throw new Error(v.error);
      $('addPersonBtn').textContent = 'Adding…';
      await Cloud.createPerson(v.value);
      ['newName', 'newEmail', 'newPassword'].forEach((id) => { $(id).value = ''; });
      say('teamMsg', `${v.value.full_name} added. Tell them: email ${v.value.email} and the password you set.`, true);
      await refreshTeam();
    });
  }

  /* ---------------- branches ---------------- */
  async function openBranches() {
    if (!C.canOpenBranches(Cloud.context())) return;
    say('branchMsg', ''); open('branchesModal'); close('accountModal'); await refreshBranches();
  }
  async function refreshBranches() {
    const list = $('branchList');
    try {
      const rows = await Cloud.listBranches();
      list.innerHTML = rows.map((b) => `<div class="flex items-center justify-between bg-slate-950 border border-slate-800 rounded-xl px-3 py-2.5 ${b.active ? '' : 'opacity-60'}">
        <div><p class="text-sm font-semibold text-white">${E(b.name)}</p><p class="text-[11px] text-slate-400 font-mono">SAP ${E(b.code)}${b.active ? '' : ' • inactive'}</p></div>
        <button type="button" data-act="bactive" data-id="${E(b.id)}" data-active="${b.active ? '1' : '0'}" class="px-2.5 py-1.5 rounded bg-slate-800 border border-slate-700 text-[11px] ${b.active ? 'text-rose-300' : 'text-emerald-300'}">${b.active ? 'Deactivate' : 'Reactivate'}</button></div>`).join('') || '<p class="text-xs text-slate-500">No branches.</p>';
    } catch (e) { say('branchMsg', e.message); }
  }
  async function addBranch() {
    await guarded('addBranchBtn', 'branchMsg', async () => {
      const v = C.validateNewBranch({ name: $('newBranchName').value, code: $('newBranchCode').value });
      if (!v.ok) throw new Error(v.error);
      $('addBranchBtn').textContent = 'Adding…';
      await Cloud.addBranch(v.value.name, v.value.code);
      $('newBranchName').value = ''; $('newBranchCode').value = '';
      say('branchMsg', `${v.value.name} added.`, true); await refreshBranches();
    });
  }
  async function onBranchClick(ev) {
    const btn = ev.target.closest('button[data-act="bactive"]'); if (!btn || busy) return;
    busy = true; say('branchMsg', '');
    try {
      const makeActive = btn.dataset.active !== '1';
      if (!makeActive && !confirm('Deactivate this branch? People there will lose access until it is reactivated.')) return;
      await Cloud.setBranchActive(btn.dataset.id, makeActive); busy = false; await refreshBranches();
    } catch (e) { say('branchMsg', e.message); } finally { busy = false; }
  }

  /* ---------------- wiring ---------------- */
  let started = false;
  function init() {
    if (started) return; started = true;
    if (!Cloud.available()) { $('accountBtn').classList.add('hidden'); return; }
    Cloud.onChange(renderAccount);
    $('accountBtn').addEventListener('click', () => { say('loginMsg', ''); renderAccount(Cloud.context()); open('accountModal'); });
    $('closeAccountX').addEventListener('click', () => close('accountModal'));
    $('loginBtn').addEventListener('click', doLogin);
    $('loginPassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
    $('signOutBtn').addEventListener('click', async () => { await Cloud.signOut(); close('accountModal'); });
    $('openTeamBtn').addEventListener('click', openTeam);
    $('openBranchesBtn').addEventListener('click', openBranches);
    $('closeTeamX').addEventListener('click', () => close('teamModal'));
    $('closeBranchesX').addEventListener('click', () => close('branchesModal'));
    $('teamBranchSelect').addEventListener('change', (e) => { teamBranchId = e.target.value; refreshTeam(); });
    $('newRole').addEventListener('change', updatePwHint);
    $('teamList').addEventListener('click', onTeamClick);
    $('teamList').addEventListener('change', onTeamChange);
    $('addPersonBtn').addEventListener('click', addPerson);
    $('branchList').addEventListener('click', onBranchClick);
    $('addBranchBtn').addEventListener('click', addBranch);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') ['accountModal', 'teamModal', 'branchesModal'].forEach(close); });
    Cloud.restore().then((ctx) => { if (ctx) renderAccount(ctx); });
  }
  document.addEventListener('DOMContentLoaded', init);
  if (document.readyState !== 'loading') init();
})();
