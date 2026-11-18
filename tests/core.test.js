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
t('parseModelList keeps generateContent models, drops embeddings/tts, flash first', () => {
  const r = C.parseModelList({ models: [
    { name: 'models/text-embedding-9', supportedGenerationMethods: ['embedContent'] },
    { name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.1-pro', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', supportedGenerationMethods: ['generateContent', 'countTokens'] },
    { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.8-flash-tts', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/old-only-count', supportedGenerationMethods: ['countTokens'] }
  ] });
  assert.deepStrictEqual(r.map((m) => m.id), ['gemini-3.8-flash', 'gemini-3.1-pro', 'gemini-3.5-flash-lite']);
  assert.deepStrictEqual(C.parseModelList(null), []);
});
t('sanitizeEntry coerces junk and never throws', () => {
  assert.strictEqual(C.sanitizeEntry(null), null); assert.strictEqual(C.sanitizeEntry('x'), null); assert.strictEqual(C.sanitizeEntry([1]), null);
  const e = C.sanitizeEntry({ id: 'a', isoTime: 'not-a-date', zone: '', partNo: 5, totalQty: '-3', mrp: 'abc', syncStatus: 'weird', counted: 1, depthMult: 0 });
  assert.strictEqual(e.zone, 'UNASSIGNED'); assert.strictEqual(e.partNo, '5'); assert.strictEqual(e.totalQty, 0); assert.strictEqual(e.mrp, 0);
  assert.strictEqual(e.syncStatus, 'pending'); assert.strictEqual(e.counted, true); assert.strictEqual(e.depthMult, 1); assert.ok(!isNaN(Date.parse(e.isoTime)));
  assert.strictEqual(C.sanitizeEntry({ id: 'x'.repeat(500), description: 'd'.repeat(9999) }).description.length, 300);
});
t('sanitizeEntries drops bad rows and duplicate ids', () => {
  const r = C.sanitizeEntries([{ id: 'a', partNo: 'A' }, null, { id: 'a', partNo: 'dup' }, 7, { id: 'b', partNo: 'B' }]);
  assert.deepStrictEqual(r.entries.map((x) => x.id), ['a', 'b']); assert.strictEqual(r.dropped, 3); assert.deepStrictEqual(C.sanitizeEntries('nope'), { entries: [], dropped: 0 });
});
t('diffEntries: create / update / delete with audit snapshots', () => {
  const a = C.sanitizeEntry({ id: 'a', partNo: 'A', totalQty: 1 }), b = C.sanitizeEntry({ id: 'b', partNo: 'B', totalQty: 2 });
  const prev = new Map([[a.id, JSON.stringify(a)], [b.id, JSON.stringify(b)]]);
  const a2 = { ...a, totalQty: 9 }, c = C.sanitizeEntry({ id: 'c', partNo: 'C' });
  const d = C.diffEntries(prev, [a2, c], '2026-01-01T00:00:00.000Z');
  assert.deepStrictEqual(d.puts.map((x) => x.id), ['a', 'c']); assert.deepStrictEqual(d.deletes, ['b']);
  const ev = Object.fromEntries(d.events.map((e) => [e.entryId, e]));
  assert.strictEqual(ev.a.type, 'update'); assert.strictEqual(ev.a.before.totalQty, 1); assert.strictEqual(ev.a.after.totalQty, 9);
  assert.strictEqual(ev.b.type, 'delete'); assert.strictEqual(ev.b.before.partNo, 'B'); assert.strictEqual(ev.c.type, 'create');
  assert.deepStrictEqual(C.diffEntries(new Map([[a.id, JSON.stringify(a)]]), [a]).puts, []);
});
t('backup roundtrip, validation, merge never overwrites', () => {
  const a = C.sanitizeEntry({ id: 'a', partNo: 'A' }), b = C.sanitizeEntry({ id: 'b', partNo: 'B' });
  const bk = C.makeBackup([a, b], [{ type: 'create' }]); const p = C.parseBackup(JSON.parse(JSON.stringify(bk)));
  assert.ok(p.ok && p.entries.length === 2 && p.dropped === 0);
  assert.strictEqual(C.parseBackup({ format: 'other' }).ok, false); assert.strictEqual(C.parseBackup(null).ok, false);
  assert.strictEqual(C.parseBackup({ format: C.BACKUP_FORMAT, version: 99, entries: [] }).ok, false);
  assert.strictEqual(C.parseBackup({ format: C.BACKUP_FORMAT, version: 1 }).ok, false);
  const m = C.mergeBackup([{ ...a, totalQty: 5 }], p.entries); assert.deepStrictEqual(m.add.map((x) => x.id), ['b']); assert.strictEqual(m.skipped, 1);
});
t('crash record is bounded; AI allowance gap + cap', () => {
  const r = C.makeCrashRecord('error', { message: 'm'.repeat(5000), stack: 's'.repeat(9000) }, 'x'); assert.ok(r.message.length <= 500 && r.stack.length <= 2000);
  assert.strictEqual(C.makeCrashRecord('e', 'plain string').message, 'plain string');
  assert.strictEqual(C.aiAllowance({ lastAt: 1000, now: 1500, countToday: 1, minGapMs: 1500, dailyCap: 5 }).ok, false);
  assert.strictEqual(C.aiAllowance({ lastAt: 1000, now: 3000, countToday: 1, minGapMs: 1500, dailyCap: 5 }).ok, true);
  assert.strictEqual(C.aiAllowance({ lastAt: 0, now: 9e9, countToday: 5, minGapMs: 1, dailyCap: 5 }).ok, false);
  assert.ok(C.daysSince('2020-01-01', Date.parse('2020-01-08')) === 7 && C.daysSince('garbage') === Infinity);
});
console.log(`\n${n} tests passed`);
