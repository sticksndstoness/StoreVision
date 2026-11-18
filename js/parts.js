/* Part identification against the branch's SAP part list (window.SVParts). Pure functions, no network.
 * The list holds code, description, unit and bin(s) - never quantities or prices.
 * Goal: turn whatever the camera managed to read (part number text, QR/barcode text, or a few typed letters) into ONE exact SAP part. */
(function (root) {
  'use strict';
  const SVParts = {};

  SVParts.norm = (s) => String(s == null ? '' : s).toUpperCase().replace(/\s+/g, '');
  const base = (k) => k.replace(/\([^)]*\)\s*$/, '');                   // "53XW001(L)" -> "53XW001"
  const FOLD = { O: '0', Q: '0', I: '1', L: '1', S: '5', B: '8', Z: '2' };   // letters that are commonly misread as digits (and back)
  const fold = (k) => k.replace(/[OQILSBZ]/g, (c) => FOLD[c]);

  function lev1(a, b) {                                                 // true when the strings differ by at most ONE edit
    if (a === b) return true;
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0, j = 0, edits = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { i++; j++; continue; }
      if (++edits > 1) return false;
      if (a.length > b.length) i++; else if (a.length < b.length) j++; else { i++; j++; }
    }
    return edits + (a.length - i) + (b.length - j) <= 1;
  }

  /** rows: [{part_code, description, uom, bin}] -> index */
  SVParts.build = function (rows) {
    const parts = new Map();
    for (const r of Array.isArray(rows) ? rows : []) {
      const code = String(r && r.part_code != null ? r.part_code : '').trim(); if (!code) continue;
      const key = SVParts.norm(code);
      let p = parts.get(key);
      if (!p) { p = { part_code: code, description: '', uom: '', bins: [], key, baseKey: base(key), foldKey: fold(base(key)), descLower: '' }; parts.set(key, p); }
      if (!p.description && r.description) { p.description = String(r.description).trim(); p.descLower = p.description.toLowerCase(); }
      if (!p.uom && r.uom) p.uom = String(r.uom).trim();
      const bin = String(r.bin == null ? '' : r.bin).trim();
      if (bin && !p.bins.includes(bin)) p.bins.push(bin);
    }
    const list = [...parts.values()].sort((a, b) => a.part_code.localeCompare(b.part_code, undefined, { numeric: true }));
    const byBase = new Map(); for (const p of list) { if (!byBase.has(p.baseKey)) byBase.set(p.baseKey, []); byBase.get(p.baseKey).push(p); }
    return { byKey: parts, byBase, list, size: list.length };
  };

  /** Exact lookup (case/space-insensitive). "53XW001" also finds "53XW001(L)" when that is the only variant. */
  SVParts.find = function (index, text) {
    if (!index) return null;
    const k = SVParts.norm(text); if (!k) return null;
    const exact = index.byKey.get(k); if (exact) return { part: exact, alternatives: (index.byBase.get(exact.baseKey) || []).filter((p) => p !== exact) };
    const variants = index.byBase.get(base(k)) || [];
    return variants.length ? { part: variants[0], alternatives: variants.slice(1) } : null;
  };

  /** QR / barcode text often holds several fields ("PHJ00006|CBL0NL0050", "PHJ00006,CBL0NL0050,3470.00"). Try every piece. */
  SVParts.fromText = function (index, text) {
    const t = String(text == null ? '' : text); if (!index || !t.trim()) return null;
    const whole = SVParts.find(index, t); if (whole) return Object.assign({ token: t.trim() }, whole);
    const tokens = t.split(/[^A-Za-z0-9()\-]+/).map((x) => x.replace(/^[()\-]+|[()\-]+$/g, '')).filter((x) => x.length >= 4);
    for (const tok of tokens) { const hit = SVParts.find(index, tok); if (hit) return Object.assign({ token: tok }, hit); }
    return null;
  };

  /** Close-but-not-exact candidates for a misread code: look-alike characters (O/0, I/1, S/5, B/8 ...) or one wrong/missing/extra character. */
  SVParts.suggest = function (index, text, max) {
    max = max || 5; if (!index) return [];
    const k = base(SVParts.norm(text)); if (k.length < 5) return [];          // too short to guess safely
    const fk = fold(k); const out = [];
    for (const p of index.list) {
      if (p.baseKey === k) continue;
      if (p.foldKey === fk) out.push({ p, d: 0 });
      else if (k.length >= 6 && (lev1(p.baseKey, k) || lev1(p.foldKey, fk))) out.push({ p, d: 1 });
    }
    const strong = out.filter((x) => x.d === 0);                              // a look-alike match is far more likely than a one-character slip
    return (strong.length ? strong : out).sort((a, b) => a.d - b.d || a.p.part_code.localeCompare(b.p.part_code)).slice(0, max).map((x) => x.p);
  };

  /**
   * One call for the whole label. input: { partNo, texts: [qr/barcode strings] }
   * -> { status: 'exact' | 'suggest' | 'none', part, via, token, alternatives, suggestions }
   */
  SVParts.identify = function (index, input) {
    input = input || {}; if (!index || !index.size) return { status: 'none', suggestions: [] };
    const a = input.partNo ? SVParts.find(index, input.partNo) : null;
    if (a) return { status: 'exact', part: a.part, via: 'part number', token: String(input.partNo).trim(), alternatives: a.alternatives, suggestions: [] };
    for (const t of input.texts || []) { const h = SVParts.fromText(index, t); if (h) return { status: 'exact', part: h.part, via: 'QR / barcode', token: h.token, alternatives: h.alternatives, suggestions: [] }; }
    const sug = [];
    const add = (arr) => arr.forEach((p) => { if (!sug.includes(p)) sug.push(p); });
    if (input.partNo) add(SVParts.suggest(index, input.partNo));
    for (const t of input.texts || []) for (const tok of String(t).split(/[^A-Za-z0-9()\-]+/)) if (tok.length >= 6) add(SVParts.suggest(index, tok, 2));
    return { status: sug.length ? 'suggest' : 'none', suggestions: sug.slice(0, 5) };
  };

  /** Type-ahead for typed text: code (exact, prefix, contains) first, then description words. */
  SVParts.search = function (index, query, max) {
    max = max || 8; if (!index) return [];
    const raw = String(query == null ? '' : query).trim(); if (raw.length < 2) return [];
    const q = SVParts.norm(raw), words = raw.toLowerCase().split(/\s+/).filter(Boolean); const scored = [];
    for (const p of index.list) {
      let s = 9;
      if (p.key === q || p.baseKey === q) s = 0; else if (p.key.startsWith(q)) s = 1; else if (p.key.includes(q)) s = 2;
      else if (words.every((w) => p.descLower.startsWith(w) || p.descLower.includes(' ' + w))) s = 3;
      else if (words.every((w) => p.descLower.includes(w))) s = 4;
      if (s < 9) scored.push({ p, s });
    }
    return scored.sort((a, b) => a.s - b.s || a.p.part_code.localeCompare(b.p.part_code, undefined, { numeric: true })).slice(0, max).map((x) => x.p);
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = SVParts; else root.SVParts = SVParts;
})(typeof self !== 'undefined' ? self : this);
