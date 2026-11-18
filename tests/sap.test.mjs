// SAP report reader: parsing rules, the safety checks, and CSV/XLSX agreement. Fixtures are synthetic (tests/fixtures/make_sap_fixtures.py).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { readSheet } from 'read-excel-file/node';
const S = createRequire(import.meta.url)('../js/sap.js');
const fx = (n) => new URL('./fixtures/' + n, import.meta.url).pathname;
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };
const by = (rows, part, bin) => rows.find((r) => r.part_code === part && (bin == null || r.bin === bin));

const good = S.parseRows(await readSheet(fx('sap_good.xlsx')));

await t('a good file parses with no errors and the right totals', () => {
  assert.equal(good.ok, true, good.errors.join(';'));
  assert.equal(good.summary.lines, 13); assert.equal(good.summary.declared, 13);
  assert.equal(good.summary.parts, 11); assert.equal(good.summary.partBinLines, 12); assert.deepEqual(good.summary.branchCodes, ['6696']);
});
await t('lot rows are summed per part and bin, cost is quantity-weighted', () => {
  const a = by(good.rows, 'AF-100', 'C01-E4'); assert.equal(a.book_qty, 8); assert.equal(a.unit_cost, 407.5);   // (5*400 + 3*420) / 8
  assert.equal(by(good.rows, 'AF-100', 'D02-C2').book_qty, 2, 'same part in another bin stays separate');
});
await t('Issued Quantity is ignored; Blocked counts; In-Transit does not', () => {
  assert.equal(by(good.rows, 'SENS-1').book_qty, 2, 'issued 9 must not count');
  assert.equal(by(good.rows, 'BLK-1').book_qty, 4, 'blocked stock is physically in the store');
  assert.equal(by(good.rows, 'TRN-1').book_qty, 1, 'in-transit is not in the store');
});
await t('sensitive means strictly above the threshold', async () => {
  assert.equal(by(good.rows, 'SENS-1').sensitive, true); assert.equal(by(good.rows, 'EDGE-10K').sensitive, false); assert.equal(by(good.rows, 'EDGE-10K1').sensitive, true);
  assert.equal(good.summary.sensitiveParts, 2);
  assert.equal(S.parseRows(await readSheet(fx('sap_good.xlsx')), { sensitiveThreshold: 11000 }).summary.sensitiveParts, 1, 'threshold is configurable (only the 12,500 part is above 11,000)');
});
await t('part codes stay text; spaces/case are normalised; empty and "0" bins become NO BIN; fractions survive', () => {
  assert.ok(by(good.rows, '0000123', 'NO BIN'), 'leading zeros kept'); assert.ok(by(good.rows, '4567', 'NO BIN'), 'numeric cell becomes text');
  assert.ok(by(good.rows, 'SP-SP', 'C01-E4'), '" sp-sp " / " c01-e4 " normalised'); assert.equal(by(good.rows, 'OIL-5L').book_qty, 12.5);
  assert.ok(good.warnings.some((w) => w.includes('no bin location')));
});
await t('rows are sorted by bin then part (natural order)', () => {
  const bins = good.rows.map((r) => r.bin); const sorted = [...bins].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })); assert.deepEqual(bins, sorted);
});
await t('CSV and XLSX give identical results', () => {
  const csv = S.parseRows(S.parseCsv(readFileSync(fx('sap_good.csv'), 'utf8')));
  assert.equal(csv.ok, true, csv.errors.join(';')); assert.deepEqual(csv.rows, good.rows); assert.equal(csv.summary.declared, null, 'plain CSV has no title row');
});
await t('a cut-off export is rejected (declared line count differs)', async () => {
  const r = S.parseRows(await readSheet(fx('sap_truncated.xlsx'))); assert.equal(r.ok, false); assert.ok(r.errors[0].includes('cut off') && r.errors[0].includes('18') && r.errors[0].includes('13'));
});
await t('a file mixing branches is rejected', async () => {
  const r = S.parseRows(await readSheet(fx('sap_wrong_branch.xlsx'))); assert.equal(r.ok, false); assert.ok(r.errors.some((e) => e.includes('6696') && e.includes('7001')));
});
await t('unreadable numbers are rejected instead of silently skipped', async () => {
  const r = S.parseRows(await readSheet(fx('sap_bad_number.xlsx'))); assert.equal(r.ok, false); assert.ok(r.errors.some((e) => e.includes('not a number')));
});
await t('not a SAP report / missing columns / empty input never throw', () => {
  for (const g of [null, undefined, [], [[]], [['a', 'b'], [1, 2]], 'text', [['Part Code'], ['x']]]) { const r = S.parseRows(g); assert.equal(r.ok, false); assert.ok(r.errors.length >= 1); }
});
await t('negative stock is warned about but allowed', () => {
  const r = S.parseRows([['Part Code', 'Total Quantity', 'Cost'], ['A', -2, 5]]); assert.equal(r.ok, true); assert.ok(r.warnings.some((w) => w.includes('negative')));
});
await t('a missing Cost column warns that sensitive parts cannot be found', () => {
  const r = S.parseRows([['Part Code', 'Total Quantity'], ['A', 2]]); assert.equal(r.ok, true); assert.ok(r.warnings.some((w) => w.includes('Cost')));
});
await t('CSV parser handles quotes, commas, CRLF and a BOM', () => {
  assert.deepEqual(S.parseCsv('﻿a,"b,c","d""e"\r\n1,2,3\r\n'), [['a', 'b,c', 'd"e'], ['1', '2', '3']]);
  const r = S.parseRows(S.parseCsv('Part Code,Part Desc.,Total Quantity,Cost\r\nX1,"Filter, air",1,000\r\nX1,"Filter, air",2,5\r\n'.replace('1,000', '"1,000"')));
  assert.equal(r.ok, true); assert.equal(r.rows[0].book_qty, 1002, 'thousands separator in quoted number');
});
await t('report date comes from the file name', () => {
  assert.equal(S.reportDateFromName('Stock_Report_15.10.2026_Bilaspur_1.xlsx'), '2026-10-15'); assert.equal(S.reportDateFromName('stock-2026-11-03.csv'), '2026-11-03');
  assert.equal(S.reportDateFromName('stock_31.02.2026.xlsx'), null, 'impossible date'); assert.equal(S.reportDateFromName('stock.xlsx'), null); assert.equal(S.reportDateFromName(null), null);
});
console.log(`\n${n} SAP reader tests passed`);
