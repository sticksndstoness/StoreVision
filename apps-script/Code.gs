/**
 * StoreVision backend (Google Apps Script Web App, bound to your inventory Sheet).
 *
 * SETUP
 *  1. Open the Sheet -> Extensions -> Apps Script, paste this file.
 *  2. Project Settings -> Script properties, add:
 *       TOKEN          = a long random string (same value you enter in the app's Setup)
 *       GEMINI_API_KEY = your Gemini key (only needed for "AI proxy" mode)
 *  3. Deploy -> New deployment -> Web app. Execute as: Me. Who has access: Anyone.
 *     Copy the /exec URL into the app's Setup.
 *  After editing this file you must create a NEW deployment version for changes to go live.
 *
 * Every request must carry the correct token. Entries are upserted by id, so retrying or editing never duplicates rows.
 */
var SHEET_NAME = 'Inventory';
var HEADERS = ['ID', 'Timestamp (ISO)', 'Bay/Zone', 'Part No', 'Description', 'Barcode', 'Mfg Date',
  'Visible Count', 'Hidden Qty (typed)', 'Depth Mult', 'Total Qty', 'MRP', 'Total Value',
  'AI Counted', 'Edited', 'Counted/Verified', 'Updated At'];

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function safeCell_(v) {            // block spreadsheet formula injection
  if (typeof v !== 'string') return v;
  return /^[=+\-@\t\r]/.test(v) ? "'" + v : v;
}

function tokenOk_(t) {
  var expected = PropertiesService.getScriptProperties().getProperty('TOKEN');
  return !!expected && typeof t === 'string' && t.length === expected.length && t === expected;
}

function doGet() { return json_({ ok: true, service: 'storevision', version: 2 }); }

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    if (!tokenOk_(body.token)) return json_({ ok: false, error: 'Unauthorized: bad or missing token' });
    if (body.action === 'append') return json_(appendEntry_(body.entry));
    if (body.action === 'vision') return json_(vision_(body));
    return json_({ ok: false, error: 'Unknown action' });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function sheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  if (sh.getLastRow() === 0) {
    sh.appendRow(HEADERS);
    sh.setFrozenRows(1);
  }
  return sh;
}

function appendEntry_(en) {
  if (!en || !en.id) return { ok: false, error: 'Missing entry id' };
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = sheet_();
    var row = [en.id, en.isoTime, en.zone, en.partNo, en.description, en.barcode, en.mfgDate,
      Number(en.visibleCount) || 0, Number(en.hiddenQty) || 0, Number(en.depthMult) || 1,
      Number(en.totalQty) || 0, Number(en.mrp) || 0, Number(en.totalValue) || 0,
      en.aiCounted ? 'yes' : 'no', en.edited ? 'yes' : 'no', en.counted ? 'yes' : 'no', new Date().toISOString()].map(safeCell_);
    var last = sh.getLastRow();
    var rowIdx = -1;
    if (last > 1) {
      var ids = sh.getRange(2, 1, last - 1, 1).getValues();
      for (var i = 0; i < ids.length; i++) { if (ids[i][0] === en.id) { rowIdx = i + 2; break; } }
    }
    if (rowIdx > 0) sh.getRange(rowIdx, 1, 1, row.length).setValues([row]);
    else sh.appendRow(row);
    return { ok: true, updated: rowIdx > 0 };
  } finally { lock.releaseLock(); }
}

/** Server-side Gemini call so the API key never reaches the phone. */
function vision_(b) {
  var key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!key) return { ok: false, error: 'GEMINI_API_KEY is not set in Script Properties' };
  if (!b.image || b.image.length > 6 * 1024 * 1024) return { ok: false, error: 'Missing or oversized image' };
  var model = /^[a-z0-9.\-]+$/i.test(b.model || '') ? b.model : 'gemini-3.8-flash';
  var res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'x-goog-api-key': key },
    payload: JSON.stringify({
      contents: [{ parts: [{ text: String(b.prompt || '') }, { inline_data: { mime_type: 'image/jpeg', data: b.image } }] }],
      generationConfig: { temperature: 0.1, responseMimeType: 'application/json', responseSchema: b.schema, maxOutputTokens: 8192 }
    })
  });
  var code = res.getResponseCode();
  var parsed = JSON.parse(res.getContentText());
  if (code !== 200) return { ok: false, error: (parsed.error && parsed.error.message) || ('Gemini error ' + code) };
  return { ok: true, result: parsed };
}
