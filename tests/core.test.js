const assert = require('assert');
const C = require('../js/core.js');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

t('escapeHtml neutralises markup', () => assert.strictEqual(C.escapeHtml('<img src=x onerror="a">&\''), '&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;'));
t('safeCell prefixes formulas', () => { for (const s of ['=1+1', '+1', '-1', '@SUM(A1)']) assert.strictEqual(C.safeCell(s), "'" + s); assert.strictEqual(C.safeCell('P5105384'), 'P5105384'); });
t('csvCell escapes quotes + formula', () => assert.strictEqual(C.csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`));
t('computeTotals: visible*mult + hidden', () => { const r = C.computeTotals({ visible: 10, hidden: 3, mult: 3, mrp: 4110 }); assert.strictEqual(r.totalQty, 33); assert.strictEqual(r.depthExtra, 20); assert.strictEqual(r.totalValue, 135630); });
t('computeTotals guards garbage', () => { const r = C.computeTotals({ visible: 'x', hidden: -5, mult: 0, mrp: 'abc' }); assert.deepStrictEqual([r.totalQty, r.totalValue, r.mult], [0, 0, 1]); });
t('normalisePins drops non-numeric, clamps, scales', () => {
  const p = C.normalisePins([{ x: 500, y: 250 }, { x: 'a', y: 1 }, null, { x: 5000, y: -3 }, { x: '100', y: '900' }]);
  assert.strictEqual(p.length, 3); assert.deepStrictEqual([p[0].x, p[0].y], [50, 25]); assert.deepStrictEqual([p[1].x, p[1].y], [98, 2]); assert.deepStrictEqual([p[2].x, p[2].y], [10, 90]);
  assert.deepStrictEqual(C.normalisePins(undefined), []);
});
t('extractGeminiText errors', () => {
  assert.throws(() => C.extractGeminiText({}), /no result/);
  assert.throws(() => C.extractGeminiText({ promptFeedback: { blockReason: 'SAFETY' } }), /blocked/);
  assert.throws(() => C.extractGeminiText({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{' }] } }] }), /cut off/);
  assert.strictEqual(C.extractGeminiText({ candidates: [{ content: { parts: [{ text: '{"a":1}' }] } }] }), '{"a":1}');
});
t('parseModelJson handles fences + bad json', () => { assert.deepStrictEqual(C.parseModelJson('```json\n{"a":1}\n```'), { a: 1 }); assert.throws(() => C.parseModelJson('{oops'), /invalid JSON/); });
t('migrateEntry upgrades v1 rows', () => { const m = C.migrateEntry({ timestamp: '17/11/2026, 10:00:00', zone: 'D1', partNo: 'X', visibleCount: 4, hiddenOffset: 2, totalQty: 6, mrp: 10, totalValue: 60 }); assert.ok(m.id && m.syncStatus === 'pending' && m.totalQty === 6); assert.strictEqual(C.migrateEntry(m), m); });
t('entriesToCsv has BOM, header, sanitised rows', () => { const csv = C.entriesToCsv([{ id: 'a', isoTime: 'z', zone: 'D1', partNo: '=cmd', description: 'x', barcode: '', mfgDate: '', visibleCount: 1, hiddenQty: 0, depthMult: 1, totalQty: 1, mrp: 1, totalValue: 1, syncStatus: 'synced' }]); assert.ok(csv.startsWith('﻿"ID"')); assert.ok(csv.includes(`"'=cmd"`)); });
const E = [
  { zone: 'D1', partNo: 'AB1', description: 'Air filter', barcode: 'X9', totalQty: 5, totalValue: 50, counted: true },
  { zone: 'D10', partNo: 'AB2', description: 'Oil filter', barcode: '', totalQty: 3, totalValue: 30, counted: false },
  { zone: 'D2', partNo: 'CD3', description: 'Brake pad', barcode: 'Z', totalQty: 2, totalValue: 20 }
];
t('filterEntries: text, zone, counted', () => {
  assert.strictEqual(C.filterEntries(E, { q: 'filter' }).length, 2);
  assert.strictEqual(C.filterEntries(E, { q: ' x9 ' }).length, 1);
  assert.strictEqual(C.filterEntries(E, { zone: 'D2' }).length, 1);
  assert.strictEqual(C.filterEntries(E, { counted: 'yes' }).length, 1);
  assert.strictEqual(C.filterEntries(E, { counted: 'no' }).length, 2);
  assert.strictEqual(C.filterEntries(E, {}).length, 3);
});
t('uniqueZones / groupByZone natural sort + subtotals', () => {
  assert.deepStrictEqual(C.uniqueZones(E), ['D1', 'D2', 'D10']);
  const g = C.groupByZone(E); assert.deepStrictEqual(g.map((x) => x.zone), ['D1', 'D2', 'D10']); assert.strictEqual(g[0].qty, 5); assert.strictEqual(g[2].value, 30);
});
console.log(`\n${n} tests passed`);
