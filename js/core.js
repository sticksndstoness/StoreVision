/* Pure, DOM-free logic. Loaded by the browser as window.SVCore and by Node tests via module.exports. */
(function (root) {
  'use strict';

  const SVCore = {};

  SVCore.escapeHtml = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  };

  /** Neutralise spreadsheet formula injection (=, +, -, @, tab, CR). */
  SVCore.safeCell = function (v) {
    const s = String(v == null ? '' : v);
    return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  };

  SVCore.csvCell = function (v) {
    const s = typeof v === 'number' ? String(v) : SVCore.safeCell(v);
    return '"' + s.replace(/"/g, '""') + '"';
  };

  /** Single source of truth for quantity maths (used by live display AND saved entry). */
  SVCore.computeTotals = function ({ visible, hidden, mult, mrp }) {
    const v = Math.max(0, Math.floor(Number(visible) || 0));
    const h = Math.max(0, Math.floor(Number(hidden) || 0));
    const m = Math.max(1, Math.floor(Number(mult) || 1));
    const p = Math.max(0, Number(mrp) || 0);
    const depthExtra = v * (m - 1);
    const totalQty = v * m + h;
    return { visible: v, hidden: h, mult: m, mrp: p, depthExtra, totalQty, totalValue: Math.round(totalQty * p * 100) / 100 };
  };

  /** Validate / normalise pins returned by the model. Drops anything non-numeric. */
  SVCore.normalisePins = function (items) {
    if (!Array.isArray(items)) return [];
    const out = [];
    for (const pt of items) {
      if (!pt || typeof pt !== 'object') continue;
      const num = (v) => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) ? Number(v) : NaN;
      const x = num(pt.x), y = num(pt.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      out.push({ x: Math.max(2, Math.min(98, x / 10)), y: Math.max(2, Math.min(98, y / 10)), source: 'ai' });
    }
    return out;
  };

  SVCore.extractGeminiText = function (json) {
    if (json && json.promptFeedback && json.promptFeedback.blockReason) {
      throw new Error('Request blocked by Gemini: ' + json.promptFeedback.blockReason);
    }
    const cand = json && json.candidates && json.candidates[0];
    if (!cand) throw new Error('Gemini returned no result. Try again.');
    if (cand.finishReason === 'MAX_TOKENS') throw new Error('Gemini response was cut off. Try a closer photo.');
    const parts = (cand.content && cand.content.parts) || [];
    const text = parts.map((p) => p.text || '').join('').trim();
    if (!text) throw new Error('Gemini returned an empty answer. Try again.');
    return text;
  };

  SVCore.parseModelJson = function (text) {
    const cleaned = String(text).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    try { return JSON.parse(cleaned); }
    catch (e) { throw new Error('Could not understand the AI response (invalid JSON). Try again.'); }
  };

  /** Turn a Gemini ListModels response into [{id,label}] of models usable for image -> JSON (generateContent). */
  SVCore.parseModelList = function (json) {
    const list = (json && Array.isArray(json.models)) ? json.models : [];
    const skip = /embed|tts|imagen|veo|live|audio|aqa|image-generation|robotics|learnlm/i;
    const seen = new Set(); const out = [];
    for (const m of list) {
      const id = String(m && m.name || '').replace(/^models\//, '');
      if (!id || seen.has(id) || skip.test(id)) continue;
      if (Array.isArray(m.supportedGenerationMethods) && !m.supportedGenerationMethods.includes('generateContent')) continue;
      seen.add(id); out.push({ id, label: m.displayName || id });
    }
    // flash-class first (default for this app), then the rest newest-looking (reverse natural order) first
    const rank = (id) => (/flash/i.test(id) && !/lite/i.test(id) ? 0 : /pro/i.test(id) ? 1 : /lite/i.test(id) ? 2 : 3);
    return out.sort((a, b) => rank(a.id) - rank(b.id) || b.id.localeCompare(a.id, undefined, { numeric: true }));
  };


  /* ---------- hardening: validation, change tracking, backups ---------- */
  const STATUSES = ['synced', 'pending', 'failed'];
  const str = (v, max) => String(v == null ? '' : v).slice(0, max);
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

  /** Coerce an arbitrary stored/imported row into a safe entry, or null if it is unusable. Never throws. */
  SVCore.sanitizeEntry = function (raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const m = SVCore.migrateEntry(raw);
    if (!m || typeof m !== 'object') return null;
    const d = new Date(m.isoTime);
    const qty = Math.max(0, num(m.totalQty));
    return {
      id: str(m.id, 64) || SVCore.makeId(),
      isoTime: isNaN(d) ? new Date().toISOString() : d.toISOString(),
      zone: str(m.zone, 40) || 'UNASSIGNED', partNo: str(m.partNo, 80) || 'UNKNOWN-SKU',
      description: str(m.description, 300), barcode: str(m.barcode, 120), mfgDate: str(m.mfgDate, 40),
      visibleCount: Math.max(0, Math.floor(num(m.visibleCount))), hiddenQty: Math.max(0, num(m.hiddenQty)),
      depthMult: Math.max(1, Math.floor(num(m.depthMult)) || 1),
      totalQty: qty, mrp: Math.max(0, num(m.mrp)), totalValue: Math.max(0, num(m.totalValue)),
      aiCounted: !!m.aiCounted, edited: !!m.edited, counted: !!m.counted,
      syncStatus: STATUSES.includes(m.syncStatus) ? m.syncStatus : 'pending'
    };
  };

  /** Sanitise a list; returns {entries, dropped}. Duplicate ids keep the first occurrence. */
  SVCore.sanitizeEntries = function (list) {
    const out = []; const seen = new Set(); let dropped = 0;
    for (const r of Array.isArray(list) ? list : []) {
      const e = SVCore.sanitizeEntry(r);
      if (!e || seen.has(e.id)) { dropped++; continue; }
      seen.add(e.id); out.push(e);
    }
    return { entries: out, dropped };
  };

  /**
   * Compare the previously persisted snapshot (Map id -> JSON string) with the current in-memory list.
   * Returns what must be written, plus append-only audit events (create / update / delete with full snapshots,
   * so a deleted or edited entry can always be recovered from the event log).
   */
  SVCore.diffEntries = function (prevMap, nextList, nowIso) {
    const at = nowIso || new Date().toISOString();
    const puts = [], events = [], nextIds = new Set();
    for (const e of nextList) {
      nextIds.add(e.id);
      const json = JSON.stringify(e);
      const before = prevMap.get(e.id);
      if (before === undefined) { puts.push(e); events.push({ type: 'create', entryId: e.id, at, after: e }); }
      else if (before !== json) { puts.push(e); events.push({ type: 'update', entryId: e.id, at, before: JSON.parse(before), after: e }); }
    }
    const deletes = [];
    for (const [id, json] of prevMap) {
      if (!nextIds.has(id)) { deletes.push(id); events.push({ type: 'delete', entryId: id, at, before: JSON.parse(json) }); }
    }
    return { puts, deletes, events };
  };

  SVCore.BACKUP_FORMAT = 'storevision-backup';
  SVCore.BACKUP_VERSION = 1;

  SVCore.makeBackup = function (entries, events, extra) {
    return { format: SVCore.BACKUP_FORMAT, version: SVCore.BACKUP_VERSION, exportedAt: new Date().toISOString(),
      counts: { entries: entries.length, events: (events || []).length }, entries, events: events || [], ...(extra || {}) };
  };

  /** Validate a parsed backup file. Never throws. */
  SVCore.parseBackup = function (obj) {
    if (!obj || typeof obj !== 'object' || obj.format !== SVCore.BACKUP_FORMAT) return { ok: false, error: 'This is not a StoreVision backup file.' };
    if (!Number.isInteger(obj.version) || obj.version > SVCore.BACKUP_VERSION) return { ok: false, error: 'This backup was made by a newer version of the app.' };
    if (!Array.isArray(obj.entries)) return { ok: false, error: 'The backup has no entries list.' };
    const { entries, dropped } = SVCore.sanitizeEntries(obj.entries);
    return { ok: true, entries, dropped, events: Array.isArray(obj.events) ? obj.events : [] };
  };

  /** Which backup entries are not already present (existing data always wins; restore never overwrites). */
  SVCore.mergeBackup = function (existing, incoming) {
    const have = new Set(existing.map((e) => e.id));
    const add = incoming.filter((e) => !have.has(e.id));
    return { add, skipped: incoming.length - add.length };
  };

  SVCore.daysSince = function (iso, now) {
    const t = Date.parse(iso); if (!Number.isFinite(t)) return Infinity;
    return ((now == null ? Date.now() : now) - t) / 86400000;
  };

  /** Free-form crash record, bounded so a crash loop cannot fill storage. */
  SVCore.makeCrashRecord = function (kind, err, ctx) {
    const e = err && typeof err === 'object' ? err : { message: String(err) };
    return { at: new Date().toISOString(), kind: str(kind, 30), message: str(e.message || e, 500), stack: str(e.stack, 2000), ctx: str(ctx, 200) };
  };

  /** Minimum gap between AI calls + daily cap, as a pure function so it can be tested. */
  SVCore.aiAllowance = function ({ lastAt, now, countToday, minGapMs, dailyCap }) {
    if (countToday >= dailyCap) return { ok: false, reason: `Daily AI limit (${dailyCap}) reached. Count manually or try tomorrow.` };
    if (lastAt && now - lastAt < minGapMs) return { ok: false, reason: 'Please wait a moment before the next AI request.' };
    return { ok: true };
  };

  SVCore.makeId = function () {
    return 'sv_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  };

  SVCore.fmtInr = function (n, digits) {
    return '₹' + (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: digits == null ? 0 : digits });
  };

  /** Migrate v1 log rows (no id / ISO ts / sync flag) to the v2 shape. */
  SVCore.migrateEntry = function (r) {
    if (r && r.id && r.isoTime) return r;
    const visible = Number(r.visibleCount) || 0;
    return {
      id: r.id ? String(r.id) : SVCore.makeId(),
      isoTime: (() => { const d = new Date(r.isoTime || r.timestamp); return isNaN(d) ? new Date().toISOString() : d.toISOString(); })(),
      zone: r.zone || 'UNASSIGNED', partNo: r.partNo || 'UNKNOWN-SKU', description: r.description || '',
      barcode: r.barcode || '', mfgDate: r.mfgDate || '',
      visibleCount: visible, hiddenQty: Number(r.hiddenQty != null ? r.hiddenQty : r.hiddenOffset) || 0, depthMult: Number(r.depthMult) || 1,
      totalQty: Number(r.totalQty) || 0, mrp: Number(r.mrp) || 0, totalValue: Number(r.totalValue) || 0,
      aiCounted: !!r.aiCounted, edited: !!r.edited, counted: !!r.counted, syncStatus: r.syncStatus || 'pending'
    };
  };

  /** Filter by free-text query and/or exact zone. */
  SVCore.filterEntries = function (entries, { q = '', zone = '', counted = '' } = {}) {
    const needle = String(q).trim().toLowerCase();
    return entries.filter((e) => {
      if (zone && e.zone !== zone) return false;
      if (counted === 'yes' && !e.counted) return false;
      if (counted === 'no' && e.counted) return false;
      if (!needle) return true;
      return [e.partNo, e.description, e.barcode, e.zone].some((f) => String(f || '').toLowerCase().includes(needle));
    });
  };

  SVCore.uniqueZones = function (entries) {
    return Array.from(new Set(entries.map((e) => e.zone))).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  };

  /** Group (already filtered) entries by zone, with qty/value subtotals. Order: zone name, entries keep their order. */
  SVCore.groupByZone = function (entries) {
    const map = new Map();
    for (const e of entries) {
      if (!map.has(e.zone)) map.set(e.zone, { zone: e.zone, entries: [], qty: 0, value: 0 });
      const g = map.get(e.zone); g.entries.push(e); g.qty += Number(e.totalQty) || 0; g.value += Number(e.totalValue) || 0;
    }
    return Array.from(map.values()).sort((a, b) => a.zone.localeCompare(b.zone, undefined, { numeric: true }));
  };

  SVCore.entriesToCsv = function (entries) {
    const headers = ['ID', 'Timestamp (ISO)', 'Bay/Zone', 'Part No', 'Description', 'Barcode', 'Mfg Date', 'Visible Count', 'Hidden Qty (typed)', 'Depth Mult', 'Total Qty', 'MRP', 'Total Value', 'AI Counted', 'Edited', 'Counted/Verified', 'Sync Status'];
    const rows = entries.map((r) => [
      r.id, r.isoTime, r.zone, r.partNo, r.description, r.barcode, r.mfgDate,
      r.visibleCount, r.hiddenQty, r.depthMult, r.totalQty, r.mrp, r.totalValue,
      r.aiCounted ? 'yes' : 'no', r.edited ? 'yes' : 'no', r.counted ? 'yes' : 'no', r.syncStatus
    ].map(SVCore.csvCell).join(','));
    return '﻿' + [headers.map(SVCore.csvCell).join(','), ...rows].join('\r\n');
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = SVCore;
  else root.SVCore = SVCore;
})(typeof self !== 'undefined' ? self : this);
