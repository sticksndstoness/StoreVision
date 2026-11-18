// Part identification against the SAP part list: exact, QR text, look-alike characters, one-character slips, type-ahead.
const assert = require('assert');
const P = require('../js/parts.js');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok -', name); };
const rows = [
  { part_code: 'PHJ00006', description: 'FUEL WATER SEPARATOR SPIN ON', uom: 'EA', bin: 'C01-E4' },
  { part_code: 'PHJ00006', description: 'FUEL WATER SEPARATOR SPIN ON', uom: 'EA', bin: 'D02-C2' },
  { part_code: 'PHJ00007', description: 'FUEL FILTER ELEMENT', uom: 'EA', bin: 'C01-E4' },
  { part_code: 'F7B00100', description: 'FF CUM WATER SEPARATOR SPIN-ON N4', uom: 'EA', bin: 'PLAT' },
  { part_code: '53XW001(L)', description: 'LUBE OIL', uom: 'L', bin: '18_C' },
  { part_code: '165462VE0A', description: 'AIR FILTER PRIMARY', uom: 'EA', bin: 'C01-E4' },
  { part_code: '0000123', description: 'LEADING ZEROS', uom: 'EA', bin: 'NO BIN' },
  { part_code: 'SB8-ZQ1', description: 'LOOKALIKE CHARS', uom: 'EA', bin: 'X1' }
];
const idx = P.build(rows);

t('build groups bins per part and keeps the first description', () => {
  assert.strictEqual(idx.size, 7); const p = P.find(idx, 'PHJ00006').part;
  assert.deepStrictEqual(p.bins, ['C01-E4', 'D02-C2']); assert.strictEqual(p.description, 'FUEL WATER SEPARATOR SPIN ON'); assert.strictEqual(p.uom, 'EA');
});
t('junk rows are ignored; no list gives no matches', () => {
  assert.strictEqual(P.build([null, {}, { part_code: '  ' }, { part_code: 'A1' }]).size, 1); assert.strictEqual(P.build(null).size, 0);
  assert.strictEqual(P.find(null, 'X'), null); assert.deepStrictEqual(P.identify(null, { partNo: 'X' }), { status: 'none', suggestions: [] });
});
t('exact lookup ignores case and spaces; keeps leading zeros', () => {
  assert.strictEqual(P.find(idx, ' phj 00006 ').part.part_code, 'PHJ00006'); assert.strictEqual(P.find(idx, '0000123').part.part_code, '0000123'); assert.strictEqual(P.find(idx, '123'), null);
});
t('a label without the (L) suffix still finds the SAP code that has it', () => {
  assert.strictEqual(P.find(idx, '53XW001').part.part_code, '53XW001(L)'); assert.strictEqual(P.find(idx, '53xw001(l)').part.part_code, '53XW001(L)');
});
t('QR / barcode text with several fields: the part is found, the serial is not mistaken for one', () => {
  for (const text of ['PHJ00006|CBL0NL0050', 'PHJ00006,CBL0NL0050,3470.00', 'P:PHJ00006 S:CBL0NL0050', '{"p":"PHJ00006","s":"CBL0NL0050"}', 'CBL0NL0050;PHJ00006'])
    assert.strictEqual(P.fromText(idx, text).part.part_code, 'PHJ00006', text);
  assert.strictEqual(P.fromText(idx, 'CBL0NL0050'), null, 'a serial number alone is not a part'); assert.strictEqual(P.fromText(idx, ''), null);
});
t('look-alike characters are suggested, never silently accepted', () => {
  assert.strictEqual(P.find(idx, 'PHJ0O006'), null);
  assert.deepStrictEqual(P.suggest(idx, 'PHJ0O006').map((p) => p.part_code), ['PHJ00006']);
  assert.deepStrictEqual(P.suggest(idx, 'PHJOOOO6').map((p) => p.part_code), ['PHJ00006']);
  assert.ok(P.suggest(idx, 'SB8-ZQ1').length === 0, 'an exact code needs no suggestion');
});
t('one missing / extra / wrong character is suggested', () => {
  assert.deepStrictEqual(P.suggest(idx, 'PHJ0006').map((p) => p.part_code), ['PHJ00006']);      // missing
  assert.deepStrictEqual(P.suggest(idx, 'PHJ000006').map((p) => p.part_code), ['PHJ00006']);     // extra
  assert.ok(P.suggest(idx, 'PHJ00009').some((p) => p.part_code === 'PHJ00006' || p.part_code === 'PHJ00007'), 'wrong character');
  assert.deepStrictEqual(P.suggest(idx, 'XYZ12345'), [], 'nothing close: no invented match'); assert.deepStrictEqual(P.suggest(idx, 'PHJ'), [], 'too short to guess');
});
t('identify: part number first, then QR text, then suggestions, then none', () => {
  let r = P.identify(idx, { partNo: 'PHJ00006', texts: ['PHJ00007|X'] }); assert.strictEqual(r.status, 'exact'); assert.strictEqual(r.part.part_code, 'PHJ00006'); assert.strictEqual(r.via, 'part number');
  r = P.identify(idx, { partNo: '', texts: ['PHJ00007|CBL0NL0050'] }); assert.strictEqual(r.status, 'exact'); assert.strictEqual(r.part.part_code, 'PHJ00007'); assert.strictEqual(r.via, 'QR / barcode');
  r = P.identify(idx, { partNo: 'PHJ0O006', texts: [] }); assert.strictEqual(r.status, 'suggest'); assert.strictEqual(r.suggestions[0].part_code, 'PHJ00006');
  r = P.identify(idx, { partNo: 'ZZZ999', texts: ['CBL0NL0050'] }); assert.strictEqual(r.status, 'none');
  r = P.identify(idx, { partNo: 'ZZZ999', texts: ['PHJ0O006|CBL0NL0050'] }); assert.strictEqual(r.status, 'suggest', 'a misread code inside QR text is also suggested');
  assert.strictEqual(P.identify(idx, {}).status, 'none'); assert.strictEqual(P.identify(idx).status, 'none');
});
t('a wrong part number from the AI does not hide a correct QR code', () => {
  const r = P.identify(idx, { partNo: 'ZZZ999', texts: ['PHJ00006|CBL0NL0050'] }); assert.strictEqual(r.status, 'exact'); assert.strictEqual(r.part.part_code, 'PHJ00006');
});
t('type-ahead: code prefix, code fragment, description words; best first', () => {
  assert.deepStrictEqual(P.search(idx, 'phj').map((p) => p.part_code), ['PHJ00006', 'PHJ00007']);
  assert.strictEqual(P.search(idx, 'PHJ00006')[0].part_code, 'PHJ00006'); assert.ok(P.search(idx, '0006').some((p) => p.part_code === 'PHJ00006'));
  assert.deepStrictEqual(P.search(idx, 'water sep').map((p) => p.part_code).sort(), ['F7B00100', 'PHJ00006'], 'both water separators found by description words');
  assert.deepStrictEqual(P.search(idx, 'x'), [], 'one letter is too vague'); assert.deepStrictEqual(P.search(idx, ''), []); assert.deepStrictEqual(P.search(null, 'abc'), []);
  assert.ok(P.search(idx, 'e', 8).length === 0);
});
console.log(`\n${n} part-matching tests passed`);
