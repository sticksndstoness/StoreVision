/* SAP stock upload screen (admins / owners). Reads the file in the browser (SVSap), shows what was found and every problem,
 * and only then sends it to the database through the all-or-nothing import function. Nothing here can weaken the server checks. */
(function () {
  'use strict';
  const C = window.SVCore, Cloud = window.SVCloud, Sap = window.SVSap;
  const $ = (id) => document.getElementById(id);
  const E = C.escapeHtml;

  let branches = [], branch = null, parsed = null, busy = false;

  const fmtDate = (iso) => { const d = new Date(iso + 'T00:00:00'); return isNaN(d) ? iso : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); };
  const daysOld = (iso) => { const d = new Date(iso + 'T00:00:00'); const t = new Date(); t.setHours(0, 0, 0, 0); return isNaN(d) ? null : Math.round((t - d) / 86400000); };
  const rupees = (n) => '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 });

  function say(msg, good) { const el = $('stockMsg'); el.textContent = msg || ''; el.className = 'text-xs min-h-[1rem] ' + (good ? 'text-emerald-300' : 'text-rose-300'); }
  function list(id, items) { $(id).innerHTML = items.map((m) => `<li class="flex gap-1.5"><span aria-hidden="true">•</span><span>${E(m)}</span></li>`).join(''); }

  async function open() {
    const ctx = Cloud.context(); if (!C.canUploadSap(ctx)) return;
    say(''); resetPreview();
    let all = [];
    try { all = (await Cloud.listBranches()).filter((b) => b.active); } catch (e) { say(e.message); }
    const adminIds = new Set(C.adminBranches(ctx).map((m) => m.branch_id));
    branches = C.isOwner(ctx) ? all : all.filter((b) => adminIds.has(b.id));
    $('stockBranchSelect').innerHTML = branches.map((b) => `<option value="${E(b.id)}">${E(b.name)} (${E(b.code)})</option>`).join('');
    branch = branches.find((b) => b.id === (branch && branch.id)) || branches[0] || null;
    if (branch) $('stockBranchSelect').value = branch.id;
    $('stockModal').classList.remove('hidden'); $('accountModal').classList.add('hidden');
    await renderCurrent();
  }

  async function renderCurrent() {
    const box = $('stockCurrent');
    if (!branch) { box.textContent = 'No branch available.'; return; }
    box.textContent = 'Checking the current SAP stock…';
    try {
      const s = await Cloud.currentSnapshot(branch.id);
      if (!s) { box.innerHTML = `<span class="text-amber-300">No SAP stock uploaded yet for ${E(branch.name)}.</span>`; return; }
      const age = s.report_date ? daysOld(s.report_date) : null;
      box.innerHTML = `<p class="text-slate-400">Current SAP stock for ${E(branch.name)}</p>
        <p class="text-white font-semibold break-all">${E(s.file_name)}</p>
        <p>${s.report_date ? 'Report dated <strong class="text-white">' + E(fmtDate(s.report_date)) + '</strong>' + (age != null ? ` (${age <= 0 ? 'today' : age + ' day' + (age === 1 ? '' : 's') + ' old'})` : '') : 'Report date not recorded'} · ${E(s.part_count)} parts · uploaded ${E(new Date(s.uploaded_at).toLocaleDateString('en-IN'))}</p>
        ${age != null && age > 7 ? '<p class="text-amber-300 mt-1">This report is more than a week old. Upload a fresh one before counting.</p>' : ''}`;
    } catch (e) { box.textContent = e.message; }
  }

  function resetPreview() { parsed = null; $('stockPreview').classList.add('hidden'); $('stockFile').value = ''; }

  function codeCheck() {                                               // the on-screen version of the server's branch-code safety net
    const codes = parsed && parsed.summary ? parsed.summary.branchCodes : [];
    if (!branch || !parsed || !parsed.summary) return { ok: false, text: '' };
    if (codes.length !== 1) return { ok: false, text: 'The file has no Branch Code, so it cannot be checked against the branch.' };
    if (codes[0] !== branch.code) return { ok: false, text: `This file is for SAP branch code ${codes[0]}, but you chose ${branch.name} (${branch.code}). Pick the right branch or file.` };
    return { ok: true, text: `✓ The file is for ${branch.name} (SAP ${branch.code}).` };
  }

  function refreshUploadState() {
    if (!parsed) return;
    const chk = codeCheck();
    const errs = parsed.errors.slice(); if (parsed.summary && !chk.ok && chk.text) errs.push(chk.text);
    const date = $('spDate').value;
    const warns = parsed.warnings.slice();
    if (!date) errs.push('Enter the date of the SAP report.');
    else { const age = daysOld(date); if (age != null && age < 0) errs.push('The report date is in the future.'); else if (age != null && age > 1) warns.push(`This report is ${age} days old. SAP stock moves daily, so compare counts with a same-day report if you can.`); }
    list('spErrors', errs); list('spWarnings', warns);
    $('spBranch').textContent = chk.ok ? chk.text : ''; $('spBranch').className = 'font-semibold text-emerald-300';
    $('stockUploadBtn').disabled = busy || errs.length > 0 || !parsed.ok;
    $('stockUploadBtn').textContent = branch ? `Upload to ${branch.name}` : 'Upload';
  }

  async function onFile() {
    const file = $('stockFile').files && $('stockFile').files[0]; if (!file || busy || !branch) return;
    say(''); busy = true; $('stockPreview').classList.add('hidden');
    say('Reading the file…', true);
    try { parsed = await Sap.readFile(file, { sensitiveThreshold: branch.sensitive_threshold }); } finally { busy = false; $('stockFile').value = ''; }
    say('');
    $('stockPreview').classList.remove('hidden');
    $('spFile').textContent = parsed.fileName || file.name;
    const s = parsed.summary;
    $('spParts').textContent = s ? s.parts.toLocaleString('en-IN') : '–'; $('spLines').textContent = s ? s.partBinLines.toLocaleString('en-IN') : '–';
    $('spBins').textContent = s ? s.bins.toLocaleString('en-IN') : '–';
    $('spSens').textContent = s ? `${s.sensitiveParts} (above ${rupees(s.threshold)})` : '–';
    $('spDate').value = parsed.reportDate || '';
    refreshUploadState();
  }

  async function upload() {
    if (busy || !parsed || !parsed.ok || !branch) return;
    const date = $('spDate').value; const chk = codeCheck(); if (!chk.ok || !date) return refreshUploadState();
    const s = parsed.summary;
    if (!confirm(`Upload ${s.parts.toLocaleString('en-IN')} parts to ${branch.name}?\n\nReport dated ${fmtDate(date)}. This becomes the current SAP stock; the previous one is kept in history.`)) return;
    busy = true; $('stockUploadBtn').disabled = true; $('stockUploadBtn').textContent = 'Uploading…'; say('');
    try {
      await Cloud.importSap({ branchId: branch.id, fileName: parsed.fileName, reportDate: date, branchCode: s.branchCodes[0], lineCount: s.lines, rows: parsed.rows });
      say(`Uploaded: ${s.parts.toLocaleString('en-IN')} parts for ${branch.name} (report dated ${fmtDate(date)}).`, true);
      resetPreview(); await renderCurrent();
    } catch (e) { say(e.message); }
    finally { busy = false; refreshUploadState(); }
  }

  let started = false;
  function init() {
    if (started) return; started = true;
    if (!Cloud.available()) return;
    $('openStockBtn').addEventListener('click', open);
    $('closeStockX').addEventListener('click', () => $('stockModal').classList.add('hidden'));
    $('stockBranchSelect').addEventListener('change', (e) => { branch = branches.find((b) => b.id === e.target.value) || null; resetPreview(); say(''); renderCurrent(); });
    $('stockFile').addEventListener('change', onFile);
    $('spDate').addEventListener('input', refreshUploadState);
    $('stockUploadBtn').addEventListener('click', upload);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('stockModal').classList.add('hidden'); });
  }
  document.addEventListener('DOMContentLoaded', init);
  if (document.readyState !== 'loading') init();
})();
