/* SAP stock report reader (window.SVSap). Pure functions except readFile(), which needs the browser's File + read-excel-file.
 *
 * What the real "Stock Report" export looks like (verified against a Bilaspur sample):
 *   - an optional title row "Total Number of Lines: N", a blank row, then the header row, then ONE ROW PER PART PER GRN LOT;
 *   - physical stock = "Total Quantity" (= Available + Reserved + Blocked). "Issued Quantity" is lot history and "IN-Transit"
 *     is not in the store, so neither is added;
 *   - "Part-Bin Location" is the rack/bay; "Lot-Bin Location" (BIN01...) is not;
 *   - part codes are text; quantities can be fractional for L / M / KG.
 * We sum the lot rows per (part, bin) and report anything that would make a comparison untrustworthy. */
(function (root) {
  'use strict';
  const SVSap = {};

  const ALIASES = {
    branch: ['branch code'], part: ['part code', 'material', 'material code'], desc: ['part desc.', 'part desc', 'part description', 'description'],
    uom: ['primary uom', 'uom', 'unit'], bin: ['part-bin location', 'part bin location', 'bin', 'bin location'],
    total: ['total quantity'], avail: ['available quantity'], blocked: ['blocked quantity'],
    cost: ['cost', 'unit cost'], mrp: ['current mrp', 'mrp'], amount: ['amount', 'value'], sloc: ['storage location no', 'storage location']
  };
  const norm = (v) => String(v == null ? '' : v).trim().toLowerCase().replace(/\s+/g, ' ');
  const NO_BIN = 'NO BIN';

  function num(v) {
    if (typeof v === 'number') return v;
    if (v == null) return 0;
    const s = String(v).replace(/[,\s]/g, '');
    if (s === '' || s === '-') return 0;
    const n = Number(s);
    return Number.isFinite(n) ? n : NaN;
  }
  const round = (n, d) => { const f = Math.pow(10, d); return Math.round((n + Number.EPSILON) * f) / f; };

  /** "Stock_Report_15.10.2026_Bilaspur_1.xlsx" -> "2026-10-15" (or null). Accepts dd.mm.yyyy, dd-mm-yyyy, dd_mm_yyyy and yyyy-mm-dd. */
  SVSap.reportDateFromName = function (name) {
    const s = String(name || '');
    let m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (m) return valid(m[1], m[2], m[3]);
    m = s.match(/(\d{1,2})[._-](\d{1,2})[._-](\d{4})/);
    return m ? valid(m[3], m[2], m[1]) : null;
  };
  function valid(y, mo, d) {
    const dt = new Date(Date.UTC(+y, +mo - 1, +d));
    return dt.getUTCFullYear() === +y && dt.getUTCMonth() === +mo - 1 && dt.getUTCDate() === +d ? `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null;
  }

  /** Quote-aware CSV -> array of rows (handles commas, quotes, CRLF). */
  SVSap.parseCsv = function (text) {
    const rows = []; let row = [], cell = '', q = false;
    const src = String(text || '').replace(/^﻿/, '');
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (q) { if (c === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
      else if (c === '"') q = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && src[i + 1] === '\n') i++; row.push(cell); cell = ''; rows.push(row); row = []; }
      else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
  };

  /**
   * Turn a grid of cells into aggregated stock rows.
   * Returns { ok, errors[], warnings[], rows[], summary } - when errors is non-empty the file MUST NOT be imported.
   */
  SVSap.parseRows = function (grid, opts) {
    opts = opts || {};
    const errors = [], warnings = [];
    const rows2d = Array.isArray(grid) ? grid : [];
    // 1. find the header row (the title / blank rows above it vary)
    let h = -1, col = {};
    for (let i = 0; i < Math.min(rows2d.length, 15); i++) {
      const cells = (rows2d[i] || []).map(norm);
      if (cells.includes('part code') && cells.includes('total quantity')) {
        h = i;
        for (const k of Object.keys(ALIASES)) { const idx = cells.findIndex((c) => ALIASES[k].includes(c)); if (idx >= 0) col[k] = idx; }
        if (col.mrp != null) { const cur = cells.indexOf('current mrp'); if (cur >= 0) col.mrp = cur; }
        break;
      }
    }
    if (h < 0) return fail('This does not look like a SAP stock report: the "Part Code" and "Total Quantity" columns were not found.');
    if (col.part == null || col.total == null) return fail('The "Part Code" or "Total Quantity" column is missing.');
    if (col.cost == null) warnings.push('There is no "Cost" column, so expensive (sensitive) parts cannot be identified.');
    if (col.bin == null) warnings.push('There is no "Part-Bin Location" column, so parts cannot be listed by bay.');
    if (col.branch == null) warnings.push('There is no "Branch Code" column, so the branch cannot be double-checked from the file.');

    // 2. the declared line count (guards against a cut-off export)
    let declared = null;
    for (let i = 0; i < h; i++) for (const c of rows2d[i] || []) { const m = String(c == null ? '' : c).match(/total number of lines\s*:\s*([\d,]+)/i); if (m) declared = Number(m[1].replace(/,/g, '')); }

    // 3. data rows
    const agg = new Map(); const branches = new Set(); const slocs = new Set(); let lines = 0, skippedBlank = 0, bad = 0;
    const get = (r, k) => (col[k] == null ? undefined : r[col[k]]);
    for (let i = h + 1; i < rows2d.length; i++) {
      const r = rows2d[i] || [];
      if (!r.some((c) => c !== '' && c != null)) continue;                                  // totally empty row
      const part = String(get(r, 'part') == null ? '' : get(r, 'part')).trim().toUpperCase();
      if (!part) { skippedBlank++; continue; }
      lines++;
      const total = num(get(r, 'total'));
      const cost = col.cost == null ? 0 : num(get(r, 'cost'));
      const amountRaw = col.amount == null ? NaN : num(get(r, 'amount'));
      if (!Number.isFinite(total) || !Number.isFinite(cost)) { bad++; if (bad <= 5) errors.push(`Row ${i + 1} (${part}): the quantity or cost is not a number.`); continue; }
      let bin = String(get(r, 'bin') == null ? '' : get(r, 'bin')).trim().toUpperCase().replace(/\s+/g, ' ');
      if (bin === '' || bin === '0') bin = NO_BIN;
      if (col.branch != null) { const b = String(get(r, 'branch') == null ? '' : get(r, 'branch')).trim(); if (b) branches.add(b); }
      if (col.sloc != null) { const s = String(get(r, 'sloc') == null ? '' : get(r, 'sloc')).trim(); if (s) slocs.add(s); }
      const key = part + '\u0000' + bin;
      let a = agg.get(key);
      if (!a) { a = { part_code: part, description: '', uom: '', bin, book_qty: 0, available_qty: 0, blocked_qty: 0, value: 0, maxCost: 0, mrp: 0 }; agg.set(key, a); }
      a.book_qty += total;
      a.available_qty += num(get(r, 'avail')) || 0;
      a.blocked_qty += num(get(r, 'blocked')) || 0;
      a.value += Number.isFinite(amountRaw) && col.amount != null ? amountRaw : total * cost;
      a.maxCost = Math.max(a.maxCost, cost);
      a.mrp = Math.max(a.mrp, num(get(r, 'mrp')) || 0);
      if (!a.description) a.description = String(get(r, 'desc') == null ? '' : get(r, 'desc')).trim().slice(0, 200);
      if (!a.uom) a.uom = String(get(r, 'uom') == null ? '' : get(r, 'uom')).trim().toUpperCase().slice(0, 10);
      if (total < 0) warnings.push(`${part}: negative stock (${total}).`);
    }
    if (bad > 5) errors.push(`...and ${bad - 5} more rows with unreadable numbers.`);
    if (!lines) errors.push('No stock rows were found under the header.');
    if (declared != null && lines && declared !== lines) errors.push(`The file says it has ${declared} lines but ${lines} were read. The export may be cut off - download it again.`);
    if (branches.size > 1) errors.push(`The file mixes several branches (${[...branches].join(', ')}). Upload one branch per file.`);
    if (slocs.size > 1) warnings.push(`The file has ${slocs.size} storage locations (${[...slocs].join(', ')}); they are combined.`);
    if (skippedBlank) warnings.push(`${skippedBlank} rows without a Part Code were ignored.`);

    // 4. finish rows: unit cost = value / qty (weighted over lots), natural sort by bin then part
    const threshold = opts.sensitiveThreshold == null ? 10000 : opts.sensitiveThreshold;
    const out = [...agg.values()].map((a) => {
      const unit = a.book_qty > 0 ? a.value / a.book_qty : a.maxCost;
      return { part_code: a.part_code, description: a.description, uom: a.uom, bin: a.bin, book_qty: round(a.book_qty, 3), available_qty: round(a.available_qty, 3),
        blocked_qty: round(a.blocked_qty, 3), unit_cost: round(unit, 2), mrp: round(a.mrp, 2), value: round(a.value, 2), sensitive: unit > threshold };
    }).sort((x, y) => x.bin.localeCompare(y.bin, undefined, { numeric: true }) || x.part_code.localeCompare(y.part_code, undefined, { numeric: true }));
    const parts = new Set(out.map((r) => r.part_code)), bins = new Set(out.map((r) => r.bin));
    const sensitiveParts = new Set(out.filter((r) => r.sensitive).map((r) => r.part_code));
    const noBin = out.filter((r) => r.bin === NO_BIN).length;
    if (noBin) warnings.push(`${noBin} part/bin lines have no bin location (shown as "${NO_BIN}").`);
    return {
      ok: errors.length === 0, errors, warnings, rows: out,
      summary: { lines, declared, parts: parts.size, partBinLines: out.length, bins: bins.size, branchCodes: [...branches], sensitiveParts: sensitiveParts.size,
        totalQty: round(out.reduce((s, r) => s + r.book_qty, 0), 3), totalValue: round(out.reduce((s, r) => s + r.value, 0), 2), threshold }
    };
    function fail(msg) { return { ok: false, errors: [msg], warnings: [], rows: [], summary: null }; }
  };

  /** Read a File (.xlsx or .csv) in the browser and parse it. Never throws; returns the same shape as parseRows. */
  SVSap.readFile = async function (file, opts) {
    try {
      if (!file) return { ok: false, errors: ['Choose a file first.'], warnings: [], rows: [], summary: null };
      if (file.size > 25 * 1024 * 1024) return { ok: false, errors: ['That file is too large (over 25 MB).'], warnings: [], rows: [], summary: null };
      const name = String(file.name || '').toLowerCase();
      let grid;
      if (name.endsWith('.csv')) grid = SVSap.parseCsv(await file.text());
      else if (name.endsWith('.xlsx')) {
        if (typeof root.readXlsxFile !== 'function') return { ok: false, errors: ['The Excel reader is not available.'], warnings: [], rows: [], summary: null };
        grid = await root.readXlsxFile(file);
        if (grid && !Array.isArray(grid) && Array.isArray(grid[0] && grid[0].data)) grid = grid[0].data;        // multi-sheet shape: use the first sheet
        else if (Array.isArray(grid) && grid[0] && grid[0].data && Array.isArray(grid[0].data)) grid = grid[0].data;
      } else return { ok: false, errors: ['Use an Excel (.xlsx) or CSV (.csv) file. Old .xls files: open and Save As .xlsx first.'], warnings: [], rows: [], summary: null };
      const res = SVSap.parseRows(grid, opts);
      res.reportDate = SVSap.reportDateFromName(file.name);
      res.fileName = file.name;
      return res;
    } catch (e) {
      return { ok: false, errors: ['That file could not be read. Is it a valid Excel (.xlsx) file?'], warnings: [], rows: [], summary: null };
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = SVSap; else root.SVSap = SVSap;
})(typeof self !== 'undefined' ? self : this);
