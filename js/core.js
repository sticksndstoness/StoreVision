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
      id: SVCore.makeId(),
      isoTime: (() => { const d = new Date(r.timestamp); return isNaN(d) ? new Date().toISOString() : d.toISOString(); })(),
      zone: r.zone || 'UNASSIGNED', partNo: r.partNo || 'UNKNOWN-SKU', description: r.description || '',
      barcode: r.barcode || '', mfgDate: r.mfgDate || '',
      visibleCount: visible, hiddenQty: Number(r.hiddenOffset) || 0, depthMult: 1,
      totalQty: Number(r.totalQty) || 0, mrp: Number(r.mrp) || 0, totalValue: Number(r.totalValue) || 0,
      aiCounted: false, edited: false, counted: false, syncStatus: 'pending'
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
