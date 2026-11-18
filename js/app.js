/* StoreVision Count — UI + I/O. Pure logic lives in core.js (window.SVCore). */
(function () {
  'use strict';
  const C = window.SVCore;
  const $ = (id) => document.getElementById(id);

  const LS = { LOG: 'sv_inventory_log', KEY: 'sv_gemini_key', URL: 'sv_webhook_url', TOKEN: 'sv_webhook_token', PROXY: 'sv_use_proxy', MODEL: 'sv_model', MODELS: 'sv_model_list' };
  const DEFAULT_MODEL = 'gemini-3.8-flash';
  const RETIRED_MODELS = ['gemini-2.5-flash']; // Google no longer serves these to new keys; fall back to the default
  const FETCH_TIMEOUT_MS = 45000;

  /* ---------- safe storage ---------- */
  const store = {
    get(k, d = '') { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  };

  /* ---------- state ---------- */
  let pins = [];
  let currentStackBase64 = null;
  let aiCounted = false;       // true once AI produced the pins for the current photo
  let zoneManual = false;      // user typed the zone, so AI must not overwrite it
  let busy = { label: false, stack: false, sync: false };
  const view = { q: '', zone: '', counted: '', group: false };
  let inventoryLog = [];
  let storageReady = false;    // never write the log before it has been loaded (would look like "delete everything")
  let saving = false;
  const SAVE_BTN_HTML = '<i class="fa-solid fa-cloud-arrow-up" aria-hidden="true"></i> Save &amp; Sync to Google Sheet';

  /** Persists the log. Never rejects: failures are reported to the user and the crash log. Resolves true/false. */
  async function persistLog() {
    if (!storageReady) return false;
    try { await SVDB.saveDiff(inventoryLog); return true; }
    catch (err) {
      SVDB.logCrash(C.makeCrashRecord('storage', err, 'persistLog'));
      showToast('⚠ Could not save on this device (' + (err && err.message || 'storage error') + '). Download a backup now.', { ms: 10000, actionLabel: 'Backup', onAction: downloadBackup });
      return false;
    }
  }

  /* ---------- global crash safety net ---------- */
  let lastBannerAt = 0;
  function unstick() {   // an unexpected error must never leave overlays or buttons stuck
    busy.label = busy.stack = busy.sync = false; saving = false;
    ['labelScanningOverlay', 'stackScanningOverlay'].forEach((id) => { const el = $(id); if (el) el.classList.add('hidden'); });
    const b = $('saveSyncBtn'); if (b && storageReady) { b.disabled = false; b.innerHTML = SAVE_BTN_HTML; }
  }
  function showErrorBanner() {
    if (Date.now() - lastBannerAt < 10000) return;
    lastBannerAt = Date.now();
    const el = $('errorBanner'); if (el) el.classList.remove('hidden');
  }
  function onFatal(kind, err) {
    const msg = String((err && err.message) || err || '');
    if (/ResizeObserver loop/i.test(msg)) return;      // harmless browser noise
    try { SVDB.logCrash(C.makeCrashRecord(kind, err, location.pathname)); } catch (e) { /* never throw from the handler */ }
    try { unstick(); showErrorBanner(); } catch (e) { /* ignore */ }
  }
  window.addEventListener('error', (e) => onFatal('error', e.error || e.message));
  window.addEventListener('unhandledrejection', (e) => onFatal('promise', e.reason));

  /* ---------- draft autosave (survives reloads, crashes, phone calls, iOS killing the tab) ---------- */
  let draftTimer = null, restoringDraft = false;
  function collectDraft() {
    const img = $('stackImg');
    const src = img && !img.classList.contains('hidden') ? img.getAttribute('src') : null;
    return {
      v: 1, savedAt: Date.now(), aiCounted, zoneManual, pins,
      stackDataUrl: src && src.startsWith('data:image/') ? src : null,
      fields: {
        partNo: $('partNoInput').value, barcode: $('barcodeInput').value, desc: $('descInput').value, mrp: $('mrpInput').value,
        mfg: $('mfgInput').value, zone: $('zoneInput').value, hidden: $('hiddenOffsetInput').value, mult: $('depthMultSelect').value, roi: $('roiToggle').checked
      }
    };
  }
  function draftIsEmpty(d) {
    const f = d.fields;   // the bay alone is not worth restoring: it is kept between saves anyway
    return !d.pins.length && !d.stackDataUrl && !f.partNo && !f.barcode && !f.desc && !f.mrp && !f.mfg && (f.hidden === '0' || f.hidden === '') && f.mult === '1';
  }
  function flushDraft() {
    clearTimeout(draftTimer); draftTimer = null;
    if (!storageReady || restoringDraft) return;
    const d = collectDraft();
    (draftIsEmpty(d) ? SVDB.clearDraft() : SVDB.saveDraft(d)).catch(() => { /* best effort */ });
  }
  function scheduleDraft() { if (!storageReady || restoringDraft) return; clearTimeout(draftTimer); draftTimer = setTimeout(flushDraft, 700); }

  async function restoreDraft() {
    let d; try { d = await SVDB.loadDraft(); } catch (e) { return; }
    if (!d || typeof d !== 'object' || !d.fields || !Array.isArray(d.pins) || draftIsEmpty(d)) return;
    restoringDraft = true;
    try {
      const f = d.fields;
      $('partNoInput').value = String(f.partNo || '').slice(0, 80); $('barcodeInput').value = String(f.barcode || '').slice(0, 120);
      $('descInput').value = String(f.desc || '').slice(0, 300); $('mrpInput').value = String(f.mrp || '').slice(0, 20);
      $('mfgInput').value = String(f.mfg || '').slice(0, 40); $('zoneInput').value = String(f.zone || '').slice(0, 40);
      $('hiddenOffsetInput').value = String(f.hidden || '0').slice(0, 10);
      if (['1', '2', '3', '4'].includes(String(f.mult))) $('depthMultSelect').value = String(f.mult);
      $('roiToggle').checked = f.roi !== false;
      pins = d.pins.filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y)).map((p) => ({ x: p.x, y: p.y, source: p.source === 'manual' ? 'manual' : 'ai' }));
      aiCounted = !!d.aiCounted; zoneManual = !!d.zoneManual;
      if (typeof d.stackDataUrl === 'string' && d.stackDataUrl.startsWith('data:image/')) {
        currentStackBase64 = d.stackDataUrl.split(',')[1] || null;
        $('stackImg').src = d.stackDataUrl; $('stackImg').classList.remove('hidden');
        $('stackPlaceholder').classList.add('hidden'); $('pinControls').classList.remove('hidden');
      }
      renderPins();
    } finally { restoringDraft = false; }
    showToast('Restored your unsaved count', { actionLabel: 'Discard', ms: 8000, onAction: () => resetForm() });
  }

  /* ---------- toast ---------- */
  let toastTimer;
  function showToast(msg, opts = {}) {
    $('toastMsg').textContent = msg;
    const act = $('toastAction');
    if (opts.actionLabel) {
      act.textContent = opts.actionLabel; act.classList.remove('hidden');
      act.onclick = () => { hideToast(); opts.onAction && opts.onAction(); };
    } else { act.classList.add('hidden'); act.onclick = null; }
    $('toast').classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, opts.ms || (msg.length > 60 ? 6500 : 3500));
  }
  function hideToast() { $('toast').classList.add('hidden'); }

  /* ---------- settings ---------- */
  const usableModel = (m) => (!m || RETIRED_MODELS.includes(m.trim())) ? DEFAULT_MODEL : m.trim();
  const settings = () => ({
    key: store.get(LS.KEY), url: store.get(LS.URL), token: store.get(LS.TOKEN),
    proxy: store.get(LS.PROXY) === '1', model: usableModel(store.get(LS.MODEL))
  });
  /* ---------- model picker ---------- */
  const CUSTOM = '__custom__';
  const cachedModels = () => { try { const v = JSON.parse(store.get(LS.MODELS, '[]')); return Array.isArray(v) ? v : []; } catch (e) { return []; } };

  function fillModelSelect(selected, list) {
    const models = (list || cachedModels()).slice();
    if (!models.some((m) => m.id === DEFAULT_MODEL)) models.unshift({ id: DEFAULT_MODEL, label: DEFAULT_MODEL });
    if (selected && !models.some((m) => m.id === selected)) models.push({ id: selected, label: selected });
    const sel = $('modelSelect'); const E = C.escapeHtml;
    sel.innerHTML = models.map((m) => `<option value="${E(m.id)}">${E(m.id)}${m.id === DEFAULT_MODEL ? '  (default)' : ''}</option>`).join('') + `<option value="${CUSTOM}">Custom model ID…</option>`;
    sel.value = selected || DEFAULT_MODEL;
    $('modelCustomInput').classList.add('hidden');
  }
  function chosenModel() {
    const v = $('modelSelect').value;
    return v === CUSTOM ? $('modelCustomInput').value.trim() : v;
  }

  async function checkModels() {
    const btn = $('checkModelsBtn'), status = $('modelStatus');
    const useProxy = $('useProxyToggle').checked;
    const key = $('apiKeyInput').value.trim() || store.get(LS.KEY);
    const url = $('webhookUrlInput').value.trim() || store.get(LS.URL);
    const token = $('webhookTokenInput').value.trim() || store.get(LS.TOKEN);
    if (useProxy ? !(url && token) : !key) { status.textContent = useProxy ? 'Enter the Sheet URL and token first.' : 'Enter your Gemini API key first.'; return; }
    btn.disabled = true; status.textContent = 'Asking Google which models your key can use…';
    try {
      let json = { models: [] };
      if (useProxy) {
        const res = await fetchWithTimeout(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'models', token }) });
        const body = await res.json();
        if (!body.ok) throw new Error(body.error || 'Proxy error');
        json = body.result;
      } else {
        let pageToken = '';
        for (let i = 0; i < 5; i++) {
          const res = await fetchWithTimeout('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200' + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''), { headers: { 'x-goog-api-key': key } });
          if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error((err.error && err.error.message) || `API Error (${res.status})`); }
          const page = await res.json();
          json.models = json.models.concat(page.models || []);
          pageToken = page.nextPageToken || '';
          if (!pageToken) break;
        }
      }
      const list = C.parseModelList(json);
      if (!list.length) throw new Error('No usable models returned for this key.');
      store.set(LS.MODELS, JSON.stringify(list));
      const keep = chosenModel();
      const pick = list.some((m) => m.id === keep) ? keep : (list.some((m) => m.id === DEFAULT_MODEL) ? DEFAULT_MODEL : list[0].id);
      fillModelSelect(pick, list);
      status.textContent = `Found ${list.length} models. Pick one and tap Save Settings.`;
    } catch (err) { status.textContent = '⚠ ' + err.message; }
    finally { btn.disabled = false; }
  }

  function openSettings() {
    const s = settings();
    $('apiKeyInput').value = s.key; $('webhookUrlInput').value = s.url; $('webhookTokenInput').value = s.token;
    $('useProxyToggle').checked = s.proxy; fillModelSelect(s.model);
    syncDirectKeyVisibility();
    $('settingsModal').classList.remove('hidden');
    refreshDiagnostics().catch(() => {});
  }
  function closeSettings() { $('settingsModal').classList.add('hidden'); }
  function syncDirectKeyVisibility() { $('directKeyWrap').classList.toggle('hidden', $('useProxyToggle').checked); }
  function saveSettings() {
    const url = $('webhookUrlInput').value.trim();
    if (url && !/^https:\/\/script\.google(usercontent)?\.com\//.test(url)) {
      return showToast('Sheet URL must be a https://script.google.com/... Web App URL');
    }
    const ok = [
      store.set(LS.KEY, $('apiKeyInput').value.trim()), store.set(LS.URL, url),
      store.set(LS.TOKEN, $('webhookTokenInput').value.trim()),
      store.set(LS.PROXY, $('useProxyToggle').checked ? '1' : '0'), store.set(LS.MODEL, chosenModel())
    ].every(Boolean);
    updateSyncBadge(); closeSettings();
    showToast(ok ? 'Settings saved on device' : '⚠ Could not store settings on this device');
  }
  function updateSyncBadge() { $('syncIndicator').classList.toggle('hidden', !settings().url); }

  /* ---------- network helpers ---------- */
  async function fetchWithTimeout(url, init) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try { return await fetch(url, { ...init, signal: ctrl.signal }); }
    catch (e) {
      if (e.name === 'AbortError') throw new Error('Request timed out. Check your connection and try again.');
      throw new Error(navigator.onLine ? 'Network error. Please try again.' : 'You are offline. Try again when connected.');
    } finally { clearTimeout(t); }
  }

  /* ---------- image ---------- */
  function compressImage(file, maxDim = 1280) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Could not read that photo.'));
      reader.onload = (e) => {
        const img = new Image();
        img.onerror = () => reject(new Error('This image format is not supported. Try a JPEG/PNG photo.'));
        img.onload = () => {
          let w = img.width, h = img.height;
          if (w > maxDim || h > maxDim) {
            if (w > h) { h = Math.round(h * maxDim / w); w = maxDim; }
            else { w = Math.round(w * maxDim / h); h = maxDim; }
          }
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
          resolve({ dataUrl, base64: dataUrl.split(',')[1] });
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  /* ---------- Gemini (direct or via Apps Script proxy) ---------- */
  const LABEL_SCHEMA = {
    type: 'OBJECT',
    properties: {
      partNo: { type: 'STRING' }, description: { type: 'STRING' }, barcode: { type: 'STRING' },
      mrp: { type: 'NUMBER' }, mfgDate: { type: 'STRING' }
    },
    required: ['partNo', 'description', 'barcode', 'mrp', 'mfgDate']
  };
  const STACK_SCHEMA = {
    type: 'OBJECT',
    properties: {
      bayTag: { type: 'STRING' },
      items: { type: 'ARRAY', items: { type: 'OBJECT', properties: { x: { type: 'NUMBER' }, y: { type: 'NUMBER' } }, required: ['x', 'y'] } }
    },
    required: ['bayTag', 'items']
  };
  const LABEL_PROMPT = 'Extract spare part or product label details from this image. If a field is not visible use an empty string (or 0 for mrp). mrp is the numeric MRP without currency symbol. mfgDate looks like 08/2026.';
  const stackPrompt = (focusCenter) => `You are a warehouse inventory vision counter.
1. Read any rack bay label or zone sticker visible on the shelving uprights (e.g. D1, D2, A1, ZONE-1). Empty string if none.
2. Detect every individual stacked box, carton, bucket, or product unit ${focusCenter ? 'in the primary foreground/center rack or stack (ignore distant background aisles and loose floor debris)' : 'visible in the image'}.
Return the CENTER of each unit as x (left=0 to right=1000) and y (top=0 to bottom=1000) relative to the whole image. One entry per unit; do not repeat the same unit.`;

  /** Retired/unknown model errors are common; tell the user exactly where to fix it. */
  function modelHint(msg) {
    return /no longer available|not found|is not supported|deprecated/i.test(msg)
      ? msg + ' — open Setup and change "Gemini Model" (try ' + DEFAULT_MODEL + ').' : msg;
  }

  const AI_MIN_GAP_MS = 1000, AI_DAILY_CAP = 400;   // protects against runaway taps and surprise bills
  let lastAiAt = 0;
  function aiGuard() {
    const today = new Date().toISOString().slice(0, 10);
    let st; try { st = JSON.parse(store.get('sv_ai_count', 'null')); } catch (e) { st = null; }
    if (!st || st.day !== today) st = { day: today, n: 0 };
    const a = C.aiAllowance({ lastAt: lastAiAt, now: Date.now(), countToday: st.n, minGapMs: AI_MIN_GAP_MS, dailyCap: AI_DAILY_CAP });
    if (!a.ok) throw new Error(a.reason);
    lastAiAt = Date.now(); st.n++; store.set('sv_ai_count', JSON.stringify(st));
  }

  async function callGemini(base64Image, promptText, schema) {
    aiGuard();
    const s = settings();
    if (s.proxy) {
      if (!s.url || !s.token) { openSettings(); throw new Error('Set the Sheet URL and token in Setup first.'); }
      const res = await fetchWithTimeout(s.url, {
        method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'vision', token: s.token, model: s.model, prompt: promptText, image: base64Image, schema })
      });
      let body; try { body = await res.json(); } catch (e) { throw new Error('Proxy returned an unreadable response. Check the Apps Script deployment.'); }
      if (!body.ok) throw new Error(modelHint(body.error || 'Proxy error'));
      return C.parseModelJson(C.extractGeminiText(body.result));
    }
    if (!s.key) { openSettings(); throw new Error('Please enter your Gemini API Key in Setup first.'); }
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(s.model)}:generateContent`;
    const res = await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': s.key }, // header, not URL, so it stays out of logs/history
      body: JSON.stringify({
        contents: [{ parts: [{ text: promptText }, { inline_data: { mime_type: 'image/jpeg', data: base64Image } }] }],
        generationConfig: { temperature: 0.1, responseMimeType: 'application/json', responseSchema: schema, maxOutputTokens: 8192 }
      })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(modelHint((err.error && err.error.message) || `API Error (${res.status})`));
    }
    return C.parseModelJson(C.extractGeminiText(await res.json()));
  }

  /* ---------- label scan ---------- */
  async function handleLabelFile(input) {
    const file = input.files && input.files[0];
    input.value = ''; // allow re-selecting the same photo
    if (!file || busy.label) return;
    busy.label = true;
    try {
      const { dataUrl, base64 } = await compressImage(file, 1024);
      $('labelPreviewWrap').classList.remove('hidden');
      $('labelPreviewImg').src = dataUrl;
      $('labelScanningOverlay').classList.remove('hidden');
      const data = await callGemini(base64, LABEL_PROMPT, LABEL_SCHEMA);
      if (data.partNo) $('partNoInput').value = data.partNo;
      if (data.description) $('descInput').value = data.description;
      if (data.barcode) $('barcodeInput').value = data.barcode;
      if (data.mrp > 0) $('mrpInput').value = data.mrp;
      if (data.mfgDate) $('mfgInput').value = data.mfgDate;
      recalculateTotals();
      showToast('Label details extracted — please verify them');
    } catch (err) { showToast(err.message); }
    finally { busy.label = false; $('labelScanningOverlay').classList.add('hidden'); }
  }

  /* ---------- stack photo + pins ---------- */
  async function handleStackFile(input) {
    const file = input.files && input.files[0];
    input.value = '';
    if (!file || busy.stack) return;
    try {
      const { dataUrl, base64 } = await compressImage(file, 1280);
      currentStackBase64 = base64;
      const img = $('stackImg');
      img.src = dataUrl; img.classList.remove('hidden');
      $('stackPlaceholder').classList.add('hidden');
      $('pinControls').classList.remove('hidden');
      pins = []; aiCounted = false; renderPins();
      await recountWithAI();
    } catch (err) { showToast(err.message); }
  }

  async function recountWithAI() {
    if (!currentStackBase64 || busy.stack) return;
    busy.stack = true;
    $('stackScanningOverlay').classList.remove('hidden');
    try {
      const result = await callGemini(currentStackBase64, stackPrompt($('roiToggle').checked), STACK_SCHEMA);
      const tag = typeof result.bayTag === 'string' ? result.bayTag.trim() : '';
      if (tag && (!zoneManual || !$('zoneInput').value)) { $('zoneInput').value = tag; zoneManual = false; }
      const manual = pins.filter((p) => p.source === 'manual');
      const ai = C.normalisePins(result.items);
      if (manual.length && ai.length) {
        // keep the user's manual pins; do not silently wipe corrections
        pins = manual.concat(ai);
      } else pins = ai.length ? ai : manual;
      aiCounted = ai.length > 0;
      renderPins();
      showToast(`AI estimated ${ai.length} visible units — verify the pins`);
    } catch (err) { showToast(err.message); }
    finally { busy.stack = false; $('stackScanningOverlay').classList.add('hidden'); }
  }

  function addManualPin(event) {
    const rect = $('stackImg').getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    pins.push({
      x: Math.max(0, Math.min(100, ((event.clientX - rect.left) / rect.width) * 100)),
      y: Math.max(0, Math.min(100, ((event.clientY - rect.top) / rect.height) * 100)),
      source: 'manual'
    });
    renderPins();
  }

  function removePin(index, event) {
    event.stopPropagation();
    const [removed] = pins.splice(index, 1);
    renderPins();
    showToast('Pin removed', { actionLabel: 'Undo', ms: 5000, onAction: () => { pins.splice(index, 0, removed); renderPins(); } });
  }

  function clearPins() {
    if (!pins.length) return;
    const backup = pins.slice();
    pins = []; renderPins();
    showToast(`Cleared ${backup.length} pins`, { actionLabel: 'Undo', ms: 5000, onAction: () => { pins = backup; renderPins(); } });
  }

  function renderPins() {
    const layer = $('pinsLayer');
    layer.textContent = '';
    pins.forEach((pin, idx) => {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = `pin-dot pointer-events-auto absolute rounded-full text-[11px] font-extrabold text-white flex items-center justify-center ${pin.source === 'manual' ? 'pin-manual' : 'pin-ai'}`;
      dot.style.left = `${pin.x}%`; dot.style.top = `${pin.y}%`;
      dot.textContent = idx + 1;
      dot.setAttribute('aria-label', `Remove pin ${idx + 1}`);
      dot.addEventListener('click', (e) => removePin(idx, e));
      layer.appendChild(dot);
    });
    recalculateTotals();
  }

  /* ---------- totals ---------- */
  function currentTotals() {
    return C.computeTotals({
      visible: pins.length, hidden: $('hiddenOffsetInput').value,
      mult: $('depthMultSelect').value, mrp: $('mrpInput').value
    });
  }
  function recalculateTotals() {
    const t = currentTotals();
    $('visibleCountDisplay').textContent = t.visible;
    $('totalQtyDisplay').innerHTML = `${t.totalQty} <span class="text-xs font-normal text-slate-400">units</span>`;
    $('totalValueDisplay').textContent = (aiCounted ? '≈ ' : '') + C.fmtInr(t.totalValue);
    scheduleDraft();
  }

  /* ---------- save & sync ---------- */
  async function saveAndSyncEntry() {
    if (!storageReady) return showToast('Still opening storage — try again in a second');
    if (busy.sync || saving) return;
    saving = true;
    try { await saveEntryFlow(); } finally { saving = false; }
  }

  async function saveEntryFlow() {
    const t = currentTotals();
    const partNo = $('partNoInput').value.trim() || 'UNKNOWN-SKU';
    const zone = $('zoneInput').value.trim() || 'UNASSIGNED';
    if (t.totalQty === 0 && !confirm('Total quantity is 0. Save anyway?')) return;
    const today = new Date().toDateString();
    const dup = inventoryLog.find((e) => e.partNo === partNo && e.zone === zone && new Date(e.isoTime).toDateString() === today);
    if (dup && !confirm(`${partNo} in ${zone} was already logged today (${dup.totalQty} pcs).\nAdd this as another entry?\n\n(Cancel, then use Edit on the existing row to correct it.)`)) return;

    const entry = {
      id: C.makeId(), isoTime: new Date().toISOString(), zone, partNo,
      description: $('descInput').value.trim(), barcode: $('barcodeInput').value.trim(), mfgDate: $('mfgInput').value.trim(),
      visibleCount: t.visible, hiddenQty: t.hidden, depthMult: t.mult,
      totalQty: t.totalQty, mrp: t.mrp, totalValue: t.totalValue,
      aiCounted, edited: false, counted: false, syncStatus: 'pending'
    };
    inventoryLog.unshift(entry);
    if (!(await persistLog())) {          // not on disk: keep the form so nothing the user typed is lost
      inventoryLog = inventoryLog.filter((e) => e !== entry); renderLog();
      return;
    }
    renderLog();
    resetForm();
    SVDB.requestPersistence();            // ask the browser not to evict our data (best effort)

    if (!settings().url) { showToast('Saved locally! Add Sheet URL in Setup for cloud sync.'); return; }
    await syncEntries([entry]);
  }

  function resetForm() {
    ['partNoInput', 'barcodeInput', 'descInput', 'mrpInput', 'mfgInput'].forEach((id) => { $(id).value = ''; });
    $('hiddenOffsetInput').value = '0'; $('depthMultSelect').value = '1';
    pins = []; aiCounted = false; currentStackBase64 = null; zoneManual = false;
    $('stackImg').removeAttribute('src'); $('stackImg').classList.add('hidden');
    $('stackPlaceholder').classList.remove('hidden'); $('pinControls').classList.add('hidden');
    $('labelPreviewWrap').classList.add('hidden'); $('labelPreviewImg').removeAttribute('src');
    renderPins(); // zone is intentionally kept: next SKU is usually on the same rack
    clearTimeout(draftTimer); SVDB.clearDraft().catch(() => {});
  }

  /** Posts entries to the Apps Script. Only marks 'synced' when the script confirms with {ok:true}. */
  async function syncEntries(entries) {
    const s = settings();
    if (!s.url) return showToast('Add the Sheet URL in Setup first');
    if (!s.token) { openSettings(); return showToast('Add the access token in Setup first'); }
    busy.sync = true;
    const btn = $('saveSyncBtn'), orig = SAVE_BTN_HTML;
    btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Syncing to Google Sheet...';
    let okCount = 0, lastErr = '';
    try {
      for (const e of entries) {
        try {
          const res = await fetchWithTimeout(s.url, {
            method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({ action: 'append', token: s.token, entry: e })
          });
          const body = await res.json();
          if (!body.ok) throw new Error(body.error || 'Sheet rejected the entry');
          e.syncStatus = 'synced'; okCount++;
        } catch (err) { e.syncStatus = 'failed'; lastErr = err.message; }
      }
    } finally {
      busy.sync = false; btn.disabled = false; btn.innerHTML = orig;
      persistLog(); renderLog();
    }
    const failed = entries.length - okCount;
    if (!failed) showToast(entries.length === 1 ? `Synced ${entries[0].partNo} (${entries[0].totalQty} units) ✓` : `Synced ${okCount} entries ✓`);
    else showToast(`${failed} not synced (${lastErr}). Saved locally — use Retry.`, { ms: 8000 });
  }

  const unsynced = () => inventoryLog.filter((e) => e.syncStatus !== 'synced');

  /* ---------- log rendering / edit / delete ---------- */
  const STATUS = {
    synced: ['text-emerald-400', 'fa-circle-check', 'Synced'],
    pending: ['text-amber-300', 'fa-clock', 'Not synced'],
    failed: ['text-rose-400', 'fa-triangle-exclamation', 'Sync failed']
  };
  function rowHtml(item) {
    const E = C.escapeHtml;
    const st = STATUS[item.syncStatus] || STATUS.pending;
    const when = new Date(item.isoTime).toLocaleString('en-IN');
    return `
      <div class="bg-slate-950 border ${item.counted ? 'border-emerald-500/40' : 'border-slate-800'} rounded-xl p-3 space-y-2">
        <div class="flex items-center justify-between gap-2">
          <div class="min-w-0">
            <div class="flex items-center gap-1.5">
              <span class="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 text-[10px] font-bold">${E(item.zone)}</span>
              <span class="text-xs font-bold text-white truncate">${E(item.partNo)}</span>
            </div>
            <p class="text-[11px] text-slate-400 truncate mt-0.5">${E(item.description) || 'No description'}</p>
            <p class="text-[10px] text-slate-500">${E(when)}${item.aiCounted ? ' • AI est.' : ''}${item.edited ? ' • edited' : ''}</p>
          </div>
          <div class="text-right shrink-0">
            <span class="block text-sm font-black text-emerald-400">${E(item.totalQty)} pcs</span>
            <span class="block text-[10px] text-slate-400">${E(C.fmtInr(item.totalValue))}</span>
          </div>
        </div>
        <div class="flex items-center justify-between gap-2">
          <label class="flex items-center gap-1.5 text-[11px] ${item.counted ? 'text-emerald-300' : 'text-slate-400'}">
            <input type="checkbox" data-act="counted" data-id="${E(item.id)}" ${item.counted ? 'checked' : ''} class="accent-emerald-500 w-4 h-4" /> Verified
          </label>
          <span class="text-[10px] ${st[0]}"><i class="fa-solid ${st[1]} mr-1" aria-hidden="true"></i>${st[2]}</span>
          <div class="flex gap-1.5">
            ${item.syncStatus !== 'synced' && settings().url ? `<button type="button" data-act="resync" data-id="${E(item.id)}" class="px-2.5 py-1.5 rounded bg-slate-800 border border-slate-700 text-[10px] text-sky-300">Retry</button>` : ''}
            <button type="button" data-act="edit" data-id="${E(item.id)}" class="px-2.5 py-1.5 rounded bg-slate-800 border border-slate-700 text-[10px] text-slate-200">Edit qty</button>
            <button type="button" data-act="delete" data-id="${E(item.id)}" class="px-2.5 py-1.5 rounded bg-rose-500/10 border border-rose-500/30 text-[10px] text-rose-300">Delete</button>
          </div>
        </div>
      </div>`;
  }

  const visibleEntries = () => C.filterEntries(inventoryLog, view);

  function renderLog() {
    const E = C.escapeHtml;
    $('logCount').textContent = inventoryLog.length;
    const n = unsynced().length;
    $('unsyncedCount').textContent = n;
    $('retryAllBtn').classList.toggle('hidden', !(n && settings().url));
    $('clearLogBtn').classList.toggle('hidden', !inventoryLog.length);

    const sel = $('logZoneFilter');
    const zones = C.uniqueZones(inventoryLog);
    if (view.zone && !zones.includes(view.zone)) view.zone = '';
    sel.innerHTML = '<option value="">All bays</option>' + zones.map((z) => `<option value="${E(z)}"${z === view.zone ? ' selected' : ''}>${E(z)}</option>`).join('');

    const list = visibleEntries();
    const filtered = !!(view.q || view.zone || view.counted);
    const totQty = list.reduce((a, e) => a + (Number(e.totalQty) || 0), 0);
    const totVal = list.reduce((a, e) => a + (Number(e.totalValue) || 0), 0);
    $('logSummary').textContent = inventoryLog.length ? `Showing ${list.length} of ${inventoryLog.length} • ${totQty} pcs • ${C.fmtInr(totVal)}` : '';
    $('csvLabel').textContent = filtered ? 'CSV (filtered)' : 'CSV';

    const container = $('logList');
    if (!storageReady) { container.innerHTML = '<p class="text-xs text-slate-500 text-center py-4">Opening your saved counts…</p>'; return; }
    if (!inventoryLog.length) { container.innerHTML = '<p class="text-xs text-slate-500 text-center py-4">No scans logged yet.</p>'; return; }
    if (!list.length) { container.innerHTML = '<p class="text-xs text-slate-500 text-center py-4">No entries match this filter.</p>'; return; }
    if (!view.group) { container.innerHTML = list.map(rowHtml).join(''); return; }
    container.innerHTML = C.groupByZone(list).map((g) => `
      <div class="flex items-center justify-between sticky top-0 bg-slate-900 py-1.5 px-1 border-b border-slate-800">
        <span class="px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 text-[11px] font-bold">${E(g.zone)}</span>
        <span class="text-[11px] text-slate-300">${g.entries.length} SKUs • <strong class="text-emerald-400">${g.qty} pcs</strong> • ${E(C.fmtInr(g.value))}</span>
      </div>${g.entries.map(rowHtml).join('')}`).join('');
  }

  function onLogClick(ev) {
    if (!storageReady) return;
    const btn = ev.target.closest('button[data-act]');
    if (!btn) return;
    const idx = inventoryLog.findIndex((e) => e.id === btn.dataset.id);
    if (idx < 0) return;
    const entry = inventoryLog[idx];
    if (btn.dataset.act === 'resync') return syncEntries([entry]);
    if (btn.dataset.act === 'edit') {
      const v = prompt(`Correct total quantity for ${entry.partNo} (${entry.zone}):`, String(entry.totalQty));
      if (v === null) return;
      const q = Math.floor(Number(v));
      if (!Number.isFinite(q) || q < 0 || v.trim() === '') return showToast('Enter a whole number, 0 or more');
      entry.totalQty = q; entry.totalValue = Math.round(q * (entry.mrp || 0) * 100) / 100;
      entry.edited = true; entry.syncStatus = 'pending';
      persistLog(); renderLog();
      if (settings().url) syncEntries([entry]); else showToast('Quantity updated');
      return;
    }
    if (btn.dataset.act === 'delete') {
      inventoryLog.splice(idx, 1); persistLog(); renderLog();
      const hint = entry.syncStatus === 'synced' ? ' (the Sheet row is not deleted — remove it there too)' : '';
      showToast(`Deleted ${entry.partNo}${hint}`, { actionLabel: 'Undo', ms: 7000, onAction: () => { inventoryLog.splice(idx, 0, entry); persistLog(); renderLog(); } });
    }
  }

  /* ---------- backup / restore / diagnostics ---------- */
  function updateBackupHint() {
    const el = $('backupHintBtn'); if (!el) return;
    if (!storageReady || !inventoryLog.length) { el.classList.add('hidden'); return; }
    const last = store.get('sv_last_backup');
    const days = last ? C.daysSince(last) : Infinity;
    if (days <= 7) { el.classList.add('hidden'); return; }
    el.textContent = last ? `⚠ Last backup ${Math.floor(days)} days ago — tap to download a new one` : '⚠ No backup yet — tap to download one';
    el.classList.remove('hidden');
  }

  async function downloadBackup() {
    try {
      const bk = await SVDB.exportAll();
      const blob = new Blob([JSON.stringify(bk)], { type: 'application/json' });
      const a = document.createElement('a'); const url = URL.createObjectURL(blob);
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      a.href = url; a.download = `storevision_backup_${stamp}.json`;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
      store.set('sv_last_backup', new Date().toISOString()); updateBackupHint();
      showToast(`Backup saved: ${bk.counts.entries} entries, ${bk.counts.events} history records`);
    } catch (err) { showToast('Backup failed: ' + err.message); }
  }

  async function restoreBackup(input) {
    const file = input.files && input.files[0]; input.value = '';
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) return showToast('That file is too large to be a StoreVision backup');
    let parsed;
    try { parsed = C.parseBackup(JSON.parse(await file.text())); } catch (e) { parsed = { ok: false, error: 'Could not read that file.' }; }
    if (!parsed.ok) return showToast(parsed.error, { ms: 6000 });
    const have = new Set(inventoryLog.map((e) => e.id));
    const fresh = parsed.entries.filter((e) => !have.has(e.id)).length;
    if (!fresh) return showToast('Nothing to restore — every entry in that backup is already here');
    if (!confirm(`Restore ${fresh} entries from this backup?\n${parsed.entries.length - fresh} already exist and will be left untouched.`)) return;
    try {
      const r = await SVDB.importBackup(parsed);
      inventoryLog = (await SVDB.loadEntries()).entries; renderLog(); updateBackupHint();
      showToast(`Restored ${r.added} entries` + (r.dropped ? ` (${r.dropped} unreadable rows skipped)` : ''), { ms: 6000 });
    } catch (err) { showToast('Restore failed: ' + err.message); }
  }

  async function refreshDiagnostics() {
    const info = await SVDB.storageInfo();
    const crashes = await SVDB.getCrashLog();
    const mode = info.mode === 'idb' ? 'Secure database (IndexedDB)' : 'Basic storage (localStorage — less safe)';
    const persist = info.persisted === true ? 'protected from automatic cleanup' : info.persisted === false ? 'NOT protected from automatic cleanup — keep backups' : 'protection status unknown';
    $('storageInfo').textContent = `${mode}; ${persist}.` + (info.usageMB != null ? ` Using ${info.usageMB} MB.` : '') + ` ${inventoryLog.length} entries.`;
    $('errorCount').textContent = crashes.length;
  }

  async function copyErrorLog() {
    const log = await SVDB.getCrashLog();
    const text = JSON.stringify({ app: 'StoreVision', at: new Date().toISOString(), ua: navigator.userAgent, errors: log.slice(-20) }, null, 2);
    try { await navigator.clipboard.writeText(text); showToast('Error log copied'); }
    catch (e) { window.prompt('Copy this error log:', text); }
  }

  /* ---------- export / share ---------- */
  function exportCSV() {
    const rows = visibleEntries();
    if (!rows.length) return showToast('Nothing to export for this filter');
    const blob = new Blob([C.entriesToCsv(rows)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url; a.download = `storevision_${view.zone ? view.zone.replace(/[^A-Za-z0-9_-]/g, '') + '_' : ''}${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  async function copyWhatsAppSummary() {
    const rows = visibleEntries();
    if (!rows.length) return showToast('Nothing to share for this filter');
    const MAX = 15;
    const lines = rows.slice(0, MAX).map((r) => `• [${r.zone}] ${r.partNo}: *${r.totalQty} pcs* (${C.fmtInr(r.totalValue)})`);
    if (rows.length > MAX) lines.push(`…and ${rows.length - MAX} more (see CSV)`);
    const text = `*StoreVision Inventory Count*\n${lines.join('\n')}`;
    try {
      if (navigator.share) { await navigator.share({ text }); return; }
      await navigator.clipboard.writeText(text);
      showToast('Summary copied to clipboard');
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      window.prompt('Copy this summary:', text); // clipboard blocked (non-HTTPS / webview)
    }
  }

  /* ---------- wiring ---------- */
  function init() {
    $('openSettingsBtn').addEventListener('click', openSettings);
    $('closeSettingsX').addEventListener('click', closeSettings);
    $('cancelSettingsBtn').addEventListener('click', closeSettings);
    $('saveSettingsBtn').addEventListener('click', saveSettings);
    $('useProxyToggle').addEventListener('change', syncDirectKeyVisibility);
    $('checkModelsBtn').addEventListener('click', checkModels);
    $('modelSelect').addEventListener('change', (e) => $('modelCustomInput').classList.toggle('hidden', e.target.value !== CUSTOM));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSettings(); });

    ['labelCamera', 'labelGallery'].forEach((id) => $(id).addEventListener('change', (e) => handleLabelFile(e.target)));
    ['stackCamera', 'stackGallery'].forEach((id) => $(id).addEventListener('change', (e) => handleStackFile(e.target)));
    $('stackImg').addEventListener('click', addManualPin);
    $('recountBtn').addEventListener('click', recountWithAI);
    $('clearPinsBtn').addEventListener('click', clearPins);
    ['mrpInput', 'hiddenOffsetInput'].forEach((id) => $(id).addEventListener('input', recalculateTotals));
    $('depthMultSelect').addEventListener('change', recalculateTotals);
    $('zoneInput').addEventListener('input', () => { zoneManual = true; });
    $('saveSyncBtn').addEventListener('click', saveAndSyncEntry);
    $('saveSyncBtn').disabled = true;     // enabled once storage has opened
    ['partNoInput', 'barcodeInput', 'descInput', 'mfgInput', 'zoneInput'].forEach((id) => $(id).addEventListener('input', scheduleDraft));
    $('roiToggle').addEventListener('change', scheduleDraft);

    $('downloadBackupBtn').addEventListener('click', downloadBackup);
    $('backupHintBtn').addEventListener('click', downloadBackup);
    $('restoreBackupInput').addEventListener('change', (e) => restoreBackup(e.target));
    $('copyErrorsBtn').addEventListener('click', copyErrorLog);
    $('clearErrorsBtn').addEventListener('click', async () => { await SVDB.clearCrashLog(); refreshDiagnostics(); });
    $('errorReloadBtn').addEventListener('click', () => location.reload());
    $('errorDismissBtn').addEventListener('click', () => $('errorBanner').classList.add('hidden'));
    $('errorDetailsBtn').addEventListener('click', () => { $('errorBanner').classList.add('hidden'); openSettings(); });

    $('logList').addEventListener('click', onLogClick);
    $('logList').addEventListener('change', (ev) => {
      const cb = ev.target.closest('input[data-act="counted"]');
      if (!cb) return;
      const entry = inventoryLog.find((e) => e.id === cb.dataset.id);
      if (!entry) return;
      entry.counted = cb.checked; entry.syncStatus = 'pending';
      persistLog(); renderLog();
      if (settings().url) syncEntries([entry]);
    });
    let searchTimer;
    $('logSearch').addEventListener('input', (e) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { view.q = e.target.value; renderLog(); }, 150); });
    $('logZoneFilter').addEventListener('change', (e) => { view.zone = e.target.value; renderLog(); });
    $('logCountedFilter').addEventListener('change', (e) => { view.counted = e.target.value; renderLog(); });
    $('logGroupToggle').addEventListener('change', (e) => { view.group = e.target.checked; renderLog(); });
    $('exportCsvBtn').addEventListener('click', exportCSV);
    $('shareBtn').addEventListener('click', copyWhatsAppSummary);
    $('retryAllBtn').addEventListener('click', () => syncEntries(unsynced()));
    $('clearLogBtn').addEventListener('click', () => {
      const n = unsynced().length;
      if (!confirm(n ? `${n} entries are NOT synced and will be lost. Export CSV first.\n\nClear the whole local log?` : 'Clear the whole local log? (Sheet rows are not affected.)')) return;
      inventoryLog = []; persistLog(); renderLog(); updateBackupHint();
      showToast('Local log cleared (history is kept in the audit log; restore from a backup if needed)', { ms: 6000 });
    });

    const setOffline = () => $('offlineBadge').classList.toggle('hidden', navigator.onLine);
    window.addEventListener('online', setOffline); window.addEventListener('offline', setOffline); setOffline();

    // flush the draft the moment the page is hidden: iOS can kill background tabs without warning
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushDraft();
      else if (storageReady && !busy.sync && !saving) reloadFromStorage();   // pick up changes made in another tab
    });
    window.addEventListener('pagehide', flushDraft);

    updateSyncBadge(); renderPins(); renderLog();
    initStorage();
    if (!settings().key && !settings().proxy) setTimeout(() => showToast('Tap Setup to enter your Gemini key or proxy'), 800);

    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      let hadController = !!navigator.serviceWorker.controller;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController) { hadController = true; return; }            // first install, not an update
        showToast('A new version is ready', { actionLabel: 'Reload', ms: 15000, onAction: () => location.reload() });
      });
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  async function reloadFromStorage() {
    try { inventoryLog = (await SVDB.loadEntries()).entries; renderLog(); updateBackupHint(); } catch (e) { /* keep what we have */ }
  }

  async function initStorage() {
    try {
      const info = await SVDB.open();
      const { entries, dropped } = await SVDB.loadEntries();
      inventoryLog = entries; storageReady = true;
      $('saveSyncBtn').disabled = false;
      renderLog(); updateBackupHint();
      if (info.mode !== 'idb') showToast('⚠ Secure storage is unavailable here — using basic storage. Download backups often.', { ms: 9000 });
      else if (info.migrated) showToast(`Moved ${info.migrated} earlier entries into secure storage`, { ms: 6000 });
      if (dropped) showToast(`${dropped} unreadable entries were skipped`, { ms: 6000 });
      await restoreDraft();
      SVDB.requestPersistence();
    } catch (err) {
      onFatal('init', err);
      showToast('Could not open storage: ' + (err && err.message || err), { ms: 9000 });
    } finally {
      document.documentElement.dataset.ready = '1';
    }
  }
  document.addEventListener('DOMContentLoaded', init);
})();
